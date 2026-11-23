/**
 * 看板快照与事件流：把任务根下的记录整理成界面直接可渲染的结构。
 *
 * 只做读取与整形，不写状态；写入由各路由完成，随后经 invalidateBoardCaches 让读缓存失效。
 */

import os from "node:os";
import { buildThreadsPage } from "./threads";
import { WorkerStuckState, Dispatch, listWorkers, loadSupervisor, readDispatches, WorkerRecord, workerLogIdleSec, workerLivenessOf, DEFAULT_LOG_STALL_SEC, activeDispatch, isSupervisorAlive } from "../../core/record/supervisor";
import { WorkerDoing } from "../worker/activity";
import { UsageFigures } from "../usage/usage";
import { shardTitle, summarizeTitle } from "../usage/taskTitle";
import { statCached } from "../../core/record/fsCache";
import { join, resolve } from "node:path";
import { ledger as ledgerLoc, runtime as runtimeLoc, inbox as inboxLoc } from "../../core/record/locations";
import { tailLines, readJsonlFromTail, meaningfulLines } from "./logs";
import { zh } from "./zh";
import { loadState } from "../../core/record/state";
import { workerCost } from "./stats";
import { clipText } from "../../core/text";
import { openInboxAsks } from "../../core/dispatch/inbox";
import { hasCustomContract } from "../../core/contract/customContract";
import { loadContract, stageById } from "../../core/contract/contract";
import { runCheck } from "../../core/contract/checks";
import { byId, workerHosts } from "../../agent/registry";
import { eventsFile, listTaskRoots } from "./sources";
import { readdirSync, existsSync } from "node:fs";

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
    /** 宿主的显示名；未注册宿主为空串，前端改用 worker_host 显示。 */
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

export const SNAPSHOT_DISPATCH_LIMIT = 8;
export const THREAD_PAGE_LIMIT = 60;
export const THREAD_PEEK_TAIL_BYTES = 256 * 1024;
export const NOTE_PREVIEW_CHARS = 200;

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
export type ThreadKind = "dispatch" | "verdict" | "output" | "tool" | "say" | "thinking" | "engine" | "notice";

export interface ThreadMessage {
  /**
   * 消息 id。
   *
   * 真实消息取消息编号（`任务号-方向-时间戳`，见 core/message/msgId.ts）；视图块（思考、
   * 工具聚合、输出分块、引擎日志）取 `viewId()` 的 `~` 形态。视图块不是消息，不带编号、
   * 不可引用，{@link view} 为 true 时界面不得显示编号。
   */
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
  lines?: number;  /** 这一块里被过滤掉的引擎调试行数（页面上要说明“已隐藏 N 行”，不能无提示地丢弃） */
  hidden?: number;
  debug?: string[];
  event?: string;
  /** 附件路径只取本条记录写入时的值，缺失即无图，不回退到上一条或全局。 */
  atts?: string[];
  /** 随带的技能名，气泡上按标签展示；缺失表示没选技能。 */
  skills?: string[];
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
  /** 视图块标记：真相是日志切片或聚合结果，不是一条消息。界面不显示编号、不提供引用。 */
  view?: boolean;
  /**
   * 用户消息的送达档位。
   *
   * 界面按档位出词与配色，不解析 `status` 的文案：`status` 是给人看的句子，措辞随时会改，
   * 前端按字面比对在改词后整片失效。这里只给码。
   */
  delivery?: Delivery;
}

/** 用户消息的送达档位：`ok` 已送达，`pending` 待送达，`bad` 未送达。 */
export type Delivery = "ok" | "pending" | "bad";

export interface ThreadSummary {
  id: string;
  no: string;
  shard: string;
  lineage?: string;
  stage: string;
  status: string;
  bucket?: "run" | "queue" | "paused" | "bad" | "done" | "canceled" | "closed"; /* 由 taskBucket 算定，前端直接读 */
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
 * 上屏后需要能引用的裁决类事件：对申报的正式答复与流程结论。进程启停、心跳这类
 * 状态播报不在其中，它们没有可引用的内容。两条消息流共用这份清单。
 */
export const REFUNDABLE_EVENTS = new Set([
  "mq_triage",
  "dispatch_done",
  "dispatch_failed",
  "dispatch_closed",
  "dispatch_retry",
  "dispatch_orphan",
  "dispatch_reaped",
  "stuck_detected",
  "stuck_cleared",
  "stuck_killed",
  "stuck_guidance_delivered",
  "supervisor_advance",
  "supervisor_done",
]);

export const FEED_EVENTS = new Set([  "dispatch_open",
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

export const FEED_LIMIT = 20;
export const SNAPSHOT_WORKER_LIMIT = 20;
export const ACTION_PREVIEW_CHARS = 160;
export const FEED_TEXT_CHARS = 160;

/** 永不返回分片 id 作为标题；老记录按分片映射补短名，再退到正文摘要。 */
export function dispatchTitle(d: Dispatch): string {
  const v = (d as unknown as Record<string, unknown>).title;
  const stored = typeof v === "string" ? v.trim() : "";
  if (stored) return stored;
  return shardTitle(d.shard) || summarizeTitle(d.action);
}

/** 结构指纹只用于 /api/tasks 的 rev 字段。 */
export function signature(root: string): string {
  /* 走统一入口取绝对路径：目录重排后运行态在 runtime/，台账在 ledger/，不再按相对名拼。 */
  const parts = [runtimeLoc.state(root), runtimeLoc.supervisor(root), inboxLoc.dispatch(root)];
  let s = "";
  for (const file of parts) {
    try {
      s += `${file}:${statCached(file)?.mtimeMs ?? "-"};`;
    } catch {
      s += `${file}:-;`;
    }
  }
  for (const w of listWorkers(root)) {
    s += `${w.id}:${w.status}:${w.heartbeat_ts};`;
  }
  return s;
}

export function ageSec(ts: unknown): number {  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return -1;
  return Math.max(0, Math.round(Date.now() / 1000 - n));
}

export const DIAGNOSE_LOG_BYTES = 4_000;

export function readTailText(file: string): string {
  return tailLines(file, DIAGNOSE_LOG_BYTES).join("\n");
}

/** 返回空串表示事件没有可读正文，调用方整条跳过。 */
/**
 * 台账里可能夹着原始输出的字段。
 *
 * 判定与重试理由由模型或子进程产出，容易把 stderr、PID、退出码、JSON 片段整段复制进来。
 * 界面只留能判断下一步的那一句：取首行、去掉明显的技术片段、超出上限截断。
 */
export function brief(value: unknown, max = 120): string {
  let t = String(value ?? "").split(/\r?\n/)[0] ?? "";
  t = t.replace(/\{[\s\S]*$/, "").replace(/\s+(PID|PPID|Stderr|Exit Code|rawResponse)\s*[=:][\s\S]*$/i, "");
  t = t.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}

/**
 * 事件的一句话说明。
 *
 * `customContract` 为 false 表示当前是引擎默认任务列表：阶段推进、跳步、门槛这些
 * 契约过程对用户没有含义，改成不带阶段号的陈述，或直接不上面板。
 * 缺省按 true 处理，历史记录与只读视图保持原样。
 */
export function describeEvent(
  e: Record<string, unknown>,
  opts: { customContract?: boolean } = {},
): string {
  const custom = opts.customContract !== false;
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
      /*
       * 不写阶段号：派单是分头交给各自的进程做，阶段号对读者与执行方都没有可执行含义，
       * 写出来只会被复述进申报（“S0 盘点：…”），读的人还得反查 S0 是什么。
       */
      return `派发任务 ${d}${shard ? `（${shard}）` : ""}：${String(e.action ?? "")}`;
    case "dispatch_done":
      return `回报完成 ${d}：${brief(e.note) || "（无说明）"}`;
    case "dispatch_failed":
      return `回报失败 ${d}：${brief(e.note) || "（无说明）"}`;
    case "dispatch_closed":
      return `手动结束 ${d}（原状态 ${zh.status(e.from) || "未知状态"}${e.worker ? "，执行中" : "，排队中"}${e.killed ? "，已中断" : ""}）：${String(e.reason ?? "")}`;
    case "dispatch_wake":
      return `消息唤醒 ${d}（原状态 ${zh.status(e.from) || "未知状态"}）`;
    case "dispatch_retry": {
      const attempt = Number(e.attempt) || 1;
      const failed = Number(e.previous_failures) || 0;
      return `重派任务 ${d}（第 ${attempt} 次${failed > 0 ? `，累计失败 ${failed} 次` : ""}）`;
    }
    case "dispatch_orphan":
      return `派单 ${d} 判定失败，重新派发（进程状态：${zh.status(e.worker_status) || "未知状态"}）`;
    case "worker_start": {
      const host = String(e.host ?? "");
      return `开始执行 ${d}${host ? `（${host}）` : ""}`;
    }
    case "worker_gone":
      return `执行进程${d ? `（${d}）` : ""} ${e.stale ? "心跳超时" : "已退出"}，回收`;
    case "worker_stopped":
      return `执行进程被用户中断${e.killed ? "（已发送终止信号）" : ""}${d ? `，${d} 按失败结束` : ""}`;
    case "worker_launch_failed":
      return `进程启动失败：${brief(e.error)}`;
    case "dispatch_superseded":
      return `派单 ${d} 作废：不属于当前编排`;
    case "dispatch_reaped":
      return `回收执行进程：${d} 已按失败结束，等待重派（退出码 ${String(e.exit_code ?? "?")}）`;
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
       * 记录：同一条消息出现两处回执，会使人误以为监工参与过这条对话。
       */
      return "";
    case "supervisor_advance": {
      const from = String(e.from ?? "");
      const to = String(e.to ?? "");
      /* 起止相同不是推进：界面出现 X -> X 只会使人误以为流程在推进。 */
      if (!from || !to || from === to) return "";
      if (!custom) return "进入下一步";
      return `阶段推进 ${from} 到 ${to}`;
    }
    case "supervisor_done":
      return custom ? `任务完成（${st}）` : "任务完成";
    case "hook_error":
      return `钩子异常：${String(e.error ?? "")}`;
    case "gate_eval": {
      const missing = Array.isArray(e.missing) ? e.missing.map((x) => String(x)) : [];
      /* 门槛评估是契约的判据，默认任务列表下没有可描述的契约过程，整条不上面板。 */
      if (!custom) return "";
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
      return `这条追加含 ${Number.isFinite(n) && n > 0 ? n : "几"} 张图，但没有归属，未带入派单：${String(e.text ?? "")}`;
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
      action: clipText(d.action, ACTION_PREVIEW_CHARS),
      worker: d.worker ?? "",
      note: clipText(d.note ?? "", NOTE_PREVIEW_CHARS),
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
  /* 默认任务列表下，阶段推进这类契约过程按中性说法上屏。 */
  const customContract = hasCustomContract(state?.contract);
  const feed: BoardEvent[] = readJsonlFromTail(ledgerLoc.events(root), 512_000)
    .filter((e) => FEED_EVENTS.has(String(e.event ?? e.kind ?? "")))
    .filter((e) => !(ledgerOnly && String(e.event ?? e.kind ?? "") === "supervisor_done"))
    .slice(-FEED_LIMIT)
    .reverse()
    .map((e) => ({
      at: String(e.at ?? ""),
      event: String(e.event ?? e.kind ?? ""),
      text: clipText(describeEvent(e, { customContract }), FEED_TEXT_CHARS),
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
    ...stageViewOf(
      String(state?.contract ?? ""),
      String(state?.stage ?? ""),
      stage?.name ?? "",
      stageIndex,
      contract ? contract.stages.length : 0,
    ),
    target: state?.target ?? "",
    contract: state?.contract ?? "",
    next_action: state?.next_action ?? "",
    stage_goal: stage?.goal ?? "",
    /* 门槛属于契约过程，默认任务列表下不对外给出。 */
    gate: hasCustomContract(state?.contract) ? gate : [],
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
      blockerReasons: Array.isArray(state?.blockers)
        ? state?.blockers.map((b) => String((b as { reason?: unknown }).reason ?? ""))
        : [],
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
           * 故先按 id 查，再按 worker key 查；都查不到时留空，前端改用 id 显示。
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
  const customContract = hasCustomContract(loadState(root)?.contract);
  return readJsonlFromTail(eventsFile(root), 512_000)
    .filter((e) => FEED_EVENTS.has(String(e.event ?? e.kind ?? "")))
    .filter((e) => !(ledgerOnly && String(e.event ?? e.kind ?? "") === "supervisor_done"))
    .slice(-n)
    .reverse()
    .map((e) => ({
      at: String(e.at ?? ""),
      event: String(e.event ?? e.kind ?? ""),
      text: clipText(describeEvent(e, { customContract }), FEED_TEXT_CHARS),
    }));
}

export function rootFromUrl(url: string, fallback: string): string {
  const q = url.indexOf("?");
  if (q < 0) return fallback;
  const want = new URLSearchParams(url.slice(q + 1)).get("root");
  if (!want) return fallback;
  const abs = resolve(want);
  return listTaskRoots(fallback).includes(abs) ? abs : fallback;
}

export function contractDirs(root: string): string[] {
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

export function ledgerOnlyRoot(root: string): boolean {
  const state = loadState(root);
  const contract = state?.contract ? loadContract(String(state.contract), contractDirs(root)) : null;
  return !!contract && contract.stages.length <= 1;
}

/**
 * 对外的阶段读数。默认任务列表下全部置空：阶段号会让读者反查“S0 是什么”，
 * 而一张单落在哪一步不影响用户要看的结果。两处快照共用这一处口径。
 */
export function stageViewOf(
  contractName: string,
  stageId: string,
  stageName: string,
  stageIndex: number,
  stageTotal: number,
): { stage: string; stage_name: string; stage_index: number; stage_total: number } {
  if (!hasCustomContract(contractName)) {
    return { stage: "", stage_name: "", stage_index: -1, stage_total: 0 };
  }
  return { stage: stageId, stage_name: stageName, stage_index: stageIndex, stage_total: stageTotal };
}

export interface DiagnoseInput {
  hasState: boolean;
  supervisor: ReturnType<typeof loadSupervisor>;
  alive: boolean;
  workers: BoardWorker[];
  dispatches: BoardDispatch[];
  blockers: number;
  /** 阻塞原因，与终端状态行同源；只用于把“阻塞在哪”写清楚。 */
  blockerReasons?: string[];
  hasActive: boolean;
  lastLogTail: string;
}

export function diagnose(i: DiagnoseInput): BoardDiagnosis {
  if (!i.hasState) {
    return {
      level: "bad",
      title: "当前目录没有任务根",
      detail: "看板读不到 .capitalist/runtime/state.json。",
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
        `最后一次心跳 ${ageSec(i.supervisor.heartbeat_ts)} 秒前，进程已不运行。` +
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
        detail: `工作进程 ${last.id} 因缺少登录态退出。`,
        fix: "在宿主 CLI 里登录后再派单。",
      };
    }
    if (/session ended/i.test(log)) {
      return {
        level: "bad",
        title: "宿主会话一建立就结束",
        detail: `工作进程 ${last.id}（${last.host}）建立会话后立即结束，通常是该宿主没有可用模型或凭据。`,
        fix: "先在同机用该宿主的非交互入口执行一次验证，确认它能独立完成一轮",
      };
    }
    if (body === "") {
      return {
        level: "bad",
        title: "工作进程零输出退出",
        detail: `工作进程 ${last.id}（${last.host}）只写了启动日志就结束，没有报错也没有回答。`,
        fix: "手动跑一次该宿主的 -p 入口并加超时，确认是认证、模型名还是端口占用",
      };
    }
    return {
      level: "warn",
      title: `最近一个工作进程状态为 ${last.status}`,
      detail: `${last.id}（${last.host}）退出，退出码 ${last.note || "未知"}。`,
      fix: "展开该工作进程的日志，查看最后几十行",
    };
  }

  if (i.blockers > 0) {
    /* 与终端状态行同口径：同类阻塞合并计数，写明有几条、阻塞在哪。 */
    const counts = new Map<string, number>();
    for (const x of i.blockerReasons ?? []) {
      const key = String(x ?? "").trim() || "未写原因";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const items = [...counts.entries()]
      .slice(0, 2)
      .map(([reason, n]) => `${reason} ${n} 条`)
      .join("、");
    return {
      level: "warn",
      title: `${i.blockers} 条阻塞未解除，监工暂不派新单`,
      detail: items || "执行侧登记了阻塞，没有写原因。",
      fix: "capitalist unblock --all 解除全部，或按类型逐条解除",
    };
  }

  if (i.supervisor.max_workers === 0) {
    return {
      level: "warn",
      title: "监工不自动启动工作进程",
      detail: "以 --no-spawn 运行：只派单，由另一个会话执行 capitalist next 接收。",
      fix: "另开一个会话执行 capitalist next，完成后执行 capitalist report <派单id> done",
    };
  }

  if (live.length > 0) {
    return {
      level: "ok",
      title: `${live.length} 个工作进程运行中`,
      detail: `宿主 ${i.supervisor.worker_host}，最多 ${i.supervisor.max_workers} 个工作进程。`,
      fix: "",
    };
  }

  return {
    level: "ok",
    title: "监工在线，当前空闲",
    detail: i.hasActive ? "有一张单在途，等工作进程领取。" : "等待下一次派单。",
    fix: "",
  };
}
