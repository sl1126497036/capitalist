/**
 * 会话车道：按阶段与分片（无分片时按分类标签）派生车道基名，决定工作进程续接哪条 AI 会话。
 *
 * 上下文占用超过窗口比例时换代；同一车道同时只允许一个进程续接；action 指纹只作记录，不参与换代判定。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { recordEvent } from "../core/ledger";
import { resolveContextWindow } from "../core/limits";
import type { Dispatch, WorkerRecord } from "../core/supervisor";
import type { WorkerSession } from "../host/contract";

/** 车道记录：一车道一代，换代只改 `current`。 */
export interface LaneState {
  /** 车道基名，例如 `capitalist-u6-main`、`capitalist-u6-ui`。 */
  base: string;
  /** 当前使用的会话 id，例如 `capitalist-u6-main-g3`。 */
  current: string;
  /** 第几代，从 0 起（0 表示基名本身）。 */
  gen: number;
  /** 上一次写下这一代的 action 指纹。 */
  sig: string;
  /** 上一次观测到的上下文占用（token）。 */
  ctx_used: number | null;
  /** 该模型的上下文窗口（写入时已按默认表校正）。 */
  ctx_window: number | null;
  /** 上一次读数对应的模型名，用于校正占位窗口值。 */
  ctx_model?: string;
  /** 当前代已续接次数；`ctx_used` 为 null 时按 {@link CTX_UNKNOWN_MAX_RESUME} 上限换代。 */
  resumes?: number;
  /** 上一次更新的时刻。 */
  at: string;
}

/** 上下文的换道阈值：占窗口的比例。 */
const CTX_RATIO = 0.6;
/** 拿不到窗口时的回落上限（常见窗口 300k，取六成）。 */
const CTX_FALLBACK_LIMIT = 180_000;
/** 占用未知时同一代最多续接几次，再多就换代。 */
const CTX_UNKNOWN_MAX_RESUME = 2;
/** `.capitalist/sessions` 目录。 */
export function sessionsDir(root: string): string {
  return join(root, ".capitalist", "sessions");
}

function basePath(root: string, base: string): string {
  return join(sessionsDir(root), `${base}.json`);
}

/** 车道基名取分片，无分片时取首个分类标签；无标签时为 `misc`。本函数供看板复用。 */
export function laneBaseId(stage: string, shard: string, tags: readonly string[] = []): string {
  const pick = String(shard ?? "").trim() || String(tags[0] ?? "").trim() || "misc";
  return `capitalist-${stage}-${pick}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 52);
}

/** 读车道记录；没有或损坏时返回 null（按首次处理）。 */
export function readLane(root: string, base: string): LaneState | null {
  try {
    const st = JSON.parse(readFileSync(basePath(root, base), "utf8")) as LaneState;
    if (!st || typeof st.base !== "string" || typeof st.current !== "string") return null;
    return st;
  } catch {
    return null;
  }
}

function writeLane(root: string, st: LaneState): void {
  try {
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(basePath(root, st.base), JSON.stringify(st, null, 1));
  } catch {
    /* 写盘失败时按无记录处理，下一次按首次处理。 */
  }
}

/** 追加段起始标记；按前缀匹配，且须与 worker.ts 的 `BLOCKER_MARKER`、`spliceDirectives` 的插话标记保持一致。 */
const APPEND_SECTION_MARKS = ["【用户插话", "【上一轮卡点"] as const;

/** 取 action 正文在首个追加段标记之前的部分计算指纹，追加段不计入。 */
function fingerprintOf(action: string): string {
  let base = String(action ?? "");
  for (const mark of APPEND_SECTION_MARKS) {
    const at = base.indexOf(mark);
    if (at >= 0) base = base.slice(0, at);
  }
  return createHash("sha1").update(base.trim()).digest("hex").slice(0, 12);
}

/** 与看板、监工超限判定共用 {@link resolveContextWindow}；车道文件中的占位窗口按 `ctx_model` 校正。 */
export function laneContextWindow(st: LaneState | null): number {
  if (!st) return 0;
  const w = resolveContextWindow(String(st.ctx_model ?? ""), st.ctx_window);
  return w !== null && w > 0 ? w : 0;
}

/** 这一代车道的换道阈值（token）：窗口的六成，拿不到窗口时取回落值。 */
export function laneLimit(st: LaneState | null): number {
  if (!st) return CTX_FALLBACK_LIMIT;
  const win = laneContextWindow(st);
  return win > 0 ? Math.floor(win * CTX_RATIO) : CTX_FALLBACK_LIMIT;
}

/** 上下文是否已经太满：满了就换代，不续接。 */
export function laneTooFull(st: LaneState | null): boolean {
  if (!st || st.ctx_used === null) return false;
  return st.ctx_used >= laneLimit(st);
}

/** `ctx_used` 为 null 时按续接次数判定是否达到上限。 */
export function laneUnknownSpent(st: LaneState | null): boolean {
  if (!st || st.ctx_used !== null) return false;
  return (st.resumes ?? 0) >= CTX_UNKNOWN_MAX_RESUME;
}

/** `busy` 由调用方提供；本模块不读工作进程台账，`worker.ts` 与看板各自判定车道占用。 */
export function pickLane(
  root: string,
  dispatch: Dispatch,
  busy: (sessionId: string) => boolean = () => false,
): WorkerSession {
  const tags = Array.isArray((dispatch as { tags?: string[] }).tags)
    ? ((dispatch as { tags?: string[] }).tags as string[])
    : [];
  const base = laneBaseId(String(dispatch.stage ?? ""), String(dispatch.shard ?? ""), tags);
  const sig = fingerprintOf(String(dispatch.action ?? ""));
  const st = readLane(root, base);

  // 首次：用基名新开，不续接。
  if (!st) {
    writeLane(root, {
      base,
      current: base,
      gen: 0,
      sig,
      ctx_used: null,
      ctx_window: null,
      at: new Date().toISOString(),
    });
    return { id: base, resume: false };
  }

  /* 占用未满、未知续接次数未达上限、无进程占用三道闸门全通过才续接，否则换代；与 action 指纹无关。sig 更新为最新指纹供回查。 */
  /* 占用判定读取车道文件的实时读数：`loop.ts` 的 `refreshLaneUsage` 每轮按日志增量刷新，不等进程退出。 */
  const tooFull = laneTooFull(st);
  const unknownSpent = laneUnknownSpent(st);
  const occupied = busy(st.current);
  if (!tooFull && !unknownSpent && !occupied) {
    writeLane(root, {
      ...st,
      sig,
      // 读数已知时清零；未知续接上限只约束 `ctx_used` 为 null 的代。
      resumes: st.ctx_used === null ? (st.resumes ?? 0) + 1 : 0,
      at: new Date().toISOString(),
    });
    return { id: st.current, resume: true };
  }
  const gen = st.gen + 1;
  const current = `${base}-g${gen}`;
  const why = tooFull ? "ctx_full" : unknownSpent ? "ctx_unknown" : "occupied";
  recordEvent(root, "lane_rotated", {
    base,
    from_gen: st.gen,
    to_gen: gen,
    ctx_used: st.ctx_used,
    limit: laneLimit(st),
    why,
  });
  writeLane(root, {
    base,
    current,
    gen,
    sig,
    // 换代时清零占用读数：新一代从零开始。
    ctx_used: null,
    ctx_window: st.ctx_window,
    ctx_model: st.ctx_model ?? "",
    resumes: 0,
    at: new Date().toISOString(),
  });
  return { id: current, resume: false };
}

/**
 * 把工作进程的上下文占用写回其车道：运行中由 `loop.ts` 的 `refreshLaneUsage` 每轮刷新，退出时由 exit 回调与 `reap` 补写终值。
 *
 * 只写当前代，老代读数晚到时不覆盖新代。
 */
export function recordLaneUsage(
  root: string,
  laneId: string,
  figures: { context_used: number | null; context_window: number | null; context_model?: string },
): void {
  if (!laneId) return;
  const base = laneId.replace(/-g\d+$/, "");
  const st = readLane(root, base);
  if (!st) return;
  // 老代的退出回调晚到，不覆盖新代读数。
  if (st.current !== laneId) return;
  writeLane(root, {
    ...st,
    ctx_used: figures.context_used ?? st.ctx_used,
    ctx_window: figures.context_window ?? st.ctx_window,
    ctx_model: figures.context_model || st.ctx_model || "",
    at: new Date().toISOString(),
  });
}

/** 车道文件是否存在（调试/看板用）。 */
export function laneExists(root: string, base: string): boolean {
  return existsSync(basePath(root, base));
}

/** 从工作进程记录取会话 id；老记录没有该字段时返回空串。 */
export function laneOfWorker(w: WorkerRecord | null | undefined): string {
  return String((w as unknown as { ai_session?: string } | null)?.ai_session ?? "");
}
