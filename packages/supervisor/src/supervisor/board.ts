
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { runCheck } from "../core/checks";
import { attachmentsIn, bindAttachments, stripAttachments } from "../core/attachments";
import { activeTakeover, directPath, isWorkerRef, laneKeyOf, listDirectives, promoteTask, stopWorker } from "../core/commands";
import { loadContract, stageById } from "../core/contract";
import { sizeCached, statCached } from "../core/fsCache";
import { openInboxAsks } from "../core/inbox";
import { appendJsonl, readJson, readJsonl, writeJson } from "../core/json";
import type { Stage } from "../core/types";
import { recordEvent } from "../core/ledger";
import { lockStatus } from "../core/fileLock";
import {
  CTX_WINDOW_PRESETS,
  MAX_SAY_CHARS,
  ctxWindowSupported,
  defaultContextWindow,
  effectiveCtxWindow,
  isCtxWindowPreset,
  modelRealWindow,
  readCtxWindow,
  readCtxWindowChosen,
  resolveContextWindow,
  writeCtxWindow,
} from "../core/limits";
import { attachmentsOfMessage, newMessageId, recentShots, recordUserMessage, type ShotRef } from "../core/messages";
import { mqPath, readPendingMq } from "../core/mq";
import { supervisorDir } from "../core/paths";
import { clearQuotaExhausted, markQuotaExhausted, readQuotaState } from "../core/quota";
import { all, byId, detect, hostOverrideOf, workerHosts } from "../agent/registry";
import {
  findHostCli,
  helpModels as catalogHelpModels,
  parseModelIdsFromHelp,
  resetHelpModelsCacheForTest,
} from "../agent/modelCatalog";
import { assignThreadNos, dispatchNoTable, dispatchOfThreadNo, threadNoLabel, threadNoOf } from "./threadNo";
import {
  chatVerdictOf,
  dismissChat,
  listUnhandled,
  settleChat,
  unhandledFromEvents,
  type ChatVerdict,
} from "./chatSettle";
import { appendSupervisorDirective, listSupervisorDirectives, type SupervisorDirective } from "./direct";
import { buildForestView } from "./forestView";
import { askModelStream, isQuotaText, parseReply } from "./llm";
import type { WorkerHost } from "./worker";

/**
 * 对话通道用哪个 CLI：监工启动时的 `host` 优先，其次是进程内的 `--agent` 覆盖，
 * 都没有时返回 null，由 llm 按当前宿主推断。三处入口读同一份声明，避免各自回落到常量。
 */
function chatHostOf(root: string): WorkerHost | null {
  const saved = String(loadSupervisor(root)?.host ?? "").trim();
  if (saved) return saved as WorkerHost;
  const live = hostOverrideOf();
  return live ? (live as WorkerHost) : null;
}
import { resolveModel } from "./modelPolicy";
import { stripDispatchEcho, supervisorReplyView } from "./msgView";
import {
  buildSupervisorContextView,
  estimateSessionContextTokens,
  recentUserLines,
  recordSupervisorContext,
  reloadBrief,
  reloadStatus,
  severeSupervisorEventLines,
  sessionPath,
  supervisorChatTurnSessionId,
  type ReloadStatus,
  type SupervisorContextView,
} from "./reload";
import { laneBaseId, laneContextWindow, readLane } from "./sessionLane";
import { loadState, updateState } from "../core/state";
import { pausePath, readNextModel, readPause } from "./loop";
import {
  activeDispatch,
  archiveFinished,
  clearStopFlag,
  closeDispatch,
  dispatchPaused,
  finishDispatch,
  isSupervisorAlive,
  listWorkers,
  loadSupervisor,
  loadWorker,
  parentOf,
  pendingPrerequisites,
  pidAlive,
  readDispatches,
  requestSupervisorStop,
  saveSupervisor,
  setWorkerModel,
  wakeDispatch,
  workerModelPath,
  supervisorStaleSec,
  workerLivenessOf,
  workerLogIdleSec,
  DEFAULT_LOG_STALL_SEC,
  type Dispatch,
  type SupervisorRecord,
  type WorkerRecord,
  type WorkerStuckState,
} from "../core/supervisor";
import { isShellTool, parseWorkerLog, summarizeCommand, type WorkerAction, type WorkerLogParts } from "./workerLog";
import { doingOfAction, enterSupervisorAction, currentSupervisorAction, supervisorActivityOf, type SupervisorAction, type SupervisorActivityKind, type WorkerDoing } from "./activity";
import { reapOrphans } from "./reapOrphans";
import {
  buildContextView,
  buildUsageLedger as usageLedger,
  noUsage,
  workerUsageRow,
  type ContextView,
  type UsageFigures,
  type UsageRow,
} from "./usage";
import { balanceView, type BalanceView } from "./balance";
import { creditOfWorker } from "./creditLedger";
import {
  addMemory,
  deleteMemory,
  isMemoryKind,
  memoryLines,
  memorySnapshot,
  updateMemory,
} from "./memory";
import { shardTitle, summarizeTitle } from "./taskTitle";
/** 消息文案术语表在 terms.ts；前端复用同一份，组件内不另写标签。 */
import { zhCommandLabel, zhContractKind, zhStatus } from "./terms";

function zhCall(fn: unknown, value: unknown, extra?: unknown): string {
  if (typeof fn !== "function") return String(value ?? "");
  try {
    return String((fn as (v: unknown, e?: unknown) => unknown)(value, extra) ?? "");
  } catch {
    return String(value ?? "");
  }
}

const zh = {
  status: (v: unknown): string => zhCall(zhStatus, v),
  cmd: (a: unknown, u?: unknown): string => zhCall(zhCommandLabel, a, u),
  kind: (k: unknown): string => zhCall(zhContractKind, k),
};
import { readTasks, taskSummary as poolSummary, type TaskSummary as TaskPoolSummary } from "../core/tasks";

export interface BoardSnapshot {
  root: string;
  at: string;
  stage: string;
  target: string;
  contract: string;
  next_action: string;
  stage_goal: string;
  stage_name: string;
  stage_index: number;
  stage_total: number;
  gate: string[];
  blockers: string[];
  diagnosis: BoardDiagnosis;
  supervisor: {
    pid: number;
    status: string;
    alive: boolean;
    ticks: number;
    heartbeat_age_sec: number;
    worker_host: string;
    /** 宿主的显示名；未注册宿主为空串，前端回落显示 worker_host。 */
    worker_host_label: string;
    max_workers: number;
    note: string;
  } | null;
  workers: BoardWorker[];
  workers_total: number;
  dispatches: BoardDispatch[];
  asks: BoardAsk[];
  feed: BoardEvent[];
}

const SNAPSHOT_DISPATCH_LIMIT = 8;
const THREAD_PAGE_LIMIT = 60;
const THREAD_PEEK_TAIL_BYTES = 256 * 1024;
const NOTE_PREVIEW_CHARS = 200;

export interface BoardDiagnosis {
  level: "ok" | "warn" | "bad";
  title: string;
  detail: string;
  fix: string;
}

export interface BoardWorker {
  id: string;
  status: string;
  host: string;
  pid: number;
  stage: string;
  dispatch: string;
  mode: string;
  heartbeat_at: string;
  heartbeat_age_sec: number;
  log_idle_sec: number;
  alive: boolean;
  stuck?: WorkerStuckState;
  credential: string;
  note: string;
  output_bytes: number;
  duration_sec: number;
  spawn_count: number;
}

export interface BoardDispatch {
  id: string;
  status: string;
  stage: string;
  shard: string;
  title: string;
  action: string;
  worker: string;
  note: string;
  at: string;
  done_at: string;
}

export interface BoardAsk {
  text: string;
  at: string;
  stage: string;
  status: string;
}

export interface BoardEvent {
  at: string;
  event: string;
  text: string;
}

export type ThreadRole = "supervisor" | "worker" | "user";
export type ThreadKind = "dispatch" | "verdict" | "output" | "tool" | "say" | "thinking" | "engine";

export interface ThreadMessage {
  /** 消息 id 必须与时间戳解耦，取派单 id、工作进程输出块序号、事件内容指纹等来源标识。 */
  id: string;
  at: string;
  role: ThreadRole;
  kind: ThreadKind;
  text: string;
  tool: string;
  cmd: string;
  status: string;
  thread: string;
  no?: string;
  duration_sec?: number;
  idle_sec?: number;
  lines?: number;  /** 这一块里被过滤掉的引擎调试行数（页面上要说明“已隐藏 N 行”，不能静默丢弃） */
  hidden?: number;
  debug?: string[];
  event?: string;
  /** 附件路径只取本条记录写入时的值，缺失即无图，不回退到上一条或全局。 */
  atts?: string[];
  /** id 必须与 buildThreadsPage 的线程 id 一致（阶段/分片，空分片用 main）。 */
  jump?: { id: string; label: string };
  /** 曝光层级由服务端按事件类型判定，前端不另判。 */
  tier?: "main" | "log";
  count?: number;
  first_at?: string;
  last_at?: string;
  action?: string;
  arg?: string;
  ok?: boolean;
  reason?: string;
  detail?: string;
  urgent?: boolean;
  link?: string;
  msg_id?: string;
  unhandled?: boolean;
  quote?: string;
  quote_text?: string;
}

export interface ThreadSummary {
  id: string;
  no: string;
  shard: string;
  lineage?: string;
  stage: string;
  status: string;
  settled?: boolean;
  queued_reason?: string;
  model: string;
  worker: string;
  last_at: string;
  last_role: ThreadRole | "";
  last: string;
  unread: number;
  held: boolean;
  started_at?: string;
  heartbeat_age_sec?: number;
  alive?: boolean;
  log_idle_sec?: number;
  doing?: WorkerDoing;
  stuck?: WorkerStuckState;
  promoted_at?: string;
  urgent?: boolean;
  yielded_at?: string;
  yielded_by?: string;
  dispatch: string;
  workers?: string[];
  dispatches?: string[];
  title: string;
  parent?: string;
  parent_reason?: string;
  /** 等所有单的 "*" 按空串处理。 */
  stuck_on: string;
  stuck_on_no: string;
  retry_verdict?: string;
  retry_why?: string;
  output_bytes: number;
  duration_sec: number;
  spawn_count: number;
  /** 与 /api/metrics 的 threads[].usage 由同一函数计算；无读数时 reported=false、数值为 null。 */
  usage: UsageFigures;
}


/**
 * 看板侧的派单与工作进程读取缓存。
 *
 * 一次页面刷新里，线程列表、监工状态、任务计数会各读一遍同一批文件；这些文件
 * 在两次轮询之间通常没有变化，重复读只是把同一份磁盘 I/O 做几遍。这里按任务根
 * 缓存 800ms（短于 2 秒轮询间隔），只供看板使用。监工主循环仍直接读盘，
 * 调度判定不读这份缓存。
 */
const BOARD_READ_TTL_MS = 800;
const dispatchesBoardCache = new Map<string, { at: number; rows: Dispatch[] }>();
const workersBoardCache = new Map<string, { at: number; rows: WorkerRecord[] }>();

function readDispatchesBoard(root: string): Dispatch[] {
  const hit = dispatchesBoardCache.get(root);
  if (hit && Date.now() - hit.at < BOARD_READ_TTL_MS) return hit.rows;
  const rows = readDispatches(root);
  dispatchesBoardCache.set(root, { at: Date.now(), rows });
  return rows;
}

/**
 * 清空看板侧全部读缓存。
 *
 * 写接口进来时调用：用户刚做的操作必须在下一次读取里立刻可见，
 * 宁可多读一次盘，也不能让界面停在操作之前的状态。
 */
function invalidateBoardCaches(): void {
  threadsPageCache.clear();
  messageContextCache.clear();
  dispatchesBoardCache.clear();
  workersBoardCache.clear();
  supervisorLogCache = null;
}

function listWorkersBoard(root: string): WorkerRecord[] {
  const hit = workersBoardCache.get(root);
  if (hit && Date.now() - hit.at < BOARD_READ_TTL_MS) return hit.rows;
  const rows = listWorkers(root);
  workersBoardCache.set(root, { at: Date.now(), rows });
  return rows;
}

const FEED_EVENTS = new Set([
  "dispatch_open",
  "dispatch_done",
  "dispatch_failed",
  "dispatch_closed",
  "dispatch_wake",
  "dispatch_orphan",
  "dispatch_reaped",
  "dispatch_retry",
  "worker_start",
  "worker_gone",
  "worker_launch_failed",
  "stuck_detected",
  "stuck_guidance_delivered",
  "stuck_killed",
  "stuck_cleared",
  "supervisor_advance",
  "supervisor_done",
  "hook_error",
]);

const FEED_LIMIT = 20;
const SNAPSHOT_WORKER_LIMIT = 20;
const ACTION_PREVIEW_CHARS = 160;
const FEED_TEXT_CHARS = 160;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** 日志尾部内容缓存：一轮请求里同一条日志会被预览、用量、成本各读一次。 */
const tailLinesCache = new Map<string, { key: string; lines: string[] }>();
const TAIL_CACHE_MAX = 256;

function tailLines(file: string, maxBytes: number): string[] {
  try {
    const st = statCached(file);
    if (!st) return [];
    const size = st.size;
    const cacheKey = `${st.mtimeMs}:${size}:${maxBytes}`;
    const hit = tailLinesCache.get(file);
    if (hit && hit.key === cacheKey) return hit.lines.slice();
    const start = Math.max(0, size - maxBytes);
    const want = size - start;
    if (want <= 0) return [];

    const buf = Buffer.alloc(want);
    const handle = openSync(file, "r");
    let read = 0;
    try {
      read = readSync(handle, buf, 0, want, start);
    } finally {
      closeSync(handle);
    }

    let text = buf.subarray(0, read).toString("utf8");
    if (start > 0) text = text.replace(/^[^\n]*\n/, "");
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    if (tailLinesCache.size >= TAIL_CACHE_MAX) tailLinesCache.clear();
    tailLinesCache.set(file, { key: cacheKey, lines });
    return lines.slice();
  } catch {
    return [];
  }
}

/** 只发送到最后一个换行，避免多字节 UTF-8 被切出半个汉字；单次最多 maxBytes。 */
function readDelta(file: string, from: number, maxBytes = 16_384): { text: string; next: number } {
  try {
    const size = statSync(file).size;
    const start = size < from ? 0 : from;
    if (size <= start) return { text: "", next: start };

    const want = Math.min(size - start, maxBytes);
    const buf = Buffer.alloc(want);
    const handle = openSync(file, "r");
    let read = 0;
    try {
      // 按返回值而非请求量取内容：短读时缓冲区尾部是零字节。
      read = readSync(handle, buf, 0, want, start);
    } finally {
      closeSync(handle);
    }
    if (read <= 0) return { text: "", next: start };

    const raw = buf.subarray(0, read).toString("utf8");
    const nl = raw.lastIndexOf("\n");
    if (nl < 0) {
      return read < maxBytes ? { text: "", next: start } : { text: raw, next: start + read };
    }
    const text = raw.slice(0, nl + 1);
    return { text, next: start + Buffer.byteLength(text, "utf8") };
  } catch {
    return { text: "", next: from };
  }
}

function fileSize(file: string): number {
  return sizeCached(file);
}

const NEW_WORKER_TAIL_BYTES = 2_048;
const LINE_SCAN_BYTES = 4_096;

function alignToLine(file: string, from: number): number {
  if (from <= 0) return 0;
  const back = Math.min(from, LINE_SCAN_BYTES);
  const buf = Buffer.alloc(back);
  try {
    const handle = openSync(file, "r");
    let read = 0;
    try {
      read = readSync(handle, buf, 0, back, from - back);
    } finally {
      closeSync(handle);
    }
    if (read <= 0) return from;
    const nl = buf.subarray(0, read).lastIndexOf(0x0a);
    return nl >= 0 ? from - back + nl + 1 : 0;
  } catch {
    return from;
  }
}


export interface ThreadCost {
  output_bytes: number;
  duration_sec: number;
  spawn_count: number;
}

export interface ThreadCostRow extends ThreadCost {
  id: string;
  shard: string;
  stage: string;
  usage: UsageFigures;
}

const LAUNCH_PROBE_BYTES = 4096;

function launchBannerBytes(file: string): number {
  try {
    if (!statCached(file)) return 0;
    const buf = Buffer.alloc(LAUNCH_PROBE_BYTES);
    const handle = openSync(file, "r");
    let read = 0;
    try {
      read = readSync(handle, buf, 0, buf.length, 0);
    } finally {
      closeSync(handle);
    }
    let bytes = 0;
    for (const line of buf.subarray(0, read).toString("utf8").split("\n")) {
      if (!line.startsWith("[launch")) break;
      bytes += Buffer.byteLength(line, "utf8") + 1;
    }
    return bytes;
  } catch {
    return 0;
  }
}

function spawnCountFor(stage: string, shard: string, dispatches: readonly Dispatch[]): number {
  return shard
    ? dispatches.filter((d) => (d.shard ?? "") === shard).length
    : dispatches.filter((d) => d.stage === stage && !d.shard).length;
}

const logStatsCache = new Map<string, { key: string; size: number; banner: number }>();
const LOG_STATS_CACHE_MAX = 512;

function logStats(file: string): { size: number; banner: number } {
  try {
    /* 一轮请求里每条日志会被预览、成本、头像各查一次，stat 走缓存。 */
    const st = statCached(file);
    if (!st) return { size: 0, banner: 0 };
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = logStatsCache.get(file);
    if (hit && hit.key === key) return hit;
    const v = { key, size: st.size, banner: launchBannerBytes(file) };
    if (logStatsCache.size >= LOG_STATS_CACHE_MAX) logStatsCache.clear();
    logStatsCache.set(file, v);
    return v;
  } catch {
    return { size: 0, banner: 0 };
  }
}

export function workerCost(w: WorkerRecord, dispatches: Dispatch[], nowSec = Date.now() / 1000): ThreadCost {
  const start = atTs(w.started_at);
  const d = w.dispatch ? dispatches.find((x) => x.id === w.dispatch) : undefined;
  const doneTs = d?.done_at ? atTs(d.done_at) : 0;
  const live = w.status === "running" || w.status === "starting";
  const end = doneTs > 0 ? doneTs : live ? nowSec : Math.max(w.heartbeat_ts, 0);
  const stats = logStats(w.log);
  return {
    output_bytes: Math.max(0, stats.size - stats.banner),
    duration_sec: start > 0 && end > start ? Math.round(end - start) : 0,
    spawn_count: spawnCountFor(w.stage, w.shard ?? "", dispatches),
  };
}

export function threadCostRows(root: string): ThreadCostRow[] {
  return costRowsWith(listWorkersBoard(root), readDispatchesBoard(root), root);
}

const costRowCache = new Map<string, { fp: string; row: ThreadCostRow }>();
const COST_ROW_CACHE_MAX = 1024;

function costRowOf(w: WorkerRecord, dispatches: Dispatch[], nowSec = Date.now() / 1000, root = ""): ThreadCostRow {
  const live = w.status === "running" || w.status === "starting";
  const d = w.dispatch ? dispatches.find((x) => x.id === w.dispatch) : undefined;
  const fp = [
    w.status,
    String(w.started_at ?? ""),
    String(w.heartbeat_ts ?? 0),
    String(d?.done_at ?? ""),
    String(d?.attempt ?? 0),
    dispatches.length,
    logStats(w.log).size,
    // 积分摊算可能晚于收工落账，结构指纹包含积分值。
    String(root ? creditOfWorker(root, w.id) ?? "" : ""),
  ].join("|");
  if (!live) {
    const hit = costRowCache.get(w.id);
    if (hit && hit.fp === fp) return hit.row;
  }
  const row: ThreadCostRow = {
    id: w.id,
    shard: w.shard ?? "",
    stage: w.stage,
    ...workerCost(w, dispatches, nowSec),
    usage: workerUsageRow(w, dispatches, root),
  };
  if (!live) {
    if (costRowCache.size >= COST_ROW_CACHE_MAX) costRowCache.clear();
    costRowCache.set(w.id, { fp, row });
  }
  return row;
}

function costRowsWith(workers: readonly WorkerRecord[], dispatches: readonly Dispatch[], root = ""): ThreadCostRow[] {
  const nowSec = Date.now() / 1000;
  const rows: ThreadCostRow[] = workers.map((w) => costRowOf(w, dispatches as Dispatch[], nowSec, root));
  const served = new Set(workers.map((w) => w.dispatch));
  const keys = new Set(rows.map((r) => r.id));
  for (const d of dispatches) {
    if (d.status !== "open" && d.status !== "claimed") continue;
    if (d.id && served.has(d.id)) continue;
    const key = d.shard ? `shard:${d.shard}` : d.id;
    if (keys.has(key)) continue;
    keys.add(key);
    rows.push({
      id: key,
      shard: d.shard ?? "",
      stage: d.stage,
      output_bytes: 0,
      duration_sec: 0,
      spawn_count: spawnCountFor(d.stage, d.shard ?? "", dispatches),
      usage: noUsage(d.at, dispatchModel(d)),
    });
  }
  return fillContextWindow(rows, root, (r) => r.id);
}

/**
 * 补齐每行读数的上下文分母。
 *
 * 分母按作用域分别取：监工的窗口由 {@link buildSupervisorContextView} 单独算，这里只处理工作进程。
 * 每个工作进程自己设过的值优先（`scopeOf` 给出该行的作用域键），没设过用默认档，
 * 两种情况都不超过该行模型的真实窗口。
 */
function fillContextWindow<T extends { usage: { model: string; context_window: number | null } }>(
  rows: T[],
  root = "",
  scopeOf?: (row: T) => string,
): T[] {
  for (const r of rows) {
    const u = r.usage;
    if (!u.model) continue;
    const scope = scopeOf ? scopeOf(r) : "default";
    const chosen = root && scope ? readCtxWindowChosen(root, scope) : null;
    const w = effectiveCtxWindow(u.model, u.context_window, chosen);
    if (w !== u.context_window) r.usage = { ...u, context_window: w };
  }
  return rows;
}

const METRICS_COST_ROWS_MAX = 20;

function pickCurrentCostRows(
  rows: readonly ThreadCostRow[],
  workers: readonly WorkerRecord[],
  dispatches: readonly Dispatch[],
): ThreadCostRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const picked: ThreadCostRow[] = [];
  const liveIds = new Set<string>();
  for (const w of workers) {
    if (w.status !== "running" && w.status !== "starting") continue;
    liveIds.add(w.id);
    const r = byId.get(w.id);
    if (r) picked.push(r);
  }
  const rest = workers
    .filter((w) => !liveIds.has(w.id))
    .sort((a, b) => String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")))
    .slice(0, Math.max(0, METRICS_COST_ROWS_MAX - picked.length));
  for (const w of rest) {
    const r = byId.get(w.id);
    if (r) picked.push(r);
  }
  for (const d of dispatches) {
    if (d.status !== "open" && d.status !== "claimed") continue;
    for (const key of [d.shard ? `shard:${d.shard}` : "", d.id]) {
      const r = key ? byId.get(key) : undefined;
      if (r && !picked.includes(r)) picked.push(r);
    }
  }
  return picked;
}

export function costTotals(rows: readonly ThreadCost[]): {
  total_duration_sec: number;
  total_output_bytes: number;
  total_spawn_count: number;
} {
  let duration = 0;
  let output = 0;
  let spawns = 0;
  for (const r of rows) {
    duration += r.duration_sec;
    output += r.output_bytes;
    spawns += r.spawn_count;
  }
  return { total_duration_sec: duration, total_output_bytes: output, total_spawn_count: spawns };
}

function tokenTotals(figs: readonly UsageFigures[]): {
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_tokens: number | null;
  total_cache_read_tokens: number | null;
  usage_reported: number;
  usage_unreported: number;
  billing_unit: string;
  total_credit: number | null;
  credit_unit: string;
} {
  const sum = (pick: (f: UsageFigures) => number | null): number | null => {
    let total = 0;
    let hit = 0;
    for (const f of figs) {
      const v = pick(f);
      if (v === null) continue;
      total += v;
      hit++;
    }
    return hit > 0 ? total : null;
  };
  const cost = sum((f) => f.cost_usd);
  const input = sum((f) => f.input_tokens);
  const reported = figs.filter((f) => f.reported).length;
  const credit = sum((f) => f.credit);
  return {
    total_input_tokens: input,
    total_output_tokens: sum((f) => f.output_tokens),
    total_tokens: sum((f) => f.total_tokens),
    total_cache_read_tokens: sum((f) => f.cache_read_tokens),
    usage_reported: reported,
    usage_unreported: figs.length - reported,
    billing_unit: credit !== null ? "credit" : cost !== null && cost > 0 ? "usd" : input !== null ? "token" : "",
    total_credit: credit,
    credit_unit: credit !== null ? (figs.map((f) => f.credit_unit).find(Boolean) || "积分") : "",
  };
}

/** 永不返回分片 id 作为标题；老记录按分片映射补短名，再退到正文摘要。 */
function dispatchTitle(d: Dispatch): string {
  const v = (d as unknown as Record<string, unknown>).title;
  const stored = typeof v === "string" ? v.trim() : "";
  if (stored) return stored;
  return shardTitle(d.shard) || summarizeTitle(d.action);
}

/** 结构指纹只用于 /api/tasks 的 rev 字段。 */
function signature(root: string): string {
  const parts = ["state.json", "supervisor.json", "inbox/dispatch.jsonl"];
  let s = "";
  for (const rel of parts) {
    try {
      s += `${rel}:${statCached(join(supervisorDir(root), rel))?.mtimeMs ?? "-"};`;
    } catch {
      s += `${rel}:-;`;
    }
  }
  for (const w of listWorkers(root)) {
    s += `${w.id}:${w.status}:${w.heartbeat_ts};`;
  }
  return s;
}

function ageSec(ts: unknown): number {  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return -1;
  return Math.max(0, Math.round(Date.now() / 1000 - n));
}

const DIAGNOSE_LOG_BYTES = 4_000;

function readTailText(file: string): string {
  return tailLines(file, DIAGNOSE_LOG_BYTES).join("\n");
}

/** 返回空串表示事件没有可读正文，调用方整条跳过。 */
/**
 * 台账里可能夹着原始输出的字段。
 *
 * 判定与重试理由由模型或子进程产出，容易把 stderr、PID、退出码、JSON 片段整段抄进来。
 * 界面只留能判断下一步的那一句：取首行、去掉明显的技术片段、超出上限截断。
 */
function brief(value: unknown, max = 120): string {
  let t = String(value ?? "").split(/\r?\n/)[0] ?? "";
  t = t.replace(/\{[\s\S]*$/, "").replace(/\s+(PID|PPID|Stderr|Exit Code|rawResponse)\s*[=:][\s\S]*$/i, "");
  t = t.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}

function describeEvent(e: Record<string, unknown>): string {
  const name = String(e.event ?? e.kind ?? "");
  const d = String(e.dispatch ?? "");
  const w = String(e.worker ?? "");
  const st = String(e.stage ?? "");
  const shard = shardTitle(e.shard);
  const shardOf = (value: unknown): string => {
    const raw = String(value ?? "");
    if (!raw) return "";
    return shardTitle(raw) || "指定分片";
  };
  switch (name) {
    case "dispatch_open":
      return `派发任务 ${d}（阶段 ${st}${shard ? ` · ${shard}` : ""}）：${String(e.action ?? "")}`;
    case "dispatch_done":
      return `回报完成 ${d}：${brief(e.note) || "（无说明）"}`;
    case "dispatch_failed":
      return `回报失败 ${d}：${brief(e.note) || "（无说明）"}`;
    case "dispatch_closed":
      return `手动结项 ${d}（原状态 ${zh.status(e.from) || "未知状态"}${e.worker ? "，执行中" : "，排队中"}${e.killed ? "，已中断" : ""}）：${String(e.reason ?? "")}`;
    case "dispatch_wake":
      return `消息唤醒 ${d}（原状态 ${zh.status(e.from) || "未知状态"}）：会话新消息将该派单重新置为待执行，沿用原上下文续跑`;
    case "dispatch_retry": {
      const attempt = Number(e.attempt) || 1;
      const failed = Number(e.previous_failures) || 0;
      return `重派任务 ${d}（第 ${attempt} 次${failed > 0 ? `，累计失败 ${failed} 次` : ""}）`;
    }
    case "dispatch_orphan":
      return `派单 ${d} 判死重派（进程状态：${zh.status(e.worker_status) || "未知状态"}）`;
    case "worker_start": {
      const host = String(e.host ?? "");
      return `开始执行 ${d}${host ? `（${host}）` : ""}`;
    }
    case "worker_gone":
      return `执行进程${d ? `（${d}）` : ""} ${e.stale ? "心跳超时" : "已退出"}，回收`;
    case "worker_stopped":
      return `执行进程被用户中断${e.killed ? "（已发送终止信号）" : ""}${d ? `，${d} 按失败结单` : ""}`;
    case "worker_launch_failed":
      return `进程启动失败：${brief(e.error)}`;
    case "dispatch_superseded":
      return `派单 ${d} 作废：不属于当前编排`;
    case "dispatch_reaped":
      return `回收执行进程：${d} 已按失败结单，等待重派（退出码 ${String(e.exit_code ?? "?")}）`;
    case "worker_reaped":
      return `执行进程已回收${d ? `（${d}）` : ""}`;
    case "worker_killed":
      return `中断执行进程${d ? `（${d}）` : ""}：${String(e.how ?? "收到结束信号")}${e.confirmed === false ? "，未确认" : ""}`;
    case "model_fallback":
      return `模型 ${String(e.from_model ?? "")} 启动失败，回退到 ${String(e.to_model ?? "")}`;
    case "takeover":
      return `转入人工接管：${String(e.shard ?? "*") === "*" ? "整个任务根" : shardOf(e.shard)}（${String(e.reason ?? "")}）`;
    case "release":
      return `交还监工：${String(e.shard ?? "") === "*" ? "整个任务根" : shardOf(e.shard)}，恢复自动裁定`;
    case "direct_inject":
      return `用户插话已登记（${shardOf(e.shard) || "等待归属"}）：${String(e.text ?? "")}`;
    case "direct_deliver":
      /*
       * 未开监工介入时的普通对话，投递结果由消息旁的“已送达”标签表达，这里不再单列一条
       * 记录：同一条消息出现两处回执，会让人以为监工插了手。
       */
      return "";
    case "supervisor_advance": {
      const from = String(e.from ?? "");
      const to = String(e.to ?? "");
      /* 起止相同不是推进：界面出现 X -> X 只会让人以为流程在动。 */
      if (!from || !to || from === to) return "";
      return `阶段推进 ${from} 到 ${to}`;
    }
    case "supervisor_done":
      return `任务完成（${st}）`;
    case "hook_error":
      return `钩子异常：${String(e.error ?? "")}`;
    case "gate_eval": {
      const missing = Array.isArray(e.missing) ? e.missing.map((x) => String(x)) : [];
      return e.ok === true
        ? `门槛评估 ${st}：已满足，可以推进`
        : `门槛评估 ${st}：未达标（${missing.join("；") || "未给出缺失项"}）`;
    }
    case "dispatch_merged": {
      const into = String(e.into ?? d ?? "");
      const tag = String(e.tag ?? "");
      const text = String(e.text ?? "").trim();
      return [
        `同一批次的派单合并到 ${into}${tag ? `（批次 ${tag}）` : ""}`,
        text ? `：${text}` : "",
      ].join("");
    }
    case "directive_amended": {
      const text = String(e.text ?? "").trim();
      return `派单 ${d} 追加内容${text ? `：${text}` : "（未给出正文）"}`;
    }
    case "retry_allowed":
    case "retry_refused": {
      const verdict = name === "retry_allowed" ? "可以再试" : "不再重试";
      const why = brief(e.why);
      const attempts = Number(e.attempts);
      return `重试判定：${verdict}（第 ${Number.isFinite(attempts) ? attempts : "?"} 次失败）${why ? `：${why}` : ""}`;
    }
    case "stuck_detected": {
      const label = String(e.label ?? "卡点");
      const why = brief(e.why);
      const worker = String(e.worker ?? "");
      return `派单 ${d} 判为${label}${worker ? `（${worker}）` : ""}${why ? `：${why}` : ""}`;
    }
    case "stuck_guidance_delivered": {
      const label = String(e.label ?? "卡点");
      return `派单 ${d} 的${label}指导已送达工作进程`;
    }
    case "stuck_killed": {
      const label = String(e.label ?? "卡点");
      const attempts = Number(e.attempts);
      return `派单 ${d} 判卡死（${label}）：同类指导 ${Number.isFinite(attempts) ? attempts : "两"} 次未生效，已停进程并重开`;
    }
    case "stuck_cleared": {
      const label = String(e.label ?? "卡点");
      return `派单 ${d} 已恢复推进（${label}解除）`;
    }
    case "attachment_unbound": {
      const n = Number(e.count);
      return `这条追加带着 ${Number.isFinite(n) && n > 0 ? n : "几"} 张图，但没有归属，未带入派单：${String(e.text ?? "")}`;
    }
    default: {
      /** 只用记录自带文本，事件名与默认标签都不作正文；无可读文本返回空串。 */
      return String(e.text ?? e.why ?? e.reason ?? e.note ?? "").trim();
    }
  }
}

/** 文件缺失按空值处理；单条脏记录不影响整体投影。 */
export function buildSnapshot(root: string): BoardSnapshot {
  const state = loadState(root);
  const capitalist = loadSupervisor(root);
  const nowSec = Date.now() / 1000;

  const allWorkers = listWorkers(root);
  const allDispatches = readDispatches(root);
  const workers: BoardWorker[] = allWorkers.slice(-SNAPSHOT_WORKER_LIMIT).map((w: WorkerRecord) => {
    const cost = workerCost(w, allDispatches);
    return {
      id: w.id,
      status: w.status,
      host: w.host,
      pid: w.pid,
      stage: w.stage,
      dispatch: w.dispatch,
      mode: w.mode ?? "background",
      heartbeat_at: w.heartbeat_at,
      heartbeat_age_sec: ageSec(w.heartbeat_ts),
      log_idle_sec: w.log ? Math.round(workerLogIdleSec(w.log)) : -1,
      alive:
        w.mode === "visible"
          ? true
          : workerLivenessOf(w, {
              heartbeatSec: capitalist?.worker_timeout_sec ?? 900,
              logStallSec: capitalist?.stuck_sec ?? DEFAULT_LOG_STALL_SEC,
            }).alive,
      ...(w.stuck ? { stuck: w.stuck } : {}),
      credential: w.credential ?? "",
      note: w.exit_code === undefined ? "" : `exit ${w.exit_code}`,
      output_bytes: cost.output_bytes,
      duration_sec: cost.duration_sec,
      spawn_count: cost.spawn_count,
    };
  });

  const dispatches: BoardDispatch[] = allDispatches
    .slice(-SNAPSHOT_DISPATCH_LIMIT)
    .reverse()
    .map((d: Dispatch) => ({
      id: d.id,
      status: d.status,
      stage: d.stage,
      shard: d.shard ?? "",
      title: dispatchTitle(d),
      action: clip(d.action, ACTION_PREVIEW_CHARS),
      worker: d.worker ?? "",
      note: clip(d.note ?? "", NOTE_PREVIEW_CHARS),
      at: d.at,
      done_at: d.done_at ?? "",
    }));

  // 畸形记录（缺 id、空 text、status 越界）不上面板。
  const asks: BoardAsk[] = openInboxAsks(root).map((q) => ({
    text: String(q.text ?? ""),
    at: String(q.at ?? ""),
    stage: String(q.stage ?? ""),
    status: String(q.status ?? ""),
  }));

  // 事件窗口需容纳 tool 事件，否则派单与回报事件会被挤出尾部窗口。
  const ledgerOnly = ledgerOnlyRoot(root);
  const feed: BoardEvent[] = readJsonlFromTail(join(supervisorDir(root), "events.jsonl"), 512_000)
    .filter((e) => FEED_EVENTS.has(String(e.event ?? e.kind ?? "")))
    .filter((e) => !(ledgerOnly && String(e.event ?? e.kind ?? "") === "supervisor_done"))
    .slice(-FEED_LIMIT)
    .reverse()
    .map((e) => ({
      at: String(e.at ?? ""),
      event: String(e.event ?? e.kind ?? ""),
      text: clip(describeEvent(e), FEED_TEXT_CHARS),
    }));

  const active = activeDispatch(root);
  const lastWorker = allWorkers[allWorkers.length - 1];
  const lastLogTail = lastWorker?.log
    ? `${readTailText(lastWorker.log)}\n${readTailText(`${lastWorker.log}.err`)}`.trim()
    : "";

  const contract = state?.contract ? loadContract(String(state.contract), contractDirs(root)) : null;
  const stage = contract && state?.stage ? stageById(contract, String(state.stage)) : undefined;
  const gate = stage?.done ? runCheck(stage.done, root).missing : [];
  const stageIndex = contract && state?.stage
    ? contract.stages.findIndex((s) => s.id === String(state.stage))
    : -1;

  return {
    root,
    at: new Date().toISOString(),
    stage: state?.stage ?? "",
    target: state?.target ?? "",
    contract: state?.contract ?? "",
    next_action: state?.next_action ?? "",
    stage_goal: stage?.goal ?? "",
    stage_name: stage?.name ?? "",
    stage_index: stageIndex,
    stage_total: contract ? contract.stages.length : 0,
    gate,
    blockers: Array.isArray(state?.blockers)
      ? state?.blockers.map((b) => String((b as { reason?: unknown }).reason ?? ""))
      : [],
    diagnosis: diagnose({
      hasState: Boolean(state),
      supervisor: capitalist,
      alive: capitalist ? isSupervisorAlive(root, nowSec) : false,
      workers,
      dispatches,
      blockers: Array.isArray(state?.blockers) ? state?.blockers.length : 0,
      hasActive: Boolean(active),
      lastLogTail,
    }),
    supervisor: capitalist
      ? {
          pid: capitalist.pid,
          status: capitalist.status,
          alive: isSupervisorAlive(root, nowSec),
          ticks: capitalist.ticks,
          heartbeat_age_sec: ageSec(capitalist.heartbeat_ts),
          worker_host: capitalist.worker_host,
          /*
           * 宿主 id 用于逻辑判断，标签用于顶栏显示。
           * worker_host 记的是 `worker.key`，与 impl id 不一定同名（如 claude-code / claude），
           * 故先按 id 查，再按 worker key 查；都查不到时留空，前端回落显示 id。
           */
          worker_host_label: String(
            (
              byId(capitalist.worker_host) ??
              workerHosts().find((i) => i.worker?.key === capitalist.worker_host)
            )?.label ?? "",
          ).trim(),
          max_workers: capitalist.max_workers,
          note: capitalist.note ?? "",
        }
      : null,
    workers,
    workers_total: allWorkers.length,
    dispatches,
    asks,
    feed,
  };
}

export function buildFeed(root: string, limit = 40): BoardEvent[] {
  const n = Math.max(1, Math.min(Math.floor(limit) || 40, 200));
  const ledgerOnly = ledgerOnlyRoot(root);
  return readJsonlFromTail(eventsFile(root), 512_000)
    .filter((e) => FEED_EVENTS.has(String(e.event ?? e.kind ?? "")))
    .filter((e) => !(ledgerOnly && String(e.event ?? e.kind ?? "") === "supervisor_done"))
    .slice(-n)
    .reverse()
    .map((e) => ({
      at: String(e.at ?? ""),
      event: String(e.event ?? e.kind ?? ""),
      text: clip(describeEvent(e), FEED_TEXT_CHARS),
    }));
}

function rootFromUrl(url: string, fallback: string): string {
  const q = url.indexOf("?");
  if (q < 0) return fallback;
  const want = new URLSearchParams(url.slice(q + 1)).get("root");
  if (!want) return fallback;
  const abs = resolve(want);
  return listTaskRoots(fallback).includes(abs) ? abs : fallback;
}

function contractDirs(root: string): string[] {
  const dirs = [join(root, "contracts"), join(root, "packages", "supervisor", "contracts")];
  try {
    for (const name of readdirSync(root)) {
      if (!name.startsWith(".")) continue;
      const p = join(root, name, "contracts");
      if (existsSync(p)) dirs.push(p);
    }
  } catch {
  }
  return dirs;
}

function ledgerOnlyRoot(root: string): boolean {
  const state = loadState(root);
  const contract = state?.contract ? loadContract(String(state.contract), contractDirs(root)) : null;
  return !!contract && contract.stages.length <= 1;
}


const RESTART_DELAY_MS = 3000;

const RESTART_LAUNCHER = `
const { spawn } = require("node:child_process");
const args = JSON.parse(process.env.CAPITALIST_RELAUNCH_ARGS || "[]");
const oldPid = Number(process.env.CAPITALIST_RELAUNCH_PID || 0);
const cwd = process.env.CAPITALIST_RELAUNCH_CWD || process.cwd();
const deadline = Date.now() + 25000;
function gone() {
  if (!oldPid) return true;
  try { process.kill(oldPid, 0); return false; } catch { return true; }
}
function tick() {
  if (gone() || Date.now() > deadline) {
    try {
      const c = spawn(process.execPath, args, { cwd: cwd, detached: true, stdio: "ignore", windowsHide: true });
      c.unref();
    } catch (e) {}
    return;
  }
  setTimeout(tick, 200);
}
setTimeout(tick, 400);
`;
const RESTART_COOLDOWN_MS = 15_000;
const restartAt = new Map<string, number>();


function knownModelsOf(host: string): readonly string[] {
  return byId(host)?.knownModels ?? [];
}
function cliBinsOf(host: string): readonly string[] {
  return byId(host)?.cliBins ?? [];
}
function configDirOf(host: string): string {
  return byId(host)?.configDir ?? "";
}

interface ModelsView {
  host: string;
  source: string;
  models: string[];
  /** 宿主配置里的默认模型（`<configDir>/settings.json` 的 model 字段）；空值表示未配置。 */
  default_model: string;
  at: string;
  reason: string;
}

const MODELS_TTL_MS = 5 * 60_000;
let modelsCache: { host: string; at: number; view: ModelsView } | null = null;

/**
 * 通道失败时补一行处置。
 *
 * 授权只在启动监工时发生一次：拿到就是全树可用，拿不到则后续统一失败。因此这里的处置
 * 是“重启监工并允许授权”，而不是让用户在发消息时再点一次授权。
 */
function chatAuthHint(root: string): string {
  try {
    if (String(loadSupervisor(root)?.host ?? "").trim() !== "workbuddy") return "";
    return "\n启动监工时没有取得宿主登录态。重启监工并在弹窗中选择允许；启动日志会写明是未登录、被拒还是格式不支持。";
  } catch {
    return "";
  }
}

function hostConfigModel(host: string): string {
  const dir = configDirOf(host);
  if (!dir) return "";
  try {
    const raw = readFileSync(join(os.homedir(), dir, "settings.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const m = (parsed as { model?: unknown } | null)?.model;
    const s = typeof m === "string" ? m.trim() : "";
    return /^[\w.:-]+$/.test(s) ? s : "";
  } catch {
    return "";
  }
}

export { findHostCli, parseModelIdsFromHelp, resetHelpModelsCacheForTest };

/**
 * 宿主模型清单，供看板下拉使用。
 *
 * 清单来源与派单轮换同一份（见 `host/modelCatalog`），本处只负责在清单变化后
 * 让看板侧的模型视图缓存失效。
 */
export function helpModels(host: string): string[] {
  const models = catalogHelpModels(host);
  if (models.length > 0) modelsCache = null;
  return models;
}

function readModels(host: string): ModelsView {
  const at = new Date().toISOString();
  const configured = hostConfigModel(host);
  const parsed = helpModels(host);
  const known = knownModelsOf(host);
  const rest = parsed.length > 0 ? parsed : known;
  const models = [...new Set([configured, ...rest].filter(Boolean))];
  if (models.length > 0) {
    const from = [
      configured ? "宿主配置 model 字段" : "",
      parsed.length ? "宿主 CLI --model 全量清单" : known.length ? "已知模型清单（CLI 解析失败回退）" : "",
    ].filter(Boolean).join(" + ");
    return {
      host,
      source: from,
      models,
      /* 宿主配置的默认模型，用于“宿主默认”一行。 */
      default_model: configured,
      at,
      reason: parsed.length ? "" : "未解析出宿主模型清单，以下为回退清单，可手填",
    };
  }
  return {
    host,
    source: configDirOf(host) ? `~/${configDirOf(host)}/settings.json` : "",
    models: [],
    default_model: configured,
    at,
    reason: "该宿主没有已知模型清单，可在输入框直接填写模型名",
  };
}

function modelsView(root: string, fresh: boolean): ModelsView {
  const host = currentHostOf(root);
  if (!fresh && modelsCache && modelsCache.host === host && Date.now() - modelsCache.at < MODELS_TTL_MS) {
    return modelsCache.view;
  }
  const view = readModels(host);
  modelsCache = { host, at: Date.now(), view };
  return view;
}

function currentHostOf(root: string): string {
  try {
    const h = String(loadSupervisor(root)?.worker_host ?? "").trim();
    if (h && h !== "none") return h;
  } catch {
  }
  return detect() ?? "generic";
}


let BOARD_KEY = "";
/**
 * 是否校验访问 key（安全模式）。
 *
 * 缺省关闭。看板仅监听回环地址，缺省无需 key。需区分本机其它用户，或看板以 `capitalist board --host`
 * 对外开放时，启动传 `--secure`。关闭时不做 key 比对，同源判定与客户端标识头仍生效。
 */
let BOARD_SECURE = false;
const BOARD_KEY_COOKIE = "supervisor_board_key";

function boardKeyPath(root: string): string {
  return join(root, ".capitalist", "board.key");
}

function loadOrCreateBoardKey(root: string, forceNew: boolean): string {
  const p = boardKeyPath(root);
  if (!forceNew) {
    try {
      const old = readFileSync(p, "utf8").trim();
      if (old.length >= 16) return old;
    } catch {
    }
  }
  const key = randomBytes(18).toString("base64url");
  try {
    mkdirSync(join(root, ".capitalist"), { recursive: true });
    writeFileSync(p, `${key}\n`, "utf8");
  } catch {
  }
  return key;
}

/** 常数时间比较，长度不同直接判否。 */
function keyEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

function needKeyPage(): string {
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>capitalist · 需要访问 key</title>",
    "<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;",
    "background:#0b1020;color:#c8d3e6;font:14px/1.7 system-ui,-apple-system,'Segoe UI',sans-serif}",
    ".box{max-width:560px;padding:32px 36px;border:1px solid #24304a;border-radius:12px;background:#111830}",
    "h1{margin:0 0 12px;font-size:16px;font-weight:600;color:#e6edf8}",
    "p{margin:8px 0;color:#8fa1bd}code{font-family:ui-monospace,Menlo,Consolas,monospace;",
    "background:#1a2338;padding:2px 6px;border-radius:4px;color:#9ecbff}</style></head><body>",
    '<div class="box"><h1>需要访问 key</h1>',
    "<p>安全模式下需要提供访问 key，每次启动生成新的 key，并输出到启动日志。</p>",
    "<p>带 key 打开一次后，浏览器以会话 cookie 保存，关闭浏览器后失效：</p>",
    "<p><code>http://&lt;主机&gt;:&lt;端口&gt;/?key=&lt;访问 key&gt;</code></p>",
    "<p>访问 key 也可从启动监工终端输出的 <code>board_url</code> 或 <code>capitalist status</code> 读取。</p>",
    "</div></body></html>",
  ].join("");
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = String(req.headers.origin ?? "").trim();
  if (!origin) return true;
  const host = String(req.headers.host ?? "").trim();
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function isImageGet(req: IncomingMessage, url: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  return url === "/api/attachment" || url.startsWith("/api/attachment?");
}

function hasClientHeader(req: IncomingMessage, url: string): boolean {
  if (url.startsWith("/stream")) return true;
  return String(req.headers["x-capitalist-client"] ?? "").trim() === "board";
}

function guardBoardAccess(req: IncomingMessage, res: ServerResponse, url: string): boolean {
  const cookie = String(req.headers.cookie ?? "");
  const hasCookie = cookie.split(";").some((c) => c.trim() === `${BOARD_KEY_COOKIE}=${BOARD_KEY}`);
  const isData = url.startsWith("/api/") || url === "/health" || url.startsWith("/stream");
  /* 非安全模式不校验 key，与持有 cookie 走同一分支；同源判定与客户端标识头仍生效。 */
  if (hasCookie || !BOARD_SECURE) {
    if (!sameOrigin(req)) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "来源不匹配：只接受与看板同源的请求" }));
      return false;
    }
    /** 数据接口要求自定义头，跨源请求会先触发 OPTIONS 预检，预检同样过鉴权。 */
    if (isData && !hasClientHeader(req, url) && !isImageGet(req, url)) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "缺少客户端标识头 x-capitalist-client" }));
      return false;
    }
    return true;
  }

  const qs = url.indexOf("?") >= 0 ? new URLSearchParams(url.slice(url.indexOf("?") + 1)) : null;
  const given = String(qs?.get("key") ?? "").trim();
  if (given && keyEquals(given, BOARD_KEY)) {
    /** 种下 cookie 后从地址栏清除 key。 */
    const u = new URL(url, "http://placeholder");
    u.searchParams.delete("key");
    const loc = `${u.pathname}${u.search}` || "/";
    res.writeHead(302, {
      location: loc,
      /* 会话 cookie：不设 Max-Age，关闭浏览器即失效。 */
      "set-cookie": `${BOARD_KEY_COOKIE}=${BOARD_KEY}; Path=/; HttpOnly; SameSite=Lax`,
      "cache-control": "no-store",
    });
    res.end();
    return false;
  }

  if (isData) {
    res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "需要访问 key：用启动时打印的带 ?key= 的地址打开看板" }));
  } else {
    res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(needKeyPage());
  }
  return false;
}

export function listTaskRoots(current: string): string[] {
  const out = new Set<string>([resolve(current)]);
  for (const part of (process.env.CAPITALIST_BOARD_ROOTS ?? "").split(/[;,]/)) {
    const v = part.trim();
    if (v) out.add(resolve(v));
  }
  return [...out];
}

export interface TaskSummary {
  root: string;
  target: string;
  stage: string;
  stage_name: string;
  stage_index: number;
  stage_total: number;
  running: number;
  blocked: number;
  level: "ok" | "warn" | "bad";
  rev: string;
  doing: string;
  threads: number;
  /** 监工态与 supervisor.json 同源；paused 取 .capitalist/pause.json，running 要求心跳在判活窗口内。 */
  status: "running" | "paused" | "stale" | "done";
  heartbeat_age_sec: number | null;
}

function supervisorStateOf(root: string): { status: TaskSummary["status"]; age: number | null } {
  const rec = loadSupervisor(root);
  if (!rec) return { status: "done", age: null };
  const age = Math.max(0, Math.round(Date.now() / 1000 - rec.heartbeat_ts));
  if (readPause(root) !== null) return { status: "paused", age };
  if (rec.status === "running") {
    return { status: age <= supervisorStaleSec(rec) ? "running" : "stale", age };
  }
  if (rec.status === "done") return { status: "done", age };
  return { status: "stale", age };
}

export function buildTaskSummaries(roots: string[]): TaskSummary[] {
  return roots.map((root) => {
    try {
      const snap = buildSnapshot(root);
      const capitalist = supervisorStateOf(root);
      const running = snap.workers.filter((w) => w.status === "running" || w.status === "starting").length;
      const liveWorker = snap.workers.filter((w) => w.status === "running" || w.status === "starting").pop();
      const doing = liveWorker
        ? `${liveWorker.id} 运行中 ${liveWorker.stage}${liveWorker.dispatch ? ` · ${liveWorker.dispatch}` : ""}`
        : snap.diagnosis.title;
      return {
        root,
        target: snap.target,
        stage: snap.stage,
        stage_name: snap.stage_name,
        stage_index: snap.stage_index,
        stage_total: snap.stage_total,
        running,
        blocked: snap.blockers.length,
        level: snap.diagnosis.level,
        rev: signature(root),
        doing,
        threads: snap.dispatches.length + snap.workers.length,
        status: capitalist.status,
        heartbeat_age_sec: capitalist.age,
      };
    } catch {
      return {
        root,
        target: "",
        stage: "",
        stage_name: "",
        stage_index: -1,
        stage_total: 0,
        running: 0,
        blocked: 0,
        level: "warn" as const,
        rev: "",
        doing: "读取失败",
        threads: 0,
        status: "stale" as const,
        heartbeat_age_sec: null,
      };
    }
  });
}

interface DiagnoseInput {
  hasState: boolean;
  supervisor: ReturnType<typeof loadSupervisor>;
  alive: boolean;
  workers: BoardWorker[];
  dispatches: BoardDispatch[];
  blockers: number;
  hasActive: boolean;
  lastLogTail: string;
}

function diagnose(i: DiagnoseInput): BoardDiagnosis {
  if (!i.hasState) {
    return {
      level: "bad",
      title: "当前目录没有任务根",
      detail: "看板读不到 .capitalist/state.json。",
      fix: 'capitalist start "<目标>" --contract <任务列表名>',
    };
  }

  const live = i.workers.filter((w) => w.status === "running" || w.status === "starting");
  const last = i.workers[i.workers.length - 1];

  if (!i.supervisor) {
    return {
      level: "warn",
      title: "监工从未启动",
      detail: "只有任务根，没有 supervisor.json。没有进程在派单。",
      fix: "capitalist supervise --no-spawn（另一会话领单）或直接 capitalist supervise",
    };
  }

  if (!i.alive) {
    return {
      level: "warn",
      title: "监工已停",
      detail:
        `最后一次心跳 ${ageSec(i.supervisor.heartbeat_ts)}s 前，进程 pid ${i.supervisor.pid} 不运行中。` +
        (last ? ` 最近的工作进程 ${last.id} 为 ${last.status}；重启监工后该状态会重复出现。` : ""),
      fix: "capitalist supervise --force 重新接管（会清掉熔断计数）",
    };
  }

  if (last && (last.status === "failed" || last.status === "exited")) {
    const log = i.lastLogTail;
    const logLines = log.split("\n");
    const body = meaningfulLines(logLines).join("\n").trim();

    if (/Authentication required|not logged in|unauthorized/i.test(log)) {
      return {
        level: "bad",
        title: "工作进程缺认证",
        detail: `worker ${last.id} 以“需要登录”退出。`,
        fix: "在宿主 CLI 里登录后再派单；工作进程沿用宿主登录态，项目不注入令牌",
      };
    }
    if (/session ended/i.test(log)) {
      return {
        level: "bad",
        title: "宿主会话一建立就结束",
        detail: `worker ${last.id}（${last.host}）拿到 session 后立刻 ended，通常是该宿主没有可用模型或凭据。`,
        fix: "先在同机用该宿主的非交互入口执行一次验证，确认它能独立完成一轮",
      };
    }
    if (body === "") {
      return {
        level: "bad",
        title: "工作进程零输出退出",
        detail: `worker ${last.id}（${last.host}）只写了启动 banner 就结束，没有报错也没有回答。`,
        fix: "手动跑一次该宿主的 -p 入口并加超时，确认是认证、模型名还是端口占用",
      };
    }
    return {
      level: "warn",
      title: `最近一个 worker ${last.status}`,
      detail: `${last.id}（${last.host}）退出，退出码 ${last.note || "未知"}。`,
      fix: "展开该 worker 的日志看最后几十行",
    };
  }

  if (i.blockers > 0) {
    return {
      level: "warn",
      title: `状态里有 ${i.blockers} 条阻塞`,
      detail: "执行侧登记了阻塞，监工据此暂停派单或放行收工。",
      fix: "capitalist status 看清原因后 capitalist unblock",
    };
  }

  if (i.supervisor.max_workers === 0) {
    return {
      level: "warn",
      title: "监工不自动拉起 worker",
      detail: "以 --no-spawn 运行：只派单，等另一个会话 capitalist next 领走。",
      fix: "另开一个会话跑 capitalist next，做完 capitalist report <派单id> done",
    };
  }

  if (live.length > 0) {
    return {
      level: "ok",
      title: `${live.length} 个 worker 运行中`,
      detail: `宿主 ${i.supervisor.worker_host}，并行度 ${i.supervisor.max_workers}。`,
      fix: "",
    };
  }

  return {
    level: "ok",
    title: "监工在线，当前空闲",
    detail: i.hasActive ? "有一张单在途，等 worker 领。" : "等下一轮 tick 派单。",
    fix: "",
  };
}

const tailRowsCache = new Map<string, { key: string; rows: Array<Record<string, unknown>> }>();

function readJsonlFromTail(file: string, maxBytes: number): Array<Record<string, unknown>> {
  let key: string;
  try {
    const st = statSync(file);
    key = `${st.mtimeMs}:${st.size}:${maxBytes}`;
  } catch {
    return [];
  }
  const hit = tailRowsCache.get(file);
  if (hit && hit.key === key) return hit.rows;

  const rows: Array<Record<string, unknown>> = [];
  for (const line of tailLines(file, maxBytes)) {
    try {
      const v = JSON.parse(line) as Record<string, unknown>;
      if (v && typeof v === "object") rows.push(v);
    } catch {
    }
  }
  if (tailRowsCache.size > 64) tailRowsCache.clear();
  tailRowsCache.set(file, { key, rows });
  return rows;
}

function etagOf(body: string): string {
  return `"${createHash("sha256").update(body, "utf8").digest("hex").slice(0, 20)}"`;
}

function sendAsset(
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  etag: string,
  type: string,
  maxAge: number,
): void {
  const inm = req.headers["if-none-match"];
  const matched =
    typeof inm === "string" && inm.split(",").some((v) => v.trim() === etag);
  if (matched) {
    res.writeHead(304, { etag, "cache-control": `public, max-age=${maxAge}` });
    res.end();
    return;
  }
  res.writeHead(200, {
    "content-type": type,
    "content-length": Buffer.byteLength(body, "utf8"),
    "cache-control": `public, max-age=${maxAge}`,
    etag,
  });
  res.end(body);
}


/**
 * 监工对话层最近一次实际使用的模型，单独落一个文件。
 *
 * 不写 `supervisor.json`：监工每轮调度 用内存快照整份写回该文件，只同步 `supervisor_model`
 * 与上下文上限，别的字段会被抹掉。`supervisor_model` 为空时面板靠这份记录标出具体模型。
 */
function supervisorModelUsedFile(root: string): string {
  return join(supervisorDir(root), "capitalist-model-used.json");
}

function noteSupervisorModelUsed(root: string, model: string): void {
  const m = String(model || "").trim();
  if (!m) return;
  try {
    /* 显式指定了模型时跑的就是它，不是宿主默认，记了会把“宿主默认”标错行。 */
    if (String(loadSupervisor(root)?.supervisor_model ?? "").trim()) return;
    const cur = readJson<{ model?: string }>(supervisorModelUsedFile(root), {});
    if (String(cur?.model ?? "") === m) return;
    writeJson(supervisorModelUsedFile(root), { model: m, at: new Date().toISOString() });
  } catch {
    /* 记不住不影响这一轮对话本身。 */
  }
}

function readSupervisorModelUsed(root: string): string {
  try {
    const d = readJson<{ model?: string }>(supervisorModelUsedFile(root), {});
    return String(d?.model ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * 前端产物缺失时的提示页。
 *
 * 看板只提供 Vue 版本，页面由 `dist/board-web` 托管；产物未构建时给出可执行命令，
 * 不再回落到内联页面。API 路由不受影响，命令行与看板接口保持可用。
 */
function missingBoardWebPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>capitalist · 看板前端未构建</title>
<style>
body{margin:0;padding:48px 24px;font:14px/1.7 -apple-system,"Segoe UI",sans-serif;color:#1f2328;background:#f6f7f9}
main{max-width:640px;margin:0 auto}
h1{font-size:18px;margin:0 0 12px}
p{margin:0 0 12px;color:#4b5563}
code{display:block;padding:10px 12px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
</style>
</head>
<body>
<main>
<h1>看板前端未构建</h1>
<p>服务已启动，缺少页面产物 <code style="display:inline;padding:2px 6px">dist/board-web/index.html</code>。</p>
<p>在项目内执行构建，然后刷新本页：</p>
<code>cd packages/supervisor &amp;&amp; npm run build:web</code>
<p>API 与命令行不受影响。</p>
</main>
</body>
</html>`;
}

function boardWebDir(): string {
  // 本文件编译后位于 dist/supervisor/，前端产物位于 dist/board-web/，需向上一级查找。
  return join(__dirname, "..", "board-web");
}

const BOARD_WEB_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** resolve 之后路径必须仍在 board-web 目录内，目录索引与隐藏文件一律拒绝。 */
function serveBoardWeb(req: IncomingMessage, res: ServerResponse, url: string): boolean {
  const base = resolve(boardWebDir());
  const rawPath = url.split(/[?#]/)[0] ?? "/";
  let rel: string;
  try {
    rel = decodeURIComponent(rawPath);
  } catch {
    return false;
  }
  if (rel === "" || rel === "/") rel = "/index.html";
  // 前导 / 先换成 ./ 再 resolve，否则会被当成盘符根并越过产物目录。
  const full = resolve(base, `.${rel}`);
  if (full !== base && !full.startsWith(base + sep)) return false;

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(full);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;

  const ext = extname(full).toLowerCase();
  const type = BOARD_WEB_TYPES[ext];
  if (!type) return false;

  const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const inm = req.headers["if-none-match"];
  if (typeof inm === "string" && inm.split(",").some((v) => v.trim() === etag)) {
    res.writeHead(304, { etag, "cache-control": "no-cache" });
    res.end();
    return true;
  }
  const body = readFileSync(full);
  const cache = ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable";
  res.writeHead(200, {
    "content-type": type,
    "content-length": body.length,
    "cache-control": cache,
    etag,
  });
  res.end(body);
  return true;
}

const STATE_MAX_BYTES = 20_000;
const ALERT_MAX_BYTES = 30_000;

/** since 接受 epoch 秒、毫秒与 ISO；无法解析按不限处理并回 0，非正数同样按不限。 */
function parseSince(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  const num = Number(text);
  if (Number.isFinite(num)) {
    if (num <= 0) return undefined;
    return num > 1e12 ? num / 1000 : num;
  }
  const ts = Date.parse(text);
  return Number.isFinite(ts) && ts > 0 ? ts / 1000 : undefined;
}

/** 结构化裁剪后仍超预算时从最旧数据开始丢弃，并在响应里标明。 */
function fitState(snap: BoardSnapshot): string {
  const body = {
    ...snap,
    serverTime: new Date().toISOString(),
    truncated: false,
    total: snap.workers_total,
    has_more: snap.workers.length < snap.workers_total,
  };
  let text = JSON.stringify(body);
  while (Buffer.byteLength(text, "utf8") > STATE_MAX_BYTES) {
    if (body.workers.length > 5) {
      body.workers = body.workers.slice(1);
    } else if (body.dispatches.length > 3) {
      body.dispatches = body.dispatches.slice(0, -1);
    } else if (body.feed.length > 0) {
      body.feed = body.feed.slice(0, -1);
    } else {
      break;
    }
    body.truncated = true;
    body.has_more = true;
    text = JSON.stringify(body);
  }
  return text;
}

/** 监工被强制结束后由看板回收其拉起的工作进程。 */
function watchOrphanSupervisors(root: string, out: (s: string) => void): () => void {
  const handled = new Set<string>();

  const tick = (): void => {
    let rec: SupervisorRecord | null = null;
    try {
      rec = loadSupervisor(root);
    } catch {
      return;
    }
    if (!rec || rec.status !== "running") return;
    if (!Number.isInteger(rec.pid) || rec.pid <= 0 || rec.pid === process.pid) return;
    if (pidAlive(rec.pid)) return;

    const key = `${root}|${rec.pid}`;
    if (handled.has(key)) return;

    try {
      const live = listWorkers(root).filter(
        (w) => (w.status === "running" || w.status === "starting") && w.supervisor_pid === rec!.pid,
      );
      if (live.length === 0) {
        handled.add(key);
        return;
      }
      const reaped = reapOrphans(root, out, { onlySupervisorPid: rec.pid });
      handled.add(key);
      out(
        `[看板] 监工 pid ${rec.pid} 已不在（记录状态仍是 running，判定被强杀），` +
          `收掉它拉起的 ${reaped.length} 个 worker`,
      );
    } catch (err) {
      out(`[看板] 收孤儿失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const timer = setInterval(tick, 5000);
  timer.unref?.();
  setTimeout(tick, 2500).unref?.();

  return () => clearInterval(timer);
}

export interface ServeOptions {  root: string;
  port?: number | undefined;
  host?: string | undefined;
  maxPortTries?: number;
  newKey?: boolean;
  /** 安全模式：校验访问 key。缺省关闭。 */
  secure?: boolean | undefined;
  /**
   * 宿主令牌，启动监工时一次性传入，仅在内存持有。
   *
   * 监工进程通常无法获取宿主登录态文件的读取权限（桌面端对本机文件访问单独授权）。
   * 返回空值将导致对话通道与工作进程同时认证失败；由启动方传入时不再读取文件。
   */
  token?: string | undefined;
  out?: (line: string) => void;
  onMq?: () => void;
}

export interface Served {
  server: Server;
  url: string;
  port: number;
  close: () => void;
}

const WORKER_TERMINAL = new Set(["exited", "failed", "done"]);

/** 从列表消失只是结束的一种来源，判结束还要看终态记录或 pid 是否存活。 */
function workerGone(w: WorkerRecord): boolean {
  if (WORKER_TERMINAL.has(w.status)) return true;
  return w.mode !== "visible" && w.pid > 0 && !pidAlive(w.pid);
}

/** 仅当 .capitalist/board.pid 的 pid、端口、任务根三者都匹配时才回收占用端口的旧看板，且只给一次机会。 */
async function reclaimStaleBoard(root: string, port: number): Promise<boolean> {
  try {
    const rec = readJson<{ pid?: number; port?: number; root?: string } | null>(join(root, ".capitalist", "board.pid"), null);
    if (!rec || !rec.pid || Number(rec.port) !== port) return false;
    if (rec.root && resolve(rec.root) !== resolve(root)) return false;
    try {
      process.kill(Number(rec.pid), "SIGTERM");
    } catch {
      return false;
    }
    /** SIGTERM 到内核回收句柄之间存在间隙，需等端口真正释放再 listen。 */
    await new Promise((r) => setTimeout(r, 500));
    return true;
  } catch {
    return false;
  }
}

/** 默认只监听回环地址；对外网卡开放需显式传 --host。 */
export async function serveBoard(opts: ServeOptions): Promise<Served> {
  const out = opts.out ?? ((s: string) => process.stdout.write(`${s}\n`));
  const host = opts.host ?? "127.0.0.1";
  const tries = opts.maxPortTries ?? 20;
  const base = opts.port ?? 7788;

  BOARD_SECURE = opts.secure === true;
  BOARD_KEY = loadOrCreateBoardKey(opts.root, opts.newKey === true);

  /** SSE 单一通道 output，只推工作进程日志增量；每帧带自增 seq，收尾帧带 done。 */
  const viewCache = new Map<string, { at: number; val: unknown }>();
  const cachedView = <T,>(key: string, ttlMs: number, build: () => T): T => {
    const now = Date.now();
    const hit = viewCache.get(key);
    if (hit !== undefined && now - hit.at < ttlMs) return hit.val as T;
    const val = build();
    viewCache.set(key, { at: now, val });
    if (viewCache.size > 64) {
      for (const [k, v] of viewCache) if (now - v.at > 60_000) viewCache.delete(k);
    }
    return val;
  };

  const stopOrphanWatch = watchOrphanSupervisors(opts.root, (s) => {
    opts.out?.(s);
  });

  /** 工作进程记录按 400ms 共享一次读取，跨连接复用。 */
  let workersCache: { at: number; list: ReturnType<typeof listWorkers> } = { at: 0, list: [] };
  const workersNow = (root: string): ReturnType<typeof listWorkers> => {
    const now = Date.now();
    if (now - workersCache.at < 400 && workersCache.list.length > 0) return workersCache.list;
    const list = listWorkers(root);
    workersCache = { at: now, list };
    return list;
  };

  const sse = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const send = (event: string, data: unknown): void => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
      }
    };

    const logOffsets = new Map<string, number>();
    const seqs = new Map<string, number>();
    /** 同一个 id 只发一次 done，重连不重发。 */
    const doneSent = new Set<string>();
    const known = new Set<string>();
    const streamModes = new Map<string, boolean>();
    const modeOf = (rec: WorkerRecord): boolean => {
      const caused = streamModes.get(rec.id);
      if (caused !== undefined) return caused;
      let mode = false;
      try {
        mode = parseWorkerLog(tailLines(rec.log, 65_536)).stream;
      } catch {
        mode = false;
      }
      streamModes.set(rec.id, mode);
      return mode;
    };
    for (const w of workersNow(opts.root)) {
      known.add(w.id);
      if (w.log) logOffsets.set(w.id, fileSize(w.log));
      // 连上时已结束的工作进程不补 done，全文由 /api/thread 首轮拉取负责。
      if (workerGone(w)) doneSent.add(w.id);
    }

    const nextSeq = (id: string): number => {
      const n = (seqs.get(id) ?? 0) + 1;
      seqs.set(id, n);
      return n;
    };

    const timer = setInterval(() => {
      try {
        const workers = workersNow(opts.root);
        for (const w of workers) {
          known.add(w.id);
          if (doneSent.has(w.id)) continue;
          if (!w.log) continue;
          const from = logOffsets.get(w.id);
          if (from === undefined) {
            logOffsets.set(w.id, alignToLine(w.log, Math.max(0, fileSize(w.log) - NEW_WORKER_TAIL_BYTES)));
            continue;
          }
          const r = readDelta(w.log, from, 8192);
          logOffsets.set(w.id, r.next);
          if (r.text) {
            const text = meaningfulLines(r.text.split("\n"), modeOf(w)).join("\n");
            if (text !== "") {
              send("output", {
                worker: w.id,
                host: w.host,
                seq: nextSeq(w.id),
                text,
                at: new Date().toISOString(),
              });
            }
          }
        }

        // 收尾帧置于输出之后。
        // 收尾同时释放 logOffsets，否则会随历史工作进程持续增长。
        const live = new Map(workers.map((w) => [w.id, w] as const));
        for (const id of known) {
          if (doneSent.has(id)) continue;
          const w = live.get(id);
          if (w && !workerGone(w)) continue;
          doneSent.add(id);
          logOffsets.delete(id);
          send("output", { worker: id, seq: nextSeq(id), text: "", done: true, at: new Date().toISOString() });
        }
      } catch {
      }
    }, 500);

    // 心跳用注释行发送，不触发客户端逻辑。
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
      }
    }, 15_000);

    // 连接关闭时清掉该连接的所有定时器；req 与 res 的 close 都挂上，stop 幂等。
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearInterval(ping);
      try {
        res.end();
      } catch {
      }
    };
    req.on("close", stop);
    req.on("error", stop);
    res.on("close", stop);
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? "/";
    /** 页面、静态资源、API、SSE、health 都要先过鉴权。 */
    if (!guardBoardAccess(req, res, url)) return;
    /*
     * 任何写请求进来先清一次读缓存。
     *
     * 前端在操作后立刻重新拉数据；缓存仍留着上一轮的线程列表或派单快照时，
     * 界面停在被操作之前的状态，操作没有反应。写请求进入时清空，下一次 GET 重建。
     */
    if (req.method !== "GET" && req.method !== "HEAD" && url.startsWith("/api/")) invalidateBoardCaches();
    if (url === "/stream" || url.startsWith("/stream?")) {
      sse(req, res);
      return;
    }
    if (url === "/api/tasks" || url.startsWith("/api/tasks?")) {
      try {
        const tasks = cachedView(`tasks:${opts.root}`, 4000, () => buildTaskSummaries(listTaskRoots(opts.root)));
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ serverTime: new Date().toISOString(), tasks }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
      }
      return;
    }
    /** 结构、状态归一与堵点标记在 forestView.ts 计算；台账是唯一数据源，前端不拼 jsonl、不留结构副本。 */
    if (url === "/api/forest" || url.startsWith("/api/forest?")) {
      try {
        const root = rootFromUrl(url, opts.root);
        const view = buildForestView(root, forestNoOf(root));
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ serverTime: new Date().toISOString(), ...view }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
      }
      return;
    }
    if (url === "/api/metrics" || url.startsWith("/api/metrics?")) {
      try {
        const root = rootFromUrl(url, opts.root);
        const metrics = cachedView(`metrics:${root}`, 4000, () => buildMetrics(root));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ serverTime: new Date().toISOString(), root, ...metrics }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
      }
      return;
    }
    if (url === "/api/usage" || url.startsWith("/api/usage?")) {
      try {
        const root = rootFromUrl(url, opts.root);
        const ledger = cachedView(`usage:${root}`, 3000, () => usageLedger(root));
        const titles = new Map(readDispatches(root).map((d) => [d.id, dispatchTitle(d)] as const));
        const byDispatch = ledger.by_dispatch.map((r) => ({ ...r, title: titles.get(r.id) ?? "" }));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            root,
            ...ledger,
            by_dispatch: byDispatch,
          }),
        );
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
      }
      return;
    }
    if (url.startsWith("/api/models")) {
      try {
        const qs = url.indexOf("?") >= 0 ? new URLSearchParams(url.slice(url.indexOf("?") + 1)) : null;
        const root = rootFromUrl(url, opts.root);
        const view = modelsView(root, qs?.get("fresh") === "1");
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ root, ...view }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
      }
      return;
    }
    if (url.startsWith("/api/fs-list")) {
      try {
        /** 该接口能列本机目录，只接受本机回环来源。 */
        const peer = req.socket.remoteAddress ?? "";
        const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
        if (!loopback) {
          res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ error: "目录浏览只接受本机回环地址" }));
          return;
        }
        const qs = url.indexOf("?") >= 0 ? new URLSearchParams(url.slice(url.indexOf("?") + 1)) : new URLSearchParams();
        const root = rootFromUrl(url, opts.root);
        const want = String(qs.get("path") ?? "").trim();
        const abs = want ? (isAbsolute(want) ? resolve(want) : resolve(root, want)) : root;
        const outside = !(abs === root || abs.startsWith(root + sep));
        const SKIP = new Set([".capitalist", ".git", "node_modules", ".tmp", ...all().map((h) => h.configDir)]);
        const entries = readdirSync(abs, { withFileTypes: true })
          .filter((e) => !SKIP.has(e.name) && !(e.name.startsWith(".") && e.name !== ".env"))
          .map((e) => {
            const full = join(abs, e.name);
            return {
              name: e.name,
              dir: e.isDirectory(),
              rel: outside ? full : relative(root, full).split(sep).join("/"),
              outside,
              size: e.isDirectory() ? 0 : (() => {
                try {
                  return statSync(full).size;
                } catch {
                  return 0;
                }
              })(),
            };
          })
          .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
          .slice(0, 500);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(
          JSON.stringify({
            root,
            path: abs,
            rel: outside ? abs : relative(root, abs).split(sep).join("/"),
            outside,
            entries,
          }),
        );
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
      }
      return;
    }
    if (url === "/api/overview" || url.startsWith("/api/overview?")) {
      try {
        const roots = listTaskRoots(opts.root);
        const fresh = new URL(url, "http://x").searchParams.has("fresh");
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(overviewJson(roots, fresh));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
      }
      return;
    }
    if (url.startsWith("/api/state")) {
      try {
        const root = rootFromUrl(url, opts.root);
        const snap = cachedView(`snapshot:${root}`, 4000, () => buildSnapshot(root));
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(fitState(snap));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
      }
      return;
    }
    /** 推送只唤醒监工；内容以 .capitalist/mq/reports.jsonl 为准，按 cursor 顺序读取，推送丢失、重复或乱序不影响队列。 */
    if (url === "/api/mq" || url.startsWith("/api/mq?")) {
      const peer = req.socket.remoteAddress ?? "";
      const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
      if (!loopback) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "申报接口只接受本机回环地址" }));
        return;
      }
      req.resume(); // 丢弃请求体（内容以文件为准）
      req.on("end", () => {
        try {
          opts.onMq?.();
        } catch {
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (url === "/api/attachments" || url.startsWith("/api/attachments?")) {
      try {
        const rows = readJsonl<{ path?: string; thread?: string; tag?: string; at?: string; name?: string }>(
          join(supervisorDir(opts.root), "attachments", "index.jsonl"),
        );
        const map: Record<string, { thread: string; tag: string; at: string; name: string }> = {};
        for (const r of rows) {
          const p = String(r.path ?? "");
          if (!p) continue;
          map[p] = {
            thread: String(r.thread ?? ""),
            tag: String(r.tag ?? ""),
            at: String(r.at ?? ""),
            name: String(r.name ?? ""),
          };
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ count: Object.keys(map).length, items: map }));
      } catch {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ count: 0, items: {} }));
      }
      return;
    }
    if (url === "/api/threads" || url.startsWith("/api/threads?")) {
      try {
        const root = rootFromUrl(url, opts.root);
        const q = url.indexOf("?") >= 0 ? new URLSearchParams(url.slice(url.indexOf("?") + 1)) : new URLSearchParams();
        const want = Number(q.get("limit"));
        const limit = Number.isFinite(want) && want > 0 ? Math.min(Math.floor(want), 500) : THREAD_PAGE_LIMIT;
        const page = cachedView(`threads:${root}:${limit}`, 4000, () => buildThreadsPage(root, limit));
        const now = new Date().toISOString();
        const balance = balanceView(root);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(
          JSON.stringify({
            serverTime: now,
            lastUpdated: now,
            root,
            takeover: activeTakeover(root),
            ...page.totals,
            credit: balance.credit,
            credit_used: balance.credit_used,
            credit_left: balance.credit,
            credit_unit: balance.credit_unit,
            credit_at: balance.at,
            credit_source: balance.source,
            credit_stale: balance.stale,
            balance,
            credit_unavailable_reason: balance.reason,
            file_locks: (() => {
              try {
                const { locks } = lockStatus(root);
                const nowMs = Date.now();
                return {
                  count: locks.length,
                  items: locks.slice(0, 20).map((e) => {
                    const beat = Date.parse(e.beat);
                    return {
                      path: e.path,
                      mode: e.mode,
                      holder: e.holder,
                      since: e.since,
                      age_sec: Number.isFinite(beat) ? Math.max(0, Math.round((nowMs - beat) / 1000)) : -1,
                    };
                  }),
                };
              } catch {
                return { count: 0, items: [] };
              }
            })(),
            total: page.total,
            truncated: page.truncated,
            counts: page.counts,
            threads: page.threads,
          }),
        );
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
      }
      return;
    }
    if (url.startsWith("/api/thread")) {
      const q = url.indexOf("?") >= 0 ? new URLSearchParams(url.slice(url.indexOf("?") + 1)) : new URLSearchParams();
      const id = q.get("id");
      if (!id) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "缺少 id 参数" }));
        return;
      }
      const root = rootFromUrl(url, opts.root);
      const limitRaw = Number(q.get("limit"));
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 2000) : 400;
      const since = parseSince(q.get("since")) ?? 0;
      try {
        const base = buildThreadMessages(root, id, q.get("shard") ?? "", { limit, since });
        /** 工作进程会话的对话记在 events.jsonl 并带 thread 标识，需并入消息流。 */
        const talkIds = ((): Set<string> => {
          if (!id.includes("/")) return new Set([id]);
          const parts = id.split("/");
          const st = String(parts[0] ?? "").trim().toLowerCase();
          const tail = String(parts[1] ?? "").trim().toLowerCase();
          const workers = listWorkers(root);
          const isLineage =
            /^x[0-9a-z]{3,}$/.test(tail) &&
            !workers.some((w) => String(w.shard ?? "").trim().toLowerCase() === tail);
          const sh = tail === "main" || isLineage ? "" : tail;
          const linTail = isLineage ? tail.slice(1) : "";
          const rows = linTail ? readDispatches(root) : [];
          return new Set([
            id,
            ...workers
              .filter((w) => {
                if (String(w.stage || "").trim().toLowerCase() !== st) return false;
                if (sh) return String(w.shard ?? "").trim().toLowerCase() === sh;
                if (String(w.shard ?? "").trim()) return false;
                if (!linTail) return true;
                const d = w.dispatch ? rows.find((x) => x.id === w.dispatch) : undefined;
                return String((d as { lineage?: string } | undefined)?.lineage ?? "").endsWith(linTail);
              })
              .map((w) => w.id),
          ]);
        })();
        const talkRows = readJsonlFromTail(eventsFile(root), 2_000_000).filter((e) => {
          const n = String(e.event ?? e.kind ?? "");
          return (n === "supervisor_chat_ask" || n === "supervisor_reply") && talkIds.has(String(e.thread ?? ""));
        });
        /** 同一句用户发言会落 supervisor_chat_ask 与 direct.jsonl 两条记录，按正文归一判同去重。 */
        const normTalk = (s: unknown): string =>
          String(s ?? "")
            .replace(/^\[附件\][^\n]*$/gm, "")
            .replace(/\s+/g, "")
            .toLowerCase();
        const saidRows = base.messages.filter((m) => m.role === "user" && m.kind === "say");
        const said = new Set(saidRows.map((m) => normTalk(m.text)));
        const mergeActedEcho = (
          e: Record<string, unknown>,
          role: ThreadRole,
        ): ThreadMessage | null => {
          const replyText = String(e.reply ?? "");
          const body = String((e as { dispatch_text?: unknown }).dispatch_text ?? e.want ?? "");
          const leftover = stripDispatchEcho(replyText, body);
          const atN = Date.parse(String(e.at ?? "")) || 0;
          /** 同一时间窗（10 秒）内才算同一条。 */
          const near = (m: ThreadMessage): boolean =>
            Math.abs((Date.parse(String(m.at ?? "")) || 0) - atN) < 10_000;
          const hit = body
            ? base.messages.find((m) => {
                if (!near(m)) return false;
                if (m.kind === "say" && m.role === "supervisor") {
                  return normTalk(m.text) === normTalk(`amend ${body}`);
                }
                if (m.kind === "verdict") {
                  const vt = String(m.text ?? "");
                  const bodyClean = normTalk(body.replace(/^\s*#\s*\d{1,4}\s*/, ""));
                  return vt.startsWith("派单 ") && vt.includes("追加内容") && normTalk(vt).includes(bodyClean);
                }
                if (m.kind === "dispatch") {
                  return normTalk(String(m.text ?? "")).includes(normTalk(body));
                }
                return false;
              })
            : undefined;
          if (hit) {
            if (leftover) hit.text = `${hit.text}\n${leftover}`;
            return null;
          }
          if (!leftover) return null;
          return {
            id: `CH-${fingerprint(e)}`,
            at: String(e.at ?? ""),
            role,
            kind: "say",
            text: leftover,
            tool: "",
            cmd: "",
            status: "",
            thread: id,
          } as ThreadMessage;
        };
        const talk = talkRows
          .filter((e) => {
            const isAsk = String(e.event ?? e.kind) === "supervisor_chat_ask";
            if (!isAsk) return true;
            if (!said.has(normTalk(e.text))) return true;
            const askAt = Date.parse(String(e.at ?? "")) || 0;
            return !saidRows.some((m) => {
              if (normTalk(m.text) !== normTalk(e.text)) return false;
              const sayAt = Date.parse(String(m.at ?? "")) || 0;
              return Math.abs(askAt - sayAt) < 5_000;
            });
          })
          .map((e) => {
          const isAsk = String(e.event ?? e.kind) === "supervisor_chat_ask";
          /** 角色以写入时的 from 字段为准，旧记录缺该字段才按事件名回落。 */
          const from = String((e as { from?: unknown }).from ?? "");
          const role: ThreadRole =
            from === "user" || from === "supervisor" || from === "worker"
              ? (from as ThreadRole)
              : ((isAsk ? "user" : "supervisor") as ThreadRole);
          if (!isAsk && (e as { acted?: unknown }).acted === true) return mergeActedEcho(e, role);
          return {
            id: `CH-${fingerprint(e)}`,
            at: String(e.at ?? ""),
            role,
            kind: "say" as ThreadKind,
            text: isAsk ? String(e.text ?? "") : String(e.reply ?? ""),
            tool: "",
            cmd: "",
            status: "",
            ref: "",
            unread: false,
            thread: id,
            /** 引用随事件原样下发，写入时已持久化，重建与实时发送同一口径。 */
            ...(isAsk && String((e as { quote?: unknown }).quote ?? "")
              ? {
                  quote: String((e as { quote?: unknown }).quote),
                  ...(String((e as { quote_text?: unknown }).quote_text ?? "")
                    ? { quote_text: String((e as { quote_text?: unknown }).quote_text) }
                    : {}),
                }
              : {}),
          } as ThreadMessage;
        })
          .filter((m): m is ThreadMessage => m !== null)
          .filter((m) => m.text.trim() !== "");
        const sameSaid = (a: ThreadMessage, b: ThreadMessage): boolean => {
          if (String(a.role) !== "user" || String(b.role) !== "user") return false;
          const ka = String(a.text ?? "").trim();
          if (!ka || ka !== String(b.text ?? "").trim()) return false;
          const ta = Date.parse(String(a.at ?? "")) || 0;
          const tb = Date.parse(String(b.at ?? "")) || 0;
          return Math.abs(ta - tb) < 5000;
        };
        const baseKept = base.messages.filter((m) => !talk.some((t) => sameSaid(m, t)));
        const messages = [...baseKept, ...talk].sort((a, b) => String(a.at).localeCompare(String(b.at)));
        const total = base.total + talk.length;
        const next_since = base.next_since;
        loadThreadSeen(root);
        threadSeen.set(id, Date.now() / 1000);
        saveThreadSeen(root);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            root,
            id,
            since,
            total,
            truncated: total > messages.length,
            next_since,
            messages,
          }),
        );
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
      }
      return;
    }
    if (url === "/api/command") {
      // 写操作只接受本机回环来源。
      const peer = req.socket.remoteAddress ?? "";
      const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
      if (!loopback) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "命令接口只接受本机回环地址" }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
        res.end(JSON.stringify({ error: "只接受 POST" }));
        return;
      }
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
        if (body.length > 1_000_000) req.destroy();
      });
      req.on("end", () => {
        let parsed: unknown;
        try {
          parsed = body.trim() ? JSON.parse(body) : {};
        } catch {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "JSON 解析失败" }));
          return;
        }
        const r = runCommand(opts.root, parsed);
        res.writeHead(r.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(r.body));
      });
      return;
    }
    if (url === "/api/ctx-window" || url.startsWith("/api/ctx-window?")) {
      const peer = req.socket.remoteAddress ?? "";
      const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
      if (!loopback) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "该接口只接受本机回环地址" }));
        return;
      }
      const reply = (code: number, body: unknown): void => {
        res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(body));
      };
      /* 作用域：supervisor 是监工自己，其余为工作进程 id；监工与各工作进程互不影响。 */
      const q = url.indexOf("?") >= 0 ? new URLSearchParams(url.slice(url.indexOf("?") + 1)) : new URLSearchParams();
      const scopeOfQuery = (): string => {
        const s = String(q.get("scope") ?? "").trim();
        return s || "supervisor";
      };
      const modelOfScope = (scope: string): string => {
        if (scope === "supervisor" || scope === "default") return String(buildSupervisorStatus(opts.root).model ?? "");
        const w = listWorkers(opts.root).find((x) => String(x.id) === scope);
        return w ? String(workerUsageRow(w).model ?? "") : "";
      };
      if (req.method === "GET") {
        const scope = scopeOfQuery();
        const curModel = modelOfScope(scope);
        reply(200, {
          scope,
          window: readCtxWindow(opts.root, scope),
          chosen: readCtxWindowChosen(opts.root, scope),
          default: readCtxWindowChosen(opts.root, "default"),
          presets: CTX_WINDOW_PRESETS,
          model: curModel,
          real: modelRealWindow(curModel, null),
        });
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET, POST" });
        res.end(JSON.stringify({ error: "只接受 GET / POST" }));
        return;
      }
      let body = "";
      req.on("data", (c: Buffer) => {
        body += c.toString("utf8");
        if (body.length > 10_000) req.destroy();
      });
      req.on("end", () => {
        let parsed: { window?: number; force?: boolean; scope?: string } = {};
        try {
          parsed = body.trim() ? (JSON.parse(body) as typeof parsed) : {};
        } catch {
          reply(400, { error: "JSON 解析失败" });
          return;
        }
        const want = Math.round(Number(parsed.window));
        if (!isCtxWindowPreset(want)) {
          reply(400, { error: "只能是 300k / 600k / 1M 三档" });
          return;
        }
        const scope = String(parsed.scope ?? "").trim() || scopeOfQuery();
        const curModel = modelOfScope(scope);
        const check = ctxWindowSupported(curModel, null, want);
        if (!check.supported && !parsed.force) {
          reply(409, {
            supported: false,
            scope,
            window: want,
            real: check.real,
            model: curModel,
            message: check.real
              ? `${curModel} 的窗口是 ${Math.round(check.real / 1000)}k，设不到 ${Math.round(want / 1000)}k。`
              : `${curModel} 没有窗口读数，无法确认是否支持 ${Math.round(want / 1000)}k。`,
          });
          return;
        }
        const ok = writeCtxWindow(opts.root, want, scope);
        reply(ok ? 200 : 500, { ok, scope, window: want, supported: check.supported });
      });
      return;
    }
    if (url === "/api/alerts" || url.startsWith("/api/alerts?")) {
      try {
        const q =
          url.indexOf("?") >= 0 ? new URLSearchParams(url.slice(url.indexOf("?") + 1)) : new URLSearchParams();
        const lvlParam = q.get("level");
        const level = lvlParam === "P0" || lvlParam === "P1" || lvlParam === "P2" ? lvlParam : undefined;
        const rawLimit = Number(q.get("limit"));
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : undefined;
        const sinceRaw = (q.get("since") ?? "").trim();
        const since: number | string | undefined = parseSince(sinceRaw) ?? (sinceRaw || undefined);
        const root = rootFromUrl(url, opts.root);

        const { alerts, unread, total, has_more, next_since } = buildAlerts(root, { level, limit, since });
        const payload = {
          serverTime: new Date().toISOString(),
          level: level ?? "all",
          since: since ?? 0,
          limit: limit ?? ALERT_LIMIT_DEFAULT,
          total,
          has_more,
          truncated: total > alerts.length,
          next_since,
          unread,
          alerts,
        };
        while (Buffer.byteLength(JSON.stringify(payload), "utf8") > ALERT_MAX_BYTES && payload.alerts.length > 0) {
          payload.alerts.pop();
          payload.truncated = true;
        }
        payload.has_more = payload.total > payload.alerts.length;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(payload));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
      }
      return;
    }
    if (url === "/api/supervisor/self" || url.startsWith("/api/supervisor/self?")) {
      try {
        const root = rootFromUrl(url, opts.root);
        const view = cachedView(`supervisorstatus:${root}`, 1500, () => buildSupervisorStatus(root));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ serverTime: new Date().toISOString(), root, ...view }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
      }
      return;
    }
    if (url === "/api/capitalist-events" || url.startsWith("/api/capitalist-events?")) {
      try {
        const root = rootFromUrl(url, opts.root);
        const q = url.indexOf("?") >= 0 ? new URLSearchParams(url.slice(url.indexOf("?") + 1)) : new URLSearchParams();
        const want = Number(q.get("limit"));
        const limit = Number.isFinite(want) && want > 0 ? Math.floor(want) : 120;
        /** hours 不传按 6 小时，传 0 表示不限；解析不了按未传处理。 */
        const hRaw = Number(q.get("hours"));
        const hours = q.has("hours") && Number.isFinite(hRaw) && hRaw >= 0 ? hRaw : undefined;
        const log = buildSupervisorLog(root, { limit, ...(hours === undefined ? {} : { hours }) });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ serverTime: new Date().toISOString(), root, ...log }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
      }
      return;
    }
    if (url === "/api/capitalist-command") {
      const peer = req.socket.remoteAddress ?? "";
      const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
      if (!loopback) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "指令接口只接受本机回环地址" }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
        res.end(JSON.stringify({ error: "只接受 POST" }));
        return;
      }
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
        if (body.length > 10_000) req.destroy();
      });
      req.on("end", () => {
        let parsed: Record<string, unknown>;
        try {
          parsed = body.trim() ? (JSON.parse(body) as Record<string, unknown>) : {};
        } catch {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "JSON 解析失败" }));
          return;
        }
        const input: { text?: string; action?: string; arg?: string; confirm?: boolean; via?: "user" | "capitalist" } = {};
        if (typeof parsed.text === "string") input.text = parsed.text;
        if (typeof parsed.action === "string") input.action = parsed.action;
        if (typeof parsed.arg === "string") input.arg = parsed.arg;
        if (parsed.confirm === true) input.confirm = true;
        // 该接口的指令来源记为 user；监工落的指令走 /api/capitalist-chat 的 DO 行并带 via:"capitalist"。
        input.via = "user";

        /** 只接受已知任务根，其余回落本看板自己的根；关停写停止哨兵，不进指令队列。 */
        const targetRoot =
          typeof parsed.root === "string" && parsed.root.trim()
            ? listTaskRoots(opts.root).includes(resolve(parsed.root.trim()))
              ? resolve(parsed.root.trim())
              : opts.root
            : opts.root;

        if (input.action === "stop") {
          /** 先写停止哨兵再结束进程；结束失败时监工下一轮调度 仍会自行退出。 */
          const rec = loadSupervisor(targetRoot);
          requestSupervisorStop(targetRoot, "看板指标条：用户关停");
          let killedPid = 0;
          const pid = Number(rec?.pid ?? 0);
          if (pid > 0) {
            try {
              process.kill(pid, "SIGTERM");
              killedPid = pid;
            } catch {
            }
          }
          recordEvent(targetRoot, "supervisor_stop", { by: "user", via: "board", pid: killedPid });
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(
            JSON.stringify({
              ok: true,
              action: "stop",
              root: targetRoot,
              killed: killedPid,
              effective: killedPid
                ? `已立即关停（结束进程 ${killedPid}）；进度已保存，重新执行 capitalist supervise 后按恢复计划继续`
                : "停止请求已写入，监工在下一 tick 退出",
            }),
          );
          return;
        }

        if (input.action === "stop-all") {
          const roots = listTaskRoots(opts.root);
          const stopped: string[] = [];
          const killed: number[] = [];
          const skipped: string[] = [];
          for (const r of roots) {
            const rec = loadSupervisor(r);
            if (!rec) {
              skipped.push(r);
              continue;
            }
            requestSupervisorStop(r, "看板：用户关停所有");
            stopped.push(r);
            const pid = Number(rec.pid);
            if (pid > 0) {
              try {
                process.kill(pid, "SIGTERM");
                killed.push(pid);
              } catch {
              }
            }
          }
          recordEvent(opts.root, "supervisor_stop_all", {
            by: "user",
            via: "board",
            roots: stopped.length,
            killed,
          });
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(
            JSON.stringify({
              ok: true,
              action: "stop-all",
              roots: stopped.length,
              killed: killed.length,
              skipped: skipped.length,
              effective: stopped.length
                ? `已立即关停 ${stopped.length} 个监工${killed.length ? `（结束 ${killed.length} 个进程）` : ""}；进度已保存，重新执行 capitalist supervise 后按恢复计划继续`
                : "没有可关停的监工：这些任务根上都没有运行中的监工记录",
            }),
          );
          return;
        }

        if (input.action === "restart") {
          const capitalist = loadSupervisor(targetRoot) as Record<string, unknown> | null;
          if (!capitalist || !Number(capitalist.pid)) {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(
              JSON.stringify({
                ok: false,
                error: "这个任务根上没有运行中的监工记录（从未启动或已归档），没有可重启的进程；请先 capitalist supervise",
              }),
            );
            return;
          }
          const last = restartAt.get(targetRoot) ?? 0;
          if (Date.now() - last < RESTART_COOLDOWN_MS) {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ ok: false, error: "刚发起过重启，等新进程起来再看（15 秒内不重复拉起）" }));
            return;
          }
          restartAt.set(targetRoot, Date.now());

          const cli = process.argv[1] ?? "";
          const target = String(capitalist.target ?? "").trim() || "监工";
          const args = [cli, "supervise", target, "--root", targetRoot];
          const contract = String(capitalist.contract ?? "").trim();
          if (contract) args.push("--contract", contract);
          const workers = Number(capitalist.max_workers);
          if (Number.isFinite(workers) && workers > 0) args.push("--workers", String(workers));
          /*
           * 工作进程宿主不在重启参数里：新进程按自身宿主环境重新判定，与首次启动同一口径。
           * 透传旧的 worker_host 会让判定结果被历史值锁定。
           */
          /* 透传宿主声明（--agent）。 */
          const declaredHost = hostOverrideOf();
          if (declaredHost) args.push("--agent", declaredHost);

          /** 先把拉起器派出去，再请求停止；宿主端口不能被继承。 */
          const env = { ...process.env };
          delete env.SERVER__PORT;
          env.CAPITALIST_RELAUNCH_PID = String(Number(capitalist.pid));
          env.CAPITALIST_RELAUNCH_ARGS = JSON.stringify(args);
          env.CAPITALIST_RELAUNCH_CWD = targetRoot;
          let launcherPid = 0;
          try {
            const launcher = spawn(process.execPath, ["-e", RESTART_LAUNCHER], {
              cwd: targetRoot,
              detached: true,
              stdio: "ignore",
              env,
            });
            launcher.unref();
            launcherPid = launcher.pid ?? 0;
            recordEvent(targetRoot, "supervisor_restarted", { pid: launcherPid, via: "relauncher", target, contract });
          } catch (e) {
            recordEvent(targetRoot, "supervisor_restart_failed", {
              error: e instanceof Error ? e.message : String(e),
            });
            res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(
              JSON.stringify({
                ok: false,
                error: `重启失败：拉起器没有启动（${e instanceof Error ? e.message : String(e)}）。旧监工仍在运行，没有停。`,
              }),
            );
            return;
          }

          requestSupervisorStop(targetRoot, "看板：用户重启（新进程由拉起器接管）");
          recordEvent(targetRoot, "supervisor_restart_requested", { by: "user", via: "board", target, contract });

          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(
            JSON.stringify({
              ok: true,
              action: "restart",
              root: targetRoot,
              effective: "已请求关闭，3 秒后由看板进程拉起新的监工（新 pid）；期间在途工作进程按正常收尾",
            }),
          );
          return;
        }

        if (input.action === "next-model") {
          const model = String(input.arg ?? "").trim();
          const p = join(targetRoot, ".capitalist", "next_model.json");
          try {
            if (!model) rmSync(p, { force: true });
            else writeJson(p, { model, at: new Date().toISOString(), by: "user" });
            recordEvent(targetRoot, "next_model_set", { model, by: "user" });
          } catch (e) {
            res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(
            JSON.stringify({
              ok: true,
              action: "next-model",
              model,
              effective: model
                ? `之后的派单都使用 ${model}（常驻，直到再次更换或清除）`
                : "已清除派单模型，之后的派单回到契约/默认模型",
            }),
          );
          return;
        }

        if (input.action === "capitalist-model") {
          const model = String(input.arg ?? "").trim();
          const rec = loadSupervisor(targetRoot);
          if (!rec) {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "这个任务根没有监工记录，无法设置监工模型" }));
            return;
          }
          saveSupervisor(targetRoot, { ...rec, supervisor_model: model });
          recordEvent(targetRoot, "supervisor_model_set", { model, by: "user" });
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(
            JSON.stringify({
              ok: true,
              action: "capitalist-model",
              model,
              effective: model
                ? `监工对话层改用 ${model}，下一轮调用即生效（不用重启）`
                : "监工对话层回到宿主默认模型",
            }),
          );
          return;
        }

        const r = appendSupervisorDirective(targetRoot, input);
        if (!r.ok) {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ ok: false, error: r.error }));
          return;
        }
        const rejected = r.rec.result && r.rec.result.ok === false ? r.rec.result.reason : "";
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(
          JSON.stringify({
            ok: !rejected,
            id: r.rec.id,
            action: r.rec.action,
            arg: r.rec.arg,
            text: r.rec.text,
            ...(rejected ? { rejected: true, reason: rejected } : { effective: "下一个 tick 生效" }),
            detail: r.rec.result?.detail ?? "",
          }),
        );
      });
      return;
    }
    if (url === "/api/confirm-dispatch") {
      const peer = req.socket.remoteAddress ?? "";
      const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
      if (!loopback) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "结单接口只接受本机回环地址" }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "只接受 POST" }));
        return;
      }
      let raw = "";
      req.on("data", (c: Buffer) => {
        raw += c.toString("utf8");
        if (raw.length > 10_000) req.destroy();
      });
      req.on("end", () => {
        const json = (obj: unknown, code = 200): void => {
          res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(obj));
        };
        let id = "";
        try {
          id = String((JSON.parse(raw) as { id?: string }).id ?? "").trim();
        } catch {
          json({ error: "请求体不是合法 JSON" }, 400);
          return;
        }
        if (!id) {
          json({ error: "缺少派单 id" }, 400);
          return;
        }
        const cur = readDispatches(opts.root).find((d) => String(d.id) === id);
        if (!cur) {
          json({ error: `没有这张单：${id}` }, 404);
          return;
        }
        const note = String(cur.review_note ?? cur.note ?? "") || "用户确认结单";
        const done = finishDispatch(opts.root, id, "done", note);
        if (!done) {
          json({ error: `这张单已经结过了：${id}` }, 409);
          return;
        }
        recordEvent(opts.root, "dispatch_confirmed", {
          dispatch: id,
          stage: done.stage,
          shard: done.shard ?? "",
          worker: done.worker ?? "",
        });
        json({ ok: true, id });
      });
      return;
    }

    if (url === "/api/memory" || url.startsWith("/api/memory?")) {
      const peer = req.socket.remoteAddress ?? "";
      const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
      const jsonReply = (obj: unknown, code = 200): void => {
        res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(obj));
      };
      if (req.method !== "POST") {
        try {
          const root = rootFromUrl(url, opts.root);
          jsonReply({ ok: true, root, ...memorySnapshot(root) });
        } catch (err) {
          jsonReply({ error: String(err instanceof Error ? err.message : err) }, 500);
        }
        return;
      }
      if (!loopback) {
        jsonReply({ error: "记忆接口只接受本机回环地址" }, 403);
        return;
      }
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
        if (raw.length > 20_000) req.destroy();
      });
      req.on("end", () => {
        let body: Record<string, unknown> = {};
        try {
          body = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          jsonReply({ error: "请求体不是合法 JSON" }, 400);
          return;
        }
        const wanted = typeof body.root === "string" && body.root.trim() ? resolve(body.root.trim()) : "";
        const root = wanted && listTaskRoots(opts.root).includes(wanted) ? wanted : opts.root;
        const op = String(body.op ?? "").trim();
        const id = String(body.id ?? "").trim();
        const note = String(body.note ?? "");
        const kind = isMemoryKind(body.kind) ? body.kind : undefined;
        try {
          if (op === "add") {
            if (!note.trim()) {
              jsonReply({ error: "note 必填" }, 400);
              return;
            }
            if (body.kind !== undefined && !kind) {
              jsonReply({ error: "kind 只能是 habit / blocker" }, 400);
              return;
            }
            const made = addMemory(root, note, kind ?? "habit");
            if (!made) {
              jsonReply({ error: "正文为空，没有可保存的内容" }, 400);
              return;
            }
            jsonReply({ ok: true, root, id: made.id, ...memorySnapshot(root) });
            return;
          }
          if (op === "update") {
            if (!id) {
              jsonReply({ error: "id 必填" }, 400);
              return;
            }
            if (body.kind !== undefined && !kind) {
              jsonReply({ error: "kind 只能是 habit / blocker" }, 400);
              return;
            }
            const next = updateMemory(root, id, { ...(body.note !== undefined ? { note } : {}), ...(kind ? { kind } : {}) });
            if (!next) {
              jsonReply({ error: "条目不存在，或改完正文为空" }, 400);
              return;
            }
            jsonReply({ ok: true, root, id: next.id, ...memorySnapshot(root) });
            return;
          }
          if (op === "delete") {
            if (!id) {
              jsonReply({ error: "id 必填" }, 400);
              return;
            }
            const gone = deleteMemory(root, id);
            jsonReply({ ok: gone, root, id, ...memorySnapshot(root), ...(gone ? {} : { error: "条目不存在" }) }, gone ? 200 : 404);
            return;
          }
          jsonReply({ error: `未知操作：${op || "(空)"}（add / update / delete）` }, 400);
        } catch (err) {
          jsonReply({ error: String(err instanceof Error ? err.message : err) }, 500);
        }
      });
      return;
    }

    if (url === "/api/unhandled" || url.startsWith("/api/unhandled?")) {
      const jsonReply = (obj: unknown, code = 200): void => {
        res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(obj));
      };
      let root = opts.root;
      try {
        root = rootFromUrl(url, opts.root);
      } catch (err) {
        jsonReply({ error: String(err instanceof Error ? err.message : err) }, 500);
        return;
      }
      if (req.method !== "POST") {
        try {
          jsonReply({ ok: true, root, items: listUnhandled(root) });
        } catch (err) {
          jsonReply({ error: String(err instanceof Error ? err.message : err) }, 500);
        }
        return;
      }
      const peer = req.socket.remoteAddress ?? "";
      const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
      if (!loopback) {
        jsonReply({ error: "该接口只接受本机回环地址" }, 403);
        return;
      }
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
        if (raw.length > 10_000) req.destroy();
      });
      req.on("end", () => {
        let body: Record<string, unknown> = {};
        try {
          body = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          jsonReply({ error: "请求体不是合法 JSON" }, 400);
          return;
        }
        const wanted = typeof body.root === "string" && body.root.trim() ? resolve(body.root.trim()) : "";
        const targetRoot = wanted && listTaskRoots(opts.root).includes(wanted) ? wanted : opts.root;
        const msgId = String(body.msg_id ?? "").trim();
        const op = String(body.op ?? "").trim();
        if (!msgId) {
          jsonReply({ error: "msg_id 必填" }, 400);
          return;
        }
        try {
          const hit = listUnhandled(targetRoot).find((u) => u.msg_id === msgId);
          if (!hit) {
            jsonReply({ error: "这条发言已处置，或不在未建单列表里" }, 409);
            return;
          }
          if (op === "dismiss") {
            dismissChat(targetRoot, { msg_id: msgId });
            jsonReply({ ok: true, root: targetRoot, msg_id: msgId, items: listUnhandled(targetRoot) });
            return;
          }
          if (op === "dispatch") {
            const atts = attachmentsOfMessage(targetRoot, msgId) ?? [];
            const arg = bindAttachments(hit.text, atts).text;
            const w = appendSupervisorDirective(targetRoot, {
              action: "dispatch",
              arg,
              confirm: true,
              via: "user",
              msg_id: msgId,
              atts,
            });
            if (!w.ok) {
              jsonReply({ error: `建单失败：${w.error}`, root: targetRoot, msg_id: msgId }, 400);
              return;
            }
            settleChat(targetRoot, {
              msg_id: msgId,
              verdict: "dispatched",
              text: hit.text,
              thread: hit.thread,
              dispatch: String(w.rec?.id ?? ""),
              action: "dispatch",
            });
            jsonReply({
              ok: true,
              root: targetRoot,
              msg_id: msgId,
              directive: String(w.rec?.id ?? ""),
              items: listUnhandled(targetRoot),
            });
            return;
          }
          jsonReply({ error: `未知操作：${op || "(空)"}（dispatch / dismiss）` }, 400);
        } catch (err) {
          jsonReply({ error: String(err instanceof Error ? err.message : err) }, 500);
        }
      });
      return;
    }

    if (url === "/api/supervisor" || url.startsWith("/api/supervisor?")) {
      try {
        const view = cachedView(`supervisorview:${opts.root}`, 1200, () => buildSupervisorStatus(opts.root));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ serverTime: new Date().toISOString(), ...view }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
      }
      return;
    }
    if (url === "/api/capitalist-chat" || url.startsWith("/api/capitalist-chat?")) {
      const peer = req.socket.remoteAddress ?? "";
      const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
      if (!loopback) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "对话接口只接受本机回环地址" }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
        res.end(JSON.stringify({ error: "只接受 POST" }));
        return;
      }
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
        if (raw.length > 40_000) req.destroy();
      });
      req.on("end", () => {
        const askedThread = (() => {
          try {
            return String((JSON.parse(raw) as { thread?: string }).thread ?? "").trim();
          } catch {
            return "";
          }
        })();
        const exec = async (): Promise<void> => {
          const json = (obj: unknown, code = 200): void => {
            res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify(obj));
          };
          let text = "";
          let thread = "";
          let via = "";
          let quote = "";
          let quoteFallback = "";
          try {
            const body = JSON.parse(raw) as { text?: string; thread?: string; via?: string; quote?: string; quote_text?: string };
            text = String(body.text ?? "").trim();
            thread = String(body.thread ?? "").trim();
            via = String(body.via ?? "").trim();
            quote = cId(body.quote, "quote") ?? "";
            quoteFallback = cStr(body.quote_text);
          } catch {
            json({ error: "请求体不是合法 JSON" }, 400);
            return;
          }
          if (!text) {
            json({ error: "没有内容" }, 400);
            return;
          }

          const state = loadState(opts.root);
          const capitalist = buildSupervisorStatus(opts.root);
          const threads = buildThreads(opts.root);
          const running = threads.filter((t) => t.status === "running" || t.status === "starting");
          const queued = threads.filter((t) => t.status === "queued").length;
          const failed = threads.filter((t) => t.status === "failed").length;
          const me = thread ? threads.find((t) => t.id === thread) : null;
          const threadWorker = thread && !me ? listWorkers(opts.root).find((w) => w.id === thread) : null;
          const threadDispatch = threadWorker?.dispatch
            ? readDispatches(opts.root).find((d) => String(d.id) === String(threadWorker.dispatch))
            : null;
          const taskStage = String(me?.stage ?? threadDispatch?.stage ?? state?.stage ?? "");
          const taskShard = String(me?.shard ?? threadDispatch?.shard ?? "");
          const taskTitle = String(me?.title ?? (threadDispatch ? dispatchTitle(threadDispatch) : "") ?? "");
          const talkDispatch = String(me?.dispatch ?? threadDispatch?.id ?? "");
          const talkNo = talkDispatch ? dispatchNoTable(opts.root).get(talkDispatch) ?? "" : "";
          const mine = thread
            ? [
                "",
                "【你现在对话的对象】",
                taskShard || taskStage
                  ? `任务：${taskStage}/${taskShard || "(整阶段)"}${taskTitle ? ` · ${taskTitle}` : ""}`
                  : "任务：(未能定位，按全局状态回答)",
                me
                  ? `当前状态：${me.status} ｜ 已运行 ${Math.round((me.duration_sec ?? 0) / 60)} 分钟`
                  : "这一单的执行进程已退出 ｜ 这条任务还在，可以重开",
                `它这一单的标题：${taskTitle || "(未记录)"}`,
                `它最近输出的一句话：${String(me?.last || "").slice(0, 300) || "(还没输出)"}`,
                ...(() => {
                  if (!me?.worker) return [];
                  const rec = loadWorker(opts.root, String(me.worker));
                  const dg = rec ? workerDigest(rec) : "";
                  return dg ? [`它已经做到哪：${dg}`] : [];
                })(),
                ...(readPause(opts.root) !== null
                  ? [
                      "",
                      "【监工当前处于“暂停派单”】任何派单 / 插队 / 立即执行指令都不会执行。",
                      "用户要推进任务，必须先恢复派单（看板指标条的“恢复调度”按钮，或 capitalist resume）。",
                      "回答时先说明暂停状态，再回答该问题。",
                    ]
                  : []),
                ...(via === "capitalist"
                  ? [
                      "",
                      "【用户按了“监工介入”】提问发生在这个进程的会话里，携带上面的任务编号直接回答，",
                      "这句话不登记回该派单，也不转给该进程；由监工直接回复。",
                      "用户所指即当前这一单。回答只围绕它：什么状态、在做什么、还差什么。",
                      "不对比其他派单，不解释其他运行中的派单，避免被理解为在描述当前派单。",
                      "确实需要提到别的单时，先说明“那是另一单，与所问无关”。",
                      talkNo
                        ? `用户说“插队 / 排到前面”：DO: queue #${talkNo}——仅插入队首，运行中的派单不受影响。`
                        : "用户说“插队 / 排到前面”：先按【任务编号表】找号，再写 DO: queue #NN。",
                      talkNo
                        ? `用户说“立即执行 / 马上跑 / 别等”：DO: promote #${talkNo}——抢占槽位，运行中的派单退回队首，本单结束后继续执行。`
                        : "用户说“立即执行 / 马上跑”：DO: promote #NN——这才抢占槽位。",
                      "要新建一单并立刻抢占槽位（不等排队）：DO: dispatch --now <内容>（--now 表示立即执行，会挂起运行中的派单）。",
                      "要重做这一单：还在排队就 queue 或 promote；已经终结就 DO: dispatch 并按原任务重写一遍。",
                      "不要为让某一单启动而新建一单改动机制：那是另一件事，除非用户明确要求。",
                      "不要用 retry：retry 的参数是分片 id，不是任务号，adhoc 单传进去会被拒。",
                    ]
                  : []),
              ]
            : [];

          if (thread && via !== "capitalist") {
            const userMsg = recordUserMessage(opts.root, {
              text,
              thread,
              ...(quote ? { quote } : {}),
              ...(quote ? { quoteText: resolveQuoteText(opts.root, thread, quote, quoteFallback) } : {}),
            });
            const targetDispatch =
              String(me?.dispatch ?? threadDispatch?.id ?? "") || targetFromText(opts.root, text);
            const targetLineage = String(me?.lineage ?? threadDispatch?.lineage ?? "");
            /**
             * 这一单的派单记录。
             * 线程按血缘键组织时 `threadDispatch` 取不到，只能按线程上的派单 id 再查一次，
             * 否则“排队中的单”会被当成“已结束的单”，用户的补充要求会答完就没了。
             */
            const disp = ((): Dispatch | null => {
              if (threadDispatch) return threadDispatch;
              if (!me?.dispatch) return null;
              return readDispatchesBoard(opts.root).find((d) => String(d.id) === String(me.dispatch)) ?? null;
            })();
            const sse = (obj: unknown): void => {
              try {
                res.write(`data: ${JSON.stringify(obj)}\n\n`);
              } catch {
              }
            };
            /* 逐字回放要按事件流下发；不带这几个头，浏览器会攒到结束才渲染。 */
            res.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache, no-transform",
              connection: "keep-alive",
              "x-accel-buffering": "no",
            });
            /**
             * 收尾：落一条回复事件并结束这一轮。
             * 正文为空表示这一轮只是登记指令，没有对话内容。
             */
            const finish = (args: { reply: string; applied: string; dispatch?: string; error?: string }): void => {
              settleChat(opts.root, {
                msg_id: userMsg.id,
                verdict: args.reply ? "answered_only" : "amended",
                text,
                thread,
                ...(args.dispatch ? { dispatch: args.dispatch } : {}),
                ...(args.error ? { error: args.error } : {}),
              });
              recordEvent(opts.root, "supervisor_reply", {
                ask: text,
                reply: args.reply,
                want: "",
                applied: args.applied,
                thread,
                from: "worker",
              });
              sse({ kind: "done", reply: args.reply, display: args.reply, want: "", applied: args.applied });
              res.end();
            };
            if (text.length > MAX_SAY_CHARS) {
              finish({
                reply: "",
                applied: `消息共 ${text.length} 字，超出单次派单可携带的上限，请分段发送`,
                error: "超出单条上限",
              });
              return;
            }
            const onDuty = Boolean(me && (me.status === "running" || me.status === "starting"));
            /** 会话 id 取自该派单最近一次执行记录。 */
            const ranWorker = targetDispatch
              ? [...listWorkers(opts.root)].reverse().find((w) => String(w.dispatch ?? "") === targetDispatch)
              : undefined;
            /** 消息并入派单的条件：进程运行中、派单在排队，或派单尚未启动。 */
            const justQueued = String(me?.status ?? "") === "queued";
            const neverLaunched = !me && String(disp?.status ?? "") === "open";
            if (onDuty || justQueued || neverLaunched) {
              let sayOk = true;
              let sayErr = "";
              if (quote) {
                sayOk = writeQuotedDirect(opts.root, {
                  text,
                  shard: String(me?.shard ?? ""),
                  thread,
                  quote,
                  quoteText: resolveQuoteText(opts.root, thread, quote, quoteFallback),
                  msgId: userMsg.id,
                  ...(targetLineage ? { lineage: targetLineage } : {}),
                  ...(targetDispatch ? { target: targetDispatch } : {}),
                });
                if (!sayOk) sayErr = "指令写入失败";
                else {
                  recordEvent(opts.root, "direct_inject", {
                    thread,
                    shard: String(me?.shard ?? ""),
                    text: text.slice(0, 120),
                  });
                }
              } else {
                const sayArgs = sayArgsOf({
                  text,
                  thread,
                  msgId: userMsg.id,
                  shard: String(me?.shard ?? ""),
                  lineage: targetLineage,
                  dispatch: targetDispatch,
                });
                sayArgs.push("--root", opts.root);
                const say = runCli(sayArgs);
                sayOk = say.code === 0;
                if (!sayOk) sayErr = (say.stderr || "").slice(0, 120) || "命令行未返回原因";
              }
              if (!sayOk) {
                finish({ reply: "", applied: `登记失败：${sayErr}`, dispatch: targetDispatch, error: sayErr });
                return;
              }
              finish({
                reply: "",
                applied: onDuty
                  ? "已登记到当前派单 · 执行中的进程会在下一个动作间隙收到这条内容"
                  : "已登记到这一单 · 启动后会带上这条内容",
                dispatch: targetDispatch,
              });
              return;
            }
            /* 已结束派单的普通消息：在原会话中回复。 */
            /** 会话 id 取自该派单最近一次执行记录。 */
            const liveSession = String(
              (ranWorker as unknown as { ai_session?: string } | null)?.ai_session ?? "",
            ).trim();
            const sessionId =
              liveSession || workerSessionId(String(me?.stage ?? taskStage), String(me?.shard ?? taskShard));
            const prompt = [
              "这条线程对应一个已经结束的任务，用户在此会话发来消息，直接回答。",
              "",
              "【这一单的情况】",
              `任务：${taskStage}/${taskShard || "(整阶段)"}${taskTitle ? ` · ${taskTitle}` : ""}`,
              `状态：${me ? me.status : "已结束"}${me?.settled ? "（已结项）" : ""}`,
              `它这一单的标题：${taskTitle || "(未记录)"}`,
              `它最近输出的一句话：${String(me?.last ?? "").slice(0, 300) || "(还没输出)"}`,
              ...(readPause(opts.root) !== null
                ? ["", "【监工当前处于“暂停派单”】任何派单 / 插队 / 立即执行指令都不会执行。"]
                : []),
              "",
              "【怎么回答】",
              "- 用中文，简短直接，一到三句；不要客套，不要复述用户的话",
              "- 思考过程也用中文写：界面会把推理过程原样展开给用户看",
              "- 只依据本会话已有的上下文和下面这条消息回答；不知道就回答不知道，不编造",
              "- 这一单已经结束：只回答问题，不要改文件、不要改派单；需要继续动手时，说明需要在队列里重开这一单",
              "- 不要用任何 Markdown：不用粗体星号、不用井号标题、不用三反引号，行首不加列表符号",
              "- 不要提内部文件名和路径（以 .capitalist/ 开头的那种），也不要提任务列表、分片、收工条件、闸门判据、阻塞编号这类内部词",
              "",
              `用户消息：${text}`,
              ...(quote
                ? [
                    "",
                    `【用户引用了消息 #${quote}，原文如下】`,
                    resolveQuoteText(opts.root, thread, quote, quoteFallback) || "（原文未取回，仅编号）",
                  ]
                : []),
            ].join("\n");
            const leaveChat = enterSupervisorAction("chat");
            /* 续接会话期间没有正文增量，每 3 秒推一次状态帧供界面显示。 */
            const startedAt = Date.now();
            sse({ kind: "status", text: "正在续接这一单的会话" });
            const beat = setInterval(() => {
              sse({ kind: "status", text: `正在续接这一单的会话` });
            }, 3_000);
            const chatHost = chatHostOf(opts.root);
            const r = await askModelStream({
              prompt,
              sessionId,
              cwd: opts.root,
              ...(chatHost ? { host: chatHost } : {}),
              effort: loadSupervisor(opts.root)?.effort ?? "high",
              model: dispatchModel(disp ?? undefined) || undefined,
              ...(opts.token ? { token: opts.token } : {}),
              onDelta: (d) => sse(d),
            }).finally(() => {
              clearInterval(beat);
              leaveChat();
            });
            if (!r.ok) {
              const quota = isQuotaText(r.text);
              if (quota) markQuotaExhausted(opts.root, r.text);
              /*
               * 通道拒绝要落成一条回复：只写 applied 时它仅进状态行，
               * 这一轮结束后状态行随即被完成文案覆盖，用户看到的就是“发了没回”。
               */
              const hurt = quota ? r.text : `对话通道不可用：${r.text}${chatAuthHint(opts.root)}`;
              finish({ reply: hurt, applied: "", error: hurt });
              return;
            }
            clearQuotaExhausted(opts.root);
            noteSupervisorModelUsed(opts.root, r.context_model ?? "");
            finish({ reply: r.text.trim(), applied: "" });
            return;
          }

          const brief = reloadBrief(opts.root);
          /** 先把发言记入流，再算候选图；顺序反了本条消息的图不在编号表里。 */
          const userMsg = recordUserMessage(opts.root, {
            text,
            thread,
            ...(quote ? { quote } : {}),
            ...(quote ? { quoteText: resolveQuoteText(opts.root, thread, quote, quoteFallback) } : {}),
          });
          const past = recentShots(opts.root, { thread });
          const ownShots = past.filter((s) => s.msg_id === userMsg.id);
          const shots = ownShots.map((s, i) => ({ ...s, index: i + 1 }));

          const ctx = [
            `阶段：${state?.stage ?? "?"}${capitalist.stage_name ? ` ${capitalist.stage_name}` : ""}`,
            ...mine,
            ...taskNoLines(threads),
            ...workerRuntimeLines(opts.root),
            ...(() => {
              const lines = recentUserLines(opts.root);
              return lines.length
                ? [
                    "",
                    "【最近收到的消息（正序，最后一条为当前消息）】派单前先核对：该事项是否已派过、上一轮派的对象是否相同。",
                    ...lines,
                  ]
                : [];
            })(),
            ...settledLines(opts.root),
            `并行度：${capitalist.parallel ?? "?"} ｜ 运行中 ${running.length} 个${
              running.length
                ? `（${running.map((t) => `#${t.no} ${t.title || t.shard || t.id}${t.worker ? ` · ${t.worker}` : ""}`).join("、")}）`
                : ""
            } ｜ 排队 ${queued} ｜ 异常 ${failed}`,
            `下一步：${state?.next_action ? String(state.next_action).slice(0, 300) : "(空)"}`,
            `线程总数：${threads.length} ｜ 已完成 ${threads.filter((t) => t.status === "done" || t.status === "exited").length}`,
            ...(brief
              ? ["", "【重载后继承的上下文（压缩过，已完成且证据齐全的不要重做）】", brief]
              : []),
            ...(() => {
              const lines = memoryLines(opts.root, `${text} ${mine.join(" ")}`);
              return lines.length ? ["", ...lines] : [];
            })(),
            ...(() => {
              const lines = severeSupervisorEventLines(opts.root);
              return lines.length ? ["", "【最近严重异常（只含严重项；心跳与过程流水不在此列）】", ...lines] : [];
            })(),
          ].join("\n");

          const prompt = [
            "你是 capitalist 监工的对话层，直接回复用户提问。",
            "",
            "【当前真实状态】",
            ctx,
            "",
            "【怎么回答】",
            "- 用中文，简短直接，一到三句，不要客套、不要重复用户的话",
            "- 思考过程也用中文写：界面会把推理过程原样展开给用户看，用英文写用户看不懂",
            "- 陈述语气：写明对象与结果。不用第二人称“你”，不用“已记这一单，没打断它”这类口语化说法，",
            "  不拟人、不承诺、不陈述自身工作。",
            "- 只依据上面的状态回答；状态里没有的信息就回答“不知道”，不编造",
            "- 心跳流水（supervisor_tick）不作为状态来源；用户问“为什么没动 / 卡在哪 / 是不是坏了”时，",
            "  读台账和日志查明，属对话层职责——直接查比派单更快且更准。",
            "- 但“对谁做”必须落到具体对象：以用户所指的那个东西为准（哪个、哪一处），不按类别推断。",
            "  写派单前先确认是**哪一个**、能把它的位置指出来；指不出唯一对象时 capitalist ask，不猜测",
            "- 用户输入按指令执行；不纠正用户表述，不解释识别规则",
            "",
            "【格式硬要求，逐条照做】",
            "1. 不要用任何 Markdown 语法：不用粗体星号、不用井号标题、不用三反引号代码块、不用行首列表符号。",
            "   这个界面只显示纯文本，Markdown 符号会原样显示。",
            "2. 不要提内部文件名和路径（以 .capitalist/ 开头的那种），也不要提任务列表、分片 id、收工条件、",
            "   闸门判据、阻塞编号这类内部词。用户要听的是“什么情况、该怎么办”。【可用截图】里的路径供挑图使用，回复里同样不要写出来。",
            "3. 最多三句，不总结、不追问、不列举选项。",
            "4. DO: 行与 ATT: 行各占单独一行，写在正文最后；它们不会显示给用户，写在正文中间会把话切断。",
            "",
            /** 是否工作进程会话只看 thread 有没有值，不看 me 是否存在。 */
            supervisorPolicy({ shots, viaSupervisor: via === "capitalist", currentMsgId: userMsg.id, ownOnly: ownShots.length > 0 }),
            "",
            `用户消息：${text}`,
            ...(quote
              ? [
                  "",
                  `【用户引用了消息 #${quote}，原文如下】`,
                  resolveQuoteText(opts.root, thread, quote, quoteFallback) || "（原文未取回，仅编号）",
                  ...(() => {
                    const hit = quoteDispatchLabel(opts.root, quote);
                    return hit ? [`这条消息已派成 ${hit}——引用它用于修正那一单。`] : [];
                  })(),
                ]
              : []),
          ].join("\n");


          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
          const sse = (obj: unknown): void => {
            try {
              res.write(`data: ${JSON.stringify(obj)}\n\n`);
            } catch {
            }
          };

          /** 优先用工作进程记录上的 ai_session；老记录缺该字段才回落基名。 */
          const liveSession = String((me as unknown as { ai_session?: string } | null)?.ai_session ?? "").trim();
          const sessionId = me
            ? liveSession || workerSessionId(String(me.stage ?? ""), String(me.shard ?? ""))
            : /*
               * 监工会话（capitalist-chat 系）：每一轮进来先过单轮注入上限。会话记录超限时
               * 换代到 `capitalist-chat-c<gen>`，不让历史与历史轮次的工具输出无限累积重发
               * （reload.ts 的 supervisorChatTurnSessionId；换代会落 context_compacted 事件）。
               */
              supervisorChatTurnSessionId(opts.root);
          const leaveChat = enterSupervisorAction("chat");
          /*
           * 模型输出首个 token 前不写入任何字节，界面显示为无回复。
           * 先立刻给一帧状态，之后每 3 秒续一次；正文增量仍由 onDelta 直接推。
           */
          sse({ kind: "status", text: "正在思考" });
          const beat = setInterval(() => sse({ kind: "status", text: "正在思考" }), 3_000);
          const chatHost = chatHostOf(opts.root);
          const r = await askModelStream({
            prompt,
            sessionId,
            cwd: opts.root,
            ...(chatHost ? { host: chatHost } : {}),
            effort: loadSupervisor(opts.root)?.effort ?? "high",
            model: loadSupervisor(opts.root)?.supervisor_model || undefined,
            ...(opts.token ? { token: opts.token } : {}),
            onDelta: (d) => sse(d),
          }).finally(() => {
            clearInterval(beat);
            leaveChat();
          });
          if (!me) {
            if (r.context_used) {
              recordSupervisorContext(opts.root, r.context_used, r.context_window ?? 0, r.context_model ?? "");
            } else {
              const estimated = estimateSessionContextTokens(sessionId);
              if (estimated !== null) {
                recordSupervisorContext(opts.root, estimated, r.context_window ?? 0, r.context_model ?? "", true);
              }
            }
          }
          if (!r.ok) {
            const quota = isQuotaText(r.text);
            if (quota) markQuotaExhausted(opts.root, r.text);
            const hurt = quota ? r.text : `对话通道不可用：${r.text}${chatAuthHint(opts.root)}`;
            settleChat(opts.root, {
              msg_id: userMsg.id,
              verdict: "answered_only",
              text,
              thread,
              error: hurt,
            });
            /* 状态帧之外再落一条回复：失败原因要留在消息流里，不能只靠会被完成文案覆盖的状态行。 */
            recordEvent(opts.root, "supervisor_reply", {
              ask: text,
              reply: hurt,
              want: "",
              applied: "",
              thread,
              from: "supervisor",
            });
            sse({ kind: "error", text: hurt });
            res.end();
            return;
          }
          clearQuotaExhausted(opts.root);
          noteSupervisorModelUsed(opts.root, r.context_model ?? "");
          const parsed = parseReply(r.text);
          const reply = parsed.reply;
          const want = parsed.want;
          let applied = "";
          let settleVerdict: ChatVerdict = "answered_only";
          let settleDispatch = "";
          let settleAction = "";
          let settleError = "";
          let multiDirectiveIds: string[] = [];
          let acted = false;
          let directiveId = "";
          let dispatchText = "";

          if (parsed.acts.length) {
            const multi = parsed.acts.length > 1;
            const anyAtt = parsed.acts.some((a) => a.shots !== undefined);
            const okTexts: string[] = [];
            const okIds: string[] = [];
            const failNotes: string[] = [];
            for (const act of parsed.acts) {
              /* 没有动作即纯对话，不当作失败上报。 */
              if (!act.action || act.action === "none") continue;
              const picks = anyAtt ? (act.shots ?? []) : undefined;
              const chosen = pickShots(picks, anyAtt && multi ? [] : userMsg.atts, shots);
              if (act.shots) {
                recordEvent(opts.root, "attachments_picked", {
                  action: act.action,
                  msg_id: userMsg.id,
                  picks: act.shots,
                  kept: chosen,
                  candidates: shots.map((s) => s.path),
                });
              }
              const arg = bindAttachments(act.arg, chosen).text;
              /*
               * 推翻说明随单进入正文：工作进程与验收需要知道本次是刻意推翻旧口径，
               * 否则会按“两套并存”处理。回执仍用原文，不把该行带进气泡。
               */
              const directiveArg = act.revoke ? `${arg}\n\n本次作废：${act.revoke}` : arg;
              /** skip 把整个阶段记成欠账跳过，不代为确认。 */
              const w = appendSupervisorDirective(opts.root, {
                action: act.action,
                arg: directiveArg,
                confirm: act.action !== "skip",
                msg_id: userMsg.id,
                atts: chosen,
                target:
                  targetFromText(opts.root, text) || String(me?.dispatch ?? threadDispatch?.id ?? ""),
                ...(parsed.parent ? { parent: parsed.parent } : {}),
                ...(parsed.parentReason ? { parent_reason: parsed.parentReason } : {}),
                ...(parsed.after ? { after: parsed.after } : {}),
                via: "capitalist",
              });
              if (!w.ok) {
                /* 白名单清单属于内部信息，不进入用户可见文案。 */
                const head = String(w.error || "动作未执行").split("白名单")[0] ?? "";
                const why = head.replace(/[：:，,]\s*$/, "");
                failNotes.push(`${String(act.action)}：${why}`);
                continue;
              }
              const why = w.rec.result?.ok === false ? w.rec.result.reason : "";
              if (why) {
                failNotes.push(`${act.action}：${why}`);
                continue;
              }
              acted = true;
              okIds.push(String(w.rec?.id ?? ""));
              okTexts.push(arg);
              if (!settleAction) {
                settleAction = act.action;
                settleVerdict = chatVerdictOf(act.action, arg);
              }
            }
            if (okIds.length) {
              directiveId = okIds[0]!;
              settleDispatch = okIds[0]!;
              dispatchText = okTexts.join("\n");
              applied = multi
                ? `已落成 ${okIds.length} 张单`
                : settleAction === "dispatch"
                  ? "已加入队列"
                  : `已执行 ${settleAction}${okTexts[0] ? `：${okTexts[0].slice(0, 60)}` : ""}`;
            }
            if (failNotes.length) {
              /* 失败原因只进“被拒”行，不并入回复正文。 */
              settleError = `未执行：${failNotes.join("；")}`;
            }
            if (okIds.length > 1) multiDirectiveIds = okIds;
          } else if (want) {
            const arg = bindAttachments(want, userMsg.atts).text;
            dispatchText = arg;
            const w = appendSupervisorDirective(opts.root, {
              action: "set-next",
              arg,
              confirm: false,
              via: "capitalist",
              msg_id: userMsg.id,
              atts: userMsg.atts,
            });
            if (w.ok) {
              acted = true;
              directiveId = String(w.rec?.id ?? "");
              applied = "已登记为下一步要求，下一轮生效";
              settleVerdict = "queued";
              settleAction = "set-next";
              settleDispatch = directiveId;
            } else {
              applied = `登记失败：${w.error}`;
              settleError = applied;
            }
          }
          const settled = settleChat(opts.root, {
            msg_id: userMsg.id,
            verdict: settleVerdict,
            text,
            thread,
            ...(settleDispatch ? { dispatch: settleDispatch } : {}),
            ...(multiDirectiveIds.length ? { dispatches: multiDirectiveIds } : {}),
            ...(settleAction ? { action: settleAction } : {}),
            ...(settleError ? { error: settleError } : {}),
          });
          recordEvent(opts.root, "supervisor_reply", {
            ask: text,
            reply,
            want,
            applied,
            ...(acted ? { acted: true } : {}),
            ...(acted && dispatchText ? { dispatch_text: dispatchText } : {}),
            ...(acted && directiveId ? { directive: directiveId } : {}),
            ...(multiDirectiveIds.length ? { directives: multiDirectiveIds } : {}),
            thread,
            from: "supervisor",
          });
          /** 实时帧与重建走同一个视图函数（msgView.ts），刷新前后逐字一致。 */
          const display = supervisorReplyView({ reply, want, applied, acted, dispatch_text: dispatchText });
          sse({ kind: "done", reply: display, display, want, applied, ...(settled.unhandled ? { unhandled: true } : {}) });
          res.end();
        };
        if (askedThread) void exec();
        else void serializeSupervisorChat(exec);
      });
      return;
    }
    if (url === "/api/upload" || url.startsWith("/api/upload?")) {
      const peer = req.socket.remoteAddress ?? "";
      const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
      if (!loopback) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "上传接口只接受本机回环地址" }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
        res.end(JSON.stringify({ error: "只接受 POST" }));
        return;
      }
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
        if (raw.length > 12_000_000) req.destroy();
      });
      req.on("end", () => {
        const json = (obj: unknown, code = 200): void => {
          res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(obj));
        };
        let payload: { name?: string; dataUrl?: string; thread?: string; tag?: string };
        try {
          payload = JSON.parse(raw) as { name?: string; dataUrl?: string; thread?: string; tag?: string };
        } catch {
          json({ error: "请求体不是合法 JSON" }, 400);
          return;
        }
        const dataUrl = String(payload.dataUrl ?? "");
        const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
        if (!m) {
          json({ error: "只接受 png / jpeg / webp / gif 的 base64 data URL" }, 400);
          return;
        }
        const mime = m[1] as string;
        const ext = mime === "image/jpeg" ? "jpg" : (mime.split("/")[1] as string);
        let buf: Buffer;
        try {
          buf = Buffer.from((m[2] as string).replace(/\s+/g, ""), "base64");
        } catch {
          json({ error: "base64 解码失败" }, 400);
          return;
        }
        if (buf.length === 0) {
          json({ error: "图片为空" }, 400);
          return;
        }
        if (buf.length > 8_000_000) {
          json({ error: `图片太大（${buf.length} 字节，上限 8MB）` }, 413);
          return;
        }
        try {
          const dir = join(supervisorDir(opts.root), "attachments");
          mkdirSync(dir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
          const rand = Math.random().toString(36).slice(2, 8);
          const fileName = `${stamp}-${rand}.${ext}`;
          writeFileSync(join(dir, fileName), buf);
          const rel = `.capitalist/attachments/${fileName}`;
          const attMeta = {
            path: rel,
            at: new Date().toISOString(),
            bytes: buf.length,
            mime,
            thread: String(payload.thread ?? "").slice(0, 80),
            tag: String(payload.tag ?? "").slice(0, 40),
            name: String(payload.name ?? "").slice(0, 120),
          };
          appendJsonl(join(dir, "index.jsonl"), attMeta);
          json({ ok: true, path: rel, bytes: buf.length, mime, thread: attMeta.thread, tag: attMeta.tag });
        } catch (err) {
          json({ error: `保存失败：${String(err instanceof Error ? err.message : err)}` }, 500);
        }
      });
      return;
    }
    /** 只认 .capitalist/attachments/ 下的图片文件，其余返回 404。 */
    if (url === "/api/attachment" || url.startsWith("/api/attachment?")) {
      const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
      const want = String(q.get("path") || "").trim();
      const root = rootFromUrl(url, opts.root);
      const dir = resolve(supervisorDir(root), "attachments");
      const full = resolve(root, want.replace(/^[\\/]+/, ""));
      if (!want || (full !== dir && !full.startsWith(dir + sep))) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "没有这张图" }));
        return;
      }
      try {
        const st = statSync(full);
        if (!st.isFile()) throw new Error("not a file");
        const ext = extname(full).toLowerCase();
        const type = BOARD_WEB_TYPES[ext];
        if (!type || !type.startsWith("image/")) throw new Error("not an image");
        const body = readFileSync(full);
        res.writeHead(200, {
          "content-type": type,
          "content-length": body.length,
          "cache-control": "private, max-age=86400",
        });
        res.end(body);
      } catch {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "没有这张图" }));
      }
      return;
    }
    if (url === "/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }
    if (serveBoardWeb(req, res, url)) return;
    const html = missingBoardWebPage();
    sendAsset(req, res, html, etagOf(html), "text/html; charset=utf-8", 0);
  };

  let lastErr: unknown = null;
  let reclaimed = false;
  for (let i = 0; i < tries; i += 1) {
    const port = base + i;
    const server = createServer(handler);
    const bound = await new Promise<boolean>((resolve) => {
      const onError = (err: unknown): void => {
        lastErr = err;
        server.removeListener("listening", onListening);
        resolve(false);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
    if (bound) {
      try {
        writeJson(join(opts.root, ".capitalist", "board.pid"), {
          pid: process.pid,
          port,
          root: opts.root,
          at: new Date().toISOString(),
        });
      } catch {
      }
      /* 非安全模式不带 key，地址可直接打开。 */
      const url = BOARD_SECURE
        ? `http://${host}:${port}/?key=${BOARD_KEY}`
        : `http://${host}:${port}/`;
      return {
        server,
        url,
        port,
        close: () => {
          stopOrphanWatch();
          try {
            server.close();
          } catch {
          }
        },
      };
    }
    if (!reclaimed && (await reclaimStaleBoard(opts.root, port))) {
      reclaimed = true;
      i -= 1;
      continue;
    }
    try {
      server.close();
    } catch {
    }
  }

  throw new Error(
    `端口 ${base}~${base + tries - 1} 都占用，看板未能启动：${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

export function snapshotJson(root: string): string {
  return `${JSON.stringify(buildSnapshot(root), null, 2)}\n`;
}


/** 各线程的已读水位（epoch 秒）。保存该值，进程重启后不将已读线程重新标记为未读。 */
const threadSeen = new Map<string, number>();
let threadSeenLoadedFor = "";

function threadSeenPath(root: string): string {
  return join(supervisorDir(root), "board-seen.json");
}

/** 首次用到时从盘上恢复一次；同一任务根只读一次。 */
function loadThreadSeen(root: string): void {
  if (threadSeenLoadedFor === root) return;
  threadSeenLoadedFor = root;
  const disk = readJson<Record<string, number>>(threadSeenPath(root), {});
  for (const [k, v] of Object.entries(disk ?? {})) {
    const n = Number(v);
    if (k && Number.isFinite(n) && n > 0 && !threadSeen.has(k)) threadSeen.set(k, n);
  }
}

function saveThreadSeen(root: string): void {
  const out: Record<string, number> = {};
  for (const [k, v] of threadSeen) out[k] = v;
  writeJson(threadSeenPath(root), out);
}

function eventsFile(root: string): string {
  return join(supervisorDir(root), "events.jsonl");
}

function atTs(s: unknown): number {
  const n = typeof s === "string" ? Date.parse(s) / 1000 : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** 附件路径只取本条记录落库时的 atts 与自身正文，不读其它记录或全局状态。 */
function attachmentsOf(r: { atts?: unknown; text?: unknown }): string[] {
  if (Array.isArray(r.atts)) {
    const own = r.atts.map((x) => String(x)).filter(Boolean);
    if (own.length) return [...new Set(own)];
  }
  return attachmentsIn(String(r.text ?? ""));
}

function dispatchModel(d: Dispatch | undefined): string {
  return d ? String((d as unknown as Record<string, unknown>).model ?? "") : "";
}

/** 规则、过滤表与事件摊平在 workerLog.ts，本处只把文件读成行。 */
const LOG_EVENTS_TAIL_BYTES = 2 * 1024 * 1024;
/** 单次增量超过上限时按尾部窗口重建。 */
const LOG_INCREMENTAL_MAX_BYTES = 8 * 1024 * 1024;

interface WorkerLogCursor {
  from: number;
  offset: number;
  parts: WorkerLogParts;
}
const workerEventsCache = new Map<string, WorkerLogCursor>();

/** 保留预算按字符数计算，三个通道各自独立。 */
const LOG_PARTS_MAX_CHARS = 4_000_000;

function capByChars(lines: string[], budget: number): string[] {
  let total = 0;
  let i = lines.length;
  while (i > 0) {
    const len = lines[i - 1]?.length ?? 0;
    if (total + len > budget) break;
    total += len;
    i -= 1;
  }
  return i === 0 ? lines : lines.slice(i);
}

function capParts(parts: WorkerLogParts): WorkerLogParts {
  return {
    text: capByChars(parts.text, LOG_PARTS_MAX_CHARS),
    tools: capByChars(parts.tools, LOG_PARTS_MAX_CHARS),
    thinking: capByChars(parts.thinking, LOG_PARTS_MAX_CHARS),
    debug: capByChars(parts.debug, LOG_PARTS_MAX_CHARS),
    hidden: parts.hidden,
    stream: parts.stream,
    ...(parts.lastAction !== undefined ? { lastAction: parts.lastAction } : {}),
  };
}

/** 从中间起读时退到第一个换行之后并前移偏移；末尾未完成的行留给下一次。 */
function readLogRange(
  file: string,
  start: number,
  end: number,
): { text: string; offset: number; consumed: number } {
  if (end <= start) return { text: "", offset: start, consumed: start };
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(end - start);
    /** readSync 不保证一次读满；Windows 上日志由另一进程持有写句柄时更常见，短读时补齐。 */
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const view = read === buf.length ? buf : buf.subarray(0, read);
    let from = 0;
    if (start > 0) {
      const nl = view.indexOf(0x0a);
      if (nl < 0) return { text: "", offset: start, consumed: start };
      from = nl + 1;
    }
    const lastNl = view.lastIndexOf(0x0a);
    const upto = lastNl >= from ? lastNl + 1 : from;
    return {
      text: view.subarray(from, upto).toString("utf8"),
      offset: start + from,
      consumed: start + upto,
    };
  } finally {
    closeSync(fd);
  }
}

function readWorkerEvents(file: string, tailBytes: number = LOG_EVENTS_TAIL_BYTES): WorkerLogParts {
  const st = statCached(file);
  if (!st) return parseWorkerLog([]);
  const size = st.size;

  const needFrom = Math.max(0, size - Math.max(64 * 1024, tailBytes));

  const prev = workerEventsCache.get(file);
  let start: number;
  let reuse: WorkerLogCursor | undefined = prev;
  if (!prev) {
    start = needFrom;
  } else if (size < prev.offset) {
    /** 文件变短即截断或被替换，游标作废。 */
    start = needFrom;
    reuse = undefined;
  } else if (needFrom < prev.from) {
    start = needFrom;
    reuse = undefined;
  } else if (size - prev.offset > LOG_INCREMENTAL_MAX_BYTES) {
    start = needFrom;
    reuse = undefined;
  } else {
    start = prev.offset;
  }
  if (reuse && start === reuse.offset && size === reuse.offset) return reuse.parts;

  let range: { text: string; offset: number; consumed: number };
  try {
    range = readLogRange(file, start, size);
  } catch {
    /** 读失败时退回上一份结果，不清空已显示内容。 */
    return reuse?.parts ?? parseWorkerLog([]);
  }

  /** stream/纯文本只在文件开头判一次，增量分片沿用该判定。 */
  const chunk = parseWorkerLog(range.text.split("\n"), reuse ? { stream: reuse.parts.stream } : {});

  let parts: WorkerLogParts;
  if (reuse && start === reuse.offset) {
    const lastAction = chunk.lastAction !== undefined ? chunk.lastAction : reuse.parts.lastAction;
    parts = capParts({
      text: [...reuse.parts.text, ...chunk.text],
      tools: [...reuse.parts.tools, ...chunk.tools],
      thinking: [...reuse.parts.thinking, ...chunk.thinking],
      debug: [...reuse.parts.debug, ...chunk.debug],
      hidden: reuse.parts.hidden + chunk.hidden,
      stream: reuse.parts.stream,
      ...(lastAction !== undefined ? { lastAction } : {}),
    });
  } else {
    /** 首轮与重建的结果不拼接，直接替换。 */
    parts = capParts({
      text: chunk.text,
      tools: chunk.tools,
      thinking: chunk.thinking,
      debug: chunk.debug,
      hidden: chunk.hidden,
      stream: chunk.stream,
      ...(chunk.lastAction !== undefined ? { lastAction: chunk.lastAction } : {}),
    });
  }
  workerEventsCache.set(file, {
    from: Math.min(start, reuse?.from ?? start),
    offset: range.consumed,
    parts,
  });
  trimWorkerEventsCache();
  return parts;
}

function trimWorkerEventsCache(): void {
  if (workerEventsCache.size <= 512) return;
  let n = 0;
  for (const k of workerEventsCache.keys()) {
    workerEventsCache.delete(k);
    if ((n += 1) >= 128) break;
  }
}

function meaningfulLines(rawLines: readonly string[], stream?: boolean): string[] {
  return parseWorkerLog(rawLines, stream === undefined ? {} : { stream }).text;
}

/** 日志在 3 秒窗口内更新即视为正在输出。 */
const FRESH_LOG_SEC = 3;

function logIdleSec(file: string): number {
  const st = statCached(file);
  return st ? Math.max(0, (Date.now() - st.mtimeMs) / 1000) : Number.POSITIVE_INFINITY;
}

const CHUNK_FALLBACK = 16;

function isStackLine(line: string): boolean {
  return /^\s+at\s+\S/.test(line) || /^at\s+\S+.*\(/.test(line);
}

function startsChunk(line: string): boolean {
  return (
    /^\d{2}:\d{2}(:\d{2})?\b/.test(line) ||
    /^\[launch/.test(line) ||
    /^\[silent\]/.test(line) ||
    /^\[thinking\]/.test(line) ||
    /^[$>]\s/.test(line) ||
    /^▸\s/.test(line)
  );
}

function chunkWorkerLines(lines: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let stack = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const nextIsStack = i + 1 < lines.length && isStackLine(lines[i + 1] ?? "");
    if (cur.length > 0 && !isStackLine(line) && startsChunk(line)) {
      out.push(cur);
      cur = [];
      stack = 0;
    }
    cur.push(line);
    if (isStackLine(line)) stack += 1;
    const limit = Math.max(CHUNK_FALLBACK, stack);
    if (!isStackLine(line) && !nextIsStack && cur.length >= limit) {
      out.push(cur);
      cur = [];
      stack = 0;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

const LOG_TAIL_BYTES = 512 * 1024;
const LOG_TAIL_LINES = 4000;
const logTailCache = new Map<string, { key: string; lines: string[] }>();

function readLogTail(file: string, size: number, maxBytes: number): string {
  const start = Math.max(0, size - maxBytes);
  let text: string;
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    text = buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
  if (start > 0) {
    const nl = text.indexOf("\n");
    text = nl >= 0 ? text.slice(nl + 1) : "";
  }
  return text;
}

function readWorkerLog(file: string): string[] {
  try {
    if (!existsSync(file)) return [];
    const st = statSync(file);
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = logTailCache.get(file);
    if (hit !== undefined && hit.key === key) return hit.lines;
    const lines = meaningfulLines(
      readLogTail(file, st.size, LOG_TAIL_BYTES)
        .split("\n")
        .map((l) => l.replace(/\r$/, "")),
    ).slice(-LOG_TAIL_LINES);
    logTailCache.set(file, { key, lines });
    if (logTailCache.size > 512) {
      let n = 0;
      for (const k of logTailCache.keys()) {
        logTailCache.delete(k);
        if ((n += 1) >= 128) break;
      }
    }
    return lines;
  } catch {
    return [];
  }
}

export function buildThreads(root: string): ThreadSummary[] {
  return buildThreadsPage(root, Number.MAX_SAFE_INTEGER).threads;
}


export type TaskBucket = "run" | "queue" | "paused" | "bad" | "done" | "canceled" | "closed";

export function taskBucket(status: unknown): TaskBucket {
  const s = String(status ?? "");
  if (s === "running" || s === "starting" || s === "claimed") return "run";
  if (s === "queued" || s === "open") return "queue";
  if (s === "suspended") return "queue";
  /* 暂停单单独成档：该状态既不在等待槽位，也不在运行，不与排队状态合并。 */
  if (s === "paused") return "paused";
  if (s === "done" || s === "exited" || s === "finished") return "done";
  if (s === "canceled") return "canceled";
  /* 作废与结项单单独成档，不计入排队与运行。 */
  if (s === "closed" || s === "superseded") return "closed";
  return "bad";
}

export interface TaskCounts {
  total: number;
  running: number;
  queued: number;
  paused: number;
  failed: number;
  done: number;
  canceled: number;
  closed: number;
  accepted: number;
  ended: number;
}

/** total = running + queued + paused + failed + done + canceled + closed，每条线程只计入一个分类。 */
export function taskCountsOf(
  threads: ReadonlyArray<{ id?: string | null; status?: string | null }>,
  acceptedKeys?: ReadonlySet<string>,
  settledKeys?: ReadonlySet<string>,
): TaskCounts {
  const out: TaskCounts = {
    total: 0,
    running: 0,
    queued: 0,
    paused: 0,
    failed: 0,
    done: 0,
    canceled: 0,
    closed: 0,
    accepted: 0,
    ended: 0,
  };
  for (const t of threads) {
    const b = taskBucket(t.status);
    out.total += 1;
    if (b === "run") out.running += 1;
    else if (b === "queue") out.queued += 1;
    else if (b === "paused") out.paused += 1;
    else if (b === "bad") out.failed += 1;
    else if (b === "canceled") out.canceled += 1;
    else if (b === "closed") out.closed += 1;
    else {
      const unsettled = String(t.status ?? "") === "exited" && settledKeys && !settledKeys.has(String(t.id ?? ""));
      if (unsettled) out.queued += 1;
      else {
        out.done += 1;
        if (acceptedKeys?.has(String(t.id ?? ""))) out.accepted += 1;
      }
    }
  }
  return out;
}

/** 已结项判据与前端 settled() 同源：派单台账里 done 或 closed 即算结项。 */
function settledThreadKeys(dispatches: readonly Dispatch[]): Set<string> {
  const keys = new Set<string>();
  for (const d of dispatches) {
    const s = String(d.status ?? "");
    if (s !== "done" && s !== "closed") continue;
    keys.add(taskKeyOf(d.stage, d.shard, String((d as { lineage?: string }).lineage ?? "")));
  }
  return keys;
}

function acceptedThreadKeys(root: string, dispatches: readonly Dispatch[]): Set<string> {
  const keys = new Set<string>();
  let rows: Array<{ state?: string; dispatch?: string }> = [];
  try {
    rows = readTasks(root);
  } catch {
    return keys;
  }
  if (rows.length === 0) return keys;
  const byId = new Map(dispatches.map((d) => [d.id, d] as const));
  for (const t of rows) {
    if (String(t.state ?? "") !== "accepted") continue;
    const d = byId.get(String(t.dispatch ?? ""));
    if (!d) continue;
    keys.add(taskKeyOf(d.stage, d.shard, String((d as { lineage?: string }).lineage ?? "")));
  }
  return keys;
}

const taskCountsCache = new Map<string, { at: number; val: TaskCounts }>();
const TASK_COUNTS_TTL_MS = 3000;

function rememberTaskCounts(root: string, val: TaskCounts): TaskCounts {
  taskCountsCache.set(root, { at: Date.now(), val });
  if (taskCountsCache.size > 32) {
    for (const [k, v] of taskCountsCache) if (Date.now() - v.at > 60_000) taskCountsCache.delete(k);
  }
  return val;
}

export function taskCounts(root: string): TaskCounts {
  const hit = taskCountsCache.get(root);
  if (hit && Date.now() - hit.at < TASK_COUNTS_TTL_MS) return { ...hit.val };
  return buildThreadsPage(root, Number.MAX_SAFE_INTEGER).counts;
}

const CANCEL_NOTE = "用户手动结项";

const CANCELED_KEEP_MS = 24 * 3600 * 1000;

function yieldedOf(d: Dispatch): { yielded_at?: string; yielded_by?: string } {
  if (!d.yielded_at) return {};
  return { yielded_at: d.yielded_at, ...(d.yielded_by ? { yielded_by: d.yielded_by } : {}) };
}

function yieldedReason(d: Dispatch): string {
  const by = String(d.yielded_by ?? "").trim();
  return by
    ? `已为立即执行派单 ${by} 让出槽位，该单结束后按原顺序恢复`
    : "已为立即执行派单让出槽位，该单结束后按原顺序恢复";
}

const WORKER_ACTION_TAIL_BYTES = 256 * 1024;
const workerActionCache = new Map<string, { key: string; action: WorkerAction | null | undefined }>();

function workerActionOf(log: string): WorkerAction | null | undefined {
  if (!log) return undefined;
  let key = "";
  try {
    const st = statSync(log);
    key = `${st.mtimeMs}:${st.size}`;
    const hit = workerActionCache.get(log);
    if (hit && hit.key === key) return hit.action;
    const size = st.size;
    const start = Math.max(0, size - WORKER_ACTION_TAIL_BYTES);
    const range = readLogRange(log, start, size);
    const parts = parseWorkerLog(range.text.split("\n"), { stream: true });
    const action = parts.lastAction;
    if (workerActionCache.size >= 512) workerActionCache.clear();
    workerActionCache.set(log, { key, action });
    return action;
  } catch {
    return workerActionCache.get(log)?.action;
  }
}

function threadDoingOf(d: Dispatch | undefined, worker: WorkerRecord, alive: boolean): WorkerDoing | "" {
  if (d?.status === "reported") return "report";
  if (!alive) return "";
  return doingOfAction(workerActionOf(worker.log));
}

function buildThreadsPageUncached(
  root: string,
  limit: number,
): {
  threads: ThreadSummary[];
  total: number;
  truncated: boolean;
  counts: TaskCounts;
  totals: {
    total_duration_sec: number;
    total_output_bytes: number;
    total_spawn_count: number;
    total_input_tokens: number | null;
    total_output_tokens: number | null;
    total_tokens: number | null;
    total_cache_read_tokens: number | null;
    usage_reported: number;
    usage_unreported: number;
    billing_unit: string;
    total_credit: number | null;
    credit_unit: string;
  };
} {
  const ctx = messageContext(root);
  const workers = ctx.workers;
  const dispatches = ctx.dispatches;
  const capitalist = loadSupervisor(root);
  const capacity = capitalist?.max_workers ?? 0;
  const running = workers.filter((w) => w.status === "running" || w.status === "starting").length;
  const hold = activeTakeover(root);
  const isHeld = (shard?: string | null): boolean =>
    hold.all || (Boolean(shard) && hold.shards.includes(String(shard)));

  /**
   * 派单对应的线程状态。暂停优先：暂停的派单既不等待槽位，也不在运行，
   * 界面需与“排队”“运行中”区分，以显示该单处于等待唤醒状态。
   */
  const threadStatusOf = (d: Dispatch): string => {
    if (dispatchPaused(d)) return "paused";
    return d.status === "claimed" ? "running" : "queued";
  };

  const dispatchById = new Map<string, Dispatch>();
  for (const d of dispatches) dispatchById.set(d.id, d);

  const threads = new Map<string, ThreadSummary>();


  for (const w of workers) {
    const d = w.dispatch ? dispatchById.get(w.dispatch) : undefined;
    const key = taskKeyOf(w.stage, w.shard, String((d as { lineage?: string } | undefined)?.lineage ?? ""));
    const prev = threads.get(key);
    /** 同一任务重派多次时留最近启动的那次为当前执行者。 */
    if (prev && String(prev.started_at ?? "") >= String(w.started_at ?? "")) continue;
    const cost = costRowOf(w, dispatches, Date.now() / 1000, root);
    /** 判活综合心跳与日志，任一在阈值内更新即为存活。 */
    const live = workerLivenessOf(w, {
      heartbeatSec: capitalist?.worker_timeout_sec ?? 900,
      logStallSec: capitalist?.stuck_sec ?? DEFAULT_LOG_STALL_SEC,
    });
    /** 可见窗口模式的存活只认自身写回的 report。 */
    const alive = w.mode === "visible" ? true : live.alive;
    const doing = threadDoingOf(d, w, alive);
    threads.set(key, {
      id: key,
      no: "",
      stuck_on: "",
      stuck_on_no: "",
      shard: w.shard ?? "",
      lineage: String((d as { lineage?: string } | undefined)?.lineage ?? w.dispatch ?? w.id),
      stage: w.stage,
      status: w.status,
      model: dispatchModel(d),
      worker: w.id,
      last_at: "",
      last_role: "",
      last: "",
      unread: 0,
      held: isHeld(w.shard),
      started_at: w.started_at,
      heartbeat_age_sec: ageSec(w.heartbeat_ts),
      alive,
      log_idle_sec: live.log_idle_sec,
      ...(doing ? { doing } : {}),
      ...(w.stuck ? { stuck: w.stuck } : {}),
      dispatch: w.dispatch ?? "",
      title: d ? dispatchTitle(d) : "",
      output_bytes: cost.output_bytes,
      duration_sec: cost.duration_sec,
      spawn_count: cost.spawn_count,
      usage: cost.usage,
    });
  }

  for (const d of dispatches) {
    if (d.status !== "closed") continue;
    if (String(d.closed_by ?? "") !== "user") continue;
    if (String(d.note ?? "") !== CANCEL_NOTE) continue;
    const closedAt = Date.parse(String(d.closed_at ?? d.done_at ?? d.at ?? ""));
    if (Number.isFinite(closedAt) && Date.now() - closedAt > CANCELED_KEEP_MS) continue;

    const own = [...threads.values()].find((th) => th.dispatch === d.id);
    if (own) {
      own.status = "canceled";
      continue;
    }

    const key = taskKeyOf(d.stage, d.shard, String((d as { lineage?: string }).lineage ?? ""));
    const taken = threads.get(key);
    if (taken) {
      if (!taken.dispatch) taken.status = "canceled";
      continue;
    }

    threads.set(key, {
      id: key,
      no: "",
      stuck_on: "",
      stuck_on_no: "",
      shard: d.shard ?? "",
      lineage: String((d as { lineage?: string }).lineage ?? d.id),
      stage: d.stage,
      status: "canceled",
      model: dispatchModel(d),
      worker: "",
      last_at: "",
      last_role: "",
      last: "",
      unread: 0,
      held: isHeld(d.shard),
      started_at: d.at,
      dispatch: d.id,
      title: dispatchTitle(d),
      output_bytes: 0,
      duration_sec: 0,
      spawn_count: 0,
      usage: noUsage(d.at, dispatchModel(d)),
    });
  }

  /*
   * 作废单补入列表。
   *
   * 阶段推进作废的单没有工作进程，不会经 worker 循环进入 threads；
   * 单独成档，不与用户取消合并。
   */
  for (const d of dispatches) {
    if (String(d.status ?? "") !== "superseded") continue;
    const supersededAt = Date.parse(String(d.closed_at ?? d.done_at ?? d.at ?? ""));
    if (Number.isFinite(supersededAt) && Date.now() - supersededAt > CANCELED_KEEP_MS) continue;
    const key = taskKeyOf(d.stage, d.shard, String((d as { lineage?: string }).lineage ?? ""));
    if (threads.has(key)) continue;
    threads.set(key, {
      id: key,
      no: "",
      stuck_on: "",
      stuck_on_no: "",
      shard: d.shard ?? "",
      lineage: String((d as { lineage?: string }).lineage ?? d.id),
      stage: d.stage,
      status: "superseded",
      model: dispatchModel(d),
      worker: "",
      last_at: "",
      last_role: "",
      last: "",
      unread: 0,
      held: isHeld(d.shard),
      started_at: d.at,
      dispatch: d.id,
      title: dispatchTitle(d),
      output_bytes: 0,
      duration_sec: 0,
      spawn_count: 0,
      usage: noUsage(d.at, dispatchModel(d)),
    });
  }

  for (const d of dispatches) {
    if (d.status !== "open" && d.status !== "claimed") continue;
    const hasWorker = workers.some((w) => w.dispatch === d.id);
    if (hasWorker) continue;
    const key = taskKeyOf(d.stage, d.shard, String((d as { lineage?: string }).lineage ?? ""));
    const prev = threads.get(key);
    if (prev) {
      const prevTerminal =
        prev.status !== "queued" && prev.status !== "running" && prev.status !== "starting";
      if (d.status === "open" && prevTerminal) {
        prev.status = threadStatusOf(d);
        prev.dispatch = d.id;
        prev.title = dispatchTitle(d) || prev.title;
        prev.model = dispatchModel(d);
        prev.usage = noUsage(d.at, dispatchModel(d));
        prev.started_at = d.at;
        prev.duration_sec = 0;
        prev.held = isHeld(d.shard);
      } else if (d.status === "claimed" && prevTerminal) {
        prev.status = threadStatusOf(d);
        prev.dispatch = d.id;
        prev.title = dispatchTitle(d) || prev.title;
        prev.started_at = d.at;
        prev.held = isHeld(d.shard);
      } else if (d.status === "open") {
        threads.set(d.id, {
          id: d.id,
          no: "",
          stuck_on: "",
          stuck_on_no: "",
          shard: d.shard ?? "",
          stage: d.stage,
          status: threadStatusOf(d),
          model: dispatchModel(d),
          worker: "",
          last_at: "",
          last_role: "",
          last: "",
          unread: 0,
          held: isHeld(d.shard),
          started_at: d.at,
          dispatch: d.id,
          title: dispatchTitle(d),
          output_bytes: 0,
          duration_sec: 0,
          spawn_count: 0,
          usage: noUsage(d.at, dispatchModel(d)),
        });
      }
      continue;
    }
    if (d.status === "claimed") {
      threads.set(key, {
        id: key,
        no: "",
        stuck_on: "",
        stuck_on_no: "",
        shard: d.shard ?? "",
        stage: d.stage,
        status: threadStatusOf(d),
        model: dispatchModel(d),
        worker: d.worker ?? "",
        last_at: "",
        last_role: "",
        last: "",
        unread: 0,
        held: isHeld(d.shard),
        started_at: d.at,
        dispatch: d.id,
        title: dispatchTitle(d),
        output_bytes: 0,
        duration_sec: 0,
        spawn_count: spawnCountFor(d.stage, d.shard ?? "", dispatches),
        usage: noUsage(d.at, dispatchModel(d)),
      });
      continue;
    }
    let reason: string;
    if (dispatchPaused(d)) reason = String(d.paused_reason ?? "").trim() || "上次中断未完成，等待唤醒";
    else if (d.yielded_at) reason = yieldedReason(d);
    else if (isHeld(d.shard)) reason = "人工接管中，监工不自动派单";
    else if (capacity <= 0) reason = "等待外部领单（--no-spawn）";
    else if (running >= capacity) reason = `等待空槽（并行度 ${running}/${capacity}）`;
    else reason = "等待派发（槽位未满）";
    threads.set(key, {
      id: key,
      no: "",
      stuck_on: "",
      stuck_on_no: "",
      shard: d.shard ?? "",
      stage: d.stage,
      status: threadStatusOf(d),
      queued_reason: reason,
      ...(d.promoted_at ? { promoted_at: d.promoted_at } : {}),
      ...(d.urgent ? { urgent: true } : {}),
      ...yieldedOf(d),
      model: dispatchModel(d),
      worker: "",
      last_at: "",
      last_role: "",
      last: "",
      unread: 0,
      held: isHeld(d.shard),
      started_at: d.at,
      dispatch: d.id,
      title: dispatchTitle(d),
      output_bytes: 0,
      duration_sec: 0,
      spawn_count: spawnCountFor(d.stage, d.shard ?? "", dispatches),
      usage: noUsage(d.at, dispatchModel(d)),
    });
  }

  for (const d of dispatches) {
    if (d.status !== "open" && d.status !== "claimed") continue;
    const key = taskKeyOf(d.stage, d.shard, String((d as { lineage?: string }).lineage ?? ""));
    const t = threads.get(key);
    if (!t) continue;
    if (t.status === "running" || t.status === "starting") continue;
    /** 让位行允许改写：其工作进程记录停在 suspended，不能按启动时刻更晚就跳过。 */
    const suspendedRow = t.status === "suspended";
    if (String(t.started_at ?? "") > String(d.at ?? "") && !suspendedRow) continue;
    const live = workers.some(
      (w) =>
        w.stage === d.stage &&
        (w.shard ?? "") === (d.shard ?? "") &&
        (w.status === "running" || w.status === "starting"),
    );
    if (live) continue;
    t.status = threadStatusOf(d);
    t.dispatch = d.id;
    t.worker = d.worker ?? "";
    if (d.promoted_at) t.promoted_at = d.promoted_at;
    else delete t.promoted_at;
    if (d.urgent) t.urgent = true;
    else delete t.urgent;
    if (d.yielded_at) {
      t.yielded_at = d.yielded_at;
      if (d.yielded_by) t.yielded_by = d.yielded_by;
    } else {
      delete t.yielded_at;
      delete t.yielded_by;
    }
    if (d.status === "open") {
      let reason: string;
      if (dispatchPaused(d)) reason = String(d.paused_reason ?? "").trim() || "上次中断未完成，等待唤醒";
      else if (d.yielded_at) reason = yieldedReason(d);
      else if (isHeld(d.shard)) reason = "人工接管中，监工不自动派单";
      else if (capacity <= 0) reason = "等待外部领单（--no-spawn）";
      else if (running >= capacity) reason = `等待空槽（并行度 ${running}/${capacity}）`;
      else reason = "等待派发（槽位未满）";
      t.queued_reason = reason;
    }
  }

  const refs = new Map<string, { workers: string[]; dispatches: string[] }>();
  const addRef = (key: string, workerId?: string | null, dispatchId?: string | null): void => {
    let h = refs.get(key);
    if (!h) {
      h = { workers: [], dispatches: [] };
      refs.set(key, h);
    }
    const w = String(workerId ?? "");
    const d = String(dispatchId ?? "");
    if (w && h.workers.length < 20 && !h.workers.includes(w)) h.workers.push(w);
    if (d && h.dispatches.length < 20 && !h.dispatches.includes(d)) h.dispatches.push(d);
  };
  for (const w of workers) {
    const d = w.dispatch ? dispatchById.get(w.dispatch) : undefined;
    addRef(taskKeyOf(w.stage, w.shard, String(d?.lineage ?? "")), w.id, w.dispatch);
  }
  for (const d of dispatches) {
    addRef(taskKeyOf(d.stage, d.shard, String(d.lineage ?? "")), d.worker, d.id);
  }
  for (const t of threads.values()) {
    const h = refs.get(t.id);
    if (!h) continue;
    t.workers = h.workers;
    t.dispatches = h.dispatches;
  }

  // 全部线程都要补消息，但只对最终返回的那批排序与截断。
  const clearedMarks = readClearedMarks(root);
  const all: ThreadSummary[] = [];
  for (const t of threads.values()) {
    if (clearedMarks[t.id] && (threadStatusTerminal(t.status) || threadStatusAbnormal(t.status))) continue;
    const msgs = threadMessages(ctx, t.id, t.shard, { limit: 40, logTailBytes: THREAD_PEEK_TAIL_BYTES }).messages;
    const last = msgs[msgs.length - 1];
    if (last) {
      t.last_at = last.at;
      t.last_role = last.role;
      t.last = oneLine(last);
    }
    loadThreadSeen(root);
    t.unread = msgs.filter((m) => atTs(m.at) > (threadSeen.get(t.id) ?? 0)).length;
    all.push(t);
  }
  fillContextWindow(all, root, (t) => String(t.worker ?? ""));
  const byAge = [...all].sort(
    (a, b) =>
      (atTs(a.started_at ?? "") || atTs(a.last_at)) - (atTs(b.started_at ?? "") || atTs(b.last_at)),
  );
  const nos = assignThreadNos(root, byAge.map((t) => t.id));
  for (const t of all) t.no = threadNoLabel(nos.get(t.id));

  for (const t of all) {
    const own = dispatchById.get(String(t.dispatch || ""));
    const s = String(own?.status ?? "");
    t.settled = s === "done" || s === "closed";
  }

  const noOfDispatch = new Map<string, string>();
  for (const t of all) {
    if (!t.no) continue;
    for (const id of [t.dispatch, ...(t.dispatches ?? [])]) {
      const key = String(id ?? "");
      if (key && !noOfDispatch.has(key)) noOfDispatch.set(key, t.no);
    }
  }
  for (const t of all) {
    const d = t.dispatch ? dispatchById.get(t.dispatch) : undefined;
    if (!d) continue;
    const p = parentOf(d);
    if (p) t.parent = p;
    const why = String(d.parent_reason ?? "").trim();
    if (why) t.parent_reason = why;
    const stuck = pendingPrerequisites(d, dispatches).filter((id) => id !== "*")[0] ?? "";
    t.stuck_on = stuck;
    t.stuck_on_no = stuck ? noOfDispatch.get(stuck) || threadNoOf(root, stuck) : "";
  }

  const holdByThread = new Map<string, { at: string; why: string }>();
  for (const d of dispatches) {
    if (d.status !== "failed") continue;
    const v = String((d as { retry_verdict?: string }).retry_verdict ?? "");
    if (v !== "hold") continue;
    const key = taskKeyOf(d.stage, d.shard, String((d as { lineage?: string }).lineage ?? ""));
    const prev = holdByThread.get(key);
    if (!prev || String(d.at ?? "") >= prev.at) {
      holdByThread.set(key, { at: String(d.at ?? ""), why: String((d as { retry_why?: string }).retry_why ?? "") });
    }
  }
  for (const t of all) {
    const hit = holdByThread.get(t.id);
    if (!hit) continue;
    t.retry_verdict = "hold";
    t.retry_why = hit.why;
  }
  all.sort((a, b) => {
    const live = (x: ThreadSummary): number => (x.status === "running" || x.status === "starting" ? 0 : 1);
    return live(a) - live(b) || atTs(b.last_at) - atTs(a.last_at);
  });

  const cost = costTotals(
    all.map((t) => ({
      id: t.id,
      shard: t.shard,
      stage: t.stage,
      output_bytes: t.output_bytes,
      duration_sec: t.duration_sec,
      spawn_count: t.spawn_count,
    })),
  );
  const totals = { ...cost, ...tokenTotals(all.map((t) => t.usage)) };
  /** 统计在全量上算完再截断，分页不影响数字。 */
  const counts = rememberTaskCounts(root, taskCountsOf(all, acceptedThreadKeys(root, dispatches), settledThreadKeys(dispatches)));

  const want = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : THREAD_PAGE_LIMIT;
  const total = all.length;
  if (total <= want) return { threads: all, total, truncated: false, counts, totals };

  // 运行中的线程全部保留，可超过 limit；剩余名额按排序补齐。
  const live = all.filter((t) => t.status === "running" || t.status === "starting");
  const rest = all.filter((t) => t.status !== "running" && t.status !== "starting");
  const room = Math.max(0, want - live.length);
  const picked = new Set<string>([...live, ...rest.slice(0, room)].map((t) => t.id));
  const visible = all.filter((t) => picked.has(t.id));
  return { threads: visible, total, truncated: visible.length < total, counts, totals };
}

function oneLine(m: ThreadMessage): string {
  const s = m.text.replace(/\s+/g, " ").trim();
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

function toolSummary(e: Record<string, unknown>): { text: string; cmd: string } {
  const tool = String(e.tool ?? "");
  const cmd = String(e.cmd ?? "");
  const verb =
    /^(Read|NotebookRead)$/.test(tool) ? "查文件"
    : /^(Write)$/.test(tool) ? "写文件"
    : /^(Edit|MultiEdit|NotebookEdit)$/.test(tool) ? "改文件"
    : /^(Grep|Search)$/.test(tool) ? "搜索"
    : /^(Glob)$/.test(tool) ? "找文件"
    : isShellTool(tool) ? "跑命令"
    : tool || "工具调用";
  const desc = String(e.desc ?? "").trim().replace(/\s+/g, " ");
  if (desc !== "") return { text: desc.slice(0, 80), cmd };
  let short = cmd.trim().replace(/\s+/g, " ");
  if (isShellTool(tool)) {
    const { intent, waiting } = summarizeCommand(short);
    if (intent !== "") short = intent;
    else if (waiting) return { text: "等待", cmd };
  }
  short = short.slice(0, 80);
  return { text: short ? `${verb} ${short}` : verb, cmd };
}

function workerLabel(id: string): string {
  const s = String(id ?? "").trim();
  return /^\d+$/.test(s) ? `#${s}` : s;
}

function targetFromText(root: string, text: string): string {
  const m = /#\s*(\d{1,3})(?!\d)/.exec(String(text ?? ""));
  if (!m) return "";
  const no = Number(m[1]);
  if (!Number.isFinite(no) || no <= 0) return "";
  try {
    return String(dispatchOfThreadNo(root, no)?.id ?? "");
  } catch {
    return "";
  }
}

function mqMessageText(e: Record<string, unknown>, rep: Record<string, unknown> | undefined): string {
  const body = String(rep?.text ?? e.text ?? "").trim();
  const evidence = String(rep?.evidence ?? e.evidence ?? "").trim();
  return [body, evidence ? `证据：\n${evidence}` : ""].filter(Boolean).join("\n\n");
}

function mqTriageText(e: Record<string, unknown>): string {
  const decision = MQ_DECISION_LABEL[String(e.decision ?? "")] ?? "已处理";
  const why = String(e.why ?? "").trim();
  const say = String(e.say ?? "").trim();
  return [`处理结论：${decision}`, why ? `理由：${why}` : "", say ? `回给进程：${say}` : ""]
    .filter(Boolean)
    .join("\n");
}

function cmdReceiptText(e: Record<string, unknown>): string {
  const label = zh.cmd(e.action, e.urgent);
  const arg = String(e.arg ?? "").trim();
  const ok = e.ok === true;
  const reason = String(e.reason ?? "").trim();
  const detail = String(e.detail ?? "").trim();
  return [
    `指令：${label}${arg ? ` · ${arg}` : ""}`,
    `结果：${ok ? "已执行" : "被拒"}`,
    !ok && reason ? `原因：${reason}` : "",
    detail ? `说明：${detail}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function verdictText(
  e: Record<string, unknown>,
  mq?: Map<string, Record<string, unknown>>,
  nos?: Map<string, string>,
): string {
  const name = String(e.event ?? e.kind ?? "");
  if (name === "mq_message") return mqMessageText(e, mq?.get(String(e.id ?? "")));
  if (name === "mq_triage") return mqTriageText(e);
  if (name === "supervisor_cmd") return maskDispatchIds(cmdReceiptText(e), nos);
  return maskDispatchIds(describeEvent(e), nos);
}

function maskDispatchIds(text: string, nos?: Map<string, string>): string {
  if (!text || !nos || nos.size === 0) return text;
  return text.replace(/\bD-[A-Za-z0-9][A-Za-z0-9-]{1,}/g, (id) => {
    const no = nos.get(id);
    return no ? `#${no}` : id;
  });
}

function fingerprint(e: object): string {
  const r = e as Record<string, unknown>;
  const s = [
    String(r.at ?? ""),
    String(r.event ?? r.kind ?? ""),
    String(r.tool ?? ""),
    String(r.cmd ?? ""),
    String(r.dispatch ?? ""),
    String(r.worker ?? ""),
    String(r.text ?? r.reason ?? r.note ?? ""),
  ].join("|");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

interface ThreadContext {
  dispatches: Dispatch[];
  workers: WorkerRecord[];
  directives: ReturnType<typeof listDirectives>;
  eventsByDispatch: Map<string, Array<Record<string, unknown>>>;
  eventsByWorker: Map<string, Array<Record<string, unknown>>>;
  /** 事件台账的 text 只留前 400 字，任务面板按申报 id 回查原文显示。 */
  mqById: Map<string, Record<string, unknown>>;
  triaged: Set<string>;
  /** 派单 id 到任务编号只读一次编号表，与任务列表同源。 */
  nos: Map<string, string>;
}

const messageContextCache = new Map<string, { at: number; ctx: ThreadContext }>();

/** 一轮页面构建里，线程消息会按线程各取一次上下文；同一任务根 800ms 内复用。 */
function messageContext(root: string): ThreadContext {
  const hit = messageContextCache.get(root);
  if (hit && Date.now() - hit.at < BOARD_READ_TTL_MS) return hit.ctx;
  const ctx = buildMessageContext(root);
  messageContextCache.set(root, { at: Date.now(), ctx });
  return ctx;
}

function buildMessageContext(root: string): ThreadContext {
  const dispatches = readDispatchesBoard(root);
  const workers = listWorkersBoard(root);
  const directives = listDirectives(root);
  const eventsByDispatch = new Map<string, Array<Record<string, unknown>>>();
  const eventsByWorker = new Map<string, Array<Record<string, unknown>>>();
  const triage: Array<Record<string, unknown>> = [];
  const triaged = new Set<string>();

  const mqById = new Map<string, Record<string, unknown>>();
  for (const r of readJsonlFromTail(mqPath(root), 4_000_000)) {
    const id = String(r.id ?? "");
    if (id) mqById.set(id, r);
  }

  for (const e of readJsonlFromTail(eventsFile(root), 512_000)) {
    if (String(e.event ?? e.kind ?? "") === "mq_triage") triage.push(e);
    const d = String(e.dispatch ?? "");
    const w = String(e.worker ?? "");
    if (d) {
      const list = eventsByDispatch.get(d);
      if (list) list.push(e);
      else eventsByDispatch.set(d, [e]);
    }
    if (w) {
      const list = eventsByWorker.get(w);
      if (list) list.push(e);
      else eventsByWorker.set(w, [e]);
    }
  }

  for (const e of triage) {
    const msgId = String(e.msg ?? "");
    if (msgId) triaged.add(msgId);
    const rep = mqById.get(msgId);
    const d = String(rep?.dispatch ?? "");
    const w = String(e.from ?? "");
    if (d) {
      const list = eventsByDispatch.get(d);
      if (list) list.push(e);
      else eventsByDispatch.set(d, [e]);
    }
    if (w) {
      const list = eventsByWorker.get(w);
      if (list) list.push(e);
      else eventsByWorker.set(w, [e]);
    }
  }
  return { dispatches, workers, directives, eventsByDispatch, eventsByWorker, mqById, triaged, nos: dispatchNoTable(root) };
}

interface ThreadMessageOptions {
  limit?: number;
  since?: number;
  logTailBytes?: number;
}

export function buildThreadMessages(
  root: string,
  threadId: string,
  shard: string,
  opts: ThreadMessageOptions = {},
): { messages: ThreadMessage[]; total: number; next_since: number } {
  return threadMessages(messageContext(root), threadId, shard, opts);
}

function threadMessages(
  ctx: ThreadContext,
  threadId: string,
  shard: string,
  opts: ThreadMessageOptions = {},
): { messages: ThreadMessage[]; total: number; next_since: number } {
  let s = shard;
  let taskStage = "";
  if (!s && threadId.startsWith("shard:")) s = threadId.slice(6);
  let lineageTail = "";
  if (threadId.includes("/")) {
    const parts = threadId.split("/");
    /** 阶段从任务键里取，调用方另给 shard 也要能认回原键。 */
    taskStage = String(parts[0] ?? "").trim().toLowerCase();
    if (!s) {
      const tail = String(parts[1] ?? "").trim().toLowerCase();
      if (tail === "main") {
        s = "";
      } else if (/^x[0-9a-z]{3,}$/.test(tail) && !ctx.workers.some((w) => String(w.shard ?? "").trim().toLowerCase() === tail)) {
        s = "";
        lineageTail = tail.slice(1);
      } else {
        s = tail;
      }
    }
  }

  const msgs: ThreadMessage[] = [];
  const dispatches = ctx.dispatches;
  const workers = ctx.workers;
  const sameTask = (w: { stage: string; shard?: string | null }): boolean =>
    (!taskStage || String(w.stage || "").toLowerCase() === taskStage) &&
    String(w.shard ?? "").toLowerCase() === String(s ?? "").toLowerCase();
  const keyOfWorker = (w: WorkerRecord): string => {
    const d = w.dispatch ? dispatches.find((x) => x.id === w.dispatch) : undefined;
    /** 与建端同一份实现（taskKeyOf），不另算一份。 */
    return taskKeyOf(w.stage, w.shard, String((d as { lineage?: string } | undefined)?.lineage ?? ""));
  };
  const wantKey = threadId.trim().toLowerCase();
  /** 带斜杠的是任务键，其余是老的工作进程 id 或 shard:xxx。 */
  const isTaskKey = threadId.includes("/");
  const byKey = isTaskKey
    ? [...workers]
        .filter((w) => keyOfWorker(w) === wantKey)
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0]
    : undefined;
  const sameLineage = lineageTail
    ? [...workers]
        .filter((w) => {
          if (taskStage && String(w.stage || "").trim().toLowerCase() !== taskStage) return false;
          if (String(w.shard ?? "").trim()) return false;
          const d = w.dispatch ? dispatches.find((x) => x.id === w.dispatch) : undefined;
          const lin = String((d as { lineage?: string } | undefined)?.lineage ?? "");
          /** 精确比尾号，不用 endsWith。 */
          return lin !== "" && lin.slice(-6) === lineageTail;
        })
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0]
    : undefined;
  const worker =
    workers.find((w) => w.id === threadId) ??
    byKey ??
    sameLineage ??
    (!isTaskKey && (s || taskStage)
      ? [...workers].filter(sameTask).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0]
      : undefined);
  const tid = threadId || worker?.id || (s ? `shard:${s}` : "");

  const keyOfDispatch = (d: Dispatch): string =>
    taskKeyOf(d.stage, d.shard, String((d as { lineage?: string }).lineage ?? ""));
  const related = new Set<string>();
  for (const d of dispatches) {
    if (worker) {
      if (d.worker === worker.id || d.id === worker.dispatch) related.add(d.id);
      continue;
    }
    if (isTaskKey) {
      /** 无执行者的任务键线程按同一个键认领派单。 */
      if (keyOfDispatch(d) === wantKey) related.add(d.id);
      continue;
    }
    if (s && d.shard === s) related.add(d.id);
    else if (!s && d.id === threadId) related.add(d.id);
  }

  for (const d of dispatches) {
    if (!related.has(d.id)) continue;
    const dur = d.done_at ? Math.max(0, atTs(d.done_at) - atTs(d.at)) : undefined;
    const dAtts = attachmentsOf({ atts: d.atts, text: d.action });
    const dNo = ctx.nos.get(d.id) ?? "";
    msgs.push({
      id: `D-${d.id}`,
      at: d.at,
      role: "supervisor",
      kind: "dispatch",
      text: d.action,
      tool: "",
      cmd: d.action,
      status: d.status,
      thread: tid,
      ...(dNo ? { no: dNo } : {}),
      ...(dAtts.length ? { atts: dAtts } : {}),
      ...(dur !== undefined ? { duration_sec: Math.round(dur) } : {}),
    });
  }

  if (worker) {
    const events = readWorkerEvents(worker.log, opts.logTailBytes);
    const lines = events.text;
    const relatedDispatch = dispatches.find((d) => d.id === worker.dispatch);
    const t0 = atTs(worker.started_at) || atTs(relatedDispatch?.at) || Date.now() / 1000;
    const logTouched = ((): number => {
      try {
        return statSync(worker.log).mtimeMs / 1000;
      } catch {
        return 0;
      }
    })();
    const t1 = relatedDispatch?.done_at
      ? atTs(relatedDispatch.done_at)
      : logTouched > 0
        ? logTouched
        : atTs(worker.heartbeat_at) || t0 + lines.length;
    const span = Math.max(t1 - t0, 1);

    if (lines.length === 0 && events.tools.length === 0) {
      const live = worker.status === "running" || worker.status === "starting";
      const idle = logIdleSec(worker.log);
      const fresh = Number.isFinite(idle) && idle < FRESH_LOG_SEC;
      msgs.push({
        id: `${worker.id}#empty`,
        at: new Date(t1 * 1000).toISOString(),
        role: "worker",
        kind: "tool",
        text: live
          ? fresh
            ? "进程运行中 · 正在输出"
            : `进程运行中 · 日志 ${Math.round(idle)}s 前更新`
          : "进程已结束 · 无输出文本 · 日志仅含宿主运行记录",
        tool: "",
        cmd: "",
        status: worker.status,
        thread: tid,
        lines: 0,
      });
    }

    if (events.tools.length > 0) {
      msgs.push({
        id: `${worker.id}#tools`,
        at: new Date(t1 * 1000).toISOString(),
        role: "worker",
        kind: "tool",
        text: events.tools.slice(-8).join("\n"),
        tool: "",
        cmd: "",
        status: worker.status,
        thread: tid,
        lines: events.tools.length,
        idle_sec: Number.isFinite(logIdleSec(worker.log)) ? Math.round(logIdleSec(worker.log)) : -1,
      });
    }

    if (events.thinking.length > 0) {
      msgs.push({
        id: `${worker.id}#think`,
        at: new Date(t0 * 1000).toISOString(),
        role: "worker",
        kind: "thinking",
        text: events.thinking.join("\n"),
        tool: "",
        cmd: "",
        status: worker.status,
        thread: tid,
        lines: events.thinking.length,
      });
    }

    const chunks = chunkWorkerLines(lines);
    let offset = 0;
    for (let ci = 0; ci < chunks.length; ci++) {
      const block = chunks[ci] ?? [];
      const at = t0 + (span * (offset + block.length)) / (lines.length + 1);
      msgs.push({
        id: `${worker.id}#${offset}`,
        at: new Date(at * 1000).toISOString(),
        role: "worker",
        kind: "output",
        text: block.join("\n"),
        tool: "",
        cmd: "",
        status: worker.status,
        thread: tid,
        lines: block.length,
      });
      offset += block.length;
    }
    if (events.debug.length > 0) {
      msgs.push({
        id: `${worker.id}#engine`,
        at: new Date(t1 * 1000).toISOString(),
        role: "worker",
        kind: "engine",
        text: events.debug.join("\n"),
        tool: "",
        cmd: "",
        status: worker.status,
        thread: tid,
        lines: events.debug.length,
        hidden: events.hidden,
      });
    }
  }

  const picked = new Set<Record<string, unknown>>();
  for (const id of related) {
    for (const e of ctx.eventsByDispatch.get(id) ?? []) picked.add(e);
  }
  if (worker) {
    for (const e of ctx.eventsByWorker.get(worker.id) ?? []) picked.add(e);
  }
  for (const e of picked) {
    const name = String(e.event ?? e.kind ?? "");
    if (name === "tool") {
      const t = toolSummary(e);
      msgs.push({
        id: `T-${fingerprint(e)}`,
        at: String(e.at ?? ""),
        role: "worker",
        kind: "tool",
        text: t.text,
        tool: String(e.tool ?? ""),
        cmd: t.cmd,
        status: String(e.decision ?? ""),
        thread: tid,
      });
      continue;
    }
    if (name === "dispatch_open") continue;
    const text = verdictText(e, ctx.mqById, ctx.nos);
    if (!text.trim()) continue;
    msgs.push({
      id: `E-${fingerprint(e)}`,
      at: String(e.at ?? ""),
      role: "supervisor",
      kind: "verdict",
      text,
      tool: "",
      cmd: "",
      /** 申报自己不带处理状态，按是否存在 mq_triage 标注。 */
      status: name === "mq_message" ? (ctx.triaged.has(String(e.id ?? "")) ? "done" : "pending") : String(e.event ?? e.kind ?? ""),
      event: name,
      thread: tid,
    });
  }

  const threadKeysOfDirective = (r: {
    thread?: unknown;
    shard?: unknown;
    target?: unknown;
    lineage?: unknown;
  }): Set<string> => {
    const keys = new Set<string>();
    const thread = String(r.thread ?? "").trim();
    const target = String(r.target ?? "").trim();
    const lineage = String(r.lineage ?? "").trim();
    const rshard = String(r.shard ?? "").trim();
    if (rshard) keys.add(`shard:${rshard.toLowerCase()}`);
    if (thread) {
      keys.add(thread);
      const w = workers.find((x) => x.id === thread);
      if (w) keys.add(keyOfWorker(w));
    }
    if (!target && !lineage && !rshard) return keys;
    for (const d of dispatches) {
      const dl = String((d as { lineage?: string }).lineage ?? "");
      if (target && target !== d.id && target !== String(d.worker ?? "")) continue;
      if (lineage && lineage !== dl) continue;
      if (rshard && String(d.shard ?? "") !== rshard) continue;
      keys.add(keyOfDispatch(d));
      if (d.worker) keys.add(String(d.worker));
    }
    if (rshard) {
      for (const d of dispatches) {
        if (String(d.shard ?? "") === rshard) keys.add(keyOfDispatch(d));
      }
      if (taskStage) keys.add(taskKeyOf(taskStage, rshard));
    }
    return keys;
  };
  for (const r of ctx.directives) {
    const keys = threadKeysOfDirective(r);
    /** 归属一个都算不出来的老记录不上屏。 */
    if (keys.size === 0) continue;
    if (!keys.has(threadId) && !keys.has(wantKey) && !keys.has(tid)) continue;
    const took = r.consumed === true ? String((r as { consumed_by?: unknown }).consumed_by ?? "").trim() : "";
    const tookNo = took ? ctx.nos.get(took) ?? "" : "";
    msgs.push({
      id: `S-${fingerprint(r)}`,
      at: String(r.at ?? ""),
      role: (r as { via?: unknown }).via === "capitalist" ? "supervisor" : "user",
      kind: "say",
      text: String(r.text ?? ""),
      tool: "",
      cmd: "",
      status: r.consumed
        ? (() => {
            const via = String((r as { consumed_via?: unknown }).consumed_via ?? "");
            /* 无进程领走的记录不能显示成“已并入派单”，否则用户会以为内容已进入执行。 */
            if (via === "dropped") return "未投递 · 所属单已随阶段推进作废";
            const viaHook = via === "hook";
            const base = viaHook ? "已送达执行中的进程" : "已并入派单";
            const outcome = String((r as { outcome?: unknown }).outcome ?? "");
            const tail =
              outcome === "done"
                ? " · 已落实"
                : outcome === "not_mine"
                  ? " · 判为不属本单"
                  : outcome === "blocked"
                    ? " · 卡住"
                    : (r as { delivered?: unknown }).delivered === true
                      ? " · 待结论"
                      : "";
            return base + tail;
          })()
        : (() => {
            const targetId = String((r as { target?: unknown }).target ?? "");
            const td = targetId ? ctx.dispatches.find((x) => String(x.id) === targetId) : undefined;
            const ts = String(td?.status ?? "");
            if (!td) return "已登记，随归属单带入";
            if (ts === "open") return "随派单启动带入";
            if (ts === "claimed" || ts === "reported" || ts === "review") return "已登记，进程下一次动作间隙送达";
            return "待补投递";
          })(),
      ...(tookNo ? { no: tookNo } : {}),
      thread: tid,
      ...(attachmentsOf(r).length ? { atts: attachmentsOf(r) } : {}),
    });
  }

  msgs.sort((a, b) => atTs(a.at) - atTs(b.at) || a.text.localeCompare(b.text));
  const normBody = (s: unknown): string =>
    String(s ?? "")
      .replace(/^\[附件\][^\n]*$/gm, "")
      .replace(/\s+/g, "")
      .toLowerCase();
  const saidBodies = msgs
    .filter((m) => (m.role === "user" || m.role === "supervisor") && m.kind === "say")
    .map((m) => normBody(m.text))
    .filter((s) => s.length > 0);
  const deduped = msgs.filter((m) => {
    if (m.kind !== "verdict") return true;
    const text = String(m.text ?? "");
    if (!/^派单 \S+ 追加内容/.test(text)) return true;
    const body = normBody(text.replace(/^派单 \S+ 追加内容(?:（未给出正文）)?[：:]?/, ""));
    if (body.length < 8) return true;
    return !saidBodies.some((saidBody) => saidBody.startsWith(body));
  });
  const nonEmpty = deduped.filter((m) => m.text.trim() !== "");
  const total = nonEmpty.length;
  const sinceTs = opts.since !== undefined && Number.isFinite(opts.since) && opts.since > 0 ? opts.since : 0;
  const fresh = sinceTs > 0 ? nonEmpty.filter((m) => atTs(m.at) > sinceTs) : nonEmpty;
  const limit = Math.min(Math.max(opts.limit ?? 400, 1), 2000);
  const messages = fresh.length > limit ? fresh.slice(fresh.length - limit) : fresh;
  // 游标只前进不后退，没有新增时停在调用方传入的 since。
  let next_since = sinceTs;
  for (const m of messages) {
    const ts = atTs(m.at);
    if (ts > next_since) next_since = ts;
  }
  return { messages, total, next_since };
}


const COMMAND_ACTIONS = new Set([
  "say",
  "direct",
  "takeover",
  "release",
  "stop-worker",
  "worker-model",
  "clear-threads",
  "clear-thread",
  "close",
  "promote",
  "answer",
  "block",
  "unblock",
  "stop-supervisor",
  "pause",
  "resume",
]);

function workerSessionId(stage: string, shard: string): string {
  return laneBaseId(stage, shard);
}

export function clearRuntimeLedger(root: string): { dir: string; moved: number; stage: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(root, ".capitalist", "archive", `clear-${stamp}`);
  let moved = 0;
  try {
    mkdirSync(dir, { recursive: true });
    const targets = [
      join(root, ".capitalist", "tasks.jsonl"),
      join(root, ".capitalist", "inbox", "dispatch.jsonl"),
      join(root, ".capitalist", "workers", "index.jsonl"),
      join(root, ".capitalist", "direct.jsonl"),
      join(root, ".capitalist", "supervisor-direct.jsonl"),
      join(root, ".capitalist", "events.jsonl"),
    ];
    for (const f of targets) {
      try {
        if (!existsSync(f)) continue;
        renameSync(f, join(dir, basename(f)));
        moved += 1;
      } catch {
      }
    }
  } catch {
  }

  let stage = "";
  try {
    const st = loadState(root);
    const specPath = String((st as unknown as { contract_path?: string } | null)?.contract_path ?? "");
    const spec = specPath ? readJson<{ stages?: { id?: string }[] } | null>(specPath, null) : null;
    stage = String(spec?.stages?.[0]?.id ?? "");
    if (st && stage) {
      updateState(root, (s) =>
        Object.assign(s, {
          stage,
          stage_entered_at: new Date().toISOString(),
          counters: {},
          next_action: "",
          blockers: [],
        }),
      );
    }
  } catch {
  }
  return { dir, moved, stage };
}

export interface CommandResult {
  status: number;
  body: Record<string, unknown>;
}

function cStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function cBad(msg: string): CommandResult {
  return { status: 400, body: { error: msg } };
}

function cId(v: unknown, name: string): string | null {
  const s = cStr(v);
  if (!s) return null;
  if (s.length > 80) return null;
  if (/[\s\u0000-\u001f]/.test(s)) return null;
  return s;
}

function pickShots(picks: number[] | undefined, own: string[], shots: readonly ShotRef[]): string[] {
  if (!picks) return own;
  if (picks.length === 0) return [];
  const byIndex = new Map(shots.map((s) => [s.index, s.path] as const));
  const hit = [...new Set(picks.map((n) => byIndex.get(n)).filter((p): p is string => Boolean(p)))];
  return hit.length ? hit : own;
}

/** 监工会话同一时刻只允许一条在调模型，顺序按发送顺序；带 thread 的工作进程会话仍并发。 */
let supervisorChatChain: Promise<void> = Promise.resolve();

function serializeSupervisorChat<T>(fn: () => Promise<T>): Promise<T> {
  const run = supervisorChatChain.then(fn, fn);
  supervisorChatChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function supervisorPolicy(opts: {
  shots: readonly ShotRef[];
  viaSupervisor: boolean;
  currentMsgId?: string;
  ownOnly?: boolean;
}): string {
  const shotBlock = opts.shots.length
    ? [
        "",
        opts.ownOnly
          ? "【可用截图】这条消息携带的图片，带编号（编号仅用于 ATT 行，正文不写路径）："
          : "【可用截图】本会话最近携带的图片，带编号（编号仅用于 ATT 行，正文不写路径）：",
        ...opts.shots.map(
          (s) => `  ${s.index}. ${s.path}${opts.currentMsgId && s.msg_id === opts.currentMsgId ? "（本条消息刚贴的）" : ""}`,
        ),
      ].join("\n")
    : "";
  return [
    "【角色：监工对话层】",
    "用户输入需先判定执行方与产出，再决定是否派单。",
    "",
    "判定依据为以下三项：",
    "  一、区分陈述 / 询问与指出问题 / 提出要求。",
    "     · 陈述、询问：进度、原因、意见与闲聊 -> 直接回答，不写动作。",
    "     · 指出问题：“这个不对”“太丑了”“又坏了”“点不动”“一直没反应”-> 需派单。",
    "     · 带图询问按指出问题处理，图作为证据。",
    "     · 提出要求：改、做、加、删、换、执行验证 -> 需派单。",
    "  二、需派单时区分运行中派单的追加要求与新事项：同一事项写 amend，新事项写 dispatch。",
    "  三、判定不明确时：带图按指出问题处理；纯文字先问是否需要改动，不直接派单。",
    "     派错会产生两个进程改同一处、互相覆盖。",
    "",
    "【一条消息里几件事：一件事一张单】",
    "  · 几件事就写几个 `DO: dispatch` 行，每行一张单，按消息里的顺序标 1. 2. 3.；界面上各成一张卡。",
    "  · 一张单只放一件事。同一块地方但验收方式不同，也算两件事：一个看视觉、一个看元素在不在，",
    "    分两单派；并入一单时，工作进程完成第一件后可能报完成，其余无人执行。",
    "  · 出现“另外 / 还有 / 顺便 / 第二个 / 再”时按新事项另起一行，不并入上一单。",
    "  · 第 2、3 件不写入第 1 件的参数里。每张单的正文都自含：只说这一件，不写“同上”“接着第 1 点”。",
    "  · 顺序写在参数开头的 `1.` `2.` `3.` 里，那是给人看的编号，不是把几件事串成一张单。",
    "  · 图号按用户发图顺序固定，不重排。",
    "  · 图跟单走：`ATT:` 写在它自己那张单的 `DO:` 行下面。写了 ATT 的单按它取图，未写 ATT 的单不带图。",
    "  · 正文里每提到一张图，必须附带它的内容特征，让编号和内容当场对上：",
    "    正确：“图1 那条 `上下文 ≈50.3k/600.0k` 的长串”“图2 那条带竖线和三个按钮的指标条”；",
    "    错：“图1 是参照样式”——没有内容特征，编号安错了也无从核对。",
    "  · 参照方向不可颠倒：“A 的样式参考 B”＝ B 是参照物（目标长这样），A 是要改的（现在不对）。",
    "    “参照”只能挂在 B 那张图上，挂在 A 上即方向颠倒。",
    "  · 每张图须逐张核对；正文引用它只写“图1”“图2”，不直接引用用户消息里的 `[附件] 路径` 行。",
    "  · 示例。用户发“这里不对（图1），照那边改（图2），另外把标题减小”，你写三张单：",
    "      DO: dispatch 1. <这里>：<要它变成什么样>",
    "      ATT: 1",
    "      DO: dispatch 2. <那边>：<照图2 改哪里>",
    "      ATT: 2",
    "      DO: dispatch 3. <标题>：<改到什么程度>",
    "      ATT: none",
    "  · 派单正文需给出每张图的内容特征；缺少特征时不派单。",
    "",
    "【不设计工序】派单就是任务本身：一件事建一张单，不要先拆成阶段",
    "  （“盘点->实现->验收”这种）。验收标准就在单里，由产出物证据判定；契约里只有一个空的",
    "  执行阶段，它不代表任何工序，也不要照着它派活。需要领域约束（红线、手法）时，",
    "  由用户指定某个 skill，读取该 skill 执行；领域规则不写进契约。",
    "",
    "【要“知道”的自己查，要“改”的才派】",
    "  · “为什么不动 / 怎么回事 / 卡在哪 / 是不是坏了 / 查一下”属查询，不生成待办。",
    "    状态、台账、日志与代码均可直接读取，读取后直接回答；派出的进程读取同一份内容。",
    "  · 只有“要落地改动（代码 / 数据 / 文件 / 配置 / 文档）、需要长时间运行、需要独立上下文”才开进程。",
    "    diagnose 仅用于对话层无法完成、需要长时间排查的任务；能自行回答的不派单。",
    "  · 派单需排队，轮到执行时单内所述现状可能已变化。派单正文写**目标**，不写**现状对比**：",
    "    · 不写“核查 #29 是否已过期，逐条给出作废/改写/保留”——该写法属代读台账。",
    "    · 写“把 <文件> 的 <行为> 改成 <目标行为>，验收读改动点确认”——现状由工作进程按目标核对。",
    "",
    "【动作面】判定依据为台账与派单状态。可用动作：",
    "  · 派单 / 补单（往已有单追加要求）/ 置顶立即执行 / 暂停调度与恢复 /",
    "    重试失败单 / 调并行度 / 重载上下文 / 重开（reload）。",
    "  · 启动时被暂停的旧派单只能由用户唤醒（看板“已暂停”筛选下逐单唤醒，或 capitalist wake --user）。",
    "    对话层不代为唤醒：这些单可能已过时，是否继续执行由用户判断。",
    "  · 结果检验：工作进程报完成后，读取报告中的完成项与改动位置，与派单要求比对。",
    "    报告声明“已完成”但改动对象与派单不一致时，按未完成处理。",
    "    接受、打回重做或换派单重派按判定结果选择。",
    "  · 调度本身也是任务：任务树怎么长、哪几单并行、哪单等哪单、并行度设几，由对话层判定。",
    "",
    "【能读到什么、能答什么】cwd 为任务根，可读取全部文件：",
    "  · `.capitalist/tasks.jsonl` 每单的 detail（要求原文）与 note（裁决结论）；",
    "  · `.capitalist/inbox/dispatch.jsonl` 派单正文、附件、状态、时间；",
    "  · `.capitalist/workers/*.log` 进程输出；`.capitalist/events.jsonl` 事件流水；",
    "  · 现成命令：`capitalist tasks`（每单要求与状态）、`capitalist worker <进程号>`（某个进程执行过什么）、",
    "    `capitalist status`（全局运行中/排队/异常）。查“为什么没动”时先执行这三条命令。",
    "  · 任务根下的内容不只代码：也可能是资产清单、数据集、报告、笔记或脚本。判断作用对象前不预设项目类型，",
    "    依据随内容而定：挖洞项目看站点与接口，代码项目看文件与组件，数据项目看表与字段。",
    "  · 凭这些能答：某单卡在哪、为什么没动、下一步怎么排；某条要求是否已实现、两份口径是否冲突；",
    "    调度历史（何时派出、被谁改过口径、哪步作废）；任务关系（`lineage` 重派血统、`merged_from` 归并来源、",
    "    父子与并行）；以及项目怎么跑、这段代码做什么、两个方案怎么选这类日常问题。",
    "    以上均可直接回答，不派单，也不另开一单去查。",
    "",
    "【进程之间不共享上下文】每张单的工作进程只拿到自己这一单的说明与自己这条会话。",
    "  同一个任务根是运行条件，不是信息通道：它没有理由、也不该去读别的单的正文、",
    "  别人的日志与会话。回复时不提及“工作进程能看见别的单 / 独立的是进程不是访问范围”；",
    "  被问到时按上面这句回答。",
    "",
    "【边界两条，不作为免责条款】",
    "  · 落地改动归工作进程：对话层判断、派单、验收，但不改动任务根内的文件（代码、数据、配置、文档都算）。",
    "  · 你不占并发槽：只有派出去的单才占，所以只读任务不派发。",
    "  · 除此之外没有禁区：答不上来的就去读，读完再答。",
    "",
    "【可写的动作行，一行一个，写在正文最后】",
    "  DO: dispatch [分类] <要做什么>   加一件新活。分类按**作用面**打一个词（组件 / 文件 / 脚本 / 数据 / 接口 / 配置），",
    "      同一块东西共用一个词、不同东西用不同的词——同词即同车道，工作进程会复用上一单的上下文。",
    "      分类**必须**用方括号包住，紧跟在 dispatch 后面：`dispatch [queue-card] 把第二行改成标签加数值`。",
    "      不写方括号，这个词就成了正文的第一个字——界面上这一单的标题会变成“ui 把顶部那行指标”，",
    "      而且它不会和其它同类活共用上下文。宁可写 [misc] 也不要省掉括号。",
    "  DO: amend #<编号> <补充或更正的内容>     这句话是在改已经开始的那一单（见下面“改口”）",
    "      编号就是上面【任务编号表】里的号，**必须写**，且写在正文最前面。不写号会被拒绝，",
    "      系统不代为推断目标单。",
    "      例：`DO: amend #02 顶栏不许再渲染状态徽章`。",
    "  DO: diagnose <查什么>  /  DO: fix <卡在哪>   查根因 / 查完直接修",
    "  DO: pause  /  DO: resume  /  DO: retry <分片>  /  DO: concurrency <数字>  /  DO: reload",
    "  DO: promote #<编号>   把这张排队中的单置顶并立刻执行（槽满时挂起一张运行中的任务腾槽）",
    "  没写成动作行就没有执行。不要声称已追加或已派单，回执由系统在动作执行后给出。",
    "",
    "【重派前先核对卡点】retry 一个失败过（或中途被结）的任务之前，必须先核对原任务的卡点：",
    "  上次失败的原因、阻塞项（缺依赖、缺权限、前置单未完成、要求矛盾等）现在是否已经消除。",
    "  卡点仍然存在的任务不要重派——重派只会在同一处再次失败。核对后仍不重派的，",
    "  在回复里写明具体原因（卡点是什么、为何暂不重派）；卡点已消除（依赖装好、前置完成、口径已改）才写 retry。",
    "",
    "【派单前先读懂，派单时写清楚】dispatch 和 amend 的参数就是工作进程拿到的任务说明：",
    "  · 生成派单参数之前，先读齐相关上下文再下笔：任务台账里这张单（含其父单、同类单）的",
    "    完整历史与已派单的结论、失败原因；涉及的实际对象与现状。确认理解与现状无偏差，",
    "    才能开始写参数；读不出把握的部分直接问用户，不要带着含糊下笔。",
    "  · 参数里写明关键上下文锚点，让工作进程无需猜测：涉及哪些模块或界面、当前行为是什么、",
    "    做到什么程度算完、不许改动的边界（哪些文件 / 模块 / 行为这一单不许碰）。",
    "    · 用户给了 skill、文档或一段任务描述，先读完读懂；理解不透就直接问用户要哪部分，",
    "    不要把自己没读懂的原始表述原样写入参数转给工作进程。",
    "  · 参数只写这一单的工作内容，整理成结构完整、目标明确、无歧义的一段话：要做什么、",
    "    改哪里、做到什么程度算完。不直接引用用户的口语表述。",
    "  · 【一件活一张单】作用对象不同，或验收方式不同，即为两件事：各写一条 `DO: dispatch`。",
    "    合并为一张时，工作进程无法确定执行顺序，可能只完成其中一部分即申报完成，验收阶段也无法判定未达标项。",
    "  · 【按消息里的顺序编号】一条消息拆成几单时，按消息里的先后给 1、2、3……，每单正文以**它自己的号**",
    "    开头（第 2 件就写“2. ”），号跟着这件事走、拆单后不重排；只有一件事时不写号。",
    "    编号用于对齐工作进程与用户：缺少编号时无法判断当单对应第几件事。",
    "  · 【顺序就是用户发的顺序】他连发几条，就按第 1、2、3 条的顺序判断与派单，后一条不越过前一条的顺序。",
    "  · 【相关就复用同一个工作进程，避免每单重新读取】分类标签不只是分类，它是**工作车道**：",
    "    同标签的单会接到同一个工作进程的上下文上，上一单读过的东西、动过的对象都还在（缓存命中，省时省钱）。",
    "    所以后一条与前一条作用在同一处、同一个对象、验收互相牵连时，**用同一个标签**派新单，使其延续已有上下文。",
    "    上下文余量由车道自己卡（占窗口六成就自动换新代），你不用自己算，也不用为了省上下文拆标签。",
    "    要真正复用上，给它写 `PARENT: #<前一张>`：等前一张做完、车道空出来，它启动时直接续接同一会话。",
    "    两单同时拉起反而各自换新代——同一条车道一次只允许一个进程，冲突时会换代并丢失上下文。",
    "    所以同一个对象有多单时默认串成链（后一单挂前一单）：同一个站的子域枚举 -> 越权 -> SSRF -> 出报告。",
    "    什么时候不建链：几件事互不依赖、更看重速度、或者前一张已经把上下文用掉大半——那就并行，代价是各自重读一遍。",
    "    跨对象永远并行：两个不同的站、两只不同的票，是两条链同时跑。",
    "  · 【上下文一定会换，结论必须落盘】车道到窗口六成就换代，新进程看不到上一单说过什么。",
    "    所以要求工作进程把**已经确认的结论写进文件**（清单、scope、笔记、报告草稿），别只留在对话里；",
    "    后一单的第一件事是读这些文件。尤其在长链里（一个站十几个面），靠上下文接力一定会断，靠文件不会。",
    "  · 【标签第一维永远是“对象”，不是动作或类型】对象 = 这件事作用在**哪一个**东西上（那个站、那个项目、",
    "    那份数据、那个主题）。同对象的多单必须同标签（同车道＝共享已经读过的东西）；",
    "    不同对象换标签（不同车道才能并行，也不会互相污染）。",
    "    第二维（漏洞面 / 改动类型 / 当前阶段）写进正文，**不进标签**。按类型拆标签的后果：同一个站的两个面",
    "    落到两条车道，侦察成果、登录态、已知接口清单全部作废，第二条从零再来一遍。",
    "    例：挖洞项目同一个站的几件事（子域枚举、越权、SSRF、出报告）全用 `[host-example-com]`，",
    "    不要写成 `[recon]` `[api]` `[ssrf]` `[doc]`；同一个组件全用 `[queue-card]`，不按 ui/fix 分；",
    "    同一只票的几次分析全用 `[600519]`，不按“财报 / 技术面 / 复盘”分。",
    "    另一种极端是把所有站都打成一个标签，形成“全网一个工作进程”——上下文耗尽、各站互相干扰。",
    "  · 【复用不等于合并】编号、验收、状态各记各的，只是落在同一个工作进程的上下文里。",
    "    只有“后一条是对前一条同一对象的补充或更正”才写 amend（把要求追加进那张单）；",
    "    是另一件事就各自成单、共用标签，不改前一张单的要求。",
    "  · 【先想清楚，再用书面语写】派单正文是转述给一个刚接手的人的一段话。写之前先答四个问题：",
    "    ① 对什么做——就是**哪一个东西**：用户说的是哪个、在哪能找到它。不要停在类别上（“那个样式”“那个站”）；",
    "    ② 要它变成什么样——用户要的结果，不是工序；",
    "    ③ 不许碰什么——边界；",
    "    ④ 怎么算做完——他要的那个结果怎么确认。",
    "    ① 答不出来、或者能落到两个东西上，就是还没懂：先自己查，查不出来就问用户（capitalist ask），不凭推断派单。",
    "    指认对象须落到具体位置：“任务消息栏”指聊天区的消息框，不等于任务卡第二行。",
    "  · 【正文要短：只负责把要求说得没有歧义】四个问题想清楚，写出来的只是一段话（多件事时每件一段）：",
    "    落在哪个东西上、要它变成什么样。**怎么改、改哪几行、用什么写法、分几步做，一个字都不要写**——",
    "    那是工作进程的任务。对话层不设计方案，只把有歧义的要求改成不会看错的一段话。",
    "    正文只写目标，不扩写成一整套排版规格；",
    "    正文写得越长，它越可能只做对一半。",
    "  · 【模板是格式，不是内容】编号、分段、附件行是为了让它读得清；决定它做对做错的，是上面四个问题",
    "    答得准不准。不要为了对齐格式把一段说明拆成检查项，也不写用户没提的工序。",
    "  · 【附件必须自带说明，正文按图号引用】一条消息带多张图时：",
    "    · `ATT:` 只写这一单要用的那几张，不把整条消息的图全部带入；",
    "    · 每张图一行，行末括号里写**它是哪一张、干什么用的**：",
    "      `（图1 · 现状：任务面板现在这条空格长串）` / `（图2 · 参照：顶栏指标条，目标样式照这个）`。",
    "      只写“现状”“参照”不够——工作进程得知道拿它干什么；",
    "    · 正文里引用图**只许写“图1”“图2”**，不许写“附图一 / 附图二 / 第一张”：",
    "      中文数字与顺序容易写反：正文写“附图一为目标样式”时，",
    "      第一张可能是任务面板现状、第二张才是监工指标条，会把现状当成目标；",
    "    · 角色**必须逐张核对图片之后写**，不按顺序推断：先发的未必是现状、后发的未必是目标；",
    "    · 图片顺序按用户发图的顺序排，不要重排；",
    "    · 绝不许把图统一列在正文末尾让工作进程自己配对——它不知道哪张对应哪段。",
    "  · 【同一处不等于一件事】两件事作用在同一块地方，但**验收方式不同**，也要拆开派：",
    "    验收方式不同的两件事合并成一单时，工作进程做完一件就可能报完成；",
    "    判据是作用对象不同或验收方式不同，不是“改的地方”不同才拆。",
    "    格式照这个写（换行是硬要求，不许压成一行）：",
    "      1. <对象>：<要做什么、做到什么程度算完>",
    "      [附件] .capitalist/attachments/<这一件的图>（图1 · 现状：<这是什么、现在什么样>）",
    "      （空行）",
    "      2. <对象>：<要做什么、做到什么程度算完>",
    "      [附件] .capitalist/attachments/<这一件的图>（图2 · 参照：<拿它干什么>）",
    "    只有一件事时去掉号，正文第一句照样指认对象；没有配图的那一段写 `[附件] 无`，不要留空。",
    "    多件事共用同一张图时，那张图在每一单里都写一次（各单独立，不跨单引用）。",
    "",
    "【验收要求不写测试与截图门槛】参数里的“做到什么程度算完”按行为写，不按证据形式写：",
    "  · 不要要求“跑通全量测试”“构建加全量校验”“端到端长跑”——耗时流程不作为阶段门槛；",
    "  · 不要要求截图或截图核对。验收就写“他要的那个结果怎么确认”——能看到那个结果出现就算过，",
    "    不要写成流程（跑通测试、构建完成）或者材料清单（交截图、交文档）。",
    "    那个结果长什么样由这件事决定：一个数值、一段输出、一个能复现的现象、一份能打开的文件。",
    "  · 只有用户明确点名要看截图时，才在参数里写截图。",
    "",
    "【派单顺序是多节点，不是一条队】每张派单是树上一个节点：最多一个父节点（做完它才能开始），",
    "  同父的节点是兄弟（可以同时跑），没有父节点的节点自成一棵树，树与树之间互不影响。",
    "  派单时先判断这一单属于哪一种，判断写进数据，不写在参数里：",
    "  · 要先等某一单做完 -> 动作行下面写两行：",
    "      PARENT: #<编号>",
    "      PARENT_REASON: <为什么必须先做它，一两句，写清等的是它的哪个产出>",
    "    例：",
    "      DO: dispatch [ui] 重做顶栏布局",
    "      PARENT: #03",
    "      PARENT_REASON: 新顶栏按 #03 定稿的栅格尺寸排版，提前做会全部返工",
    "  · 可以同时做 -> 写 `PARENT: none`。先后关系不成立就不要挂父节点：为了整齐建立 A->B->C",
    "    的长链，会把本来能并行的活压成单列。",
    "  · 兄弟由“同父”自动形成：两张单都写 `PARENT: #03`，父节点完成后两张一起进队列。",
    "  · 父节点编号必须出现在【任务编号表】里。父节点不存在、已被结项（closed）、或成环时，",
    "    该派单会被拒绝并给出原因；不挂父节点重新提交，不会静默降级为无依赖。",
    "  · 老写法 `AFTER: #<编号>` 仍然有效（多个编号 = 多个前置；收尾单写 `AFTER: *`）。",
    "    只有确实要同时等多个单时才用它，单条先后关系写 PARENT。",
    "  · 【红线】参数里绝不许出现“等…完成再做…”“先做 X 再改 Y”这类顺序句。工作进程看不到别的单、",
    "    也没法等：它只会空转，同时占着并发槽，被等的那一单永远排不上——两边互相等死。",
    "    顺序一律用 `PARENT:` 表达：挂着父节点的单在父节点完成前不会启动，也就不占槽。",
    "    参数含顺序句时，工作进程会占住并发槽等待另一单完成，两条派单互相阻塞。",
    "    顺序关系一律写入数据，不写进参数。",
    "",
    "【他说“立即做”“最高优先级”是什么意思】他要的不是“排到队首”，是“马上跑”：",
    "  · 先 `DO: dispatch` 建单，正文只写要做什么——不要把“最高优先级”这几个字写进参数，",
    "    那是给人看的表态，不是工作内容；",
    "  · 紧跟着写一行 `DO: promote #<这一单的编号>`。只写 dispatch 不写 promote，",
    "    它就只是一张普通排队单，前方存在运行中的派单时仍须排队；",
    "  · 只认明确说法：立即 / 马上 / 现在就 / 最高优先级 / 插队 / 别排队。",
    "    “优先”“尽快”“注意一下”不算——那些是普通措辞，标成立即执行会把真正的急事挤掉；",
    "  · 同一时刻只允许一张立即执行单。已经有一张在抢槽时，如实告诉用户",
    "    “#N 正在执行，这一单排在它之后”，不要两张都标；",
    "  · 用户说的是**运行中**的派单要插队，那就只写 promote，不要再 dispatch 一张。",
    "",
    "【改口不是新增任务】一条消息可能分两次发送，后一条更正前一条：",
    "  · 他要的结果变了，而这件事已经运行中 -> DO: amend，进那一单；不要新开一张去做同一件事。",
    "  · 他在补充同一个要求（说得更细、把错字改了、把口径收紧）-> 同样走 amend。",
    "  · 前后冲突时以**后收到的**为准；后一条往往用于推翻前一条。",
    "  · **引用某一条说“不对 / 应该是…”**：那是他对已经派出去的那一单做修正，不是重提、也不是新活。",
    "    引用消息时会看到“这条消息已派成 #N”，就写 `DO: amend #N …` 落回同一单；",
    "    找不到对应单（那句只是聊天、没派单）才 dispatch，并在回复里说明“没找到它对应的单，已新开 #N”。",
    "    这一步错了代价最大：他不是在提新要求，你新开一单，就是两个进程改同一处、互相覆盖。",
    "  · 【判“同一件事”比两样：作用的对象 + 要它变成什么样】两样都对得上才算同一件；只差措辞不算两件，",
    "    但**对象不同就一定不是同一件**——哪怕两个标题里都有“标题行”三个字。",
    "    判“与 #N 同一件事”须比对作用对象与验收方式：只差措辞仍算同一件，",
    "    对象不同则不是同一件，不能因标题相近就作废其中一单。",
    "  · 【说“与 #N 同一件事”之前，先读那一单的正文】编号只是索引，不是内容。",
    "    指错号比判错更伤：用户会以为派单被误作废。读一行正文就能避免。",
    "",
    "【推翻已定的口径要写明】“以后说的为准”只管**同一次对话里的改口**，不管历史派单：",
    "  · 新要求与【最近派过的单】里任何一条相反时，动作行下面单独写一行 `REVOKE: <被作废的那条口径>`，",
    "    例：",
    "      DO: dispatch [ui] 指令卡改多行展示",
    "      REVOKE: 撤掉输入框上方的调度指令回显条",
    "    这一行说明本次是**有意**推翻，后面的工作进程与验收都按它理解。",
    "  · 没有 REVOKE 却要恢复一个已经撤掉的东西，就是两套并存（旧的不拆、新的又加），",
    "    界面上会同时出现两条互斥的实现。这种情况先 `capitalist ask` 问清是推翻还是并存，不推断。",
    "  · 【红线】同一件事的两次要求在字面上互斥、又都没写 REVOKE 时，不许直接派：",
    "    指出“这一条与 #N 已验收的做法相反”，并给出两个选项。",
    "",
    "【是否带图按相关性判定】",
    "  派单或 amend 时，在动作行后单独一行写 ATT: <编号，逗号分隔>，只带真正相关的那几张。",
    "  一张都不相关就写 ATT: none。不写这一行则默认带用户这条消息自带的图。",
    "  判据只有一条：工作进程看到这张图，会不会把这件事做得更准。看不出来就不带——每张图都占它的上下文。",
    shotBlock,
    ...(opts.viaSupervisor
      ? [
          "",
          "【用户按了“监工介入”】提问发生在某个进程的会话里，携带那个任务编号直接回答；",
          "不要把这句话登记回那一单，也不要转给那个进程——他要的就是监工自己来说。",
        ]
      : []),
    "",
    "【别做的事】",
    "· 不要把问句翻成待办：每翻一个就多一张单、多一个进程，还要有人做完它。",
    "  典型误判：“查一下为什么没动”被写成 dispatch——等那单排到，要查的状态已经变了。",
    "  问句的答案只能你当场给，外面的进程给不了。",
    "· 不要写“已登记”“我记住了”“已派发”——那是系统执行完自己会说的话，写了会与系统回显重复。",
    "· 不解释判断规则，不纠正用户表述。",
    "· 自己查的时候只看不改：可以读台账、日志、代码，不要改文件、不要跑部署或删除类命令，",
    "  也不要执行 capitalist advance / capitalist adopt / capitalist supervise——那些是流程动作，不是查问题。",
  ].join("\n");
}

function taskKeyOf(stage: string, shardName: string | null | undefined, lineage?: string): string {
  return laneKeyOf({ stage, shard: shardName, lineage });
}

function forestNoOf(root: string): (id: string) => string {
  const byDispatch = dispatchNoTable(root);
  return (id) => byDispatch.get(String(id)) ?? "";
}

function taskNoLines(threads: readonly ThreadSummary[], limit = 24): string[] {
  const rank = (s: string): number =>
    s === "running" || s === "starting" ? 0 : s === "queued" ? 1 : s === "failed" ? 2 : 3;
  const picked = threads
    .filter((t) => t.no)
    .sort((a, b) => rank(a.status) - rank(b.status) || Number(a.no) - Number(b.no))
    .slice(0, limit);
  if (picked.length === 0) return [];
  return [
    "",
    "【任务编号表】用户给出的 #号 就是这里的号，回答时直接引用它，不要自己编号：",
    ...picked.map((t) => {
      const who = t.worker ? "执行中" : "排队中";
      const title = t.title ? ` · ${t.title}` : "";
      return `  #${t.no} [${t.shard || t.stage}] ${t.status}${title} · ${who}`;
    }),
  ];
}

function workerRuntimeLines(root: string, max = 5): string[] {
  const live = listWorkers(root).filter((w) => w.status === "running" || w.status === "starting");
  if (live.length === 0) return [];
  const noTable = dispatchNoTable(root);
  const disps = readDispatches(root);
  const rows: string[] = [];
  for (const w of live.slice(0, max)) {
    const no = w.dispatch ? String(noTable.get(String(w.dispatch)) ?? "") : "";
    const laneId = String((w as unknown as { ai_session?: string }).ai_session ?? "");
    const base = laneId.replace(/-g\d+$/, "");
    const st = base ? readLane(root, base) : null;
    const short = base.replace(/^capitalist-[a-z0-9]+-/, "") || "?";
    const win = st ? laneContextWindow(st) : 0;
    const used = st?.ctx_used ?? null;
    const pct = used !== null && win > 0 ? Math.round((used / win) * 100) : null;
    const room = pct === null ? "余量未知" : `余量 ${100 - pct}%`;
    const gen = st && st.gen >= 4 ? ` · 第 ${st.gen + 1} 代` : "";
    const d = w.dispatch ? disps.find((x) => String(x.id) === String(w.dispatch)) : undefined;
    const rawWhat = d ? stripAttachments(String(d.action ?? "")).trim() || dispatchTitle(d) : "";
    const what = rawWhat.replace(/\s+/g, " ").trim().slice(0, 40);
    const digest = workerDigest(w);
    const tail = [what, digest].filter(Boolean).join(" · ");
    rows.push(`  ${no ? `#${no}` : `进程 ${w.id}`} · ${w.id} · ${short}${gen} · ${room}${tail ? ` · ${tail}` : ""}`);
  }
  return [
    "",
    "【运行中的进程】一行一个：编号 · 车道 · 余量 · 这一单要做什么 · 已经做到哪。判断“这句话该不该发给它”：",
    "  车道＝是不是同类任务；余量＝装不装得下；要做什么＝与当前消息是不是同一件事；做到哪＝还差多少。",
    "  这几样不够判断时不推断：`capitalist worker <进程号>` 看它的动作时间线，再不够就读 `.capitalist/workers/<进程号>.log`。",
    ...rows,
  ];
}

function workerDigest(w: { log?: string }): string {
  const file = String(w.log ?? "");
  if (!file) return "";
  try {
    const size = statSync(file).size;
    const take = Math.min(size, 256_000);
    const buf = Buffer.alloc(take);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, take, size - take);
    } finally {
      closeSync(fd);
    }
    const parts = parseWorkerLog(buf.toString("utf8").split("\n"), { stream: true });
    const edits = new Set<string>();
    const reads = new Set<string>();
    let runs = 0;
    for (const t of parts.tools) {
      const s = String(t).replace(/^▸\s*/, "").replace(/\s+/g, " ").trim();
      if (!s) continue;
      if (/^修改\s/.test(s)) edits.add(s.replace(/^修改\s*/, ""));
      else if (/^读取\s|^搜索\s/.test(s)) reads.add(s.replace(/^(?:读取|搜索)\s*/, ""));
      else runs += 1;
    }
    const out: string[] = [];
    const ed = [...edits];
    if (ed.length) out.push(`改过 ${ed.slice(0, 2).join("、")}${ed.length > 2 ? ` 等 ${ed.length} 处` : ""}`);
    if (runs) out.push(`执行过 ${runs} 步`);
    if (out.length === 0) out.push(reads.size ? `查过 ${reads.size} 处，还没动手` : "刚开始，还没动手");
    return out.join("；").slice(0, 64);
  } catch {
    return "";
  }
}

function settledLines(root: string, limit = 8): string[] {
  const all = readTasks(root)
    .filter((t) => String(t.detail ?? "").trim() || String(t.note ?? "").trim())
    .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))
    .slice(0, limit);
  if (all.length === 0) return [];
  const noTable = dispatchNoTable(root);
  const word = (s: string): string =>
    s === "accepted"
      ? "已验收"
      : s === "closed"
        ? "已关闭"
        : s === "failed"
          ? "失败"
          : s === "reported" || s === "submitted"
            ? "待验收"
            : s === "pending" || s === "open"
              ? "待执行"
              : s;
  const flat = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();
  const ask = (s: unknown): string => {
    const t = flat(s);
    const at = t.indexOf("要求");
    return (at > 0 ? t.slice(at) : t).slice(0, 44);
  };
  const verdict = (s: unknown): string =>
    flat(s)
      .replace(/(监工裁决通过|监工裁决|实地核证|核证)[：:]\s*/g, "")
      .slice(0, 48);
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const t of all) {
    const no = t.dispatch ? String(noTable.get(String(t.dispatch)) ?? "") : "";
    const key = no || String(t.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const res = verdict(t.note);
    rows.push(`  ${no ? `#${no}` : "-"} ${word(String(t.state ?? ""))} · ${ask(t.detail)}${res ? ` · ${res}` : ""}`);
    if (rows.length >= limit) break;
  }
  return [
    "",
    "【最近派过的单】按最近更新排。翻开看一遍再派：该事项是不是已经派过、上一轮做成什么样、",
    "  有没有还没做完的单在等（重复派会让两个进程改同一处，互相把对方覆盖掉）。",
    ...rows,
    "  新要求若与其中任何一条相反（恢复被撤掉的东西、改回旧行为、把两套并存的东西再叠一层），",
    "  必须在动作行下面单独写一行 `REVOKE: <被作废的那条口径>`，说清作废的是哪一条。",
    "  没有 REVOKE 行的派单不许推翻已验收的行为：两条互斥的要求同时挂着，工作进程只能照最新一句做，",
    "  结果就是把刚拆掉的东西又装回去，形成两套并存。",
  ];
}

function quoteDispatchLabel(root: string, msgId: string): string {
  const id = String(msgId ?? "").trim();
  if (!id) return "";
  const hits = readDispatches(root).filter((x) => {
    const list = Array.isArray((x as { src_msgs?: string[] }).src_msgs)
      ? ((x as { src_msgs?: string[] }).src_msgs as string[])
      : [];
    return list.includes(id) || String((x as { src_msg?: string }).src_msg ?? "") === id;
  });
  if (hits.length === 0) return "";
  const noTable = dispatchNoTable(root);
  const nos = hits.map((d) => noTable.get(String(d.id)) ?? "").filter(Boolean);
  return nos.length ? nos.map((n) => `#${n}`).join("、") : "";
}

function sayArgsOf(input: {
  text: string;
  thread?: string;
  msgId?: string;
  shard?: string;
  lineage?: string;
  dispatch?: string;
}): string[] {
  const args = ["say", input.text];
  /** 排队行的线程 id 是 shard:<分片>，写 --thread 前先还原成分片。 */
  const rawThread = String(input.thread ?? "").trim();
  const fromThread = /^shard:(.+)$/.exec(rawThread)?.[1] ?? "";
  const thread = fromThread ? "" : rawThread;
  const shard = String(input.shard ?? "").trim() || fromThread;
  const lineage = String(input.lineage ?? "").trim();
  const dispatch = String(input.dispatch ?? "").trim();
  if (dispatch) args.push("--target", dispatch);
  else if (thread) args.push("--target", thread);
  if (lineage) args.push("--lineage", lineage);
  if (shard) args.push("--shard", shard);
  if (thread) args.push("--thread", thread);
  if (input.msgId) args.push("--msg-id", input.msgId);
  return args;
}

function writeQuotedDirect(
  root: string,
  input: {
    text: string;
    shard?: string;
    thread?: string;
    quote: string;
    quoteText: string;
    msgId?: string;
    lineage?: string;
    target?: string;
  },
): boolean {
  const rec: Record<string, unknown> = {
    at: new Date().toISOString(),
    at_ts: Date.now() / 1000,
    type: "direct",
    text: input.text,
    shard: input.shard ? input.shard : null,
    quote: input.quote,
    quote_text: input.quoteText,
    consumed: false,
  };
  const quoteAtts = attachmentsIn(input.text);
  if (quoteAtts.length) rec.atts = quoteAtts;
  rec.msg_id = input.msgId || newMessageId();
  if (input.lineage) rec.lineage = input.lineage;
  if (input.target) rec.target = input.target;
  if (input.thread) {
    if (isWorkerRef(input.thread)) rec.thread = input.thread;
    else rec.lane = input.thread;
  }
  const stage = loadState(root)?.stage;
  if (stage) rec.stage = stage;
  return appendJsonl(directPath(root), rec);
}

function reopenDispatch(root: string, thread: string, shard = ""): { ok: boolean; reason: string; id?: string } {
  const rows = readDispatches(root);
  let last: Dispatch | undefined;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const d = rows[i];
    if (d && String(d.worker ?? "") === thread) {
      last = d;
      break;
    }
  }
  if (!last && shard) {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const d = rows[i];
      if (d && String(d.shard ?? "") === shard) {
        last = d;
        break;
      }
    }
  }
  if (!last) return { ok: false, reason: "未找到对应的派单记录" };
  if (last.status === "open" || last.status === "claimed") return { ok: true, reason: "" };
  if (
    last.status !== "done" &&
    last.status !== "failed" &&
    last.status !== "review" &&
    last.status !== "closed"
  ) {    return { ok: false, reason: `该派单当前状态为 ${last.status}，无法重派` };
  }
  const r = runCli(["update", "inbox/dispatch", String(last.id), "status", "open", "--root", root]);
  if (r.code !== 0) {
    return { ok: false, reason: (r.stderr || "").slice(0, 120) || "update 没返回原因" };
  }
  /** 唤醒要盖时间戳，否则阶段推进时 supersedeStaleDispatches 会在下一轮作废在途单。 */
  runCli(["update", "inbox/dispatch", String(last.id), "wake_at", new Date().toISOString(), "--root", root]);
  recordEvent(root, "dispatch_wake", {
    dispatch: last.id,
    shard: last.shard ?? "",
    worker: last.worker ?? "",
    from: last.status,
  });
  return { ok: true, reason: "", id: String(last.id) };
}

/** 调用 dist/cli/main.js，参数以数组传递，不经过 shell、不拼字符串。 */
function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const cli = join(__dirname, "..", "cli", "main.js");
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  return {
    code: typeof r.status === "number" ? r.status : 1,
    stdout: String(r.stdout ?? "").trim(),
    stderr: String(r.stderr ?? "").trim() || String(r.error ?? ""),
  };
}

/** 暂停落 .capitalist/pause.json，形状与 capitalist pause 一致，读方只有 loop.ts 的 readPause。 */
function setPause(root: string, reason: string): void {
  const rec = { at: new Date().toISOString(), reason: reason || "看板暂停调度", by: "board" };
  writeJson(pausePath(root), rec);
  recordEvent(root, "pause_set", { reason: rec.reason, by: rec.by });
}

/** 解除暂停删除 .capitalist/pause.json；文件不存在时按成功处理，不记事件。 */
function clearPause(root: string): void {
  const file = pausePath(root);
  if (!existsSync(file)) return;
  try {
    unlinkSync(file);
  } catch (err) {
    throw new Error(`暂停状态删除失败：${err instanceof Error ? err.message : String(err)}`);
  }
  clearStopFlag(root);
  recordEvent(root, "pause_cleared", { by: "board" });
}

function workerOfThread(root: string, threadId: string, shard: string): string {
  const t = buildThreads(root).find((x) => x.id === threadId);
  if (t && t.worker) return t.worker;
  if (shard) {
    const w = listWorkers(root)
      .filter((x) => (x.shard ?? "") === shard && (x.status === "running" || x.status === "starting"))
      .pop();
    if (w) return w.id;
  }
  return "";
}

/** 接管与交还的粒度是分片；只给 id 时必须反查分片。 */
function shardOfThread(root: string, id: string): string {
  if (!id) return "";
  const t = buildThreads(root).find((x) => x.id === id);
  if (t) return t.shard || "";
  return id.startsWith("shard:") ? id.slice(6) : "";
}

function resolveQuoteText(root: string, thread: string, ref: string, fallback: string): string {
  const cut = (s: string): string =>
    stripAttachments(String(s || "")).replace(/\s*\n\s*/g, " ").trim().slice(0, 200);
  try {
    const { messages } = buildThreadMessages(root, thread, "", { limit: 500, logTailBytes: 512 * 1024 });
    const hit = messages.find((m) => m.id === ref);
    if (hit) {
      const t = cut(hit.text);
      if (t) return t;
    }
  } catch {
    /** 投影失败时退回前端摘要。 */
  }
  return cut(fallback);
}

interface ClearedMark {
  at: string;
  dispatch: string;
}

function clearedMarksPath(root: string): string {
  return join(supervisorDir(root), "board-cleared.json");
}

function readClearedMarks(root: string): Record<string, ClearedMark> {
  return readJson<Record<string, ClearedMark>>(clearedMarksPath(root), {});
}

function markThreadCleared(root: string, key: string, dispatch: string): void {
  const marks = readClearedMarks(root);
  marks[key] = { at: new Date().toISOString(), dispatch: dispatch || "" };
  writeJson(clearedMarksPath(root), marks);
}

function threadStatusTerminal(status: string): boolean {
  return status === "done" || status === "exited" || status === "finished" || status === "canceled";
}

const ABNORMAL_THREAD_STATUS = new Set(["failed", "missing", "orphan", "gone"]);

function threadStatusAbnormal(status: string): boolean {
  return ABNORMAL_THREAD_STATUS.has(status);
}

export function runCommand(root: string, raw: unknown): CommandResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return cBad("请求体必须是 JSON 对象");
  }
  const body = raw as Record<string, unknown>;
  const action = body.action;
  if (typeof action !== "string" || !COMMAND_ACTIONS.has(action)) {
    return { status: 400, body: { error: `未知动作：${String(action)}`, allowed: [...COMMAND_ACTIONS] } };
  }

  const thread = cId(body.id, "id") ?? "";
  const shard = cId(body.shard, "shard") ?? "";
  const text = cStr(body.text);
  const reason = cStr(body.reason);

  switch (action) {
    case "say":
    case "direct": {
      if (!text) return cBad("text 必填");
      if (text.length > 4000) return cBad("text 过长（上限 4000）");
      const target = shard || (thread.startsWith("shard:") ? thread.slice(6) : "");
      // 引用标识必须是合法标识符。
      const quote = cId(body.quote, "quote") ?? "";
      let detail = "已登记（带引用）";
      if (quote) {
        const ok = writeQuotedDirect(root, {
          text,
          shard: target || "",
          thread: thread || "",
          quote,
          quoteText: resolveQuoteText(root, thread, quote, cStr(body.quote_text)),
        });
        if (!ok) {
          return { status: 400, body: { error: "指令写入失败", action } };
        }
        recordEvent(root, "direct_inject", { thread: thread ?? "", shard: target ?? "", text: text.slice(0, 120) });
      } else {
        const args = [action, `--text=${text}`, "--root", root];
        if (target) args.push("--shard", target);
        if (thread) {
          args.push(isWorkerRef(thread) ? "--thread" : "--lane", thread);
        }
        const r = runCli(args);
        if (r.code !== 0) return { status: 400, body: { error: r.stderr || r.stdout || "命令执行失败", action } };
        detail = r.stdout;
      }
      const wake = reopenDispatch(root, thread, target);
      const woke = wake.ok && wake.id ? wake.id : "";
      return {
        status: 200,
        body: {
          ok: true,
          action,
          thread,
          shard: target,
          ...(quote ? { quote } : {}),
          ...(woke ? { woke } : {}),
          // 生效时机由服务端给定；工作进程是一次性进程，追加的消息只对下一次派单生效。
          effective: woke
            ? `已唤醒原派单 ${woke} · 下一轮携带本条消息继续执行（保留原上下文）`
            : target
              ? `下一次 ${target} 分片派单`
              : "下一次任意派单",
          detail,
        },
      };
    }
    case "takeover": {
      if (!thread && !shard) return cBad("id 或 shard 必填");
      const target = shard || shardOfThread(root, thread);
      const r = runCli(["takeover", target || "all", `--reason=${reason || "用户在对话面板接管"}`, "--root", root]);
      if (r.code !== 0) return { status: 400, body: { error: r.stderr || r.stdout || "接管失败", action } };
      return {
        status: 200,
        body: { ok: true, action, shard: target || "all", detail: r.stdout, effective: "下一 tick 起监工不再自动重派/验收该片" },
      };
    }
    case "release": {
      // 只给 id 时只交还该线程所属分片。
      const target = shard || shardOfThread(root, thread);
      const r = runCli(["release", target || "all", "--root", root]);
      if (r.code !== 0) return { status: 400, body: { error: r.stderr || r.stdout || "交还失败", action } };
      return {
        status: 200,
        body: { ok: true, action, shard: target || "all", detail: r.stdout, effective: "下一 tick 起恢复自动重派与验收" },
      };
    }
    case "promote": {
      if (!thread && !shard) return cBad("id 必填");
      const t = buildThreads(root).find((x) => x.id === thread);
      const target = t?.dispatch || thread || shard;
      const r = promoteTask(root, target, { by: "user" });
      if (!r) {
        return { status: 404, body: { error: `没有这张单：${target}`, action, thread } };
      }
      if (!r.ok) {
        return { status: 409, body: { error: r.reason, action, thread, dispatch: target } };
      }
      const live = listWorkers(root).filter((w) => w.status === "running" || w.status === "starting").length;
      const cap = Math.max(1, Number(loadSupervisor(root)?.max_workers ?? 1) || 1);
      const willRun = live < cap;
      return {
        status: 200,
        body: {
          ok: true,
          action,
          dispatch: r.dispatch,
          ahead: r.ahead,
          urgent: true,
          preempt: r.preempt,
          ...(r.behind ? { behind: r.behind } : {}),
          detail: `越过 ${r.ahead} 张排队单${r.already ? "（重复置顶，已刷新到队首）" : ""}`,
          effective: r.behind
            ? `已置顶 · 立即执行单 ${r.behind} 仍运行中，这一单排在它之后`
            : willRun
              ? `已置顶 · 当前 ${live}/${cap} 槽有空，下一轮拉起`
              : `已置顶 · 下一轮挂起一个运行中的任务腾出槽位；被让位的任务显示“已让位”，这一单结束后按原顺序恢复`,
        },
      };
    }
    case "wake": {
      if (!thread && !shard) return cBad("id 必填");
      const t = buildThreads(root).find((x) => x.id === thread);
      const target = t?.dispatch || thread || shard;
      const r = wakeDispatch(root, String(target));
      if (!r) {
        return {
          status: 409,
          body: { error: "该派单不在暂停状态，或已结项", action, thread, dispatch: target },
        };
      }
      recordEvent(root, "dispatch_wake", {
        dispatch: r.id,
        from: r.from,
        to: r.to,
        by: "user(board)",
      });
      return {
        status: 200,
        body: {
          ok: true,
          action,
          dispatch: r.id,
          from: r.from,
          to: r.to,
          detail: r.from === r.to ? "已唤醒" : `${r.from} 改为 ${r.to}`,
          effective: "下一 tick 起按队列顺序参与调度",
        },
      };
    }
    case "close": {
      if (!thread && !shard) return cBad("id 必填");
      const t = buildThreads(root).find((x) => x.id === thread);
      const target = t?.dispatch || thread || shard;
      const before = readDispatches(root).find((d) => String(d.id) === target)?.status ?? "";
      const args = ["close", target, "--root", root];
      if (reason) args.push(`--reason=${reason}`);
      const r = runCli(args);
      if (r.code !== 0) return { status: 409, body: { error: r.stderr || r.stdout || "结项失败", action, thread } };
      return {
        status: 200,
        body: {
          ok: true,
          action,
          dispatch: target,
          from: before,
          detail: r.stdout,
          effective:
            before === "open"
              ? "已取消排队中的派单：已从队列移除，监工不再派发"
              : "该派单已结项，监工不再为其补单",
        },
      };
    }
    case "stop-worker": {
      if (!thread && !shard) return cBad("id 必填");
      const wid = workerOfThread(root, thread, shard);
      if (!wid) {
        return { status: 409, body: { error: "该线程当前没有运行中的进程，无法中断", action, thread } };
      }
      const r = runCli(["stop-worker", wid, "--root", root]);
      if (r.code !== 0) return { status: 400, body: { error: r.stderr || r.stdout || "中断失败", action } };
      return {
        status: 200,
        body: {
          ok: true,
          action,
          worker: wid,
          detail: r.stdout,
          effective: "下一 tick 重派这一单（除非该片已被接管或登记了阻塞）",
        },
      };
    }
    case "worker-model": {
      if (!thread && !shard) return cBad("id 必填");
      const model = String(body.model ?? "").trim();
      const wid = workerOfThread(root, thread, shard);
      if (!wid) {
        return { status: 409, body: { error: "该线程当前没有运行中的进程，无法切换模型", action, thread } };
      }
      const rec = loadWorker(root, wid);
      const sh = String(rec?.shard ?? shard ?? "").trim();
      const pick = resolveModel({
        root,
        host: String(loadSupervisor(root)?.worker_host ?? ""),
        wanted: model,
      });
      if (model && pick.denied) {
        return cBad(`${model} 在禁用名单里（${pick.why}）`);
      }
      if (pick.model) {
        setWorkerModel(root, sh, pick.model);
      } else {
        /** 选“默认”即不再指定，回到契约或启动参数里的模型。 */
        try {
          unlinkSync(workerModelPath(root));
        } catch {
        }
      }
      const stopped = stopWorker(root, wid, { requeue: true, reason: "换模型重启" });
      if (!stopped) return { status: 400, body: { error: "该进程记录已不存在，切换失败", action } };
      return {
        status: 200,
        body: {
          ok: true,
          action,
          worker: wid,
          model,
          dispatch: stopped.dispatch,
          effective: model
            ? `已切到 ${model}：当前进程随即结束，下一轮用新模型接着跑这一单，会话历史保留`
            : "已切回默认模型：当前进程随即结束，下一轮接着跑这一单",
        },
      };
    }
    case "clear-threads": {
      const raw = String(body.bucket ?? "all");
      const bucket = (
        ["all", "done", "bad", "run", "queue"].includes(raw) ? raw : "all"
      ) as "all" | "done" | "bad" | "run" | "queue";
      const r = archiveFinished(root, bucket);
      /** bucket=all 才做整根重置；顺序为先清台账与进度，再换会话，最后回执。 */
      let wiped: { dir: string; moved: number; stage: string } | null = null;
      if (bucket === "all") {
        try {
          wiped = clearRuntimeLedger(root);
        } catch {
          wiped = null;
        }
      }
      let sessionId = "";
      try {
        const prev = readJson<{ gen?: number } | null>(sessionPath(root), null);
        const gen = Math.max(0, Number(prev?.gen ?? 0)) + 1;
        sessionId = `capitalist-chat-c${gen}`;
        writeJson(sessionPath(root), {
          gen,
          session_id: sessionId,
          at: new Date().toISOString(),
          brief_chars: 0,
        });
      } catch {
        /** 换会话失败不让清空列表本身失败。 */
      }
      const bits: string[] = [];
      bits.push(`已清空 ${r.workers} 个进程记录、${r.dispatches} 张派单`);
      if (wiped && wiped.moved > 0) {
        bits.push(`台账已归档 ${wiped.moved} 份到 .capitalist/archive/${basename(wiped.dir)}`);
      }
      if (wiped?.stage) bits.push(`阶段进度回到 ${wiped.stage}`);
      if (sessionId) bits.push(`监工对话已换新会话（${sessionId}）`);
      return {
        status: 200,
        body: {
          ok: true,
          action,
          bucket,
          workers: r.workers,
          dispatches: r.dispatches,
          dir: r.dir,
          session: sessionId,
          effective: bits.join("，"),
        },
      };
    }
    case "clear-thread": {
      const key = cId(body.key, "key") ?? "";
      if (!key) return cBad("key 必填（任务卡的线程 id）");
      const t = buildThreads(root).find((x) => x.id === key);
      if (!t) return { status: 404, body: { error: "任务卡不存在或已不在列表里", action, key } };
      const st = String(t.status || "");
      const abnormal = threadStatusAbnormal(st);
      if (!threadStatusTerminal(st) && !abnormal) {
        return {
          status: 409,
          body: { error: "只有已完成（已验收）、已关闭或异常的任务卡能清除，运行中与排队的单仍由监工调度", action, key },
        };
      }
      let closedBit = "";
      if (abnormal && t.dispatch) {
        const closed = runCli(["close", t.dispatch, "--root", root, "--reason=用户清除异常任务卡"]);
        if (closed.code === 0) closedBit = "派单已结项，监工不再重派；";
      }
      markThreadCleared(root, key, t.dispatch || "");
      recordEvent(root, "thread_cleared", {
        thread: key,
        dispatch: t.dispatch || "",
        stage: t.stage,
        title: String(t.title || "").slice(0, 120),
      });
      return {
        status: 200,
        body: {
          ok: true,
          action,
          key,
          dispatch: t.dispatch || "",
          effective: `已清除该任务卡：${closedBit}列表不再显示；记录保留，台账未删除。`,
        },
      };
    }
    case "answer": {
      if (!thread) return cBad("id 必填（问题 id）");
      if (!text) return cBad("text 必填");
      const r = runCli(["answer", thread, `--text=${text}`, "--root", root]);
      if (r.code !== 0) return { status: 400, body: { error: r.stderr || r.stdout || "回填失败", action } };
      return { status: 200, body: { ok: true, action, id: thread, detail: r.stdout } };
    }
    case "block": {
      const type = cId(body.type, "type") ?? "";
      if (!type) return cBad("type 必填");
      if (!reason) return cBad("reason 必填");
      const r = runCli(["block", type, `--reason=${reason}`, "--root", root]);
      if (r.code !== 0) return { status: 400, body: { error: r.stderr || r.stdout || "登记阻塞失败", action } };
      return { status: 200, body: { ok: true, action, type, detail: r.stdout } };
    }
    case "unblock": {
      const all = body.all === true || body.all === "true" || body.all === "1";
      const type = cId(body.type, "type") ?? "";
      if (!all && !type) return cBad("type 必填或传 all=true");
      const r = runCli(all ? ["unblock", "--all", "--root", root] : ["unblock", "--type", type, "--root", root]);
      if (r.code !== 0) return { status: 400, body: { error: r.stderr || r.stdout || "解除阻塞失败", action } };
      return { status: 200, body: { ok: true, action, cleared: all ? "all" : type, detail: r.stdout } };
    }
    case "stop-supervisor": {
      const r = runCli(["supervise-stop", "--root", root]);
      if (r.code !== 0) return { status: 400, body: { error: r.stderr || r.stdout || "停止监工失败", action } };
      return { status: 200, body: { ok: true, action, detail: r.stdout } };
    }
    case "pause": {
      try {
        setPause(root, reason);
      } catch (err) {
        return { status: 400, body: { error: err instanceof Error ? err.message : String(err), action } };
      }
      return {
        status: 200,
        body: {
          ok: true,
          action,
          detail: "已暂停，.capitalist/pause.json 已写入",
          effective: "下一轮起不再派新单，手里的进程随后被停掉；恢复调度后按原样重派",
        },
      };
    }
    case "resume": {
      try {
        clearPause(root);
      } catch (err) {
        return { status: 400, body: { error: err instanceof Error ? err.message : String(err), action } };
      }
      return {
        status: 200,
        body: { ok: true, action, detail: "已恢复", effective: "下一 tick 起监工恢复派单" },
      };
    }
    default:
      return cBad(`未知动作：${action}`);
  }
}



export type AlertLevel = "P0" | "P1" | "P2";

export function alertLevelOf(name: string): AlertLevel | null {
  switch (name) {
    case "worker_launch_failed":
    case "dispatch_failed":
    case "hook_error":
      return "P0";
    case "supervisor_advance":
    case "supervisor_done":
    case "dispatch_done":
    case "contract_change":
    case "dispatch_orphan":
    case "dispatch_retry":
      return "P1";
    case "dispatch_open":
    case "dispatch_closed":
    case "dispatch_wake":
    case "dispatch_reaped":
    case "worker_start":
    case "worker_gone":
    case "tool":
      return "P2";
    default:
      return null;
  }
}

export interface AlertItem {
  id: string;
  level: AlertLevel;
  at: string;
  event: string;
  text: string;
}

/** since 是 epoch 秒（也接受毫秒/ISO）或上一页最后一条告警的 id 游标。 */
export interface AlertQuery {
  level?: AlertLevel | undefined;
  limit?: number | undefined;
  since?: number | string | undefined;
}

const ALERT_TEXT_CHARS = 160;
const ALERT_LIMIT_DEFAULT = 50;
const ALERT_LIMIT_MAX = 200;

export function buildAlerts(
  root: string,
  query: AlertQuery = {},
): { alerts: AlertItem[]; unread: Record<AlertLevel, number>; total: number; has_more: boolean; next_since: number } {
  const out: AlertItem[] = [];
  const seen = new Set<string>();
  const push = (a: AlertItem): void => {
    // 空文本条目不下发。
    if (a.text.trim() === "") return;
    if (seen.has(a.id)) return;
    seen.add(a.id);
    out.push(a);
  };

  const ledgerOnly = ledgerOnlyRoot(root);
  for (const e of readJsonlFromTail(eventsFile(root), 512_000)) {
    const name = String(e.event ?? e.kind ?? "");
    if (ledgerOnly && name === "supervisor_done") continue;
    const lvl = alertLevelOf(name);
    if (!lvl) continue;
    const at = String(e.at ?? "");
    const id = `evt:${name}:${at}:${String(e.dispatch ?? "")}:${String(e.worker ?? "")}`;
    push({ id, level: lvl, at, event: name, text: clip(describeEvent(e), ALERT_TEXT_CHARS) });
  }

  for (const q of openInboxAsks(root)) {
    const id = `ask:${q.id}`;
    push({ id, level: "P0", at: String(q.at ?? ""), event: "ask", text: clip(String(q.text ?? ""), ALERT_TEXT_CHARS) });
  }

  out.sort((a, b) => atTs(b.at) - atTs(a.at));

  // since 双语义：数字按时间严格大于过滤，字符串按 id 游标只回更新的增量。
  const sinceRaw = query.since;
  let sinceTs = 0;
  let cursor = -1;
  if (typeof sinceRaw === "number") {
    if (Number.isFinite(sinceRaw) && sinceRaw > 0) sinceTs = sinceRaw;
  } else if (typeof sinceRaw === "string" && sinceRaw.trim() !== "") {
    const num = Number(sinceRaw.trim());
    if (Number.isFinite(num) && num > 0) sinceTs = num > 1e12 ? num / 1000 : num;
    else cursor = out.findIndex((a) => a.id === sinceRaw.trim());
  }
  const filtered =
    sinceTs > 0 ? out.filter((a) => atTs(a.at) > sinceTs) : cursor >= 0 ? out.slice(0, cursor) : out;

  // 游标只前进不后退，取过滤集（限长前）的最大时间戳。
  let next_since = sinceTs;
  for (const a of filtered) {
    const ts = atTs(a.at);
    if (ts > next_since) next_since = ts;
  }

  const unread: Record<AlertLevel, number> = { P0: 0, P1: 0, P2: 0 };
  for (const a of filtered) unread[a.level] += 1;

  const levelFiltered = query.level ? filtered.filter((a) => a.level === query.level) : filtered;
  const asked = Number.isFinite(query.limit) && query.limit && query.limit > 0 ? Math.floor(query.limit) : ALERT_LIMIT_DEFAULT;
  const limit = Math.min(asked, ALERT_LIMIT_MAX);
  const alerts = levelFiltered.slice(0, limit);
  return { alerts, unread, total: levelFiltered.length, has_more: levelFiltered.length > alerts.length, next_since };
}


/** online 要求 supervisor.json 存在、状态 running 且心跳在判活窗口内；heartbeat-timeout 表示记录存在但心跳超时。 */
export type SupervisorState = "online" | "stopped" | "heartbeat-timeout";

export interface SupervisorStageView {
  id: string;
  name: string;
  /** 本阶段分片数取契约 parallel 数组长度，0 表示没有分片。 */
  shards: number;
  gate_passed: boolean;
  done: boolean;
  current: boolean;
}

const gateCache = new Map<string, { at: number; ok: boolean }>();
const GATE_CACHE_MS = 2_000;

function stageGateOk(root: string, contractName: string, stage: Stage): boolean {
  const key = `${root}\u0000${contractName}\u0000${stage.id}`;
  const now = Date.now();
  const hit = gateCache.get(key);
  if (hit && now - hit.at < GATE_CACHE_MS) return hit.ok;
  let ok = false;
  try {
    ok = runCheck(stage.done as Record<string, unknown> | undefined, root).ok;
  } catch {
    /** 检查抛错按未达标算。 */
    ok = false;
  }
  if (gateCache.size > 256) gateCache.clear();
  gateCache.set(key, { at: now, ok });
  return ok;
}

/** 契约阶段按契约数组顺序，不排序不去重。 */
function stageViews(root: string, contract: { name: string; stages: Stage[] } | null, stageIndex: number): SupervisorStageView[] {
  if (!contract) return [];
  return contract.stages.map((s, i) => {
    const raw = (s as unknown as { parallel?: unknown }).parallel;
    return {
      id: s.id,
      name: s.name,
      shards: Array.isArray(raw) ? raw.length : 0,
      gate_passed: stageGateOk(root, contract.name, s),
      done: stageIndex >= 0 && i < stageIndex,
      current: i === stageIndex,
    };
  });
}

export interface SupervisorStatusView {
  status: SupervisorState;
  /**
   * 上一轮的收尾状态（done / exited / stopped 等），仅在 status 为 stopped 时有值。
   *
   * status 将所有非 running 状态归为 stopped，仅凭该字段无法区分“已执行完毕”和“从未启动”，
   * 两者对应不同操作：前者继续执行，后者需要启动监工。
   */
  last_status: string;
  pid: number;
  online: boolean;
  detail: string;
  heartbeat_age_sec: number;
  stale_sec: number;
  max_workers: number;
  running: number;
  queued: number;
  tasks: TaskCounts;
  /** 当前阶段与进度 0 起，契约里找不到为 -1。 */
  stage: string;
  stage_name: string;
  stage_index: number;
  stage_total: number;
  stages: SupervisorStageView[];
  parallel: number;
  inflight: number;
  tick: number;
  board_url: string;
  debt_count: number;
  pending_asks: number;
  heartbeat_note: string;
  reload: ReloadStatus;
  usage: {
    total_input_tokens: number | null;
    total_output_tokens: number | null;
    total_tokens: number | null;
    total_cache_read_tokens: number | null;
    reported_runs: number;
    unreported_runs: number;
    billing_unit: string;
    total_credit: number | null;
    credit_unit: string;
  };
  context: SupervisorContextView;
  model: string;
  model_version: string;
  supervisor_model: string;
  next_model: string;
  effort: string;
  paused: boolean;
  activity: { kind: SupervisorActivityKind; action: SupervisorAction | "" };
}

function heartbeatSummary(root: string, hours: number): string {
  const cutTs = hours > 0 ? Date.now() / 1000 - hours * 3600 : 0;
  let timeout = 0;
  let killed = 0;
  let redispatch = 0;
  for (const e of readJsonlFromTail(eventsFile(root), 2_000_000)) {
    if (cutTs > 0 && (atTs(String(e.at ?? "")) || 0) < cutTs) continue;
    const name = String(e.event ?? e.kind ?? "");
    /** worker_gone 且 stale=true 才算心跳超时判回收。 */
    if (name === "worker_gone" && e.stale === true) timeout += 1;
    else if (name === "worker_killed" || name === "worker_looping_killed") killed += 1;
    else if (
      name === "dispatch_orphan" ||
      name === "dispatch_retry" ||
      name === "dispatch_forced_finished" ||
      name === "redispatch_capped" ||
      name === "stage_stalled"
    )
      redispatch += 1;
  }
  const parts: string[] = [];
  if (timeout > 0) parts.push(`心跳超时 ${timeout}`);
  if (killed > 0) parts.push(`判死 ${killed}`);
  if (redispatch > 0) parts.push(`重派 ${redispatch}`);
  return parts.length ? `${parts.join(" · ")}（近 ${hours} 小时）` : "";
}

export function buildSupervisorStatus(root: string): SupervisorStatusView {
  const capitalist = loadSupervisor(root);
  const threads = buildThreads(root);
  const statsDispatches = readDispatchesBoard(root);
  const taskStats = taskCountsOf(
    threads,
    acceptedThreadKeys(root, statsDispatches),
    settledThreadKeys(statsDispatches),
  );
  const running = taskStats.running;
  const queued = taskStats.queued;

  const state = loadState(root);
  const contract = state?.contract ? loadContract(String(state.contract), contractDirs(root)) : null;
  const stageId = String(state?.stage ?? "");
  const stageIndex = contract && stageId ? contract.stages.findIndex((s) => s.id === stageId) : -1;
  const stage = contract && stageId ? stageById(contract, stageId) : undefined;
  const debt = state && Array.isArray(state.debt) ? state.debt.length : 0;
  const pendingAsks = openInboxAsks(root).length;
  const inflight = listWorkers(root).filter(
    (w) => (w.status === "running" || w.status === "starting") && (w.mode === "visible" || pidAlive(w.pid)),
  ).length;

  const tokens = tokenTotals(threads.map((t) => t.usage));
  /** 监工行模型取最近一单有工作进程记录的模型，不用宿主默认模型。 */
  const withModel = threads
    .filter((t) => t.usage.model)
    .sort((a, b) => String(a.started_at ?? "").localeCompare(String(b.started_at ?? "")));
  const lastThread = withModel[withModel.length - 1];
  const lastModel = lastThread?.usage.model ?? "";
  const lastVersion = lastThread?.usage.model_version ?? "";

  const dispatches = readDispatchesBoard(root);
  const hasPendingReceipt =
    dispatches.some((d) => String(d.status ?? "") === "reported") || readPendingMq(root).messages.length > 0;
  const reload = reloadStatus(root);
  const activity = supervisorActivityOf({ reloading: reload.active, action: currentSupervisorAction(), hasPendingReceipt, running });

  const base = {
    stage: stageId,
    stage_name: stage?.name ?? "",
    stage_index: stageIndex,
    stage_total: contract ? contract.stages.length : 0,
    stages: stageViews(root, contract, stageIndex),
    inflight,
    tasks: taskStats,
    board_url: capitalist?.board_url ?? "",
    debt_count: debt,
    pending_asks: pendingAsks,
    heartbeat_note: heartbeatSummary(root, 6),
    reload,
    usage: {
      total_input_tokens: tokens.total_input_tokens,
      total_output_tokens: tokens.total_output_tokens,
      total_tokens: tokens.total_tokens,
      total_cache_read_tokens: tokens.total_cache_read_tokens,
      reported_runs: tokens.usage_reported,
      unreported_runs: tokens.usage_unreported,
      billing_unit: tokens.billing_unit,
      total_credit: tokens.total_credit,
      /*
       * 单位回退取账号额度读数：未派发工作进程时没有日志可汇总，`tokens.credit_unit`
       * 为空时界面回落显示 token，与宿主按积分计费的单位不一致。
       */
      credit_unit: tokens.credit_unit || balanceView(root).credit_unit,
    },
    context: buildSupervisorContextView(root),
    /*
     * 最近一次派单的模型优先；没有派单时用监工对话上一次实际跑的模型。
     * 前端靠它把“宿主默认”标到具体那一行，不再出现抽象的“宿主默认”条目。
     */
    model: lastModel || readSupervisorModelUsed(root),
    model_version: lastVersion,
    supervisor_model: String(capitalist?.supervisor_model ?? "").trim(),
    next_model: readNextModel(root),
    effort: String(capitalist?.effort ?? "").trim(),
    paused: readPause(root) !== null,
    activity,
  };

  if (!capitalist || capitalist.status !== "running") {
    return {
      status: "stopped",
      last_status: String(capitalist?.status ?? ""),
      pid: capitalist?.pid ?? 0,
      online: false,
      detail: capitalist ? `监工状态为 ${capitalist.status}` : "没有 supervisor.json，监工从未启动或已退出",
      heartbeat_age_sec: capitalist ? ageSec(capitalist.heartbeat_ts) : -1,
      stale_sec: capitalist ? supervisorStaleSec(capitalist) : 0,
      max_workers: capitalist?.max_workers ?? 0,
      parallel: capitalist?.max_workers ?? 0,
      tick: capitalist?.ticks ?? 0,
      running,
      queued,
      ...base,
    };
  }

  const age = Math.max(0, Math.round(Date.now() / 1000 - capitalist.heartbeat_ts));
  const stale = supervisorStaleSec(capitalist);
  if (age > stale) {
    return {
      status: "heartbeat-timeout",
      last_status: "",
      pid: capitalist.pid,
      online: false,
      detail: `最后一次心跳 ${age}s 前，超过判活窗口 ${stale}s`,
      heartbeat_age_sec: age,
      stale_sec: stale,
      max_workers: capitalist.max_workers,
      parallel: capitalist.max_workers,
      tick: capitalist.ticks,
      running,
      queued,
      ...base,
    };
  }

  return {
    status: "online",
    last_status: "",
    pid: capitalist.pid,
    online: true,
    detail: `监工在线，并行度 ${capitalist.max_workers}`,
    heartbeat_age_sec: age,
    stale_sec: stale,
    max_workers: capitalist.max_workers,
    parallel: capitalist.max_workers,
    tick: capitalist.ticks,
    running,
    queued,
    ...base,
  };
}


/** 监工线程固定 id，左栏与 /api/capitalist-events 用同一个值。 */
export const CAPITALIST_THREAD_ID = "capitalist:main";

/** tool 不进监工流，监工没有工具调用。 */
const CAPITALIST_LOG_EVENTS = new Set([
  "dispatch_failed",
  "worker_launch_failed",
  "debt_settled",
  "supervisor_advance",
  "supervisor_done",
  "stage_skipped",
  "stage_fallback",
  "supervisor_answer",
  "supervisor_chat_ask",
  "supervisor_reply",
  "context_compacted",
  "mq_message",
  "tree_rebuilt",
]);

/** 这张表是心跳链路事件不进监工消息流的唯一闸门。 */
const HEARTBEAT_EVENTS = new Set([
  "supervisor_tick",
  "tick_window",
  "dispatch_orphan", // 判死重派
  "dispatch_retry", // 重派
  "dispatch_forced_finished", // 超时强制结单
  "dispatch_reaped",
  "redispatch_capped", // 重派达到上限
  "worker_gone", // 心跳超时判死 / 进程退出回收
  "worker_killed",
  "worker_looping_killed",
  "worker_heartbeat_rescued", // 心跳恢复
  "worker_reaped",
  "stage_stalled", // 阶段停滞：看门狗按心跳窗口判的
]);

const CAPITALIST_BAD_EVENTS = new Set([
  "dispatch_failed",
  "worker_launch_failed",
]);

const CAPITALIST_DECISION_EVENTS = new Set([
  "stage_skipped",
  "stage_fallback",
  "retry_held", // 重派审查：卡点未消除时暂不重派。
]);

const CAPITALIST_CONCLUSION_EVENTS = new Set(["supervisor_advance", "supervisor_done", "debt_settled"]);

function supervisorTierOf(name: string, e: Record<string, unknown>): "main" | "log" {
  if (name === "supervisor_chat_ask" || name === "supervisor_reply" || name === "supervisor_answer") return "main";
  if (name === "context_compacted") return "main";
  if (name === "mq_message") return "main";
  if (CAPITALIST_BAD_EVENTS.has(name)) return "main";
  if (CAPITALIST_DECISION_EVENTS.has(name)) return "main";
  if (CAPITALIST_CONCLUSION_EVENTS.has(name)) return "main";
  if (name === "supervisor_cmd") return e.ok === false ? "main" : "log";
  return "log";
}

const MQ_KIND_LABEL: Record<string, string> = {
  stuck: "卡住",
  question: "要方向",
  risk: "红线风险",
  deviation: "偏航",
  quality: "质量自评",
  blocked: "外部阻塞",
  progress: "进展",
  done: "报告完成",
};

const MQ_DECISION_LABEL: Record<string, string> = {
  continue: "继续，不干预",
  nudge: "已纠正方向",
  requeue: "已重开该派单",
  pause_shard: "已暂停该分片",
  escalate: "已转人工裁决",
  accept: "报告通过",
  reject: "报告打回",
};


/** 申报跳转的线程 id 必须与 buildThreadsPage 的 taskKey 逐字一致。 */
function jumpOf(e: Record<string, unknown>): { jump?: { id: string; label: string } } {
  const stage = String(e.stage ?? "").trim();
  if (!stage) return {};
  const shard = String(e.shard ?? "").trim();
  const lineage = String(e.lineage ?? "").trim() || String(e.dispatch ?? "").trim();
  return { jump: { id: taskKeyOf(stage, shard, lineage), label: shardTitle(shard) || `${stage} 整阶段` } };
}

function ctxTokenText(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "";
  if (v >= 1000) return `${Math.round(v / 100) / 10}k`;
  return String(Math.round(v));
}

function supervisorEventText(name: string, e: Record<string, unknown>, nos?: Map<string, string>): string {
  const d = String(e.dispatch ?? "");
  const w = String(e.worker ?? "");
  const st = String(e.stage ?? "");
  switch (name) {
    case "mq_message": {
      const kind = String(e.kind ?? "");
      /** 未知申报类型收口成“申报”。 */
      const label = MQ_KIND_LABEL[kind] ?? "申报";
      /** 给全 id，不给四位短号，便于前端渲染成任务号。 */
      const from = String(e.from ?? "");
      const evTaskNo = d && nos ? nos.get(d) ?? "" : "";
      const fromLabel = from
        ? evTaskNo
          ? `来自 #${evTaskNo}`
          : `来自进程 ${from}`
        : "";
      const shard = shardTitle(e.shard) || "";
      const sev = String(e.severity ?? "");
      const needs = String(e.needs ?? "none");
      return [
        `收到申报：${label}`,
        shard ? `分片 ${shard}` : "整阶段",
        fromLabel,
        sev === "critical" ? "严重" : "",
        needs === "decision" ? "等裁决" : needs === "intervention" ? "等干预" : "",
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "gate_eval": {
      const missing = Array.isArray(e.missing) ? e.missing.map((x) => String(x)) : [];
      return e.ok === true
        ? `门槛评估 ${st}：已满足，可以推进`
        : `门槛评估 ${st}：未达标（${missing.join("；") || "未给出缺失项"}）`;
    }
    case "supervisor_cmd": {
      const ok = e.ok === true;
      const action = zh.cmd(e.action, e.urgent);
      const arg = String(e.arg ?? "");
      const tail = ok ? String(e.detail ?? "") : String(e.reason ?? "");
      return `指令 ${action}${arg ? ` ${arg}` : ""}：${ok ? "已执行" : "被拒"}${tail ? `（${tail}）` : ""}`;
    }
    case "supervisor_answer":
      return `回答“${String(e.question ?? "")}”：${String(e.answer ?? "")}`;
    case "context_compacted": {
      /** 压缩来源有两处：重载是确定事实，读数骤降是推断，正文标 inferred。 */
      const scope = String(e.scope ?? "capitalist");
      const inferred = String(e.source ?? "") === "inferred";
      const who = scope === "worker" ? "工作进程" : "监工对话";
      const before = ctxTokenText(e.before_used);
      const after = ctxTokenText(e.after_used);
      const limit = ctxTokenText(e.limit);
      const next = String(e.next_session ?? "");
      const move =
        before && after
          ? `${before} -> ${after} token`
          : before
            ? `${before} token -> 新会话${next ? ` ${next}` : ""}`
            : after
              ? `压缩后 ${after} token`
              : "压缩前后均无读数";
      const tail = [
        limit ? `上限 ${limit} token` : "",
        `来源：${inferred ? "读数骤降推断，不是宿主事件" : "上下文重载"}`,
      ].filter(Boolean);
      return `${who}上下文已压缩：${move}（${tail.join("，")}）`;
    }
    case "supervisor_chat_ask":
      return String(e.text ?? "");
    case "supervisor_reply": {
      return supervisorReplyView(e);
    }
    case "stage_skipped":
      return `跳过阶段 ${String(e.from ?? "")} -> ${String(e.to ?? "")}（记欠账，不算达标）`;
    case "contract_reload":
      return `任务列表热加载：阶段 ${String(e.next_stages ?? "")}，分片 ${String(e.next_shards ?? "?")}`;
    case "contract_change":
      return `任务列表变更（编排层）：${String(e.reason ?? "")}`;
    case "contract_error":
      return `任务列表解析失败，沿用上一份可用任务列表：${String(e.error ?? "")}`;
    case "contract_refused":
      return `任务列表被拒（原因：${zh.kind(e.kind) || "需求层被改动"}），沿用上一份可用任务列表`;
    case "board_serve":
      return `看板已启动：${String(e.url ?? "")}`;
    case "board_reload":
      return `看板随构建重启：端口 ${String(e.port ?? "")}`;
    case "redispatch_capped":
      return `${shardTitle(e.shard) || "该分片"}连续重派达到上限 ${String(e.limit ?? "")}，已停下等裁决`;
    case "retry_held":
      return `${shardTitle(e.shard) || "该任务"}卡点未消除，暂不重派：${String(e.why ?? "").slice(0, 120)}`;
    case "debt_settled":
      return `终审清算欠账 ${String(e.count ?? 0)} 条`;
    case "tree_rebuilt":
      return String(e.note ?? "已重建派单树");
    case "gate_eval_placeholder":
      return "";
    default:
      return describeEvent(e);
  }
}

/** 监工流与工作线程的 /api/thread 并列，调度轮次 不在这里合并。 */
/** /api/capitalist-events 结果缓存键含文件指纹、参数与 root，避免多根切换串数据。 */
let supervisorLogCache: { root: string; key: string; value: ReturnType<typeof buildSupervisorLog> } | null = null;

export function buildSupervisorLog(
  root: string,
  opts: { limit?: number; hours?: number } = {},
): {
  thread: string;
  total: number;
  since_hours: number;
  main: number;
  log: number;
  /** 时间窗之外仍有事件，或被 limit 截断；界面据此决定是否提供“展开更早的消息”。 */
  has_older: boolean;
  messages: ThreadMessage[];
} {
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 120) || 120, 400));
  /** 时间窗过滤事件年龄，历史上发过的指令不重放。 */
  const hours = Number.isFinite(opts.hours) && (opts.hours as number) >= 0 ? (opts.hours as number) : 6;
  const cutTs = hours > 0 ? Date.now() / 1000 - hours * 3600 : 0;
  const fresh = (at: unknown): boolean => cutTs <= 0 || (atTs(String(at ?? "")) || 0) >= cutTs;

  /**
   * 结果缓存键用 5 秒时间桶。
   *
   * 不用文件 mtime/size：监工每 5 秒写一条 调度轮次，带了就等于永远不命中，
   * 每次轮询都要重读整份台账（几千行）。桶内复用，代价是最迟 2 秒看到新事件，
   * 与看板 2 秒轮询叠加仍在可接受范围；写接口进来时会直接置空，不必等桶过期。
   */
  let fp = "";
  try {
    statSync(eventsFile(root));
    fp = `${limit}:${hours}:${Math.floor(Date.now() / 2_000)}`;
  } catch {
    /** 没有事件台账时不缓存，走空结果。 */
  }
  if (fp && supervisorLogCache && supervisorLogCache.root === root && supervisorLogCache.key === fp) {
    return supervisorLogCache.value;
  }

  const rows = readJsonlFromTail(eventsFile(root), 2_000_000);
  const msgs: ThreadMessage[] = [];
  /** 单阶段契约没有收工时刻，supervisor_done 整类不上屏，台账照旧保留。 */
  const ledgerOnly = ledgerOnlyRoot(root);
  /** 回执正文里的内部派单 id 按编号表换成界面号。 */
  const nos = dispatchNoTable(root);
  /** 派单消息与 has_older 共用这一份读数。 */
  const dispatchRows = readDispatchesBoard(root);

  const narrationLeftover = new Map<string, string>();
  for (const e of rows) {
    if (String(e.event ?? e.kind ?? "") !== "supervisor_reply") continue;
    /** 带 thread 的是工作进程会话里的对话，归那个线程。 */
    if (String(e.thread ?? "")) continue;
    if ((e as { acted?: unknown }).acted !== true) continue;
    const dir = String((e as { directive?: unknown }).directive ?? "").trim();
    if (!dir) continue;
    if (narrationLeftover.has(dir)) continue;
    const body = String((e as { dispatch_text?: unknown }).dispatch_text ?? e.want ?? "");
    const left = stripDispatchEcho(String(e.reply ?? ""), body);
    if (left) narrationLeftover.set(dir, left);
  }


  const supervisorDirectives = listSupervisorDirectives(root) as SupervisorDirective[];
  const directiveNo = new Map<string, string>();
  for (const r of supervisorDirectives) {
    const res = r.result as { dispatch?: unknown; detail?: unknown } | undefined;
    const direct = String(res?.dispatch ?? "").trim();
    const target =
      direct ||
      (/派单\s+(D-[A-Za-z0-9][A-Za-z0-9-]{1,})/.exec(String(res?.detail ?? ""))?.[1] ?? "");
    const no = target ? nos.get(target) ?? "" : "";
    if (no) directiveNo.set(String(r.id ?? ""), no);
  }

  const triagedMsgs = new Set<string>();
  for (const e of rows) {
    if (String(e.event ?? e.kind ?? "") !== "mq_triage") continue;
    const id = String((e as { msg?: unknown }).msg ?? "");
    if (id) triagedMsgs.add(id);
  }

  /** 同一类过程事件在窗口内合并成一条，count 记次数；窗口按绝对时间分桶。 */
  const LOG_AGG_SEC = 600;
  const logAgg = new Map<string, ThreadMessage>();

  const unhandledIds = new Set(unhandledFromEvents(rows).map((u) => u.msg_id));

  for (const e of rows) {
    const name = String(e.event ?? e.kind ?? "");
    if (!fresh(e.at)) continue;
    if (name === "supervisor_tick") continue;
    /** 心跳链路事件（判死、重派、回收、停滞）一律不上屏，只留台账。 */
    if (HEARTBEAT_EVENTS.has(name)) continue;
    if (ledgerOnly && name === "supervisor_done") continue;
    if (!CAPITALIST_LOG_EVENTS.has(name)) continue;
    /** 对话事件按 thread 分流，带 thread 的不出现在监工线程。 */
    if ((name === "supervisor_chat_ask" || name === "supervisor_reply") && String(e.thread ?? "")) continue;
    if (
      name === "supervisor_reply" &&
      (e as { acted?: unknown }).acted === true &&
      String((e as { directive?: unknown }).directive ?? "").trim()
    ) {
      continue;
    }
    const bad = CAPITALIST_BAD_EVENTS.has(name) || (name === "supervisor_cmd" && e.ok === false);
    const tier = supervisorTierOf(name, e);
    const item: ThreadMessage = {
      id: `SE-${fingerprint(e)}`,
      at: String(e.at ?? ""),
      role:
        ((e as { from?: unknown }).from as ThreadRole) || (name === "supervisor_chat_ask" ? "user" : "supervisor"),
      kind: name === "supervisor_reply" || name === "supervisor_chat_ask" ? "say" : "verdict",
      text: maskDispatchIds(supervisorEventText(name, e, nos), nos),
      tool: "",
      cmd: "",
      /** 申报行带状态：待回执/已回执，判定依据是存在 mq_triage。 */
      status: bad
        ? "failed"
        : name === "mq_message"
          ? triagedMsgs.has(String(e.id ?? ""))
            ? "done"
            : "pending"
          : "",
      thread: CAPITALIST_THREAD_ID,
      event: name,
      tier,
      ...(name !== "supervisor_reply" && Array.isArray((e as { atts?: unknown }).atts)
        ? { atts: ((e as { atts: unknown[] }).atts ?? []).map((x) => String(x)).filter(Boolean) }
        : {}),
      ...(name === "mq_message" ? jumpOf(e) : {}),
      ...(name === "supervisor_reply" && String((e as { directive?: unknown }).directive ?? "")
        ? (() => {
            const dir = String((e as { directive?: unknown }).directive);
            const no = directiveNo.get(dir) ?? "";
            return { link: dir, ...(no ? { no } : {}) };
          })()
        : {}),
      ...(name === "supervisor_cmd"
        ? {
            action: String(e.action ?? ""),
            arg: String(e.arg ?? ""),
            ok: e.ok === true,
            reason: String(e.reason ?? ""),
            detail: String(e.detail ?? ""),
            ...(e.urgent === true ? { urgent: true } : {}),
          }
        : {}),
      ...(name === "supervisor_chat_ask" && String((e as { msg_id?: unknown }).msg_id ?? "")
        ? {
            msg_id: String((e as { msg_id?: unknown }).msg_id),
            ...(unhandledIds.has(String((e as { msg_id?: unknown }).msg_id)) ? { unhandled: true } : {}),
          }
        : {}),
      ...(name === "supervisor_chat_ask" && String((e as { quote?: unknown }).quote ?? "")
        ? {
            quote: String((e as { quote?: unknown }).quote),
            ...(String((e as { quote_text?: unknown }).quote_text ?? "")
              ? { quote_text: String((e as { quote_text?: unknown }).quote_text) }
              : {}),
          }
        : {}),
    };

    if (tier === "main") {
      if (item.text.trim()) msgs.push(item);
      continue;
    }
    /** 过程事件合并时 at 留在窗口内第一次的位置不动，只推 last_at。 */
    const bucket = Math.floor((atTs(item.at) || 0) / LOG_AGG_SEC);
    const key = `${name}#${bucket}`;
    const prev = logAgg.get(key);
    if (!prev) {
      logAgg.set(key, { ...item, count: 1, first_at: item.at, last_at: item.at });
      continue;
    }
    prev.count = Number(prev.count ?? 1) + 1;
    prev.last_at = item.at;
    prev.text = item.text;
  }
  for (const m of logAgg.values()) msgs.push(m);

  /*
   * 派单消息同时在监工进程出现。
   *
   * 自动派单只写 `dispatch_open`，该事件不在消息白名单内，仅靠事件流时监工进程没有消息。
   * 派单自身带正文与编号，按派单消息渲染，与工作进程侧一致。
   */
  for (const d of dispatchRows) {
    if (!fresh(d.at)) continue;
    const text = String(d.action ?? "");
    if (!text.trim()) continue;
    const atts = attachmentsOf({ atts: d.atts, text });
    const no = nos.get(d.id) ?? "";
    msgs.push({
      id: `D-${d.id}`,
      at: String(d.at ?? ""),
      role: "supervisor",
      kind: "dispatch",
      text,
      tool: "",
      cmd: text,
      status: String(d.status ?? ""),
      thread: CAPITALIST_THREAD_ID,
      tier: "main",
      ...(no ? { no } : {}),
      ...(atts.length ? { atts } : {}),
    });
  }

  // 带线程号的记录归位到那个进程的会话，不进监工流。
  for (const r of supervisorDirectives) {
    if (!fresh(r.at)) continue;
    if (String(r.thread ?? "")) continue;
    const ok = r.result?.ok;
    const status = r.consumed !== true ? "pending" : ok === true ? "executed" : ok === false ? "rejected" : "";
    const fromSupervisor = r.via === "capitalist";
    const rawText = String(r.text ?? "");
    const actionName = String(r.action ?? "");
    const shownText =
      fromSupervisor && actionName && rawText.toLowerCase().startsWith(actionName.toLowerCase())
        ? `${zh.cmd(actionName, r.result?.urgent)}${rawText.slice(actionName.length)}`
        : rawText;
    /** 指令自带的图只归这条指令。 */
    const scAtts = attachmentsOf({ atts: (r as unknown as { atts?: unknown }).atts, text: r.text });
    const scTarget = (() => {
      const res = r.result as { dispatch?: unknown; detail?: unknown } | undefined;
      const direct = String(res?.dispatch ?? "").trim();
      if (direct) return direct;
      const detail = String(res?.detail ?? "");
      const m =
        /派单\s+(D-[A-Za-z0-9][A-Za-z0-9-]{1,})/.exec(detail) ??
        /已插入队列[^\n]*?\s(D-[A-Za-z0-9][A-Za-z0-9-]{1,})/.exec(detail) ??
        /已建诊断单\s+(D-[A-Za-z0-9][A-Za-z0-9-]{1,})/.exec(detail);
      return m ? m[1] : "";
    })();
    const scNo = scTarget ? nos.get(scTarget) ?? "" : "";
    const scExtra = narrationLeftover.get(String(r.id ?? "")) ?? "";
    msgs.push({
      id: `SC-${r.id}`,
      at: r.at,
      role: fromSupervisor ? "supervisor" : "user",
      kind: "say",
      text: `${fromSupervisor ? `调度指令：${shownText}` : rawText}${scExtra ? `\n${scExtra}` : ""}`,
      tool: "",
      cmd: "",
      status,
      thread: CAPITALIST_THREAD_ID,
      tier: "main",
      /** 指令 id 随卡下发，与同一轮叙述的 link 配对。 */
      link: String(r.id ?? ""),
      ...(scNo ? { no: scNo } : {}),
      ...(scAtts.length ? { atts: scAtts } : {}),
      ...(r.action ? { action: r.action } : {}),
      ...(r.result
        ? {
            ok: r.result.ok,
            reason: r.result.reason,
            detail: maskDispatchIds(String(r.result.detail ?? ""), nos),
          }
        : {}),
    });
  }


  msgs.sort((a, b) => atTs(a.at) - atTs(b.at) || a.id.localeCompare(b.id));
  /** 分层计数一并回给前端，主流程与过程日志各用自己的条数。 */
  const main = msgs.filter((m) => m.tier !== "log").length;
  const value = {
    thread: CAPITALIST_THREAD_ID,
    total: msgs.length,
    since_hours: hours,
    main,
    log: msgs.length - main,
    /*
     * “还有更早的”只有两种来源：窗口内被 limit 截断，或时间窗之外仍有事件。
     * hours=0 时 cutTs 为 0，第二个条件恒为假，仅保留 limit 截断，符合“已经展开到不限”的语义。
     */
    has_older:
      msgs.length > limit ||
      (cutTs > 0 &&
        (rows.some((e) => (atTs(String((e as { at?: unknown }).at ?? "")) || 0) < cutTs) ||
          dispatchRows.some((d) => (atTs(String(d.at ?? "")) || 0) < cutTs))),
    messages: msgs.slice(Math.max(0, msgs.length - limit)),
  };
  if (fp) supervisorLogCache = { root, key: fp, value };
  return value;
}


function poolSummaryForMetrics(root: string): TaskPoolSummary {
  const base = poolSummary(root);
  if (base.accepted === 0) return base;
  const status = new Map<string, string>();
  for (const d of readDispatches(root)) {
    if (d.id && typeof d.status === "string") status.set(d.id, d.status);
  }
  let stale = 0;
  for (const t of readTasks(root)) {
    if (t.state !== "accepted" || !t.dispatch) continue;
    const s = status.get(String(t.dispatch));
    if (s !== undefined && s !== "done") stale += 1;
  }
  if (stale === 0) return base;
  return { ...base, accepted: base.accepted - stale, remaining: base.remaining + stale };
}

export interface BoardMetrics {
  at: string;
  /** 当前阶段契约分片数，契约读不到时为 0。 */
  scheduled: number;
  total: number;
  done: number;
  tasks: TaskPoolSummary;
  /** 任务状态聚合（taskCountsOf），与 /api/threads.counts、/api/supervisor.tasks、/api/overview.tasks 同源。 */
  stats: TaskCounts;
  /** 实际存活进程数由 pid 与进程表核对，不单看记录状态。 */
  alive: number;
  queued: number;
  /** 配额余量取积分；不可读时为 null，原因见 credit_unavailable_reason。 */
  credit: number | null;
  credit_used: number | null;
  credit_left: number | null;
  credit_unit: string;
  credit_at: string;
  credit_source: string;
  /** 这次没刷新成功时的说明；非空表示数字是上一次读到的。 */
  credit_stale: string;
  credit_unavailable_reason: string;
  balance: BalanceView;
  context: ContextView;
  usage: {
    total_input_tokens: number | null;
    total_output_tokens: number | null;
    total_tokens: number | null;
    total_cache_read_tokens: number | null;
    reported_runs: number;
    unreported_runs: number;
    billing_unit: string;
    total_credit: number | null;
    credit_unit: string;
  };
  paused: boolean;
  paused_since: string | null;
  threads: ThreadCostRow[];
  threads_total: number;
  total_duration_sec: number;
  total_output_bytes: number;
  total_spawn_count: number;
  quota: { exhausted: boolean; at: string; text: string };
}

export function buildMetrics(root: string): BoardMetrics {
  // scheduled 与 loop 的 stageParallel 同一形状判定（id 与 action 都得是字符串）。
  const state = loadState(root);
  const contract = state?.contract ? loadContract(String(state.contract), contractDirs(root)) : null;
  const stage = contract && state?.stage ? stageById(contract, String(state.stage)) : undefined;
  const raw = (stage as unknown as { parallel?: unknown } | undefined)?.parallel;
  const scheduled = Array.isArray(raw)
    ? raw.filter(
        (x) =>
          x !== null &&
          typeof x === "object" &&
          typeof (x as Record<string, unknown>).id === "string" &&
          typeof (x as Record<string, unknown>).action === "string",
      ).length
    : 0;

  // alive 要求记录为 running/starting 且 pid 真实存活。
  const workers = listWorkers(root);
  const alive = workers.filter(
    (w) => (w.status === "running" || w.status === "starting") && pidAlive(w.pid),
  ).length;

  /** 派单台账一个接口只读一次，成本明细与统计共用。 */
  const dispatches = readDispatches(root);

  const costRows = costRowsWith(workers, dispatches, root);
  const currentRows = pickCurrentCostRows(costRows, workers, dispatches);

  const pause = readPause(root);
  /** 余额照接口读数显示，不因额度耗尽判定而作废。 */
  const balance = balanceView(root);
  const quotaState = readQuotaState(root);
  const tokens = tokenTotals(costRows.map((r) => r.usage));
  /** 任务统计只算一次，兼容字段 done/queued 也从它取。 */
  const stats = taskCounts(root);
  return {
    at: new Date().toISOString(),
    scheduled,
    total: workers.length,
    done: stats.done,
    tasks: poolSummaryForMetrics(root),
    stats,
    alive,
    queued: stats.queued,
    credit: balance.credit,
    credit_used: balance.credit_used,
    credit_left: balance.credit,
    credit_unit: balance.credit_unit,
    credit_at: balance.at,
    credit_source: balance.source,
    credit_stale: balance.stale,
    credit_unavailable_reason: balance.reason,
    balance,
    context: buildContextView(root),
    usage: {
      total_input_tokens: tokens.total_input_tokens,
      total_output_tokens: tokens.total_output_tokens,
      total_tokens: tokens.total_tokens,
      total_cache_read_tokens: tokens.total_cache_read_tokens,
      reported_runs: tokens.usage_reported,
      unreported_runs: tokens.usage_unreported,
      billing_unit: tokens.billing_unit,
      total_credit: tokens.total_credit,
      /* 同 `/api/supervisor`：无工作进程记录时使用账号额度单位，避免回退为 token。 */
      credit_unit: tokens.credit_unit || balance.credit_unit,
    },
    paused: pause !== null,
    paused_since: pause ? pause.at || null : null,
    threads: currentRows,
    threads_total: costRows.length,
    quota: quotaState,
    ...costTotals(costRows),
  };
}


export interface BoardOverview {
  at: string;
  supervisors: { total: number; running: number; paused: number };
  processes: { total: number; alive: number; queued: number };
  tasks: TaskCounts;
  credit_used: number | null;
  credit_left: number | null;
  credit_unit: string;
  credit_at: string;
  credit_source: string;
  credit_stale: string;
  credit_unavailable_reason: string;
  usage: {
    total_input_tokens: number | null;
    total_output_tokens: number | null;
    total_tokens: number | null;
    total_cache_read_tokens: number | null;
    reported_runs: number;
    unreported_runs: number;
    billing_unit: string;
    total_credit: number | null;
    credit_unit: string;
  };
  /** WorkingSet 之和，一个进程都读不到时为 null。 */
  memory_bytes: number | null;
  memory_human: string;
  /** 整机内存压力百分比（0-100），与活动监视器同口径；采样不可用时为 null。 */
  memory_pressure_percent: number | null;
  resources: ResourceSampleView;
  unreclaimed_pids: number[];
  unreclaimed_detail: Array<{ pid: number; kind: string; id: string; at: string; why: string }>;
  /** 额度是账号级的，任一监工触发额度耗尽即为整个账号不可用。 */
  quota: { exhausted: boolean; at: string; text: string };
  roots: Array<{ root: string; target: string; status: TaskSummary["status"]; processes: number; alive: number; tasks: TaskCounts }>;
}

/** 内存读数按 2 秒缓存。 */
let memCache: { key: string; at: number; bytes: number | null } = { key: "", at: 0, bytes: null };

/** Windows 分支直接返回 null：Node 没有读取其它进程 WorkingSet 的 API。 */
export function workingSetBytes(pids: number[]): number | null {
  const want = [...new Set(pids.filter((p) => Number.isFinite(p) && p > 0))].sort((a, b) => a - b);
  if (want.length === 0) return 0;
  const key = want.join(",");
  const now = Date.now();
  if (memCache.key === key && now - memCache.at < 2000) return memCache.bytes;

  let bytes: number | null = null;
  try {
    if (process.platform === "linux") {
      let sum = 0;
      let hit = 0;
      for (const pid of want) {
        try {
          const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)\s+kB/);
          if (!m) continue;
          sum += Number(m[1]) * 1024;
          hit++;
        } catch {
          /** 进程刚退出时跳过，不把整次求和判成失败。 */
        }
      }
      bytes = hit > 0 ? sum : null;
    } else if (process.platform !== "win32") {
      // macOS 与其它 POSIX 读 ps 的 rss 列。
      const r = spawnSync("ps", ["-o", "rss=", "-p", want.join(",")], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (r.status === 0 && r.stdout) {
        let sum = 0;
        let hit = 0;
        for (const line of r.stdout.split(/\r?\n/)) {
          const kb = Number(line.trim());
          if (!Number.isFinite(kb) || kb <= 0) continue;
          sum += kb * 1024;
          hit++;
        }
        bytes = hit > 0 ? sum : null;
      }
    }
  } catch {
    bytes = null;
  }
  memCache = { key, at: now, bytes };
  return bytes;
}

export function humanBytes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}G`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return `${Math.round(n)}B`;
}


export interface NodeProcSample {
  pid: number;
  /** 瞬时 CPU：Windows 为格式化计数器读数（单核口径，可超过 100%），macOS 为 ps 的 %CPU，Linux 为 /proc stat 差分折算。 */
  cpu: number | null;
  mem: number | null;
}

/** 一轮采样结果按模块级缓存，5 秒新鲜期。 */
interface ProcSnapshot {
  at: number;
  procs: NodeProcSample[];
  source: string;
  reason: string;
}

let procSnap: ProcSnapshot = { at: 0, procs: [], source: "", reason: "首次采样尚未完成" };
let samplerTimer: ReturnType<typeof setInterval> | 0 = 0;
/** Linux CPU 差分用上一轮每个 pid 的 utime+stime（时钟滴答）。 */
const lastCpuTicks = new Map<number, number>();
let lastTicksAt = 0;


/** 整机读数：CPU 用 os.cpus() 时间片差分；内存压力按各平台系统口径取值。 */
interface SysSample {
  at: number;
  cpu: number | null;
  memUsed: number | null;
  memPressure: number | null;
  memTotal: number;
}
let sysSnap: SysSample = { at: 0, cpu: null, memUsed: null, memPressure: null, memTotal: 0 };
let lastCpuTimes: { idle: number; total: number } | null = null;

/**
 * 整机内存压力百分比（0-100，越高越紧张），与活动监视器同一口径：
 * macOS 取 memory_pressure 的“System-wide memory free percentage”取反；
 * Linux 用 /proc/meminfo 的 MemAvailable 折算；Windows 用 (总量 − 空闲) / 总量。
 * 读不到时返回 null，不以其它值代入。
 */
/**
 * 异步执行命令并收集 stdout，超时即杀。
 *
 * 采样在子进程中异步执行，与 HTTP 处理互不阻塞。同步采样会阻塞事件循环，
 * 使同时到达的看板请求一并等待。
 */
function runCapture(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; code: number | null; error: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (r: { stdout: string; code: number | null; error: string }): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      finish({ stdout: "", code: null, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      finish({ stdout, code: null, error: `超时（${timeoutMs}ms）` });
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      finish({ stdout, code: null, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ stdout, code, error: "" });
    });
  });
}

async function sampleMemPressure(total: number, free: number): Promise<number | null> {
  try {
    if (process.platform === "darwin") {
      const r = await runCapture("memory_pressure", [], 3000);
      const m = r.code === 0 && r.stdout
        ? r.stdout.match(/System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/)
        : null;
      return m ? Math.max(0, Math.min(100, Math.round(100 - Number(m[1])))) : null;
    }
    if (process.platform === "linux") {
      const text = readFileSync("/proc/meminfo", "utf8");
      const avail = Number((text.match(/^MemAvailable:\s+(\d+)\s+kB/m) ?? [])[1]);
      const all = Number((text.match(/^MemTotal:\s+(\d+)\s+kB/m) ?? [])[1]);
      if (Number.isFinite(avail) && Number.isFinite(all) && all > 0) {
        return Math.max(0, Math.min(100, Math.round((1 - avail / all) * 100)));
      }
      return null;
    }
    if (total > 0 && Number.isFinite(free)) {
      return Math.max(0, Math.min(100, Math.round((1 - free / total) * 100)));
    }
    return null;
  } catch {
    return null;
  }
}

async function sampleSys(): Promise<void> {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  let cpu: number | null = null;
  if (lastCpuTimes && total > lastCpuTimes.total) {
    const dTotal = total - lastCpuTimes.total;
    const dIdle = idle - lastCpuTimes.idle;
    cpu = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
  }
  lastCpuTimes = { idle, total };
  const memFree = os.freemem();
  const memTotal = os.totalmem();
  sysSnap = {
    at: Date.now(),
    cpu: cpu === null ? null : Math.round(cpu * 10) / 10,
    memUsed: Math.max(0, memTotal - memFree),
    memPressure: await sampleMemPressure(memTotal, memFree),
    memTotal,
  };
}

const SAMPLER_INTERVAL_MS = 5000;
const PS_TIMEOUT_MS = 9000;

function runPowerShell(cmd: string): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      rej(new Error(`powershell 超时（${PS_TIMEOUT_MS}ms）`));
    }, PS_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", (e) => {
      clearTimeout(timer);
      rej(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) res(out);
      else rej(new Error(`powershell 退出码 ${code}${err.trim() ? `：${err.trim().slice(0, 200)}` : ""}`));
    });
  });
}

/** Windows 用一条 CIM 查询取全部 node 进程的 CPU% 与 WorkingSet。 */
async function sampleWindows(): Promise<ProcSnapshot> {
  const source = "Win32_PerfFormattedData_PerfProc_Process（PowerShell CIM，Filter Name LIKE 'node%'）";
  /*
   * 默认不采样进程级指标。
   *
   * CIM 查询要起一个 powershell 进程，看板每 5 秒跑一次，宿主的命令通道会跟着
   * 每隔几秒闪一次控制台窗口。整机 CPU 与内存由 os.cpus / os.freemem 直接算，不受影响；
   * 只有“每个 node 进程占多少”这一项缺失。需要时设 CAPITALIST_BOARD_PROC_SAMPLE=1。
   */
  if (String(process.env.CAPITALIST_BOARD_PROC_SAMPLE ?? "").trim() !== "1") {
    return {
      at: Date.now(),
      procs: [],
      source,
      reason: "进程级采样默认关闭；需要时设 CAPITALIST_BOARD_PROC_SAMPLE=1",
    };
  }
  try {
    const out = await runPowerShell(
      `Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "Name LIKE 'node%'" ` +
        `| Select-Object IDProcess,PercentProcessorTime,WorkingSet | ConvertTo-Json -Compress`,
    );
    const raw = JSON.parse(out.trim() || "[]");
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const procs: NodeProcSample[] = [];
    for (const it of arr) {
      const pid = Number(it?.IDProcess);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      procs.push({
        pid,
        cpu: Number.isFinite(Number(it?.PercentProcessorTime)) ? Number(it.PercentProcessorTime) : null,
        mem: Number.isFinite(Number(it?.WorkingSet)) ? Number(it.WorkingSet) : null,
      });
    }
    return { at: Date.now(), procs, source, reason: procs.length ? "" : "本机没有运行中的 node 进程" };
  } catch (e) {
    return {
      at: Date.now(),
      procs: [],
      source,
      reason: `CIM 采样失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Linux 扫 /proc，comm 以 node 开头的进程，CPU% 用 stat 差分折算。 */
function sampleLinux(): ProcSnapshot {
  const source = "/proc（comm + stat + statm 差分）";
  try {
    const hz = 100; // Linux USER_HZ 几乎恒为 100
    const now = Date.now();
    const dt = lastTicksAt ? (now - lastTicksAt) / 1000 : 0;
    const procs: NodeProcSample[] = [];
    const curTicks = new Map<number, number>();
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      let comm = "";
      let ticks = 0;
      let mem: number | null = null;
      try {
        comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
        if (!/^node(\.|$)/.test(comm)) continue;
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        // 第 14、15 列是 utime/stime，取最后一个右括号之后的部分再偏移。
        const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        ticks = Number(rest[11]) + Number(rest[12]); // utime(14)-1=11, stime(15)-1=12（含 0 位）
        const m = readFileSync(`/proc/${pid}/statm`, "utf8").trim().split(/\s+/);
        mem = Number(m[1]) * 4096; // resident 列 × 页大小
      } catch {
        continue; // 进程刚退出：跳过
      }
      const prev = lastCpuTicks.get(pid);
      const cpu = prev !== undefined && dt > 0 ? ((ticks - prev) / hz / dt) * 100 : null;
      curTicks.set(pid, ticks);
      procs.push({ pid, cpu: cpu === null ? null : Math.round(cpu * 10) / 10, mem });
    }
    lastCpuTicks.clear();
    for (const [k, v] of curTicks) lastCpuTicks.set(k, v);
    lastTicksAt = now;
    return { at: now, procs, source, reason: procs.length ? "" : "本机没有运行中的 node 进程" };
  } catch (e) {
    return {
      at: Date.now(),
      procs: [],
      source,
      reason: `/proc 采样失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function sampleMac(): Promise<ProcSnapshot> {
  const source = "ps -axo pid,%cpu,rss,comm（comm 过滤 node）";
  /**
   * 经 /bin/sh -c 中转，不直接 exec ps；macOS 26 起 /bin/ps 是 setuid root，带 hardened runtime 的进程直接 exec 会被内核拒（EPERM）。
   * 用异步采集而非 `spawnSync`：`ps -axo` 是全系统扫描，同步调用会阻塞事件循环。
   */
  const r = await runCapture("/bin/sh", ["-c", "ps -axo pid=,%cpu=,rss=,comm="], 9000);
  if (r.error || r.code !== 0 || !r.stdout) {
    return {
      at: Date.now(),
      procs: [],
      source,
      reason: `ps 采样失败：${r.error || `ps 退出码 ${r.code}`}`,
    };
  }
  const procs: NodeProcSample[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!m || m.length < 5) continue;
    if (!/\/node(\.|$)|^node(\.|$)/.test(m[4] ?? "")) continue;
    procs.push({ pid: Number(m[1]), cpu: Number(m[2]), mem: Number(m[3]) * 1024 });
  }
  return { at: Date.now(), procs, source, reason: procs.length ? "" : "本机没有运行中的 node 进程" };
}

async function sampleOnce(): Promise<void> {
  if (process.platform === "win32") procSnap = await sampleWindows();
  else if (process.platform === "darwin") procSnap = await sampleMac();
  else procSnap = sampleLinux();
}

/** 懒启动后台采样器，首次有人看 /api/overview 才开始，unref 不拦进程退出。 */
function ensureProcSampler(): void {
  if (samplerTimer) return;
  void sampleOnce();
  void sampleSys();
  /** 首轮没有差分、CPU 为 null；400ms 后补一轮。 */
  setTimeout(() => void sampleSys(), 400).unref?.();
  samplerTimer = setInterval(() => {
    void sampleOnce().catch(() => {
      /** sampleOnce 返回带 reason 的快照，不会 reject。 */
    });
    void sampleSys();
  }, SAMPLER_INTERVAL_MS);
  samplerTimer.unref?.();
}

export interface ResourceSampleView {
  sampled_at: string;
  process_count: number;
  cpu_percent: number | null;
  memory_bytes: number | null;
  memory_human: string;
  /** 整机内存压力百分比（0-100），与活动监视器同口径；采样不可用时为 null。 */
  memory_pressure_percent: number | null;
  source: string;
  unavailable_reason: string;
}

const SYS_SOURCE = "os.cpus() 差分 + 系统内存压力（整机口径）";

function resourceSample(): ResourceSampleView {
  ensureProcSampler();
  /** CPU 与内存都在 sysSnap 这一份整机采样里；per-pid 清单只在拿得到时补充。 */
  const sysFresh = Date.now() - sysSnap.at < SAMPLER_INTERVAL_MS * 4;
  const procFresh = Date.now() - procSnap.at < SAMPLER_INTERVAL_MS * 4;
  const at = Math.max(sysSnap.at, procSnap.at);
  const reason = !sysFresh
    ? sysSnap.at
      ? "整机采样读数已过期（后台采样器超过 20 秒未产生数据）"
      : "首次采样尚未完成"
    : "";
  return {
    sampled_at: at ? new Date(at).toISOString() : "",
    process_count: procFresh ? procSnap.procs.length : 0,
    cpu_percent: sysFresh ? sysSnap.cpu : null,
    memory_bytes: sysFresh ? sysSnap.memUsed : null,
    memory_human: sysFresh && sysSnap.memUsed !== null ? humanBytes(sysSnap.memUsed) : "—",
    memory_pressure_percent: sysFresh ? sysSnap.memPressure : null,
    source: SYS_SOURCE,
    unavailable_reason: reason,
  };
}

interface UnreclaimedProc {
  pid: number;
  kind: "监工" | "worker";
  id: string;
  at: string;
  why: string;
}

function unreclaimedOf(roots: string[]): UnreclaimedProc[] {
  const out: UnreclaimedProc[] = [];
  for (const root of roots) {
    try {
      const rec = loadSupervisor(root);
      const pid = Number(rec?.pid ?? 0);
      if (rec && rec.status !== "running" && pid > 0 && pidAlive(pid)) {
        out.push({
          pid,
          kind: "监工",
          id: String(rec.target ?? ""),
          at: String(rec.started_at ?? ""),
          why: `监工记录状态为 ${rec.status}，进程仍在`,
        });
      }
    } catch {
      /** 单个根读失败不影响别的根。 */
    }
    try {
      for (const w of listWorkers(root)) {
        if (w.status === "running" || w.status === "starting") continue;
        if (!(w.pid > 0) || !pidAlive(w.pid)) continue;
        out.push({
          pid: w.pid,
          kind: "worker",
          id: w.id,
          at: String(w.started_at ?? ""),
          why: `worker 已 ${w.status}，进程仍在${w.dispatch ? `（派单 ${w.dispatch}）` : ""}`,
        });
      }
    } catch {
    }
  }
  return out;
}

/** 汇总所有监工，单根读取失败只影响它自己那一行。 */
export function buildOverview(roots: string[]): BoardOverview {
  const pids: number[] = [];
  let running = 0;
  let paused = 0;
  let procTotal = 0;
  let procAlive = 0;
  let queued = 0;
  /** 跨根 token 合计只做加法。 */
  const figs: UsageFigures[] = [];
  const taskTotals: TaskCounts = {
    total: 0,
    running: 0,
    queued: 0,
    paused: 0,
    failed: 0,
    done: 0,
    canceled: 0,
    closed: 0,
    accepted: 0,
    ended: 0,
  };

  const rows: BoardOverview["roots"] = [];
  for (const root of roots) {
    let status: TaskSummary["status"] = "done";
    let procs = 0;
    let alive = 0;
    let counts: TaskCounts = {
      total: 0,
      running: 0,
      queued: 0,
      paused: 0,
      failed: 0,
      done: 0,
      canceled: 0,
      closed: 0,
      accepted: 0,
      ended: 0,
    };
    try {
      status = supervisorStateOf(root).status;
      if (status === "running") running++;
      if (status === "paused") paused++;
      const rec = loadSupervisor(root);
      if (rec && status !== "done" && pidAlive(rec.pid)) pids.push(rec.pid);
      for (const w of listWorkers(root)) {
        if (w.status === "running" || w.status === "starting") {
          procs++;
          if (pidAlive(w.pid)) {
            alive++;
            pids.push(w.pid);
          }
        }
      }
      queued += readDispatches(root).filter((d) => d.status === "open").length;
      for (const r of threadCostRows(root)) figs.push(r.usage);
      counts = taskCounts(root);
    } catch {
      status = "stale";
    }
    for (const k of Object.keys(taskTotals) as Array<keyof TaskCounts>) taskTotals[k] += counts[k];
    procTotal += procs;
    procAlive += alive;
    let target = "";
    try {
      target = String(loadState(root)?.target ?? "");
    } catch {
      target = "";
    }
    rows.push({ root, target, status, processes: procs, alive, tasks: counts });
  }

  const bytes0 = workingSetBytes(pids);
  const res = resourceSample();
  /** 内存口径：采样器成功时取全部 node 进程之和，采样不可用时退回台账 pid 的 WorkingSet 求和。 */
  const bytes = res.memory_bytes ?? bytes0;
  const unreclaimedList = unreclaimedOf(roots);
  /** 额度是账号级的，取当前根的记录去找账号，避免每个根各打一次计费接口。 */
  const balanceRaw = balanceView(roots[0] ?? "");
  /** 额度状态取各根里最近一次判定，只读磁盘 quota.json。 */
  let quota: BoardOverview["quota"] = { exhausted: false, at: "", text: "" };
  for (const root of roots) {
    const q = readQuotaState(root);
    if (!q.exhausted) continue;
    if (!quota.exhausted || q.at > quota.at) quota = q;
  }
  /** 余额照计费接口读数显示，不因模型通道 429 就作废。 */
  const balance = balanceRaw;
  const tokens = tokenTotals(figs);
  return {
    at: new Date().toISOString(),
    supervisors: { total: roots.length, running, paused },
    processes: { total: procTotal, alive: procAlive, queued },
    tasks: taskTotals,
    credit_used: balance.credit_used,
    credit_left: balance.credit,
    credit_unit: balance.credit_unit,
    credit_at: balance.at,
    credit_source: balance.source,
    credit_stale: balance.stale,
    credit_unavailable_reason: balance.reason,
    usage: {
      total_input_tokens: tokens.total_input_tokens,
      total_output_tokens: tokens.total_output_tokens,
      total_tokens: tokens.total_tokens,
      total_cache_read_tokens: tokens.total_cache_read_tokens,
      reported_runs: tokens.usage_reported,
      unreported_runs: tokens.usage_unreported,
      billing_unit: tokens.billing_unit,
      total_credit: tokens.total_credit,
      /* 同 `/api/supervisor`：无工作进程记录时使用账号额度单位，避免回退为 token。 */
      credit_unit: tokens.credit_unit || balance.credit_unit,
    },
    memory_bytes: bytes,
    memory_human: humanBytes(bytes),
    memory_pressure_percent: res.memory_pressure_percent,
    resources: res,
    unreclaimed_pids: unreclaimedList.slice(0, 50).map((x) => x.pid),
    unreclaimed_detail: unreclaimedList.slice(0, 20),
    quota,
    roots: rows,
  };
}

/** 总看板 JSON 带 2 秒缓存，缓存键为任务根集合排序后拼接。 */
const overviewCache = new Map<string, { at: number; body: string }>();
const OVERVIEW_TTL_MS = 2000;

function overviewJson(roots: string[], fresh = false): string {
  const key = roots.map((r) => resolve(r)).sort().join("|");
  const now = Date.now();
  if (!fresh) {
    const hit = overviewCache.get(key);
    if (hit && now - hit.at < OVERVIEW_TTL_MS) return hit.body;
  }
  const body = JSON.stringify(buildOverview(roots));
  if (overviewCache.size > 16) overviewCache.clear();
  overviewCache.set(key, { at: now, body });
  return body;
}

/**
 * 线程页缓存。
 *
 * 一次页面刷新里，线程列表、监工状态、任务计数会各要一份，彼此只差个 limit；
 * 每份都重算一遍等于把同样的磁盘读取做三四次。这里按任务根缓存 1 秒，
 * 命中时返回浅拷贝。调用方会往线程对象上写展示字段，不能把缓存原件交出去。
 */
const THREADS_PAGE_TTL_MS = 1_000;
/* 只缓存全量页：不同 limit 只是同一份数据裁掉尾巴，没必要各算一遍。 */
const threadsPageCache = new Map<string, { at: number; page: ReturnType<typeof buildThreadsPageUncached> }>();

function cloneThreadsPage(page: ReturnType<typeof buildThreadsPageUncached>): ReturnType<typeof buildThreadsPageUncached> {
  return {
    ...page,
    counts: { ...page.counts },
    totals: { ...page.totals },
    threads: page.threads.map((t) => ({ ...t, usage: { ...t.usage } })),
  };
}

export function buildThreadsPage(root: string, limit: number): ReturnType<typeof buildThreadsPageUncached> {
  const hit = threadsPageCache.get(root);
  const full =
    hit && Date.now() - hit.at < THREADS_PAGE_TTL_MS
      ? hit.page
      : (() => {
          const page = buildThreadsPageUncached(root, Number.MAX_SAFE_INTEGER);
          threadsPageCache.set(root, { at: Date.now(), page });
          return page;
        })();
  if (limit >= full.threads.length) return cloneThreadsPage({ ...full, truncated: false });
  return cloneThreadsPage({ ...full, threads: full.threads.slice(0, limit), truncated: true });
}
