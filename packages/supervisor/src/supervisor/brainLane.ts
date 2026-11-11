/**
 * 判定会话按车道分代，占用超阈值即换代并落 `context_compacted` 事件。
 * 换代后的首轮附上上一代最近的判定结论，使新会话无需重建上下文。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { hhmmOf } from "../core/clock";
import { recordEvent } from "../core/ledger";
import { supervisorDir } from "../core/paths";
import { estimateSessionContextTokens } from "./reload";

/** 一条车道（判定脑）。 */
interface LaneState {
  base: string;
  current: string;
  gen: number;
  /** 这一代已判轮数；占用估算不可用时作为换代判据。 */
  turns: number;
  at: string;
}

/** 换代阈值（token），可由 `CAPITALIST_BRAIN_CTX_CAP` 覆盖。 */
const DEFAULT_CAP = 200_000;
/** 宿主不提供占用估算时，按已判轮数强制换代的上限。 */
const MAX_TURNS_UNKNOWN = 15;

function capOf(): number {
  const n = Number(process.env.CAPITALIST_BRAIN_CTX_CAP ?? "");
  return Number.isFinite(n) && n >= 50_000 ? Math.round(n) : DEFAULT_CAP;
}

function laneDir(root: string): string {
  return join(supervisorDir(root), "brain");
}

function lanePath(root: string, base: string): string {
  const safe = String(base || "brain").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 64);
  return join(laneDir(root), `${safe}.json`);
}

function readLane(root: string, base: string): LaneState | null {
  try {
    const st = JSON.parse(readFileSync(lanePath(root, base), "utf8")) as LaneState;
    if (!st || typeof st.base !== "string" || typeof st.current !== "string") return null;
    return {
      base: st.base,
      current: st.current,
      gen: Number.isFinite(Number(st.gen)) ? Number(st.gen) : 0,
      turns: Number.isFinite(Number(st.turns)) ? Number(st.turns) : 0,
      at: String(st.at ?? ""),
    };
  } catch {
    return null;
  }
}

function writeLane(root: string, st: LaneState): void {
  try {
    mkdirSync(laneDir(root), { recursive: true });
    writeFileSync(lanePath(root, st.base), JSON.stringify(st, null, 1));
  } catch {
    /* 写入失败按首次处理，下一轮会重发首轮规范。 */
  }
}

/** 当前代的会话 id 与是否为首轮。 */
export interface BrainLane {
  id: string;
  gen: number;
  /** 本代尚未判定：需发送首轮规范与换代摘要。 */
  fresh: boolean;
}

/**
 * 判定池并发最多 2；并发写入车道文件失败时不重试，两条判定共用同一会话，下一轮按实际占用再判。
 */
export function brainSessionOf(root: string, base: string): BrainLane {
  const name = String(base || "capitalist-brain").trim() || "capitalist-brain";
  const st = readLane(root, name);
  if (!st) {
    /* 首次建档即计入一轮；`fresh` 只表示本代尚未判定。 */
    writeLane(root, { base: name, current: name, gen: 0, turns: 1, at: new Date().toISOString() });
    return { id: name, gen: 0, fresh: true };
  }

  const used = estimateSessionContextTokens(st.current);
  const cap = capOf();
  const tooFull = used !== null ? used >= cap : st.turns >= MAX_TURNS_UNKNOWN;

  if (!tooFull) {
    writeLane(root, { ...st, turns: st.turns + 1, at: new Date().toISOString() });
    return { id: st.current, gen: st.gen, fresh: st.turns === 0 };
  }

  const gen = st.gen + 1;
  const current = `${name}-g${gen}`;
  writeLane(root, { base: name, current, gen, turns: 0, at: new Date().toISOString() });
  recordEvent(root, "context_compacted", {
    scope: "brain",
    lane: name,
    session: st.current,
    next_session: current,
    before_used: used,
    after_used: null,
    limit: cap,
    source: "turn_cap",
    trigger: "brain_cap",
    gen_from: st.gen,
    gen_to: gen,
  });
  return { id: current, gen, fresh: true };
}

/** 台账尾部窗口（字节）：只找最近的判定结论，不全量解析。 */
const VERDICT_TAIL_BYTES = 256_000;

/**
 * 上一代最近的判定结论，逐条返回。
 * 只取结论与简要理由，不带完整事实，避免换代后上下文重新膨胀。
 */
export function recentVerdicts(root: string, max = 6): string[] {
  const file = join(supervisorDir(root), "events.jsonl");
  if (!existsSync(file)) return [];
  let buf = "";
  try {
    const size = statSync(file).size;
    const want = Math.min(size, VERDICT_TAIL_BYTES);
    const fd = openSync(file, "r");
    try {
      const b = Buffer.alloc(want);
      readSync(fd, b, 0, want, size - want);
      buf = b.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const out: string[] = [];
  const lines = buf.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < max; i -= 1) {
    const s = (lines[i] ?? "").trim();
    if (!s.startsWith("{")) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(s) as Record<string, unknown>;
    } catch {
      continue;
    }
    const name = String(o.event ?? o.kind ?? "");
    const decision = String(o.decision ?? "").trim();
    const why = String(o.why ?? "").replace(/\s+/g, " ").slice(0, 70);
    const at = hhmmOf(o.at);
    if (name === "mq_triage" && decision) {
      out.push(`- ${at} 判 ${String(o.kind ?? "申报")} -> ${decision}${why ? `：${why}` : ""}`);
      continue;
    }
    if (name === "retry_allowed" || name === "retry_refused" || name === "retry_held") {
      const label = name === "retry_allowed" ? "可以再试" : name === "retry_refused" ? "不再重试" : "暂不重派";
      out.push(`- ${at} 重派 -> ${label}${why ? `：${why}` : ""}`);
    }
  }
  return out.reverse();
}
