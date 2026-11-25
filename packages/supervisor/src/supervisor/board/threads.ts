import { THREAD_PAGE_LIMIT, THREAD_PEEK_TAIL_BYTES, ThreadSummary, dispatchTitle, ageSec } from "./snapshot";
import { join } from "node:path";
import { board as boardLoc } from "../../core/record/locations";
import { readJson, writeJson } from "../../core/record/json";
import { Dispatch, WorkerRecord, loadSupervisor, dispatchPaused, workerLivenessOf, DEFAULT_LOG_STALL_SEC, parentOf } from "../../core/record/supervisor";
import { isSettled } from "../../core/record/dispatchState";
import { pendingOf } from "../../core/dispatch/deps";
import { groupIndexFrom } from "../../core/dispatch/groupOps";
import { isGroupRef, label } from "../../core/record/nodeRef";
import { laneKeyOf } from "../../core/dispatch/commands";
import { readClearedMarks, threadStatusTerminal, threadStatusAbnormal } from "./state";
import { readTasks } from "../../core/record/tasks";
import { WorkerAction, parseWorkerLog } from "../worker/workerLog";
import { statSync } from "node:fs";
import { readLogRange } from "./logs";
import { WorkerDoing, doingOfAction } from "../worker/activity";
import { messageContext, threadMessages } from "./messages";
import { activeTakeover } from "../../core/dispatch/commands";
import { costRowOf, spawnCountFor, fillContextWindow, costTotals, tokenTotals } from "./stats";
import { dispatchModel, atTs } from "./sources";
import { noUsage } from "../usage/usage";
import { maskBoardText, oneLine } from "./render";
import { taskNoOfRef, threadNoOf } from "../usage/threadNo";
/**
 * 看板线程视图层：线程列表、消息流、任务分桶与已读水位。
 *
 * 这里只做读盘与组装视图对象，不发 HTTP、不写台账。HTTP 与路由留在 index.ts，
 * 命令执行在 commands 层，三者不互相引用，避免形成环。
 */

/** 各线程的已读水位（epoch 秒）。保存该值，进程重启后不将已读线程重新标记为未读。 */
export const threadSeen = new Map<string, number>();
export let threadSeenLoadedFor = "";

export function threadSeenPath(root: string): string {
  return boardLoc.seen(root);
}

/** 首次用到时从盘上恢复一次；同一任务根只读一次。 */
export function loadThreadSeen(root: string): void {
  if (threadSeenLoadedFor === root) return;
  threadSeenLoadedFor = root;
  const disk = readJson<Record<string, number>>(threadSeenPath(root), {});
  for (const [k, v] of Object.entries(disk ?? {})) {
    const n = Number(v);
    if (k && Number.isFinite(n) && n > 0 && !threadSeen.has(k)) threadSeen.set(k, n);
  }
}

export function saveThreadSeen(root: string): void {
  const out: Record<string, number> = {};
  for (const [k, v] of threadSeen) out[k] = v;
  writeJson(threadSeenPath(root), out);
}

export function buildThreads(root: string): ThreadSummary[] {
  return buildThreadsPage(root, Number.MAX_SAFE_INTEGER).threads;
}

export type TaskBucket = "run" | "queue" | "paused" | "bad" | "done" | "canceled" | "closed";

/** 档位词条：回执与命令行输出与界面筛选同词，避免同一档出现两种叫法。 */
export const TASK_BUCKET_WORD: Record<TaskBucket, string> = {
  run: "运行中",
  queue: "排队",
  paused: "暂停中",
  bad: "异常",
  done: "已完成",
  canceled: "已取消",
  closed: "已结束",
};

/** 界面筛选与清空动作共用的档位全集，顺序与筛选菜单一致。 */
export const TASK_BUCKETS: readonly TaskBucket[] = [
  "run",
  "queue",
  "paused",
  "bad",
  "done",
  "canceled",
  "closed",
];

/**
 * 分档唯一入口：界面筛选、状态计数、按档清空三处都读它。
 *
 * `exited` 有两种结局：派单已结（执行完成或人工结束）归已完成，派单未结（被打回重排、
 * 被重启打断）归排队，与“待重派”词条一致。调用方取不到线程键的结束判据时按
 * 已结处理，保持旧行为。
 */
export function taskBucket(status: unknown, settled?: boolean): TaskBucket {
  const s = String(status ?? "");
  if (s === "running" || s === "starting" || s === "claimed") return "run";
  if (s === "queued" || s === "open") return "queue";
  if (s === "suspended") return "queue";
  /* 暂停单单独成档：该状态既不在等待槽位，也不在运行，不与排队状态合并。 */
  if (s === "paused") return "paused";
  if (s === "done" || s === "finished") return "done";
  if (s === "exited") return settled === false ? "queue" : "done";
  if (s === "canceled") return "canceled";
  /* 作废与结束单单独成档，不计入排队与运行。 */
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
  threads: ReadonlyArray<{ id?: string | null; status?: string | null; bucket?: string | null }>,
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
    const key = String(t.id ?? "");
    /* 线程自带 bucket 时直接用它，避免同一批线程在计数与列表里落到两个档。 */
    const b =
      (String(t.bucket ?? "") as TaskBucket) ||
      taskBucket(t.status, settledKeys ? settledKeys.has(key) : undefined);
    out.total += 1;
    if (b === "run") out.running += 1;
    else if (b === "queue") out.queued += 1;
    else if (b === "paused") out.paused += 1;
    else if (b === "bad") out.failed += 1;
    else if (b === "canceled") out.canceled += 1;
    else if (b === "closed") out.closed += 1;
    else {
      out.done += 1;
      if (acceptedKeys?.has(key)) out.accepted += 1;
    }
  }
  return out;
}

/** 已结束判据与前端 settled() 同源：派单台账里 done 或 closed 即算结束。 */
export function settledThreadKeys(dispatches: readonly Dispatch[]): Set<string> {
  const keys = new Set<string>();
  for (const d of dispatches) {
    const s = String(d.status ?? "");
    if (s !== "done" && s !== "closed") continue;
    keys.add(laneKeyOf({ shard: d.shard, lineage: String((d as { lineage?: string }).lineage ?? "") }));
  }
  return keys;
}

export function acceptedThreadKeys(root: string, dispatches: readonly Dispatch[]): Set<string> {
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
    keys.add(laneKeyOf({ shard: d.shard, lineage: String((d as { lineage?: string }).lineage ?? "") }));
  }
  return keys;
}

export const taskCountsCache = new Map<string, { at: number; val: TaskCounts }>();
export const TASK_COUNTS_TTL_MS = 3000;

export function rememberTaskCounts(root: string, val: TaskCounts): TaskCounts {
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

/**
 * 取消判定的默认说明。
 *
 * 只作为写库时的默认 note，不再作为判定条件：用户在取消时填的理由会覆盖它，
 * 按 note 文案判定会让“填了理由的取消”被归入已完成档。
 */
export const CANCEL_NOTE = "用户手动结束";

export const CANCELED_KEEP_MS = 24 * 3600 * 1000;

export function yieldedOf(d: Dispatch): { yielded_at?: string; yielded_by?: string } {
  if (!d.yielded_at) return {};
  return { yielded_at: d.yielded_at, ...(d.yielded_by ? { yielded_by: d.yielded_by } : {}) };
}

export function yieldedReason(d: Dispatch): string {
  const by = String(d.yielded_by ?? "").trim();
  return by
    ? `已让位给立即执行单 ${by}，该单结束后按原顺序恢复`
    : "已让位给立即执行单，该单结束后按原顺序恢复";
}

export const WORKER_ACTION_TAIL_BYTES = 256 * 1024;
export const workerActionCache = new Map<string, { key: string; action: WorkerAction | null | undefined }>();

export function workerActionOf(log: string): WorkerAction | null | undefined {
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

export function threadDoingOf(d: Dispatch | undefined, worker: WorkerRecord, alive: boolean): WorkerDoing | "" {
  if (d?.status === "reported") return "report";
  if (!alive) return "";
  return doingOfAction(workerActionOf(worker.log));
}

/**
 * 归档态占位线程：取消与作废的单没有工作进程，只按派单记录生成一行。
 *
 * 两种状态的字段完全一致，差别只在 status；合并成一个工厂，避免以后再复制第三份实现。
 * 字段顺序与合并前保持一致，接口输出的键序不变。
 *
 * @param held 该分片是否被人工接管。判定依赖调用方作用域内的接管快照，故由调用方传入。
 */
function archivedThread(
  key: string,
  d: Dispatch,
  status: "canceled" | "superseded",
  held: boolean,
): ThreadSummary {
  return {
    id: key,
    no: "",
    stuck_on: "",
    stuck_on_no: "",
    shard: d.shard ?? "",
    lineage: String((d as { lineage?: string }).lineage ?? d.id),
    status,
    model: dispatchModel(d),
    worker: "",
    last_at: "",
    last_role: "",
    last: "",
    unread: 0,
    held,
    started_at: d.at,
    dispatch: d.id,
    title: dispatchTitle(d),
    output_bytes: 0,
    duration_sec: 0,
    spawn_count: 0,
    usage: noUsage(d.at, dispatchModel(d)),
  };
}

export function buildThreadsPageUncached(
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
  /*
   * 前置判定要看组：组前置的满足条件是“整组了结”。缺索引时组号在台账里查不到，
   * 会被永远判成未满足。组已解散或已全部完成，左栏仍显示“等待 #G1”。
   */
  const gidx = groupIndexFrom(root, dispatches);
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
    const key = laneKeyOf({ shard: w.shard, lineage: String((d as { lineage?: string } | undefined)?.lineage ?? "") });
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
      /*
       * 暂停优先于进程状态：进程已按暂停停掉，仍按 `exited` 上屏会显示成“待重派”，
       * 与没有进程记录的暂停单出现两种词。
       */
      status: d && dispatchPaused(d) ? "paused" : w.status,
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
    /* 只看结束动作由谁发起：note 是可被用户理由覆盖的自由文本，按它判定会让取消显示成已完成。 */
    if (String(d.closed_by ?? "") !== "user") continue;
    const closedAt = Date.parse(String(d.closed_at ?? d.done_at ?? d.at ?? ""));
    if (Number.isFinite(closedAt) && Date.now() - closedAt > CANCELED_KEEP_MS) continue;

    const own = [...threads.values()].find((th) => th.dispatch === d.id);
    if (own) {
      own.status = "canceled";
      continue;
    }

    const key = laneKeyOf({ shard: d.shard, lineage: String((d as { lineage?: string }).lineage ?? "") });
    const taken = threads.get(key);
    if (taken) {
      if (!taken.dispatch) taken.status = "canceled";
      continue;
    }

    threads.set(key, archivedThread(key, d, "canceled", isHeld(d.shard)));
  }

  /*
   * 作废单补入列表。
   *
   * 作废单没有工作进程，不会经 worker 循环进入 threads；
   * 单独成档，不与用户取消合并。
   */
  for (const d of dispatches) {
    if (String(d.status ?? "") !== "superseded") continue;
    const supersededAt = Date.parse(String(d.closed_at ?? d.done_at ?? d.at ?? ""));
    if (Number.isFinite(supersededAt) && Date.now() - supersededAt > CANCELED_KEEP_MS) continue;
    const key = laneKeyOf({ shard: d.shard, lineage: String((d as { lineage?: string }).lineage ?? "") });
    if (threads.has(key)) continue;
    threads.set(key, archivedThread(key, d, "superseded", isHeld(d.shard)));
  }

  for (const d of dispatches) {
    if (d.status !== "open" && d.status !== "claimed") continue;
    const hasWorker = workers.some((w) => w.dispatch === d.id);
    if (hasWorker) continue;
    const key = laneKeyOf({ shard: d.shard, lineage: String((d as { lineage?: string }).lineage ?? "") });
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
        /*
         * 同一任务又派了一张单：更新既有行，不再另立一行。
         * 一个任务一行、一个任务号；该任务派过几次由 `dispatches` 汇总，不靠行数体现。
         * 已有进程在跑时保留运行态，避免把正在执行的任务显示成排队。
         */
        const running = prev.status === "running" || prev.status === "starting";
        if (!running) {
          prev.status = threadStatusOf(d);
          prev.dispatch = d.id;
          prev.title = dispatchTitle(d) || prev.title;
          prev.model = dispatchModel(d);
          prev.started_at = d.at;
          prev.duration_sec = 0;
        }
        prev.held = isHeld(d.shard);
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
        spawn_count: spawnCountFor(key, dispatches),
        usage: noUsage(d.at, dispatchModel(d)),
      });
      continue;
    }
    let reason: string;
    if (dispatchPaused(d)) reason = String(d.paused_reason ?? "").trim() || "上次中断未完成，等待唤醒";
    else if (d.yielded_at) reason = yieldedReason(d);
    else if (isHeld(d.shard)) reason = "人工接管中，监工不自动派单";
    else if (capacity <= 0) reason = "等待外部领单（--no-spawn）";
    else if (running >= capacity) reason = `并发名额已满（${running}/${capacity}），等待空位`;
    else reason = "等待派发（有空闲并发名额）";
    threads.set(key, {
      id: key,
      no: "",
      stuck_on: "",
      stuck_on_no: "",
      shard: d.shard ?? "",
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
      spawn_count: spawnCountFor(key, dispatches),
      usage: noUsage(d.at, dispatchModel(d)),
    });
  }

  for (const d of dispatches) {
    if (d.status !== "open" && d.status !== "claimed") continue;
    const key = laneKeyOf({ shard: d.shard, lineage: String((d as { lineage?: string }).lineage ?? "") });
    const t = threads.get(key);
    if (!t) continue;
    if (t.status === "running" || t.status === "starting") continue;
    /** 让位行允许改写：其工作进程记录停在 suspended，不能按启动时刻更晚就跳过。 */
    const suspendedRow = t.status === "suspended";
    if (String(t.started_at ?? "") > String(d.at ?? "") && !suspendedRow) continue;
    /* 判定“这一单是否已有进程在跑”认派单 id：同分片可能有先后两张单，按分片比会误判为已有进程。 */
    const live = workers.some(
      (w) => (w.dispatch ?? "") === d.id && (w.status === "running" || w.status === "starting"),
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
      else if (running >= capacity) reason = `并发名额已满（${running}/${capacity}），等待空位`;
      else reason = "等待派发（有空闲并发名额）";
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
    addRef(laneKeyOf({ shard: w.shard, lineage: String(d?.lineage ?? "") }), w.id, w.dispatch);
  }
  for (const d of dispatches) {
    addRef(laneKeyOf({ shard: d.shard, lineage: String(d.lineage ?? "") }), d.worker, d.id);
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
  /*
   * 任务号只有一个发行方：任务台账。派单号前缀就是任务号，界面直接取前缀，
   * 不再按列表顺序另发一套流水号。
   * 旧格式单（`D-` 前缀）没有任务号，回查历史编号表只作展示兜底，且只读不发号。
   */
  for (const t of all) {
    t.no =
      taskNoOfRef(String(t.dispatch ?? "")) ||
      taskNoOfRef(String(t.lineage ?? "")) ||
      threadNoOf(root, t.id);
  }

  /*
   * 分档在这里一次算定：界面列表、状态计数、按档清空都读 t.bucket，
   * 不再各自按 status 推导。exited 的结局按台账里该任务是否已有结束单判定。
   */
  const settledKeys = settledThreadKeys(dispatches);
  for (const t of all) {
    const own = dispatchById.get(String(t.dispatch || ""));
    const s = String(own?.status ?? "");
    t.settled = isSettled(s);
    t.bucket = taskBucket(t.status, settledKeys.has(t.id));
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
    /*
     * 前置说明是监工填写的自由文本，可能包含进程号。该字段不属于消息对象，
     * 经散文本出口 {@link maskBoardText} 改写；消息正文由 maskThreadMessage 处理，两者规则同源。
     */
    if (why) t.parent_reason = maskBoardText(why, noOfDispatch);
    const stuck = pendingOf(d, dispatches, gidx).filter((id) => id !== "*")[0] ?? "";
    /* 卡点可能是组号（归一后的 `G1`），显示形态由 `nodeRef.label` 统一补 `#`。 */
    t.stuck_on = stuck && isGroupRef(stuck) ? label(stuck) : stuck;
    t.stuck_on_no = stuck ? noOfDispatch.get(stuck) || threadNoOf(root, stuck) : "";
  }

  const holdByThread = new Map<string, { at: string; why: string }>();
  for (const d of dispatches) {
    if (d.status !== "failed") continue;
    const v = String((d as { retry_verdict?: string }).retry_verdict ?? "");
    if (v !== "hold") continue;
    const key = laneKeyOf({ shard: d.shard, lineage: String((d as { lineage?: string }).lineage ?? "") });
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
      output_bytes: t.output_bytes,
      duration_sec: t.duration_sec,
      spawn_count: t.spawn_count,
    })),
  );
  const totals = { ...cost, ...tokenTotals(all.map((t) => t.usage)) };
  /** 统计在全量上算完再截断，分页不影响数字。 */
  const counts = rememberTaskCounts(root, taskCountsOf(all, acceptedThreadKeys(root, dispatches), settledKeys));

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

export const THREADS_PAGE_TTL_MS = 1_000;
export const threadsPageCache = new Map<string, { at: number; page: ReturnType<typeof buildThreadsPageUncached> }>();

/**
 * 清线程列表与状态计数的读缓存。
 *
 * 两处都要清：状态行的数字来自 taskCountsCache，它有自己的 3 秒 TTL，
 * 只清 threadsPageCache 会出现“卡片变了、顶部计数没变”。
 */
export function clearThreadsCaches(): void {
  threadsPageCache.clear();
  taskCountsCache.clear();
}

export function cloneThreadsPage(page: ReturnType<typeof buildThreadsPageUncached>): ReturnType<typeof buildThreadsPageUncached> {
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

/** 记录某线程已读到当前时刻；读水位只前进，不回退。 */
export function markThreadSeen(root: string, id: string): void {
  loadThreadSeen(root);
  threadSeen.set(id, Date.now() / 1000);
  saveThreadSeen(root);
}
