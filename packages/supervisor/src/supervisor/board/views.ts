import { BoardSnapshot, signature, ageSec, describeEvent, buildSnapshot, ledgerOnlyRoot } from "./snapshot";
import { buildThreads, TaskCounts, taskCountsOf, settledThreadKeys, acceptedThreadKeys, taskCounts } from "./threads";
import { clipText } from "../../core/text";
import { maskBoardText } from "./render";
import { dispatchNoTable } from "../usage/threadNo";
import { readJsonlFromTail } from "./logs";
import { eventsFile, atTs, readDispatchesBoard } from "./sources";
import { openInboxAsks } from "../../core/dispatch/inbox";
import { ReloadStatus, SupervisorContextView, reloadStatus, buildSupervisorContextView } from "../context/reload";
import { SupervisorActivityKind, SupervisorAction, supervisorActivityOf, currentSupervisorAction } from "../worker/activity";
import { loadSupervisor, listWorkers, pidAlive, supervisorStaleSec, readDispatches } from "../../core/record/supervisor";
import { loadState } from "../../core/record/state";
import { hasCustomPolicy } from "../../core/policy/customPolicy";
import { loadPolicy } from "../../core/policy/policy";
import { tokenTotals, usageTotalsOf, type UsageTotals, ThreadCostRow, costRowsWith, pickCurrentCostRows, costTotals } from "./stats";
import { readPendingMq } from "../../core/dispatch/mq";
import { balanceView, BalanceView } from "../usage/balance";
import { readSupervisorModelUsed } from "./assets";
import { supervisorModelEffective } from "../judge/supervisorModel";
import { readNextModel } from "../loop";
import { readPause } from "../../core/record/pause";
import { TaskSummary as TaskPoolSummary } from "../../core/record/tasks";
import { ContextView, buildContextView } from "../usage/usage";
import { readQuotaState } from "../../core/guard/quota";
import { poolSummaryForMetrics } from "./supervisorLog";


/**
 * 看板只读视图：告警、监工状态、指标与全局概览。
 *
 * 全部由已有数据装配而成，不写盘、不发请求；HTTP 只负责把它们序列化出去。
 */
export interface TaskSummary {
  root: string;
  target: string;
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

export function buildTaskSummaries(roots: string[]): TaskSummary[] {
  return roots.map((root) => {
    try {
      const snap = buildSnapshot(root);
      const capitalist = supervisorStateOf(root);
      const running = snap.workers.filter((w) => w.status === "running" || w.status === "starting").length;
      const liveWorker = snap.workers.filter((w) => w.status === "running" || w.status === "starting").pop();
      const doing = liveWorker
        ? `${liveWorker.id} 运行中${liveWorker.dispatch ? ` | ${liveWorker.dispatch}` : ""}`
        : snap.diagnosis.title;
      return {
        root,
        target: snap.target,
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
    case "policy_change":
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
export const ALERT_LIMIT_DEFAULT = 50;
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
  /* 默认守卫下不描述守卫过程：按中性说法上屏。 */
  const customPolicy = hasCustomPolicy(loadState(root)?.policy);
  /*
   * 告警正文与线程消息使用同一口径：`describeEvent` 会把执行进程写入括号，
   * ask 正文由工作进程填写，两处都可能包含进程号。
   */
  const nos = dispatchNoTable(root);
  const show = (v: unknown): string => maskBoardText(String(v ?? ""), nos);
  for (const e of readJsonlFromTail(eventsFile(root), 512_000)) {
    const name = String(e.event ?? e.kind ?? "");
    if (ledgerOnly && name === "supervisor_done") continue;
    const lvl = alertLevelOf(name);
    if (!lvl) continue;
    const at = String(e.at ?? "");
    const id = `evt:${name}:${at}:${String(e.dispatch ?? "")}:${String(e.worker ?? "")}`;
    push({ id, level: lvl, at, event: name, text: clipText(show(describeEvent(e, { customPolicy })), ALERT_TEXT_CHARS) });
  }

  for (const q of openInboxAsks(root)) {
    const id = `ask:${q.id}`;
    push({ id, level: "P0", at: String(q.at ?? ""), event: "ask", text: clipText(show(q.text), ALERT_TEXT_CHARS) });
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
  parallel: number;
  inflight: number;
  tick: number;
  board_url: string;
  pending_asks: number;
  heartbeat_note: string;
  reload: ReloadStatus;
  usage: UsageTotals;
  context: SupervisorContextView;
  model: string;
  model_version: string;
  /** 用户选定的监工模型；空串表示跟随宿主默认。 */
  supervisor_model: string;
  /** 监工实际调用的模型：`supervisor_model` 为空时是平台默认档的具体档名。 */
  supervisor_model_effective: string;
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
      name === "stalled"
    )
      redispatch += 1;
  }
  const parts: string[] = [];
  if (timeout > 0) parts.push(`心跳超时 ${timeout}`);
  if (killed > 0) parts.push(`判定失败 ${killed}`);
  if (redispatch > 0) parts.push(`重派 ${redispatch}`);
  return parts.length ? `${parts.join(" | ")}（近 ${hours} 小时）` : "";
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
    inflight,
    tasks: taskStats,
    board_url: capitalist?.board_url ?? "",
    pending_asks: pendingAsks,
    heartbeat_note: heartbeatSummary(root, 6),
    reload,
    /* 单位回退取账号额度读数，理由见 stats.usageTotalsOf 的说明。 */
    usage: usageTotalsOf(tokens, balanceView(root).credit_unit),
    context: buildSupervisorContextView(root),
    /*
     * 最近一次派单的模型优先；没有派单时用监工对话上一次实际跑的模型。
     * 前端靠它把“宿主默认”标到具体那一行，不再出现抽象的“宿主默认”条目。
     */
    model: lastModel || readSupervisorModelUsed(root),
    model_version: lastVersion,
    supervisor_model: String(capitalist?.supervisor_model ?? "").trim(),
    supervisor_model_effective: supervisorModelEffective(root),
    next_model: readNextModel(root),
    effort: String(capitalist?.effort ?? "").trim(),
    /* 排空式停止的门闩不算暂停：监工正在退出，指标条不该给出“恢复调度”。 */
    paused: readPause(root) !== null && readPause(root)?.drain !== true,
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
      detail: `最后一次心跳 ${age} 秒前，超过判活时限 ${stale} 秒`,
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
    detail: `监工在线，最多 ${capitalist.max_workers} 个工作进程`,
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
export interface BoardMetrics {
  at: string;
  /** 工作进程记录总数（含已退出）。 */
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
  usage: UsageTotals;
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
    usage: usageTotalsOf(tokens, balance.credit_unit),
    paused: pause !== null,
    paused_since: pause ? pause.at || null : null,
    threads: currentRows,
    threads_total: costRows.length,
    quota: quotaState,
    ...costTotals(costRows),
  };
}

export function supervisorStateOf(root: string): { status: TaskSummary["status"]; age: number | null } {
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
/** 状态响应字节上限：超出时从最旧数据开始丢弃。 */
const STATE_MAX_BYTES = 20_000;

export function fitState(snap: BoardSnapshot): string {
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
