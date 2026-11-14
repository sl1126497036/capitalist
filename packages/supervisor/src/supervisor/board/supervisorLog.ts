import { readDispatches } from "../../core/supervisor";
import { readTasks, taskSummary as poolSummary, type TaskSummary as TaskPoolSummary } from "../../core/tasks";
import { unhandledFromEvents } from "../chatSettle";
import { listSupervisorDirectives, SupervisorDirective } from "../direct";
import { stripDispatchEcho, supervisorReplyView } from "../msgView";
import { shardTitle } from "../taskTitle";
import { dispatchNoTable } from "../threadNo";
import { readJsonlFromTail } from "./logs";
import { MQ_KIND_LABEL, fingerprint, maskDispatchIds } from "./render";
import { ThreadRole, ThreadMessage, describeEvent, ledgerOnlyRoot } from "./snapshot";
import { atTs, attachmentsOf, eventsFile, readDispatchesBoard } from "./sources";
import { taskKeyOf } from "./state";

import { zh } from "./zh";
import { statSync } from "node:fs";

/**
 * 监工日志视图：把监工自己的事件流整理成前端可读的时间线。
 *
 * 与线程消息流不同源：这里读的是监工通道日志，不掺工作进程输出。
 */
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

export function poolSummaryForMetrics(root: string): TaskPoolSummary {
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

/** 写操作后清空日志视图缓存，让下一次读取立刻看到新事件。 */
export function clearSupervisorLogCache(): void {
  supervisorLogCache = null;
}
