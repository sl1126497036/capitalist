/**
 * 监工上下文重载（capitalist reload）：压缩监工对话与事件流水，只保留未完成项、决策结论与需求原文，产物落在 `.capitalist/reload/`。
 *
 * 快照 `snapshot.json` 中 `done_verified` 的条目不重派，`done_unverified` 的条目由 {@link applyResumePlan} 补 `source=reverify` 复验单；另有 `context.md` 简报、`resume.json` 恢复计划、`session.json` 会话代次与历史副本。
 * 看板侧：重载开始写 `active.json`、结束删除，`/api/supervisor` 转成 `reload: { active, phase }`；残留 active 超过 {@link RELOAD_STALE_MS} 视为失效。
 *
 * 自动重载：board 把 result 行的 contextUsed / contextWindow 经 {@link recordSupervisorContext} 落到 `capitalist-ctx.json`，主循环用 {@link shouldAutoReload} 判定超限后走同一条 `beginReload` 链路。
 * 恢复计划按 {@link ReloadSnapshot.dispatch_order}（台账行序）与 `resume_order` 排序，不按任务编号排序；编号仅作身份标识，与下发顺序无关。
 *
 * 边界：只写 `.capitalist/reload/` 与复验单，不改 state、不动守卫；派单与推进只在 loop.ts 的 step 里发生。
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { clipText, sleep } from "../../core/text";

import { dirs } from "../../agent/registry";
import { hhmmOf } from "../../core/clock";
import { listDirectives } from "../../core/dispatch/commands";
import { composeDispatch } from "../../core/dispatch/newDispatch";
import type { Policy } from "../../core/policy/policy";
import { openInboxAsks } from "../../core/dispatch/inbox";
import { readJson, readJsonl, writeJson } from "../../core/record/json";
import { DEFAULT_SUPERVISOR_CONTEXT_LIMIT, readCtxWindow, readCtxWindowChosen, resolveContextWindow } from "../../core/guard/limits";
import { recordEvent } from "../../core/record/ledger";
import { reload as reloadLoc, ledger as ledgerLoc, inbox as inboxLoc } from "../../core/record/locations";
import { loadState } from "../../core/record/state";
import { EVENT_ZH } from "./terms";
import {
  appendDispatch,
  listWorkers,
  loadSupervisor,
  newDispatchId,
  readDispatches,
  type Dispatch,
} from "../../core/record/supervisor";
import {
  estimateContextTokens,
  newTextTally,
  tallyMessage,
  workerUsageRow,
} from "../usage/usage";
import type { TaskState } from "../../core/types";

/** 重载目录：`.capitalist/reload`。所有产物都在这里，归档时不与业务台账混在一起。 */
function reloadDir(root: string): string {
  return reloadLoc.dir(root);
}

function activePath(root: string): string {
  return join(reloadDir(root), "active.json");
}

/** 最近一次的进度快照。 */
export function snapshotPath(root: string): string {
  return join(reloadDir(root), "snapshot.json");
}

/** 压缩后的上下文简报（纯文本，进模型提示词）。 */
export function contextPath(root: string): string {
  return join(reloadDir(root), "context.md");
}

/** 重载后的恢复计划：哪些跳过、哪些复验。 */
export function resumePath(root: string): string {
  return join(reloadDir(root), "resume.json");
}

/** 当前重载代次与监工对话会话 id。 */
export function sessionPath(root: string): string {
  return join(reloadDir(root), "session.json");
}

function historyDir(root: string): string {
  return join(reloadDir(root), "history");
}

/** “重载进行中”标记的失效时间；重载是秒级动作，残留 active 说明写它的进程已退出。 */
export const RELOAD_STALE_MS = 3 * 60_000;

/** 一张单在快照里的状态。 */
export type ReloadItemState =
  /** 守卫里有这一片，但没有任何派单记录 */
  | "not_started"
  /** open / claimed：排队或执行中 */
  | "in_progress"
  /** 最后一单失败，等重派 */
  | "failed"
  /** 报过完成，但没有可核对的确认（review，或 done 而证据台账里没有） */
  | "done_unverified"
  /** 完成且有证据确认；重载后不得重派 */
  | "done_verified";

/** 快照里一条派单的摘要。只留判断所需，不留 action 全文（详情在 item.action 里）。 */
export interface ReloadDispatchRef {
  id: string;
  status: string;
  attempt: number;
  at: string;
  note: string;
  /** 复验单标记：这类单本身不是业务产出，不参与“业务是否完成”的判定 */
  reverify: boolean;
}

/** 一个任务节点在快照里的记录。按派生链归并：同一件事的重派单算一个节点。 */
export interface ReloadItem {
  /** 派生链键：链上第一张派单的 id。 */
  key: string;
  title: string;
  state: ReloadItemState;
  /** 判定依据。重载后据此核对状态判定。 */
  why: string;
  /** 需求原文，不压缩。 */
  action: string;
  /** 重派计数：同一片出现过的派单次数 - 1（累计口径，不受裁决重置影响） */
  retries: number;
  /** 当前连续失败次数（口径同 loop.shardRetry，受 retry_resets 影响） */
  failures: number;
  dispatches: ReloadDispatchRef[];
  /** 复验单 id（恢复计划写入；快照里只做记录） */
  verify_dispatch?: string;
  verified_by?: string;
  verified_at?: string;
}

/** 需求原文条目：来源 + 原文。 */
export interface ReloadRequirement {
  source: string;
  text: string;
}

/** 用户插话（`.capitalist/ledger/direct.jsonl` 里未消费的那些）。 */
export interface ReloadDirective {
  at: string;
  text: string;
  shard: string;
}

/** 未裁决提问。 */
export interface ReloadAsk {
  id: string;
  at: string;
  text: string;
  shard: string;
}

/** 决策结论：一行一条，来自已回填的裁决记录。 */
export interface ReloadDecision {
  at: string;
  kind: string;
  text: string;
}

/** 快照的统计，报告里的“前后对比”直接用这份数。 */
export interface ReloadMetrics {
  /** 重载前，几份台账的原始字符数合计 */
  before_chars: number;
  /** 压缩后简报的字符数 */
  after_chars: number;
  events_total: number;
  events_dropped: number;
  events_kept: number;
  items: number;
  done_verified: number;
  done_unverified: number;
  unfinished: number;
  directives: number;
  asks: number;
}

/** 守卫超过该时长未更新即视为可能过期；新鲜度写入简报前部。 */
const POLICY_STALE_HOURS = 12;

/** 守卫文件的新鲜度。 */
export interface PolicyFreshness {
  /** 守卫文件绝对路径；state 里没记或读不到时为空串。 */
  path: string;
  /** 文件最后修改时间（ISO）；读不到时为空串。 */
  mtime: string;
  /** 距现在多少小时；读不到时为 null。 */
  age_hours: number | null;
  /** 超过 {@link POLICY_STALE_HOURS} 未更新。 */
  stale: boolean;
}

/** 以守卫文件的 mtime 判断新鲜度；`state.json` 的 `rev` 只记监工写状态次数，不反映外部改动。 */
export function policyFreshness(root: string): PolicyFreshness {
  const st = loadState(root);
  const p = String(st?.policy_path ?? "").trim();
  if (!p) return { path: "", mtime: "", age_hours: null, stale: false };
  try {
    const mt = statSync(p).mtime;
    const age = (Date.now() - mt.getTime()) / 3_600_000;
    return {
      path: p,
      mtime: mt.toISOString(),
      age_hours: Math.round(age * 10) / 10,
      stale: age > POLICY_STALE_HOURS,
    };
  } catch {
    return { path: p, mtime: "", age_hours: null, stale: false };
  }
}

/**
 * 比对守卫文件 mtime，变化即登记并提示重读。
 * 记录落在 `.capitalist/reload/policy-seen.json`，进程重启后仍可判定。
 */
export interface PolicyChange {
  /** 变更前的 mtime；首次见到时为空串。 */
  from: string;
  /** 变更后的 mtime。 */
  to: string;
  /** 距上次见到的间隔小时数；首次见到为 null。 */
  gap_hours: number | null;
}

export function notePolicyChange(root: string): PolicyChange | null {
  const fresh = policyFreshness(root);
  if (!fresh.path || !fresh.mtime) return null;
  const seenPath = join(reloadDir(root), "policy-seen.json");
  const prev = readJson<{ path?: string; mtime?: string; at?: string } | null>(seenPath, null);
  const sameFile = String(prev?.path ?? "") === fresh.path;
  if (sameFile && String(prev?.mtime ?? "") === fresh.mtime) return null;

  /* 首次登记不算变更，否则每个新任务根都会报一次守卫变化。 */
  const from = sameFile ? String(prev?.mtime ?? "") : "";
  const prevAt = Date.parse(String(prev?.at ?? ""));
  const change: PolicyChange = {
    from,
    to: fresh.mtime,
    gap_hours: Number.isFinite(prevAt) ? Math.round(((Date.now() - prevAt) / 3_600_000) * 10) / 10 : null,
  };
  try {
    writeJson(seenPath, { path: fresh.path, mtime: fresh.mtime, at: new Date().toISOString() });
  } catch {
    /* 写入失败不阻断主流程：下一次比对仍会重试。 */
  }
  return from ? change : null;
}

export interface ReloadSnapshot {
  version: 1;
  gen: number;
  at: string;
  at_ts: number;
  target: string;
  policy: string;
  next_action: string;
  requirements: ReloadRequirement[];
  items: ReloadItem[];
  directives: ReloadDirective[];
  asks: ReloadAsk[];
  decisions: ReloadDecision[];
  /** 文件边界与禁止事项，原文行 */
  boundaries: string[];
  /** 守卫文件新鲜度。 */
  policy_freshness?: PolicyFreshness;
  retries: Record<string, number>;
  /**
   * 在途单按派单台账行序记录，恢复时依此顺序，不按任务编号排序。
   * 任务编号是身份标识，与下发顺序无关。
   */
  dispatch_order: ReloadOrderEntry[];
  /**
   * 未完成条目的恢复顺序（item key）。
   *
   * 按“这片第一张派单在台账里的行序”排；从没派过的片按守卫顺序排在后面。
   * 恢复计划（buildResumePlan）的 reverify / pending 数组按它排序。
   */
  resume_order: string[];
  metrics: ReloadMetrics;
}

/** 恢复计划里的一条待复验项。 */
export interface ResumeReverifyItem {
  key: string;
  title: string;
  action: string;
  /** 该片被判定为“已做但未验证”的依据。 */
  why: string;
}

/** 每条的恢复状态：由 {@link applyResumePlan} 推进。 */
export interface ResumeItemState {
  state: "pending" | "verifying" | "verified";
  verify_dispatch?: string;
  verified_by?: string;
  verified_at?: string;
}

/** 重载恢复计划。 */
export interface ResumePlan {
  gen: number;
  at: string;
  /** done_verified：不重派 */
  skip: Array<{ key: string; title: string; why: string }>;
  /** done_unverified：必须派复验 */
  reverify: ResumeReverifyItem[];
  /** 其余（未开始 / 执行中 / 失败）：交给监工的重派流程，不在此重复派 */
  pending: Array<{ key: string; state: string }>;
  state: Record<string, ResumeItemState>;
  applied_at?: string;
}

/** 快照里一条在途单的原始下发顺序记录。 */
export interface ReloadOrderEntry {
  id: string;
  shard: string;
  status: string;
  at: string;
}

/** `/api/supervisor` 下发的重载状态。 */
export interface ReloadStatus {
  active: boolean;
  /** snapshot | compress | resume | done */
  phase: string;
  gen: number;
  started_at: string;
  age_sec: number;
  /** 触发来源：manual（capitalist reload / 监工动作）| context_overflow（上下文超限自动重载） */
  trigger: string;
}

/** `.capitalist/reload/active.json` 的结构。 */
interface ActiveMarker {
  gen: number;
  phase: string;
  pid: number;
  started_at: string;
  at_ts: number;
  /** 触发来源；老标记没有这个字段，读作 manual。 */
  trigger?: string;
}

interface SessionRecord {
  gen: number;
  session_id: string;
  at: string;
  brief_chars: number;
  /**
   * 工作区标识：任务根本次生命周期的随机短串，写入会话 id。
   *
   * `session.json` 在 `.capitalist/reload/` 下，随 `.capitalist` 删除；文件缺失即新的
   * 生命周期，换新标识，不续接同一目录上一轮的会话记录。历史记录缺该字段，首次读取
   * 时补写，原有会话 id 不变。
   */
  workspace?: string;
}

interface LedgerEntry {
  id?: string;
  claim?: string;
  verdict?: string;
  evidence?: Record<string, string>;
  at?: string;
}

/** 台账文件的大小（字符数）；不存在按 0。 */
function fileChars(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** 单行化：快照里的 title / why 要能进表格，不携带换行。 */
function oneLine(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** 噪音事件：只表明进程存活、不反映进度，压缩时丢弃，避免挤占派单与裁决记录的空间。 */
const NOISE_EVENT =
  /^(supervisor_tick|heartbeat|heartbeat_.*|worker_heartbeat.*|board_.*|.*_debug|.*_probe|probe.*|tool|tool_result|stream.*|message_.*|usage|token_.*)$/i;

/** 明细事件：仅在单未了结时保留，重载后可据此还原这一单原本要做的事。 */
const DETAIL_EVENT = /^dispatch_(open|claim|start)$/i;

/** 证据四项。与 `capitalist ledger add` 的 confirmed 门槛一致（见 cli/records.ts）。 */
const EVIDENCE_FIELDS = ["baseline", "probe", "diff", "repro"] as const;

function readEvents(root: string): Array<Record<string, unknown>> {
  return readJsonl<Record<string, unknown>>(ledgerLoc.events(root));
}

function readLedger(root: string): LedgerEntry[] {
  return readJsonl<LedgerEntry>(ledgerLoc.ledger(root));
}

/** 证据是否齐全；缺项不算确认，与台账降级口径一致。 */
function evidenceComplete(e: LedgerEntry): boolean {
  const ev = (e.evidence ?? {}) as Record<string, unknown>;
  return EVIDENCE_FIELDS.every((k) => Boolean(ev[k]));
}

/**
 * 台账里有没有“这一片已确认”的记录。
 * 台账结论不绑分片，按 claim 中是否出现分片 id 或派单 id 匹配。
 */
function confirmedFor(ledger: readonly LedgerEntry[], shard: string, dispatchIds: readonly string[]): LedgerEntry | null {
  for (const e of ledger) {
    if (String(e.verdict ?? "") !== "confirmed") continue;
    if (!evidenceComplete(e)) continue;
    const claim = String(e.claim ?? "");
    if (shard && claim.includes(shard)) return e;
    if (dispatchIds.some((id) => id && claim.includes(id))) return e;
  }
  return null;
}

/**
 * 当前连续失败次数。
 *
 * 起算点之前的失败不计（用户已消解）；中途有过一张 done 即清零，否则重派会一路
 * 累加到上限，把已经好过一次的节点按老账判成“反复失败”。
 */
function retryCount(rows: readonly Dispatch[], resetAtMs: number): number {
  let failures = 0;
  for (const d of rows) {
    if (d.status === "failed") {
      const ts = Date.parse(String(d.done_at ?? d.at ?? ""));
      if (Number.isFinite(ts) && ts < resetAtMs) continue;
      failures += 1;
    } else if (d.status === "done") {
      failures = 0;
    }
  }
  return failures;
}

/**
 * 该片重派计数的起算点。
 *
 * 口径与 loop.ts 的 `retryResetMs` 一致（`*` 与分片名两档取最大）。
 * 不共用那个函数是因为 loop 会 import 本模块，反向 import 会成环。
 */
function retryResetMs(state: TaskState | null, shard: string): number {
  const map = (state?.retry_resets ?? {}) as Record<string, string>;
  const pick = (k: string): number => {
    const t = Date.parse(map[k] ?? "");
    return Number.isFinite(t) ? t : 0;
  };
  return Math.max(pick("*"), pick(shard));
}

/** 在途状态：这些状态的节点在重载后仍要继续。 */
const LIVE_STATUS = new Set(["open", "claimed", "reported", "review"]);

/** 派生链键：链上第一张派单的 id。同一件事的重派单归到同一节点。 */
function chainKeyOf(d: Dispatch): string {
  return String((d as Dispatch & { lineage?: string }).lineage ?? d.id);
}

/**
 * 构建进度快照。
 *
 * @param gen 重载代次（由 {@link beginReload} 递增）。
 */
export function buildReloadSnapshot(root: string, policy: Policy, gen: number): ReloadSnapshot {
  const state = loadState(root);
  const rows = readDispatches(root);
  const ledger = readLedger(root);
  const events = readEvents(root);
  const directives = listDirectives(root);
  const qa = readJsonl<Record<string, unknown>>(inboxLoc.qa(root));

  /*
   * 需求原文由两部分组成：守卫 context（判据与禁止事项的来源），以及在途派单的正文。
   * 全部逐字保存。压缩只针对“过程”，不针对“要求”。
   */
  const requirements: ReloadRequirement[] = [];
  const ctx = policy.data.context;
  if (typeof ctx === "string" && ctx.trim()) requirements.push({ source: "policy.context", text: ctx });
  for (const d of rows) {
    if (!LIVE_STATUS.has(String(d.status ?? ""))) continue;
    requirements.push({ source: `派单 ${d.id}`, text: String(d.action ?? "") });
  }

  // 文件边界与禁止事项：从 env_notes 与 context 里逐行挑出约束句，保留原文，不改写。
  const boundaries: string[] = [];
  const summary = policy.data.env_notes?.summary;
  if (typeof summary === "string" && summary.trim()) boundaries.push(summary.trim());
  if (typeof ctx === "string") {
    for (const line of ctx.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      if (/禁止|不许|不得|不要|只改|只动|边界|范围：|别碰|红线/.test(t)) boundaries.push(t);
    }
  }

  /* 按派生链归并成节点：同一条链只算一个节点，状态取链上最后一单。 */
  const chains = new Map<string, Dispatch[]>();
  for (const d of rows) {
    const key = chainKeyOf(d);
    const list = chains.get(key) ?? [];
    list.push(d);
    chains.set(key, list);
  }
  const items: ReloadItem[] = [...chains].map(([key, chain]) => classifyItem(state, key, chain, ledger));

  // 只保留未消费的插话：已消费的已并入某一单，重复带入会使工作进程重做。
  const openDirectives: ReloadDirective[] = directives
    .filter((d) => !d.consumed)
    .map((d) => ({
      at: String(d.at ?? ""),
      text: String(d.text ?? ""),
      shard: String(d.shard ?? ""),
    }));

  // 未裁决提问：open 的 ask 全部保留（包括带 shard 的局部提问）。
  const asks: ReloadAsk[] = openInboxAsks(root).map((q) => ({
    id: String(q.id ?? ""),
    at: String(q.at ?? ""),
    text: String(q.text ?? ""),
    shard: String(q.shard ?? ""),
  }));

  // 决策结论：已回填的裁决与用户调度指令；一行一条、去重、最多 20 条，只留结论不留过程。
  const decisions: ReloadDecision[] = [];
  const seenDecision = new Set<string>();
  const addDecision = (at: string, kind: string, text: string): void => {
    const t = oneLine(text).slice(0, 240);
    if (!t || seenDecision.has(t)) return;
    seenDecision.add(t);
    decisions.push({ at, kind, text: t });
  };
  for (const q of qa) {
    if (String(q.type ?? "") !== "answer") continue;
    addDecision(String(q.at ?? ""), "answer", String(q.text ?? ""));
  }
  for (const e of events) {
    const kind = String(e.event ?? e.kind ?? "");
    if (kind === "supervisor_instruct") addDecision(String(e.at ?? ""), "instruct", String(e.text ?? ""));
  }
  decisions.splice(20);

  const retries: Record<string, number> = {};
  for (const it of items) retries[it.key] = it.retries;

  /* 派单台账行序即下发顺序：dispatch_order 只收在途单；resume_order 按首次下发行序排。 */
  const dispatchOrder: ReloadOrderEntry[] = rows
    .filter((d) => LIVE_STATUS.has(String(d.status ?? "")))
    .map((d) => ({
      id: String(d.id ?? ""),
      shard: String(d.shard ?? ""),
      status: String(d.status ?? ""),
      at: String(d.at ?? ""),
    }));
  const resumeOrder: string[] = [];
  const seenResume = new Set<string>();
  for (const d of rows) {
    const key = chainKeyOf(d);
    if (seenResume.has(key)) continue;
    const item = items.find((i) => i.key === key);
    // 只排“重开后要继续”的节点；已完成的不占恢复次序。
    if (!item || item.state === "done_verified") continue;
    seenResume.add(key);
    resumeOrder.push(key);
  }
  for (const it of items) {
    if (it.state === "done_verified" || seenResume.has(it.key)) continue;
    seenResume.add(it.key);
    resumeOrder.push(it.key);
  }

  const dropped = events.filter((e) => isNoiseEvent(e, items)).length;
  const beforeChars =
    fileChars(ledgerLoc.events(root)) +
    fileChars(inboxLoc.dispatch(root)) +
    fileChars(ledgerLoc.direct(root)) +
    fileChars(inboxLoc.qa(root));

  const doneVerified = items.filter((i) => i.state === "done_verified").length;
  const doneUnverified = items.filter((i) => i.state === "done_unverified").length;

  return {
    version: 1,
    gen,
    at: new Date().toISOString(),
    at_ts: Date.now() / 1000,
    target: String(state?.target ?? ""),
    policy: policy.name,
    next_action: String(state?.next_action ?? ""),
    requirements,
    items,
    directives: openDirectives,
    asks,
    decisions,
    boundaries: [...new Set(boundaries)].slice(0, 60),
    retries,
    dispatch_order: dispatchOrder,
    resume_order: resumeOrder,
    metrics: {
      before_chars: beforeChars,
      // after_chars 由 buildReloadContext 填；这里先给 0，落盘前会被覆盖。
      after_chars: 0,
      events_total: events.length,
      events_dropped: dropped,
      events_kept: events.length - dropped,
      items: items.length,
      done_verified: doneVerified,
      done_unverified: doneUnverified,
      unfinished: items.length - doneVerified - doneUnverified,
      directives: openDirectives.length,
      asks: asks.length,
    },
  };
}

/**
 * 判定一个节点的状态。
 * 顺序即优先级：在途 > 失败 > 报完成待确认 > done（有证据）> done（无证据）> 未开始。
 * “done 但无证据”是复验的输入，不落成 done_verified。
 */
function classifyItem(
  state: TaskState | null,
  key: string,
  chain: readonly Dispatch[],
  ledger: readonly LedgerEntry[],
): ReloadItem {
  const business = chain.filter((d) => d.source !== "reverify");
  const resetAt = retryResetMs(state, String(chain[chain.length - 1]?.shard ?? ""));
  const failures = retryCount(business, resetAt);
  /* 重派计数取最大 attempt - 1：failed 行只记录过程，重派次数按派单下发回数计。 */
  const maxAttempt = business.reduce((n, d) => Math.max(n, Number(d.attempt ?? 1)), 1);
  const retries = Math.max(0, maxAttempt - 1);

  const refs: ReloadDispatchRef[] = chain.map((d) => ({
    id: String(d.id ?? ""),
    status: String(d.status ?? ""),
    attempt: Number(d.attempt ?? 1),
    at: String(d.at ?? ""),
    note: clipText(oneLine(String(d.review_note ?? d.note ?? "")), 160),
    reverify: d.source === "reverify",
  }));

  const dispatchIds = business.map((d) => String(d.id ?? ""));
  const last = business[business.length - 1];
  const live = business.find((d) => d.status === "open" || d.status === "claimed");

  const base = {
    key,
    title: oneLine(
      (last as (Dispatch & { title?: string }) | undefined)?.title || String(last?.action ?? "").slice(0, 40) || key,
    ),
    action: clipText(String(last?.action ?? ""), 4000),
    retries,
    failures,
    dispatches: refs,
  };

  if (live) {
    return { ...base, state: "in_progress", why: `派单 ${live.id} 处于 ${live.status}` };
  }
  if (!last) {
    return { ...base, state: "not_started", why: "没有任何派单记录" };
  }
  if (last.status === "failed") {
    return { ...base, state: "failed", why: `最后一单 ${last.id} 失败：${oneLine(String(last.note ?? "")) || "无说明"}` };
  }

  /*
   * 复验单的结局优先于业务单状态：在途判未验证，已结束判已验证。
   * 判定须放在 `review` 之前，否则每次重载都会把已结束的节点重新判成未验证、重复派复验。
   */
  const reverifies = chain.filter((d) => d.source === "reverify");
  const liveReverify = reverifies.find((d) => d.status === "open" || d.status === "claimed" || d.status === "review");
  if (liveReverify) {
    return { ...base, state: "done_unverified", why: `复验单 ${liveReverify.id} 在途（${liveReverify.status}）` };
  }
  const doneReverify = reverifies.filter((d) => d.status === "done").pop();
  if (doneReverify) {
    return {
      ...base,
      state: "done_verified",
      why: `复验单 ${doneReverify.id} 已结束`,
      verified_by: String(doneReverify.id),
      verified_at: String(doneReverify.done_at ?? doneReverify.at ?? ""),
    };
  }

  if (last.status === "review") {
    return { ...base, state: "done_unverified", why: `已报完成但仍在待确认（${last.id}），没有裁决结论` };
  }
  if (last.status === "done") {
    const hit = confirmedFor(ledger, String(last.shard ?? ""), dispatchIds);
    if (hit) {
      return {
        ...base,
        state: "done_verified",
        why: `证据台账 ${String(hit.id ?? "")} 已 confirmed（四项证据齐全）`,
        verified_by: String(hit.id ?? ""),
        verified_at: String(hit.at ?? ""),
      };
    }
    return { ...base, state: "done_unverified", why: `已结束（${last.id}），但证据台账中没有对应的已确认记录` };
  }
  // open 或其他：此处只接收非在途状态
  return { ...base, state: "in_progress", why: `状态 ${last.status}` };
}

/** 噪音判定：见 {@link NOISE_EVENT} 与 {@link DETAIL_EVENT} 的说明。 */
function isNoiseEvent(e: Record<string, unknown>, items: readonly ReloadItem[]): boolean {
  const kind = String(e.event ?? e.kind ?? "");
  if (NOISE_EVENT.test(kind)) return true;
  if (DETAIL_EVENT.test(kind)) {
    // 已完成的单的明细是重复信息：摘要已在 items 里。
    const dispatch = String(e.dispatch ?? "");
    const owned = items.find((i) => i.dispatches.some((d) => d.id === dispatch));
    return Boolean(owned && (owned.state === "done_verified" || owned.state === "done_unverified"));
  }
  return false;
}

export interface ReloadContextResult {
  text: string;
  chars: number;
}

/**
 * 把快照压缩为一段可进提示词的简报。
 * 丢弃心跳、`supervisor_tick`、已完成条目的详情与 `tool` 类流水；保留需求原文、未完成项、决策结论、待复验清单与文件边界。
 * 已完成条目只留标题与依据。
 */
export function buildReloadContext(snap: ReloadSnapshot): ReloadContextResult {
  const L: string[] = [];
  L.push(`# 监工重载简报（gen ${snap.gen}）`);
  L.push(`生成于 ${snap.at}｜目标：${snap.target}｜守卫：${snap.policy}`);
  L.push(`下一步：${oneLine(snap.next_action) || "（空）"}`);
  L.push("");

  /* 守卫文件可能数日未更新。简报标明新鲜度，并声明冲突时以派单台账为准。 */
  const fresh = snap.policy_freshness;
  if (fresh?.stale) {
    L.push(
      `守卫文件已 ${fresh.age_hours} 小时未更新（最后修改 ` +
        `${String(fresh.mtime).slice(0, 16).replace("T", " ")}）。`,
    );
    L.push("      下面的边界与判据可能已经过期。执行前先确认其是否为当前有效口径；");
    L.push("      若已过期，应先更新守卫文件，勿依据旧口径执行。");
    L.push("");
  }
  L.push("## 需求原文（逐字保留，非待办清单）");
  L.push(
    "> 这些是在途派单与守卫上下文里的原文，可能早于今天的插话（本份简报生成于 " +
      String(snap.at ?? "").slice(0, 16).replace("T", " ") +
      "）。",
  );
  L.push("> 当前任务以派单台账为准。若与下方“未完成”一节冲突，以派单为准；");
  L.push("> 台账里 done / closed 的派单是历史，不要依据它们恢复任何实现。");
  L.push("");
  if (snap.requirements.length === 0) L.push("（无）");
  for (const r of snap.requirements) {
    L.push(`【${r.source}】`);
    L.push(r.text.trim());
    L.push("");
  }

  if (snap.boundaries.length) {
    L.push("## 文件边界与禁止事项（原文）");
    for (const b of snap.boundaries) L.push(`- ${b}`);
    L.push("");
  }

  const unfinished = snap.items.filter((i) => i.state !== "done_verified" && i.state !== "done_unverified");
  L.push("## 未完成（重载后继续，不重复已完成的工作）");
  if (unfinished.length === 0) L.push("（无）");
  for (const i of unfinished) {
    const fail = i.failures > 0 ? `｜连续失败 ${i.failures} 次` : "";
    L.push(`- [${i.state}] ${i.title}：${clipText(i.why, 120)}${fail}｜原要求（历史）：${clipText(oneLine(i.action), 300)}`);
  }
  L.push("");

  const reverify = snap.items.filter((i) => i.state === "done_unverified");
  L.push("## 待复验（已做但未验证，重载后必须派复验，不得视为完成）");
  if (reverify.length === 0) L.push("（无）");
  for (const i of reverify) L.push(`- ${i.title}：${i.why}`);
  L.push("");

  const done = snap.items.filter((i) => i.state === "done_verified");
  L.push("## 已完成（不重派；只留标题与依据）");
  if (done.length === 0) L.push("（无）");
  for (const i of done) L.push(`- ${i.title}（${clipText(i.why, 100)}）`);
  L.push("");

  L.push("## 用户未处理的插话（原话，依原话执行）");
  if (snap.directives.length === 0) L.push("（无）");
  for (const d of snap.directives) L.push(`- ${d.shard ? `[${d.shard}] ` : ""}${d.text}`);
  L.push("");

  L.push("## 未裁决提问（待用户回填，不自行裁决）");
  if (snap.asks.length === 0) L.push("（无）");
  /* 提问编号用“问N”：`#N` 保留给任务编号（`thread-no.json`），避免与任务号混淆。 */
  for (const a of snap.asks) L.push(`- 问${a.id} ${a.shard ? `[${a.shard}] ` : ""}${a.text}`);
  L.push("");

  L.push("## 决策结论");
  if (snap.decisions.length === 0) L.push("（无）");
  for (const d of snap.decisions) L.push(`- (${d.kind}) ${d.text}`);
  L.push("");

  const retried = Object.entries(snap.retries).filter(([, n]) => n > 0);
  L.push("## 重派计数");
  if (retried.length === 0) L.push("（无）");
  for (const [k, n] of retried) L.push(`- ${k}: 重派 ${n} 次`);

  const text = L.join("\n");
  return { text, chars: text.length };
}

/** 由快照得出恢复计划。 */
export function buildResumePlan(snap: ReloadSnapshot): ResumePlan {
  const skip: ResumePlan["skip"] = [];
  const reverify: ResumeReverifyItem[] = [];
  const pending: ResumePlan["pending"] = [];
  const state: Record<string, ResumeItemState> = {};

  /* 恢复顺序按 `snap.resume_order` 的原始下发顺序，不按任务编号；编号是身份，不代表次序。 */
  const orderOf = (key: string): number => {
    const at = snap.resume_order.indexOf(key);
    return at >= 0 ? at : Number.MAX_SAFE_INTEGER;
  };

  for (const i of snap.items) {
    if (i.state === "done_verified") {
      skip.push({ key: i.key, title: i.title, why: i.why });
    } else if (i.state === "done_unverified") {
      reverify.push({ key: i.key, title: i.title, action: i.action, why: i.why });
      state[i.key] = { state: "pending" };
    } else {
      pending.push({ key: i.key, state: i.state });
    }
  }

  /*
   * 依次恢复：reverify / pending 都按原始下发顺序重排（稳定排序，同序不换位）。
   * applyResumePlan 按数组顺序建复验单，重开调度时因此先恢复最早下发的单。
   */
  const byOrder = <T extends { key: string }>(list: T[]): T[] =>
    list
      .map((item, idx) => ({ item, idx }))
      .sort((a, b) => orderOf(a.item.key) - orderOf(b.item.key) || a.idx - b.idx)
      .map((x) => x.item);

  return {
    gen: snap.gen,
    at: new Date().toISOString(),
    skip,
    reverify: byOrder(reverify),
    pending: byOrder(pending),
    state,
  };
}

/** 读恢复计划；没有重载过时返回 null。 */
export function readResumePlan(root: string): ResumePlan | null {
  const p = readJson<ResumePlan | null>(resumePath(root), null);
  return p && Array.isArray(p.reverify) ? p : null;
}

/** 复验单正文须写明“复验不是重做”，避免工作进程按原要求重新实现、改回已通过的实现。 */
function reverifyAction(item: ResumeReverifyItem): string {
  return [
    `复验（不是重做）：${item.title}`,
    `上一轮已报完成，但缺少可核对的确认（${item.why}），不得直接视为完成。`,
    "执行以下三项：1) 按下方原要求逐条核对是否达成；2) 每条附上证据（命令输出、产出物位置、截图路径），并以 capitalist ledger add 入账结论；",
    "3) 核对成立的，在回报中注明“已验证”，不重写已通过部分，不改动其他分片的作用对象；核对不成立的，逐条列明缺失项。",
    `原要求：${clipText(oneLine(item.action), 1200)}`,
  ].join("\n");
}

/**
 * 应用恢复计划：为“已做但未验证”的节点补派复验单。
 * 幂等：同一节点已有在途复验单时不再新建；复验单 done 后节点标 verified。
 *
 * @returns 新建的复验单数量。
 */
export function applyResumePlan(root: string, out: (s: string) => void): number {
  const plan = readResumePlan(root);
  if (!plan || plan.reverify.length === 0) return 0;

  const rows = readDispatches(root);
  let made = 0;
  /* 落盘去重：每轮都调用，内容未变时不重写。 */
  const before = JSON.stringify(plan);

  for (const item of plan.reverify) {
    const st: ResumeItemState = plan.state[item.key] ?? { state: "pending" };
    plan.state[item.key] = st;
    if (st.state === "verified") continue;

    if (st.verify_dispatch) {
      const d = rows.find((r) => r.id === st.verify_dispatch);
      if (!d) {
        // 派单已被归档或清理时允许重新下发。
        delete st.verify_dispatch;
        st.state = "pending";
      } else if (d.status === "done") {
        st.state = "verified";
        st.verified_by = d.id;
        st.verified_at = String(d.done_at ?? d.at ?? "");
        recordEvent(root, "reverify_confirmed", {
          item: item.key,
          dispatch: d.id,
          gen: plan.gen,
        });
        out(`[监工] 复验成立：${item.key}（${d.id}）`);
        continue;
      } else if (d.status === "failed") {
        delete st.verify_dispatch;
        st.state = "pending";
      } else {
        /* open / claimed / review：仍在处理中，不重复派单。 */
        continue;
      }
    }

    // 进程重启后，同一节点已有在途复验单即复用，不重复派。
    const live = rows.find(
      (r) =>
        r.source === "reverify" &&
        String((r as Dispatch & { lineage?: string }).lineage ?? "") === item.key &&
        (r.status === "open" || r.status === "claimed" || r.status === "review"),
    );
    if (live) {
      st.verify_dispatch = live.id;
      st.state = "verifying";
      continue;
    }

    const id = newDispatchId(root);
    /* title 是派单上的扩展字段（见 newDispatch.ts 的 ComposedDispatch）：核心 Dispatch 不带它，
       但界面按它显示任务名，因此一并写入。 */
    const d = composeDispatch({
      id,
      title: `复验：${clipText(item.title, 40)}`,
      action: reverifyAction(item),
      source: "reverify",
      attempt: 1,
      /*
       * 复验单挂在被复验的那条链上：快照按派生链归并节点，自成一条链的复验单
       * 不会回到原节点，下一轮重载又会把原节点判成未验证并重复派单。
       */
      lineage: item.key,
      note: `第 ${plan.gen} 次重载派出的复验单：${item.why}`,
    });
    appendDispatch(root, d);
    recordEvent(root, "dispatch_reverify", {
      dispatch: id,
      item: item.key,
      gen: plan.gen,
    });
    st.verify_dispatch = id;
    st.state = "verifying";
    made += 1;
    out(`[监工] 重载后复验：${item.key}，派单 ${id}（不重做，只核对并给证据）`);
  }

  if (plan.applied_at === undefined) plan.applied_at = new Date().toISOString();
  if (JSON.stringify(plan) !== before) writeJson(resumePath(root), plan);
  return made;
}

/*
 * 监工对话上下文读数由 board 从 stream-json result 行提取，落到 `.capitalist/reload/capitalist-ctx.json`。
 * 看板与主循环分属不同进程，判据经磁盘共享；主循环每轮读取，超阈值即触发重载。
 */

/** 上下文已用占生效上限的比例达到该值即自动重载。 */
export const CAPITALIST_CTX_RELOAD_RATIO = 0.85;
/** 已用量低于该值不触发重载，避免短会话误判。 */
const CAPITALIST_CTX_MIN_USED = 60_000;

/**
 * 判为宿主侧压缩的降幅：后一次读数不超过前一次的一半。
 * 宿主 stream-json 不报压缩事件，只能按读数回落幅度推断；上下文大幅回落只发生在压缩或换会话时。
 */
export const CTX_COMPACT_DROP_RATIO = 0.5;

/**
 * 相邻两次上下文读数是否构成一次压缩。
 * 调用方校验同一会话与读数口径，本函数只判数值：空读数与非正数不算压缩。
 */
export function ctxDropIsCompaction(
  before: number | null | undefined,
  after: number | null | undefined,
): boolean {
  const b = Number(before);
  const a = Number(after);
  if (!Number.isFinite(b) || !Number.isFinite(a) || b <= 0 || a <= 0) return false;
  return a <= b * CTX_COMPACT_DROP_RATIO;
}

function supervisorCtxPath(root: string): string {
  return join(reloadDir(root), "capitalist-ctx.json");
}

/** 监工对话上下文的最近一次读数。 */
export interface SupervisorContextRecord {
  /** 上下文已用 token */
  used: number;
  /** 上下文窗口 token（宿主没报时为 0） */
  window: number;
  /** used / window（window 缺失时为 0） */
  ratio: number;
  at: string;
  /** 这条读数属于哪一代监工会话；重载换代后旧读数不能再当判据。 */
  gen: number;
  /** 读数的模型名（宿主 modelUsage 的键）；没报时为空。 */
  model: string;
  /** 已用是否为估算值：宿主没有 contextUsed 时按会话消息文本折算 */
  estimate: boolean;
}

/**
 * 按宿主会话记录估算监工对话的上下文已用 token。
 * 宿主 stream-json 不报 contextUsed；会话记录（`<配置目录>/projects/<项目>/<会话 id>.jsonl`）存有本会话全部消息与工具结果，
 * 按与工作进程同一条 {@link estimateContextTokens} 折算：中文 3 字符/token、其余 4 字符/token。
 * 无可估算记录时返回 null，由调用方按“未上报”处理。
 */
interface SessionEstimate {
  size: number;
  mtime_ms: number;
  tokens: number;
}

const sessionEstCache = new Map<string, SessionEstimate>();

/** 在宿主配置目录的 projects/* 下找该会话最新的一份记录。 */
function hostSessionFile(sessionId: string): string {
  let best = "";
  let bestMtime = -1;
  for (const d of dirs()) {
    const base = join(homedir(), d.dir, "projects");
    if (!existsSync(base)) continue;
    let projects: string[] = [];
    try {
      projects = readdirSync(base, { withFileTypes: true })
        .filter((x) => x.isDirectory())
        .map((x) => x.name);
    } catch {
      continue;
    }
    for (const p of projects) {
      const file = join(base, p, `${sessionId}.jsonl`);
      try {
        const st = statSync(file);
        if (st.isFile() && st.mtimeMs >= bestMtime) {
          best = file;
          bestMtime = st.mtimeMs;
        }
      } catch {
        /* 该目录没有这一代会话：继续找 */
      }
    }
  }
  return best;
}

export function estimateSessionContextTokens(sessionId: string): number | null {
  const id = String(sessionId || "").trim();
  if (!id) return null;
  const file = hostSessionFile(id);
  if (!file) return null;
  let size = 0;
  let mtime = 0;
  try {
    const st = statSync(file);
    size = st.size;
    mtime = st.mtimeMs;
  } catch {
    return null;
  }
  const cached = sessionEstCache.get(file);
  if (cached && cached.size === size && cached.mtime_ms === mtime) return cached.tokens || null;
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const acc = newTextTally();
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      if (o && o.type === "message") tallyMessage(acc, o);
    } catch {
      /* 末尾半行跳过，避免解析不完整记录 */
    }
  }
  const tokens = estimateContextTokens(acc);
  if (sessionEstCache.size > 32) sessionEstCache.clear();
  sessionEstCache.set(file, { size, mtime_ms: mtime, tokens });
  return tokens > 0 ? tokens : null;
}

/** 当前监工对话会话的代次（session.json 的 gen）。 */
function currentSupervisorGen(root: string): number {
  const sess = readSessionRecord(root);
  return Math.max(0, Number(sess?.gen ?? 0));
}

/**
 * 记录监工对话上下文的最近一次读数（board 在每轮 capitalist-chat 结束后调用）。
 * 读数缺失（used <= 0）时不写，与 usage.ts 口径一致。`estimate` 标记估算口径：宿主未报 contextUsed 时由
 * {@link estimateSessionContextTokens} 估算，界面加 `≈`；宿主真读数一律 false。
 */
export function recordSupervisorContext(
  root: string,
  used: number,
  window: number,
  model = "",
  estimate = false,
): SupervisorContextRecord | null {
  const u = Number(used);
  if (!Number.isFinite(u) || u <= 0) return null;
  /* 压缩无事件可依，按相邻两次读数比较；须同代、同口径。换代归 reload 事件，估算与真读数互换不构成压缩。 */
  const prev = readSupervisorContext(root);
  /* 窗口在落盘前按默认表校正，避免各调用方重复换算；宿主对未收录模型只报 300k 占位值。 */
  const w = resolveContextWindow(String(model || "").trim(), Number(window)) ?? 0;
  const rec: SupervisorContextRecord = {
    used: Math.round(u),
    window: Math.round(w),
    ratio: w > 0 ? u / w : 0,
    at: new Date().toISOString(),
    gen: currentSupervisorGen(root),
    model: String(model || "").trim(),
    estimate: Boolean(estimate),
  };
  try {
    mkdirSync(reloadDir(root), { recursive: true });
    writeJson(supervisorCtxPath(root), rec);
  } catch {
    return rec;
  }
  if (
    prev &&
    prev.gen === rec.gen &&
    prev.estimate === rec.estimate &&
    ctxDropIsCompaction(prev.used, rec.used)
  ) {
    /* 来源 inferred 表示按读数降幅推断，与 reload 区分；窗口缺失时才扫描日志借用其他读数。 */
    const limitWindow = rec.window > 0 ? rec.window : supervisorContextModelWindow(root, rec);
    recordEvent(root, "context_compacted", {
      scope: "capitalist",
      session: reloadSessionId(root),
      before_used: prev.used,
      after_used: rec.used,
      limit: effectiveSupervisorContextLimit(supervisorContextConfigLimit(root), limitWindow),
      source: "inferred",
      gen: rec.gen,
    });
  }
  return rec;
}

/** 读监工对话上下文的最近一次读数；没有就 null。 */
export function readSupervisorContext(root: string): SupervisorContextRecord | null {
  const r = readJson<SupervisorContextRecord | null>(supervisorCtxPath(root), null);
  if (!r || !Number.isFinite(Number(r.used)) || Number(r.used) <= 0) return null;
  return {
    used: Math.round(Number(r.used)),
    window: Number.isFinite(Number(r.window)) && Number(r.window) > 0 ? Math.round(Number(r.window)) : 0,
    ratio: Number.isFinite(Number(r.ratio)) ? Number(r.ratio) : 0,
    at: String(r.at ?? ""),
    gen: Number.isFinite(Number(r.gen)) ? Number(r.gen) : 0,
    model: String(r.model ?? ""),
    estimate: Boolean(r.estimate),
  };
}

/**
 * 监工配置的上下文上限（supervisor.json 的 `supervisor_context_limit`）。
 *
 * 未配置时取 {@link DEFAULT_SUPERVISOR_CONTEXT_LIMIT}；显式写 0 表示“只按模型窗口”。
 * 返回值 0 就是“没有配置上限”。
 */
export function supervisorContextConfigLimit(root: string): number {
  const raw = loadSupervisor(root)?.supervisor_context_limit;
  if (raw === undefined || raw === null) return DEFAULT_SUPERVISOR_CONTEXT_LIMIT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** 当前监工对话的模型：`--capitalist-model` 显式配置 > 读数自报模型 > 最近一个工作进程的模型（宿主默认锚点）。 */
export function supervisorContextModel(root: string, rec: SupervisorContextRecord | null = readSupervisorContext(root)): string {
  const configured = String(loadSupervisor(root)?.supervisor_model ?? "").trim();
  if (configured) return configured;
  if (rec?.model) return rec.model;
  const rows = listWorkers(root).sort((a, b) =>
    String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")),
  );
  for (const w of rows) {
    const u = workerUsageRow(w);
    if (u.model) return u.model;
  }
  return "";
}

/**
 * 当前模型的上下文窗口（生效值，经 {@link resolveContextWindow}）。
 * 取窗口的顺序：监工读数、同模型工作进程读数、默认表；均不可用时返回 0，界面只显示已用。
 * 工作进程读数的 `context_window` 已在 usage.ts 校正；`capitalist-ctx.json` 可能存有升级前的宿主原值 300k，这里再校正一次。
 */
export function supervisorContextModelWindow(
  root: string,
  rec: SupervisorContextRecord | null = readSupervisorContext(root),
  model = supervisorContextModel(root, rec),
): number {
  const modelRows = listWorkers(root)
    .map((w) => workerUsageRow(w))
    .filter((r) => r.context_window !== null && r.context_window > 0);
  if (model) {
    const same = modelRows.find((r) => r.model === model);
    if (same?.context_window) return same.context_window;
  }
  if (rec?.window && (!rec.model || !model || rec.model === model)) {
    return resolveContextWindow(model || rec.model, rec.window) ?? 0;
  }
  if (model) return resolveContextWindow(model, null) ?? 0;
  /* 模型未知：取最近有窗口读数的那一行（宿主默认模型的代理）。 */
  return modelRows[0]?.context_window ?? 0;
}

/** 生效上限 = min(配置值, 模型实际上限)；两者都缺时为 0，界面只显示已用。 */
export function effectiveSupervisorContextLimit(configLimit: number, modelWindow: number, chosen?: number | null): number {
  /* 面板显式选择的窗口优先采用，不再与模型窗口取小；宿主对未收录模型只报 300000，取小会压低选定值。 */
  const pick = Number(chosen);
  if (Number.isFinite(pick) && pick > 0) return Math.round(pick);
  const cfg = Number.isFinite(configLimit) && configLimit > 0 ? Math.round(configLimit) : 0;
  const win = Number.isFinite(modelWindow) && modelWindow > 0 ? Math.round(modelWindow) : 0;
  if (cfg > 0 && win > 0) return Math.min(cfg, win);
  return cfg || win || 0;
}

/**
 * 看板中“监工上下文”一格的视图（GET /api/supervisor 的 `context`）。
 * 只反映监工自身对话的用量与上限，与工作进程的上下文分开；上限按 {@link effectiveSupervisorContextLimit} 算。
 * 重载换代后旧读数不作为当前值，显示为空并给出原因。
 */
export interface SupervisorContextView {
  used: number | null;
  /** 已用是否为估算值（界面加 `≈`） */
  estimate: boolean;
  /** 已用是否超过生效上限（`used` 已夹到 `limit`） */
  over: boolean;
  /** 模型窗口（原始读数；没有为 null） */
  window: number | null;
  /** 生效上限：min(配置, 模型窗口) */
  limit: number | null;
  /** 监工配置值（0 = 未配置，只按模型窗口） */
  config_limit: number;
  ratio: number | null;
  threshold: number;
  model: string;
  at: string;
  source: "supervisor_session" | "none";
  reason: string;
}

export function buildSupervisorContextView(root: string): SupervisorContextView {
  const rec = readSupervisorContext(root);
  const gen = currentSupervisorGen(root);
  const configLimit = supervisorContextConfigLimit(root);
  const model = supervisorContextModel(root, rec);
  const window = supervisorContextModelWindow(root, rec, model);
  const limit = effectiveSupervisorContextLimit(configLimit, window, readCtxWindowChosen(root, "supervisor"));
  const fresh = Boolean(rec && rec.gen === gen);
  const rawUsed = fresh ? rec?.used ?? null : null;
  /* 已用夹到生效上限，避免估算值超出窗口显示为“1.2M / 600k”；夹取后保留 `over` 供界面标超限。 */
  const over = rawUsed !== null && limit > 0 && rawUsed > limit;
  const used = rawUsed !== null && limit > 0 ? Math.min(rawUsed, limit) : rawUsed;
  const ratio = used !== null && limit > 0 ? used / limit : null;
  let reason = "";
  if (!rec) reason = "尚未与监工对话过：没有会话上下文读数";
  else if (!fresh) reason = "上下文刚优化过，等待新会话的读数";
  else if (!limit) reason = "没有可用的上下文上限（模型未上报窗口，也没有配置）";
  return {
    used,
    estimate: Boolean(fresh && rec?.estimate),
    over,
    window: window > 0 ? window : null,
    limit: limit > 0 ? limit : null,
    config_limit: configLimit,
    ratio,
    threshold: CAPITALIST_CTX_RELOAD_RATIO,
    model,
    at: fresh ? rec?.at ?? "" : "",
    source: fresh ? "supervisor_session" : "none",
    reason,
  };
}

/** 自动重载的判定结果。 */
export interface SupervisorCtxCheck {
  hit: boolean;
  reason: string;
  record: SupervisorContextRecord | null;
}

/**
 * 是否应该自动重载。
 * 四个条件同时成立才算超限：有真实读数、读数属于当前会话代次、占比达到 {@link CAPITALIST_CTX_RELOAD_RATIO}
 * （分母为 min(配置, 模型窗口)）、已用量不低于 {@link CAPITALIST_CTX_MIN_USED}；已有重载进行中不重复触发。
 * 读数须属于当前代次：重载只换会话 id，不清上一代读数，不校验代次会在重载后按旧读数再次触发。
 */
export function shouldAutoReload(root: string): SupervisorCtxCheck {
  const rec = readSupervisorContext(root);
  if (!rec) return { hit: false, reason: "没有上下文读数", record: null };
  if (reloadStatus(root).active) return { hit: false, reason: "重载已在进行中", record: rec };
  const gen = currentSupervisorGen(root);
  if (rec.gen !== gen) {
    return { hit: false, reason: `读数是第 ${rec.gen} 代会话的，当前已是第 ${gen} 代`, record: rec };
  }
  if (rec.used < CAPITALIST_CTX_MIN_USED) {
    return { hit: false, reason: `已用 ${rec.used} token，未达下限 ${CAPITALIST_CTX_MIN_USED}`, record: rec };
  }
  const configLimit = supervisorContextConfigLimit(root);
  const window = supervisorContextModelWindow(root, rec);
  const limit = effectiveSupervisorContextLimit(configLimit, window, readCtxWindowChosen(root, "supervisor"));
  if (!limit) {
    return { hit: false, reason: "没有可用的上下文上限（模型未上报窗口，也没有配置）", record: rec };
  }
  /* 分母与显示同源；已用夹到上限，超限时占比按 100% 算，理由里不写超过分母的读数。 */
  const used = Math.min(rec.used, limit);
  const ratio = used / limit;
  if (ratio < CAPITALIST_CTX_RELOAD_RATIO) {
    return {
      hit: false,
      reason: `占比 ${(ratio * 100).toFixed(1)}%，未达阈值 ${(CAPITALIST_CTX_RELOAD_RATIO * 100).toFixed(0)}%（上限 ${limit} token）`,
      record: rec,
    };
  }
  return {
    hit: true,
    reason:
      `上下文已用 ${used} token / 上限 ${limit} token` +
      `（配置 ${configLimit || "未配置"}｜模型 ${window || "未上报"}，占比 ${(ratio * 100).toFixed(1)}%）`,
    record: rec,
  };
}

/** 读重载状态。过期标记（因进程中途退出而残留）会被清除，避免看板持续显示“重载中”。 */
export function reloadStatus(root: string): ReloadStatus {
  const sess = readJson<SessionRecord | null>(sessionPath(root), null);
  const gen = Number(sess?.gen ?? 0);
  const marker = readJson<ActiveMarker | null>(activePath(root), null);
  if (!marker) {
    return { active: false, phase: "idle", gen, started_at: "", age_sec: 0, trigger: "" };
  }
  const started = String(marker.started_at ?? "");
  const phase = String(marker.phase ?? "snapshot");
  /* `done` 表示重载已完成、仅收尾删标记失败，按已结束处理，否则看板会持续显示“上下文优化中”。 */
  if (phase === "done") {
    return { active: false, phase: "done", gen: Number(marker.gen ?? gen), started_at: started, age_sec: 0, trigger: "" };
  }
  const ts = Number(marker.at_ts ?? 0) * 1000;
  const ageMs = Number.isFinite(ts) && ts > 0 ? Date.now() - ts : RELOAD_STALE_MS + 1;
  if (ageMs > RELOAD_STALE_MS) {
    try {
      rmSync(activePath(root), { force: true });
    } catch {
      /* 删除失败时保留标记，由下一次读取重试删除 */
    }
    recordEvent(root, "supervisor_reload_stale", { gen: marker.gen, phase: marker.phase, age_sec: Math.round(ageMs / 1000) });
    return { active: false, phase: "stale", gen, started_at: started, age_sec: Math.round(ageMs / 1000), trigger: "" };
  }
  return {
    active: true,
    phase,
    gen: Number(marker.gen ?? gen),
    started_at: started,
    age_sec: Math.max(0, Math.round(ageMs / 1000)),
    trigger: String(marker.trigger ?? "manual"),
  };
}

/** 监工对话会话 id 的公共前缀。hook 按该前缀识别对话层会话，换代与重载后不变。 */
export const CHAT_SESSION_PREFIX = "capitalist-chat";

/** 会话 id 中的工作区标识。历史记录没有该标识时提取为空串。 */
const WORKSPACE_IN_ID = new RegExp(`^${CHAT_SESSION_PREFIX}-w([a-f0-9]{6,16})(?:-|$)`);

/** 生成工作区标识：8 位十六进制，可区分同一目录下的多次生命周期。 */
function freshWorkspace(): string {
  return randomBytes(4).toString("hex");
}

/**
 * 取会话记录所属的工作区标识。
 *
 * 优先读记录上的 `workspace`，其次从带标识的会话 id 还原；两处都没有（历史记录）
 * 返回空串，由调用方决定生成新标识还是沿用旧 id。
 */
function workspaceOf(sess: SessionRecord | null): string {
  const own = String(sess?.workspace ?? "").trim();
  if (/^[a-f0-9]{6,16}$/.test(own)) return own;
  return WORKSPACE_IN_ID.exec(String(sess?.session_id ?? "").trim())?.[1] ?? "";
}

/** 该工作区的基线会话 id。 */
function chatSessionBase(ws: string): string {
  return `${CHAT_SESSION_PREFIX}-w${ws}`;
}

/**
 * 读会话记录。
 *
 * 文件不存在时直接返回 null，不看读缓存：`readJson` 的缓存有效期 300ms 且只有写路径
 * 会使其失效，用户删掉 `.capitalist` 后立刻再读会取到上一轮的记录，把新工作区误判成
 * 旧工作区，续接本应丢弃的历史。存在性判断必须先于缓存。
 */
function readSessionRecord(root: string): SessionRecord | null {
  const file = sessionPath(root);
  if (!existsSync(file)) return null;
  return readJson<SessionRecord | null>(file, null);
}

/** 该工作区的第 `gen` 代会话，供超限换代与清空列表使用。 */
function chatSessionGen(ws: string, gen: number): string {
  return `${chatSessionBase(ws)}-c${gen}`;
}

/** 该工作区的第 `gen` 代重载会话。 */
function chatSessionReload(ws: string, gen: number): string {
  return `${chatSessionBase(ws)}-r${gen}`;
}

/**
 * 换到该工作区的下一代会话，并落盘 `session.json`。
 *
 * 三处调用（超限换代、完整重载、清空列表）共用本函数，会话 id 的构造口径只有一份。
 * 缺失工作区标识的历史记录在此补写新标识，旧会话 id 不再沿用，台账不受影响。
 *
 * `briefChars` 是写入新记录的简报长度，由调用方指定：换代沿用上一代的值，重载用压缩后的
 * 长度，清空列表写 0。本函数不做推断。
 */
export function rotateChatSession(
  root: string,
  kind: "gen" | "reload",
  briefChars = 0,
  at = new Date().toISOString(),
): SessionRecord {
  const prev = readSessionRecord(root);
  const ws = workspaceOf(prev) || freshWorkspace();
  const gen = Math.max(0, Number(prev?.gen ?? 0)) + 1;
  const rec: SessionRecord = {
    gen,
    session_id: kind === "reload" ? chatSessionReload(ws, gen) : chatSessionGen(ws, gen),
    at,
    brief_chars: Number.isFinite(briefChars) ? briefChars : 0,
    workspace: ws,
  };
  writeJson(sessionPath(root), rec);
  return rec;
}

/**
 * 落盘失败时本轮沿用的会话 id，按任务根记录。
 *
 * `session.json` 写不进去说明任务根不可写，此时每轮新建 id 会使对话层丢失全部历史。
 * 同一进程内复用同一 id，可能落在旧会话上；跨进程重新生成，该状态本身已属异常，
 * 不再为其维护额外状态。
 */
const unsavedSession = new Map<string, string>();

/**
 * 监工对话当前使用的会话 id。
 *
 * 有记录沿用记录上的 id；历史记录缺工作区标识时补写新标识，原有 id 不变，
 * 正在使用的任务根不因升级丢上下文。
 *
 * 无记录表示新的生命周期：`.capitalist` 已被删除，或该目录从未有过对话。此时生成
 * 新标识并立即落盘，与同一目录上一轮的会话记录不再重名。此前回退到固定的
 * `capitalist-chat`，与宿主库里上一轮同名记录重名，会把该目录历次对话的全部历史
 * 重新送进模型。
 */
export function reloadSessionId(root: string): string {
  const sess = readSessionRecord(root);
  const id = String(sess?.session_id ?? "").trim();
  if (id) {
    unsavedSession.delete(root);
    if (!workspaceOf(sess)) {
      /* 历史记录：只补标识，会话 id 与代次原样保留。 */
      const ws = freshWorkspace();
      try {
        writeJson(sessionPath(root), { ...sess, workspace: ws });
      } catch {
        /* 补写失败不影响本轮对话，下次再试 */
      }
    }
    return id;
  }

  const ws = freshWorkspace();
  const fresh = chatSessionBase(ws);
  try {
    writeJson(sessionPath(root), {
      gen: 0,
      session_id: fresh,
      at: new Date().toISOString(),
      brief_chars: 0,
      workspace: ws,
    });
    unsavedSession.delete(root);
  } catch {
    /* 写不进去也返回新 id：本轮用空会话，不回退到与旧记录重名的固定 id。 */
    const memo = unsavedSession.get(root);
    if (memo) return memo;
    unsavedSession.set(root, fresh);
  }
  recordEvent(root, "chat_session_new", { scope: "capitalist", session: fresh, workspace: ws, previous: "" });
  return fresh;
}

/**
 * 监工对话单轮注入的历史上限（token）。
 * 与自动重载（按上下文占比触发）并列：此处在每轮对话前按会话记录体量换代，超限即换新会话 id
 * （`capitalist-chat-w<ws>-c<gen>`），为下一轮注入量设定上界。换代只裁历史，不写快照、不动派单队列。
 * token 估算用 {@link estimateSessionContextTokens}（带 size/mtime 缓存）；估算不可用时按会话文件字节数判断。
 */
export const CAPITALIST_CHAT_TURN_TOKEN_CAP = 600_000;

/** 回落上限（字节）：token 估算不可用时按会话记录文件的字节数判断。 */
export const CAPITALIST_CHAT_TURN_CHAR_CAP = 600_000;

/** 生效上限：`.capitalist/ctx-window.json` 指定的窗口 × 0.8，余下两成留给模型输出。 */
function supervisorChatCapOf(root: string): number {
  const want = readCtxWindow(root, "supervisor");
  return Math.floor(want * 0.8);
}

/**
 * 监工对话单轮所用的会话 id。
 * 未超上限沿用当前会话（`reloadSessionId`）；超限则换代：gen + 1，写 `session.json`，
 * 落一条 `context_compacted` 事件（`source: "turn_cap"`），新会话从空上下文开始。
 * 换代只换会话 id，不写快照、不动派单队列；完整重载由 {@link beginReload} 负责。
 * 写盘失败时沿用旧会话并放弃裁剪。
 */
export function supervisorChatTurnSessionId(root: string): string {
  const id = reloadSessionId(root);
  const tokens = estimateSessionContextTokens(id);
  let chars = 0;
  const file = hostSessionFile(id);
  if (file) {
    try {
      chars = statSync(file).size;
    } catch {
      chars = 0;
    }
  }
  const cap = supervisorChatCapOf(root);
  const over = tokens !== null ? tokens > cap : chars > CAPITALIST_CHAT_TURN_CHAR_CAP;
  if (!over) return id;

  const prev = readSessionRecord(root);
  const gen = Math.max(0, Number(prev?.gen ?? 0)) + 1;
  /* 会话 id 由 rotateChatSession 统一构造，代次与工作区标识随其生成。 */
  let next = "";
  try {
    next = rotateChatSession(root, "gen", Number(prev?.brief_chars ?? 0)).session_id;
  } catch {
    return id;
  }
  recordEvent(root, "context_compacted", {
    scope: "capitalist",
    session: id,
    next_session: next,
    before_used: tokens ?? null,
    after_used: null,
    limit: tokens !== null ? cap : CAPITALIST_CHAT_TURN_CHAR_CAP,
    source: "turn_cap",
    trigger: "turn_cap",
    gen_from: Number(prev?.gen ?? 0),
    gen_to: gen,
  });
  return next;
}

/**
 * 严重异常事件允许清单：只有这一类进监工对话上下文，心跳与过程流水不进。
 * 采用显式登记而非默认放行：新增过程事件默认不进，须在此显式登记，避免漏配后心跳流水挤占上下文。
 */
const SEVERE_SUPERVISOR_EVENT =
  /^(worker_killed|worker_looping_killed|worker_gone|worker_launch_failed|dispatch_failed|redispatch_capped|dispatch_forced_finished|policy_error|policy_refused|policy_unstable|stuck_detected|stuck_killed|stuck_escalated|stalled|board_reload_blocked|duplicate_launch_refused|retry_refused)$/i;

/** 台账尾部窗口（字节）：严重异常摘要只从这里找，不全量解析台账。 */
const SEVERE_EVENT_TAIL_BYTES = 512_000;

/**
 * 从 JSONL 台账尾部读出可解析的记录行。
 *
 * 只读尾部一段：`events.jsonl` 随任务增长到几十 MB，取最近几条不需要全量解析。
 * 半行写入（进程在写一半时被终止）按坏行跳过，不让一条损坏数据影响整段上下文。
 *
 * @param maxBytes 尾部窗口上限，实际读取量不超过文件大小。
 */
function tailJsonRows(file: string, maxBytes: number): Array<Record<string, unknown>> {
  let buf = "";
  try {
    const size = statSync(file).size;
    const handle = openSync(file, "r");
    try {
      const want = Math.min(size, maxBytes);
      const b = Buffer.alloc(want);
      readSync(handle, b, 0, want, size - want);
      buf = b.toString("utf8");
    } finally {
      closeSync(handle);
    }
  } catch {
    return [];
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const line of buf.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      if (o && typeof o === "object") rows.push(o);
    } catch {
      /* 半行写入跳过，避免解析不完整记录 */
    }
  }
  return rows;
}

/** 从台账尾部取最近的严重异常，一行一条（时间正序，最多 {@link max} 条）；无严重异常时返回空数组。 */
export function severeSupervisorEventLines(root: string, max = 8): string[] {
  const rows = tailJsonRows(ledgerLoc.events(root), SEVERE_EVENT_TAIL_BYTES);
  const out: string[] = [];
  /* 事件名与说明完全相同的仅保留最近一条，以兼容旧台账中未经节流的批量重复；不同原因各占一行。 */
  const seen = new Set<string>();
  for (let i = rows.length - 1; i >= 0 && out.length < max; i -= 1) {
    const e = rows[i]!;
    const name = String(e.event ?? e.kind ?? "");
    if (!SEVERE_SUPERVISOR_EVENT.test(name)) continue;
    const who = String(e.dispatch ?? e.worker ?? "").trim();
    const detail = oneLine(
      String(e.text ?? e.reason ?? e.error ?? e.why ?? e.detail ?? e.note ?? ""),
    ).slice(0, 160);
    const dedupeKey = `${name}|${who}|${detail}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const at = String(e.at ?? "").slice(5, 16).replace("T", " ");
    /* `repeat` 记录节流写入累计的次数：连续发生 N 次仅落一条，此处按原值标注。 */
    const rep = Number(e.repeat ?? 0);
    const times = Number.isFinite(rep) && rep > 1 ? ` ×${rep}` : "";
    out.push(`- ${at} ${EVENT_ZH[name] ?? name}${who ? `（${who}）` : ""}${detail ? `：${detail}` : ""}${times}`);
  }
  return out.reverse();
}

/**
 * 把用户最近几条指令原文写入监工上下文。
 * 只取 `supervisor_chat_ask` 且 from=user 的指令，压缩为一行、截断，最多 {@link max} 条；附件行不进本段，路径由截图段单独给出。
 */
export function recentUserLines(root: string, max = 6): string[] {
  const rows = tailJsonRows(ledgerLoc.events(root), 262_144);
  const out: string[] = [];
  for (let i = rows.length - 1; i >= 0 && out.length < max; i -= 1) {
    const e = rows[i]!;
    const name = String(e.event ?? e.kind ?? "");
    if (name !== "supervisor_chat_ask") continue;
    if (String(e.from ?? "user") !== "user") continue;
    const text = oneLine(String(e.text ?? "").replace(/\[附件\][^\n]*/g, " ")).slice(0, 100);
    if (!text) continue;
    out.push(`- ${hhmmOf(e.at)} 用户消息：${text}`);
  }
  return out.reverse();
}

/**
 * 重载简报：给监工对话层注入的继承上下文。
 * 按段落挑选而非按序截前 N 字：优先保留未完成、待复验、插话、未裁决、结论、重派计数等增量段落，
 * 再把剩余额度给需求原文等存量段落（守卫与派单中另有一份）。超出时从占用最大的段落开始截，并在末尾标明。
 */
export function reloadBrief(root: string, maxChars = 12000): string {
  let text = "";
  try {
    if (!existsSync(contextPath(root))) return "";
    text = readFileSync(contextPath(root), "utf8").trim();
  } catch {
    return "";
  }
  if (text.length <= maxChars) return text;

  /* 按 `## ` 切段，第一段是标题行。 */
  const parts = text.split(/\n(?=## )/);
  const head = parts[0] ?? "";
  const sections = parts.slice(1).map((s) => ({ title: (s.split("\n")[0] ?? "").trim(), body: s }));

  /** 优先级：数字小的先保；需求原文放最后，守卫里另有一份。 */
  const rank = (title: string): number => {
    if (/未完成/.test(title)) return 0;
    if (/待复验/.test(title)) return 1;
    if (/插话/.test(title)) return 2;
    if (/未裁决/.test(title)) return 3;
    if (/决策结论/.test(title)) return 4;
    if (/重派计数/.test(title)) return 5;
    if (/验收/.test(title)) return 6;
    if (/边界|禁止/.test(title)) return 7;
    if (/需求原文/.test(title)) return 8;
    return 9;
  };

  const sorted = [...sections].sort((a, b) => rank(a.title) - rank(b.title));
  /* 需求原文体量最大且排在简报最前，无论按原序截取还是纯按优先级截取，都会挤占其余段落的空间，因此先划出 30% 固定配额，剩余额度留给增量段落。 */
  const needQuota = Math.floor(maxChars * 0.3);
  let budget = maxChars - head.length - 200;
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const s of sorted) {
    const isNeed = rank(s.title) === 8;
    const room = isNeed ? Math.min(needQuota, budget) : budget;
    if (s.body.length <= room) {
      kept.push(s.body);
      budget -= s.body.length + 1;
      continue;
    }
    if (room > 400) {
      kept.push(`${s.body.slice(0, room)}\n…（该段超出配额，截断；全文在 .capitalist/reload/context.md）`);
      budget -= room;
    } else {
      dropped.push(s.title.replace(/^#+\s*/, ""));
    }
  }
  /* 保留的段落按原文顺序回排，保证阅读连贯。 */
  kept.sort((a, b) => text.indexOf(a) - text.indexOf(b));
  const tail = dropped.length ? `\n\n（因上限未纳入的段落：${dropped.join("、")}；完整内容在 .capitalist/reload/context.md）` : "";
  return `${head}\n${kept.join("\n")}${tail}`;
}

function writeMarker(root: string, gen: number, phase: string, startedAt: string, trigger = "manual"): void {
  mkdirSync(reloadDir(root), { recursive: true });
  const marker: ActiveMarker = {
    gen,
    phase,
    pid: process.pid,
    started_at: startedAt,
    at_ts: Date.now() / 1000,
    trigger,
  };
  writeJson(activePath(root), marker);
}

/** `capitalist reload` 的入参。 */
export interface ReloadOptions {
  /** 让“监工重载中”多停几秒，便于人/脚本观察到这个状态；0 表示不停。 */
  holdSec?: number;
  out?: (s: string) => void;
  /** 触发来源：manual（默认）| context_overflow（上下文超限自动重载）。进事件与 active 标记。 */
  trigger?: string;
  /** 是否生成压缩简报（默认 false）。压缩由宿主调度，本模块只在宿主压缩后用 `context_compacted` 事件同步状态。 */
  compress?: boolean;
}

/** 一次重载的结论，CLI 直接照着打印。 */
export interface ReloadSummary {
  gen: number;
  snapshot: string;
  context: string;
  resume: string;
  session_id: string;
  before_chars: number;
  after_chars: number;
  events_total: number;
  events_dropped: number;
  items: number;
  skip: number;
  reverify: number;
  pending: number;
}

/**
 * 执行一次重载。
 * 顺序不可调换：先落盘快照 -> 压缩 -> 换会话 -> 写恢复计划。任一步失败保留 active 标记，由 {@link reloadStatus} 超时清理。
 * @throws 已有重载进行中时抛出（并发重载会互相覆盖快照）。
 */
export async function beginReload(root: string, policy: Policy, opts: ReloadOptions = {}): Promise<ReloadSummary> {
  const out = opts.out ?? ((s: string) => process.stdout.write(`${s}\n`));
  const running = reloadStatus(root);
  if (running.active) {
    throw new Error(
      `已有重载在进行中（第 ${running.gen} 次，当前进度 ${running.phase}，已 ${running.age_sec} 秒）。待其结束后再执行重载。` +
        `进程若已退出，${Math.round(RELOAD_STALE_MS / 60000)} 分钟后标记自动失效。`,
    );
  }

  const prev = readSessionRecord(root);
  const gen = Number(prev?.gen ?? 0) + 1;
  const startedAt = new Date().toISOString();
  const trigger = String(opts.trigger ?? "manual");
  /*
   * 重载前的读数与被换掉的会话 id：压缩事件要写清“从哪条会话、多少占用”开始。
   * 这两份必须在换 session.json 之前取，否则读到的已经是新会话。
   */
  const ctxBefore = readSupervisorContext(root);
  /* 无记录时先由 reloadSessionId 建出基线会话，压缩事件才有起点。 */
  const prevSessionId = String(prev?.session_id ?? "").trim() || reloadSessionId(root);
  const limitBefore = effectiveSupervisorContextLimit(
    supervisorContextConfigLimit(root),
    supervisorContextModelWindow(root, ctxBefore),
  );

  mkdirSync(historyDir(root), { recursive: true });
  writeMarker(root, gen, "snapshot", startedAt, trigger);

  // 1. 快照
  const snap = buildReloadSnapshot(root, policy, gen);

  /* 压缩简报默认不生成；不压缩时 after_chars 记成 before_chars，避免写 0 被误读为上下文已清空。 */
  const doCompress = opts.compress === true;
  let afterChars = snap.metrics.before_chars;
  if (doCompress) {
    writeMarker(root, gen, "compress", startedAt, trigger);
    const ctx = buildReloadContext(snap);
    afterChars = ctx.chars;
    writeFileSync(contextPath(root), `${ctx.text}\n`, "utf8");
  }
  snap.metrics.after_chars = afterChars;
  writeJson(snapshotPath(root), snap);
  // 历史副本：重载可以复盘。文件名带 gen 与时间，不覆盖上一代。
  writeJson(join(historyDir(root), `gen-${gen}-${startedAt.replace(/[:.]/g, "-")}.json`), snap);

  // 3. 新会话：换 id 即换上下文，老会话不再被读。代次与工作区标识由 rotateChatSession 统一生成。
  const session = rotateChatSession(root, "reload", afterChars, startedAt);

  // 4. 恢复计划
  const plan = buildResumePlan(snap);
  writeJson(resumePath(root), plan);
  writeMarker(root, gen, "resume", startedAt, trigger);

  const holdMs = Math.max(0, Math.min(60, Number(opts.holdSec ?? 0))) * 1000;
  if (holdMs > 0) await sleep(holdMs);

  /* 收尾：撤掉“重载进行中”标记。删除失败不判重载失败：此时快照、压缩、换会话均已落盘。 */
  let cleaned = false;
  try {
    rmSync(activePath(root), { force: true });
    cleaned = true;
  } catch {
    cleaned = false;
  }
  if (!cleaned) {
    try {
      /* 删标记失败时改写终态 `done`，`reloadStatus` 视同已结束，不依赖删除成功。 */
      writeMarker(root, gen, "done", startedAt, trigger);
    } catch {
      /* 标记也写不了时留给 stale 超时清理。 */
    }
  }
  recordEvent(root, "supervisor_reload", {
    gen,
    trigger,
    items: snap.items.length,
    skip: plan.skip.length,
    reverify: plan.reverify.length,
    pending: plan.pending.length,
    before_chars: snap.metrics.before_chars,
    after_chars: afterChars,
    dropped_events: snap.metrics.events_dropped,
    session_id: session.session_id,
  });
  /* 仅真正压缩时记 `context_compacted`（source=reload）：新会话无读数，`after_used` 留 null。 */
  if (doCompress) {
    recordEvent(root, "context_compacted", {
      scope: "capitalist",
      session: prevSessionId,
      next_session: session.session_id,
      before_used: ctxBefore?.used ?? null,
      after_used: null,
      limit: limitBefore,
      source: "reload",
      trigger,
      gen_from: Number(prev?.gen ?? 0),
      gen_to: gen,
    });
  }

  out(
    `[监工] 第 ${gen} 次重载完成：快照 ${snap.items.length} 个节点｜` +
      `${doCompress ? `上下文 ${snap.metrics.before_chars} 至 ${afterChars} 字（移除 ${snap.metrics.events_dropped} 条状态检查与已完成明细）` : "未压缩（交给宿主）"}｜` +
      `不重派 ${plan.skip.length}｜待复验 ${plan.reverify.length}｜继续 ${plan.pending.length}`,
  );

  return {
    gen,
    snapshot: snapshotPath(root),
    context: contextPath(root),
    resume: resumePath(root),
    session_id: session.session_id,
    before_chars: snap.metrics.before_chars,
    after_chars: afterChars,
    events_total: snap.metrics.events_total,
    events_dropped: snap.metrics.events_dropped,
    items: snap.items.length,
    skip: plan.skip.length,
    reverify: plan.reverify.length,
    pending: plan.pending.length,
  };
}
