import { THREAD_PAGE_LIMIT, THREAD_PEEK_TAIL_BYTES, ThreadSummary, dispatchTitle, ageSec } from "./snapshot";
import { join } from "node:path";
import { supervisorDir } from "../../core/record/paths";
import { readJson, writeJson } from "../../core/record/json";
import { Dispatch, WorkerRecord, loadSupervisor, dispatchPaused, workerLivenessOf, DEFAULT_LOG_STALL_SEC, parentOf, pendingPrerequisites } from "../../core/record/supervisor";
import { taskKeyOf, readClearedMarks, threadStatusTerminal, threadStatusAbnormal } from "./state";
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
import { oneLine } from "./render";
import { assignThreadNos, threadNoLabel, threadNoOf } from "../usage/threadNo";
/**
 * 看板线程视图层：线程列表、消息流、任务分桶与已读水位。
 *
 * 这里只做「读盘 → 组装 DTO」，不发 HTTP、不写台账。HTTP 与路由留在 index.ts，
 * 命令执行在 commands 层，三者不互相引用，避免形成环。
 */

/** 各线程的已读水位（epoch 秒）。保存该值，进程重启后不将已读线程重新标记为未读。 */
export const threadSeen = new Map<string, number>();
export let threadSeenLoadedFor = "";

export function threadSeenPath(root: string): string {
  return join(supervisorDir(root), "board-seen.json");
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
export function settledThreadKeys(dispatches: readonly Dispatch[]): Set<string> {
  const keys = new Set<string>();
  for (const d of dispatches) {
    const s = String(d.status ?? "");
    if (s !== "done" && s !== "closed") continue;
    keys.add(taskKeyOf(d.stage, d.shard, String((d as { lineage?: string }).lineage ?? "")));
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
    keys.add(taskKeyOf(d.stage, d.shard, String((d as { lineage?: string }).lineage ?? "")));
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

export const CANCEL_NOTE = "用户手动结项";

export const CANCELED_KEEP_MS = 24 * 3600 * 1000;

export function yieldedOf(d: Dispatch): { yielded_at?: string; yielded_by?: string } {
  if (!d.yielded_at) return {};
  return { yielded_at: d.yielded_at, ...(d.yielded_by ? { yielded_by: d.yielded_by } : {}) };
}

export function yieldedReason(d: Dispatch): string {
  const by = String(d.yielded_by ?? "").trim();
  return by
    ? `已为立即执行派单 ${by} 让出槽位，该单结束后按原顺序恢复`
    : "已为立即执行派单让出槽位，该单结束后按原顺序恢复";
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

export const THREADS_PAGE_TTL_MS = 1_000;
export const threadsPageCache = new Map<string, { at: number; page: ReturnType<typeof buildThreadsPageUncached> }>();

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
