/**
 * 监工消息术语表：服务端与看板前端共用本文件的常量，不在别处另写一份。
 *
 * 未知事件、指令、状态回落到“其他事件”/“其他指令”/“未知状态”，不回落到英文枚举。
 */

/** 事件名 -> 标签；分类标签与消息正文共用。 */
export const EVENT_ZH: Readonly<Record<string, string>> = Object.freeze({
  dispatch_open: "派发任务",
  dispatch_done: "任务完成",
  dispatch_failed: "任务失败",
  dispatch_closed: "手动结项",
  dispatch_wake: "消息唤醒",
  dispatch_orphan: "判死重派",
  dispatch_retry: "重派任务",
  dispatch_reaped: "回收进程",
  dispatch_superseded: "任务作废",
  dispatch_forced_finished: "超时结单",
  worker_start: "启动进程",
  worker_stopped: "中断进程",
  worker_gone: "进程退出",
  worker_killed: "中断进程",
  worker_looping_killed: "循环中断",
  worker_heartbeat_rescued: "心跳恢复",
  worker_reaped: "回收进程",
  worker_launch_failed: "进程启动失败",
  gate_eval: "门槛评估",
  supervisor_advance: "阶段推进",
  supervisor_done: "收工",
  stage_skipped: "跳过阶段",
  stage_fallback: "跳过阶段",
  stage_stalled: "阶段停滞",
  contract_reload: "任务列表热加载",
  contract_change: "任务列表变更",
  contract_error: "任务列表解析失败",
  contract_refused: "任务列表被拒",
  board_serve: "看板启动",
  board_reload: "看板重启",
  redispatch_capped: "重派达到上限",
  retry_held: "暂不重派",
  debt_settled: "欠账清算",
  model_fallback: "模型回退",
  supervisor_cmd: "指令回执",
  supervisor_answer: "回答",
  supervisor_chat_ask: "用户发言",
  supervisor_reply: "监工回话",
  /* 上下文压缩：重载（source=reload）与读数推断（source=inferred）共用同一标签。 */
  context_compacted: "已压缩",
  /* 任务根的会话记录缺失：判定为新的生命周期，换新会话。 */
  chat_session_new: "新建会话",
  mq_message: "申报",
  mq_triage: "申报回执",
  takeover: "人工接管",
  release: "交还监工",
  direct_inject: "插话登记",
  hook_error: "钩子异常",
  tool: "工具调用",
  supervisor_tick: "心跳",
  tick_window: "心跳稀疏",
  tree_rebuilt: "重建派单树",
});

/** 未知事件的回落标签，不回落到原始事件名。 */
export const EVENT_ZH_FALLBACK = "其他事件";

/** 调度指令动作 -> 界面上的中文名。 */
export const CMD_ZH: Readonly<Record<string, string>> = Object.freeze({
  pause: "暂停调度",
  resume: "恢复调度",
  "set-next": "设定下一步",
  dispatch: "已派单",
  diagnose: "诊断",
  fix: "修复",
  reload: "重载任务列表",
  concurrency: "调整并行度",
  retry: "重派任务",
  skip: "跳过阶段",
  ask: "提问",
  instruct: "自然语言调度",
  say: "留言",
  direct: "插话",
  takeover: "人工接管",
  release: "交还监工",
  promote: "立即执行",
  close: "结项",
  "stop-worker": "中断进程",
  answer: "回答提问",
  block: "登记阻塞",
  unblock: "解除阻塞",
  "stop-supervisor": "停止监工",
});

/** 未知指令的回落名。 */
export const CMD_ZH_FALLBACK = "其他指令";

/** 台账状态 -> 中文；消息引用状态时不用原始枚举。 */
export const STATUS_ZH: Readonly<Record<string, string>> = Object.freeze({
  open: "待执行",
  queued: "排队",
  claimed: "已领取",
  starting: "启动中",
  running: "运行中",
  done: "已完成",
  failed: "失败",
  closed: "已结项",
  orphan: "孤儿",
  missing: "缺失",
  gone: "已退出",
  exited: "已退出",
  finished: "已完成",
  paused: "已暂停",
  held: "接管中",
});

/** 未知状态的回落词。 */
export const STATUS_ZH_FALLBACK = "未知状态";

/** 任务列表被拒的原因 -> 中文。 */
export const CONTRACT_KIND_ZH: Readonly<Record<string, string>> = Object.freeze({
  requirement_violation: "需求层被删除或降低标准",
});

/** 语言无关的技术词：只在正文里出现时统一替换，不改变字段与标识符本身。 */
export const WORD_ZH: Readonly<Record<string, string>> = Object.freeze({
  worker: "进程",
  spawn: "拉起",
  exit: "退出",
  pid: "进程号",
  hook: "钩子",
  SIGTERM: "终止信号",
});

/** 事件名 -> 中文标签；未知回落到“其他事件”。 */
export function zhEvent(name: unknown): string {
  const key = String(name ?? "");
  return EVENT_ZH[key] ?? EVENT_ZH_FALLBACK;
}

/** 指令动作 -> 中文名；未知回落到“其他指令”。 */
export function zhCommand(action: unknown): string {
  const key = String(action ?? "");
  return CMD_ZH[key] ?? CMD_ZH_FALLBACK;
}

/** dispatch 带 `urgent` 时显示“插队派单”，其余显示“已派单”；只认调用方传入的标记，不做推断。 */
export function zhCommandLabel(action: unknown, urgent?: unknown): string {
  if (String(action ?? "") === "dispatch") return urgent === true ? "插队派单" : "已派单";
  return zhCommand(action);
}

/** 台账状态 -> 中文；空值回空串，未知值回落到“未知状态”。 */
export function zhStatus(status: unknown): string {
  const key = String(status ?? "");
  if (!key) return "";
  return STATUS_ZH[key] ?? STATUS_ZH_FALLBACK;
}

/** 契约拒绝原因 -> 中文；未知原因原样保留。 */
export function zhContractKind(kind: unknown): string {
  const key = String(kind ?? "");
  if (!key) return "";
  return CONTRACT_KIND_ZH[key] ?? key;
}
