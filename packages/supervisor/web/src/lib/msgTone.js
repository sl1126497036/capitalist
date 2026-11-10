/**
 * 颜色分级只按结构化字段（event / status / ok / role）判定，不按正文措辞。
 * 红为确定失败，琥珀为待确认或未达标，中性为过程；判死重派、重派、回收归中性。
 */

/** 台账与消息的事件名集合，覆盖 `event` 与 `status` 两个来源字段。 */
const EVT_NAMES = new Set([
  "dispatch_open",
  "dispatch_done",
  "dispatch_failed",
  "dispatch_orphan",
  "dispatch_retry",
  "dispatch_reaped",
  "dispatch_superseded",
  "worker_start",
  "worker_gone",
  "worker_stopped",
  "worker_killed",
  "worker_reaped",
  "worker_launch_failed",
  "gate_eval",
  "supervisor_advance",
  "supervisor_done",
  "stage_skipped",
  "stage_fallback",
  "stage_stalled",
  "contract_reload",
  "contract_change",
  "contract_error",
  "contract_refused",
  "board_serve",
  "board_reload",
  "redispatch_capped",
  "debt_settled",
  "model_fallback",
  "supervisor_cmd",
  "supervisor_answer",
  "supervisor_chat_ask",
  "supervisor_reply",
  "tick_window",
  "takeover",
  "release",
  "direct_inject",
  "hook_error",
  "tool",
]);

/** 确定失败（红）；`tick_window` 心跳稀疏表示监工可能已停，亦归入此档。 */
const FAIL_EVENTS = new Set([
  "dispatch_failed", // 派单回报失败
  "worker_launch_failed", // 进程启动失败
  "contract_error", // 契约解析失败，沿用上一份
  "tick_window", // 心跳稀疏，监工可能受阻
]);

/** 待确认（琥珀）。第二列为块头标签文案，用「待确认 / 未达标 / 记欠账」，不写「错误」。 */
const PENDING_NOTE = new Map([
  ["redispatch_capped", "待确认"], // 重派达到上限，等待裁决
  ["stage_skipped", "记欠账"], // 跳过阶段，进度推进但该阶段未达标
  ["stage_fallback", "记欠账"],
  ["contract_refused", "待确认"], // 契约被拒，沿用上一份
]);

/** 事件名来源：监工流写 `event`，工作进程裁定块写 `status`。 */
function msgEvent(m) {
  const e = String(m?.event || "");
  if (e) return e;
  const s = String(m?.status || "");
  return EVT_NAMES.has(s) ? s : "";
}

/**
 * 返回 `{ tone, note }`：tone 为 ""、"warn"、"bad"，note 为块头标签文案。
 * 工作进程输出正文一律中性，进程失败由底部状态条与派单失败块呈现。
 */
export function toneOf(m) {
  if (!m) return { tone: "", note: "" };
  const role = String(m.role || "");

  /* 过程日志（tier=log）不参与分级；tier 由服务端判定，本模块只认结果。 */
  if (m.tier === "log") return { tone: "", note: "" };

  /* 用户消息的气泡自带配色，不参与失败分级。 */
  if (role === "user") return { tone: "", note: "" };

  const kind = String(m.kind || "");
  const evt = msgEvent(m);
  const status = String(m.status || "");

  /* 工作进程输出、思考与工具调用的正文不判为失败。 */
  if (role === "worker") return { tone: "", note: "" };

  /* 派单仅在 status 为 failed 时判红，其余状态为过程。 */
  if (kind === "dispatch") {
    return status === "failed" ? { tone: "bad", note: "" } : { tone: "", note: "" };
  }

  if (FAIL_EVENTS.has(evt)) return { tone: "bad", note: "" };

  /* 指令被拒（ok=false）为确定失败。 */
  if (evt === "supervisor_cmd" && m.ok === false) return { tone: "bad", note: "" };

  /* 门槛评估未达标（ok=false）归琥珀，标签写「未达标」。 */
  if (evt === "gate_eval") {
    return m.ok === false ? { tone: "warn", note: "未达标" } : { tone: "", note: "" };
  }

  const note = PENDING_NOTE.get(evt);
  if (note) return { tone: "warn", note };

  return { tone: "", note: "" };
}
