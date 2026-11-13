/**
 * 看板的中/英文案层。中文原文作键，EN 表只写译文，缺译时回流中文原文。
 * 语言判定优先级：显式选择（localStorage）-> navigator.languages 首选项（zh 前缀为中文，其余为英文）-> 中文。
 * 数据不翻译：派单标题与正文、监工复盘文字、模型与进程名；单位按界面语言替换，token 保留原词。
 */
import {ref} from "vue";

/** 手动切换的落盘键：只存用户显式选过的语言，没存过就按系统语言判定。 */
const LANG_KEY = "cap.board.lang";

/** 读用户显式选过的语言；没选过 / 存储不可用（隐私模式）返回空。 */
function storedLang() {
  try {
    const v = String(localStorage.getItem(LANG_KEY) || "").trim().toLowerCase();
    return v === "en" || v === "zh" ? v : "";
  } catch {
    return "";
  }
}

/**
 * 系统 / 浏览器语言取 navigator.languages 首选项：zh 前缀判为中文，其余为英文；
 * 读不到返回空，由调用方回落中文。不细分地区。
 */
function systemLang() {
  try {
    const list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
    const first = String(list[0] || "").trim().toLowerCase();
    if (!first) return "";
    return /^zh/.test(first) ? "zh" : "en";
  } catch {
    return "";
  }
}

/** 初始语言：显式选择优先，否则按系统 / 浏览器语言判定，都读不到时回落中文。 */
function readLang() {
  return storedLang() || systemLang() || "zh";
}

/** 中文原文 -> 英文。缺的条目直接回流中文。 */
const EN = {
  /* ---- 顶栏 ---- */
  "监工在线 {n} 个进程运行中": "Supervisor online {n} processes running",
  "{n} 个进程运行中": "{n} processes running",
  "监工不在线": "Supervisor offline",
  /* 顶栏状态为机器上有无监工的总控口径，不指单个掉线。 */
  "无监工在线": "No supervisor online",
  /* 离线状态提示。 */
  "监工未启动": "Supervisor not started",
  "监工心跳失联": "Supervisor heartbeat lost",
  "上一轮已结束": "Previous run finished",
  "看板连接失败": "Board connection failed",
  "正在连接看板…": "Connecting to the board…",
  "没有消息": "No messages",
  "暂停调度": "Pause",
  "恢复调度": "Resume",
  /* 点击到请求返回之间的加载态文案。 */
  "停止中…": "Stopping…",
  "恢复中…": "Resuming…",
  "已暂停": "Paused",
  /* 暂停单的唤醒动作：两次点击确认，回执说明下一轮才参与调度。 */
  "唤醒": "Wake",
  "确认唤醒": "Confirm wake",
  "取消唤醒": "Cancel wake",
  "解除暂停，按队列顺序重新参与调度": "Lifting the pause returns the task to the queue in order",
  "已唤醒": "Woken",
  "唤醒失败": "Wake failed",
  /* 模型切换为异步请求，期间显示加载态回执。 */
  "切换中…": "Switching…",
  "已连接": "Connected",
  "在线": "Online",
  "降级 轮询": "Degraded polling",
  "连接失败（第 {n} 次）": "Disconnected (attempt {n})",
  "连接中…": "Connecting…",
  "已暂停调度": "Dispatch paused",
  "已恢复调度": "Dispatch resumed",
  "账号 {a}": "Account {a}",
  "账号信息不可用": "Account info unavailable",
  "有效期未知": "expiry unknown",
  "无昵称": "no nickname",
  "暂停后不再派新单；运行中进程停止，派单退回排队，恢复后按原序重派": "Pausing stops new dispatches; running processes are stopped and their dispatches return to the queue. Dispatch resumes in the original order.",
  "切换界面语言": "Switch UI language",
  "关于": "About",
  "在 GitHub 上查看源码": "View source on GitHub",
  "工作树": "Work tree",
  "取消": "Cancel",
  "重启": "Restart",
  "监工对话模型": "Supervisor chat model",
  "监工对话模型：{m}": "Supervisor chat model: {m}",
  "宿主默认": "Host default",
  "操作未生效：{m}": "Action did not take effect: {m}",
  "宿主模型读取中…": "Loading host models…",
  "默认": "Default",
  "配色": "Theme",
  "界面配色": "UI theme",
  "当前": "current",
  "界面语言": "UI language",

  /* ---- 指标卡：任务 ---- */
  "任务调度": "Task dispatch",
  "全部监工合计": "All supervisors",
  "总调度": "Dispatched",
  "执行中": "Running",
  "异常": "Failed",
  "排队": "Queued",
  "排队中": "Queued",
  "已验收": "Accepted",
  "并行": "Parallel",
  "已派出、还未领取的派单数": "Dispatched but not yet claimed",
  "未取得并行度": "Parallelism unavailable",

  /* ---- 指标卡：资源 ---- */
  "资源占用": "Resources",
  "本机": "This host",
  "内存": "Memory",
  "积分消耗": "Credits used",
  "剩余积分": "Credits left",
  "未回收进程": "Unreaped",
  "待回收进程": "Unreclaimed",
  /* 文件写锁：仅在文件被占用时出现。 */
  "文件锁": "File locks",
  "未接入采样源": "No sampler wired",
  "未接入用量来源": "No usage source wired",
  "已消耗积分": "Credits consumed",
  "实时": "Live",
  "未连接": "No data",
  "刷新于 {t}": "Refreshed {t}",
  "刷新时间不可用": "Refresh time unavailable",
  /* ---- 资源采样 ---- */
  "采样不可用": "no sample",
  "读取不可用": "unavailable",
  "处理器采样不可用：{why}": "CPU sampling unavailable: {why}",

  /* ---- 监工条 ---- */
  "监工实例": "Supervisor instances",
  "没有监工实例": "No supervisor instances",
  "监工": "Supervisor",
  "监工 {n}": "Supervisor {n}",
  "运行中": "Running",
  "已完成": "Done",
  "暂停中": "Paused",
  "重载中": "Reloading",
  "监工重载中": "Supervisor reloading",
  /* 上下文压缩：气泡“压缩中”与消息卡标签“已压缩”共用这一组词。 */
  "压缩中": "Compacting",
  "已压缩": "Compacted",
  "空闲": "Idle",
  "待裁决": "Needs decision",
  "指令已登记，下一轮调度生效": "Command recorded; takes effect on the next scheduling round",
  "模型已切换": "Model switched",
  "已派出、还未领取的派单数（与左栏“排队”同一份统计）":
    "Dispatched but not yet claimed (same count as “Queued” in the left column)",
  "失败、丢失、孤立或已消失的线程数（与左栏“异常”同一份统计）":
    "Threads that failed, were lost, orphaned or vanished (same count as “Failed” in the left column)",
  "验收通过的项数": "Items accepted",
  "上行": "Input",
  "当前任务全部工作进程的累计输入用量": "Cumulative input usage of all work processes in this task",
  "下行": "Output",
  "当前任务全部工作进程的累计输出用量": "Cumulative output usage of all work processes in this task",
  "整机处理器占用率，与活动监视器口径一致": "Host CPU usage, same reading as Activity Monitor",
  "整机内存压力：100% 减去可用内存占比（memory_pressure）":
    "Host memory pressure: 100% minus the free memory percentage (memory_pressure)",
  "内存压力读取不可用：{why}": "Memory pressure unavailable: {why}",
  "来源：{s}": "Source: {s}",
  "账号级额度，全部监工共用": "Account-level quota, shared by every supervisor",
  "没有文件被锁": "No file is locked",
  "写锁": "write lock",
  "读锁": "read lock",
  "{n} 秒前有心跳": "heartbeat {n}s ago",
  "无心跳": "no heartbeat",
  "无响应": "Not responding",
  "卡点": "Blocked",
  "第 {n} 次指导": "guidance #{n}",
  "已写入，等待工作进程领取": "Written to the delivery channel, waiting for the worker",
  "已送达": "Delivered",
  "送达失败": "Delivery failed",
  "人工介入": "Take over",
  "无待回收进程。仅统计本项目拉起的进程。": "No unreclaimed processes. Only processes started by this project are counted.",
  "起于 {t}": "started {t}",
  "未知": "unknown",
  "总任务": "Tasks",
  "当前任务总数（全部监工合计，等于各状态之和）":
    "Total tasks (all supervisors combined; equals the sum of every state)",
  "运行": "Running",
  "当前处于运行中的任务数（与左栏“运行”同一份统计）":
    "Tasks currently running (same count as “Running” in the left column)",
  "当前排队中的任务数（与左栏“排队”同一份统计）":
    "Tasks currently queued (same count as “Queued” in the left column)",
  "当前异常任务数（与左栏“异常”同一份统计）":
    "Tasks currently failed (same count as “Failed” in the left column)",
  "完成": "Done",
  "当前已完成的任务数（与左栏“已完成”同一份统计）":
    "Tasks finished (same count as “Done” in the left column)",
  "处理器": "CPU",
  "已用": "Used",
  "剩余": "Left",
  "累计": "Total",
  "本轮消耗": "This run",
  "本轮全部工作进程的用量合计": "Total usage of all work processes in this round",

  /* ---- 任务队列（左栏）---- */
  "{name}-监工": "{name} supervisor",
  "全部": "All",
  "启动": "started",
  "启动 未记录": "start time not recorded",
  "关闭": "Close",
  "已取消": "Canceled",
  "已让位": "Yielded",
  "暂不重派": "No retry",
  "接管中": "Taken over",
  "待调度": "Pending",
  "心跳超时": "Heartbeat lost",
  "已停": "Stopped",
  "运行中 {n}": "{n} running",
  "排队 {n}": "{n} queued",
  "累计 {v}": "{v} total",
  "累计 未上报": "total not reported",
  "无采样": "no sample",
  "进行中": "In progress",
  "{n} 进行中": "{n} in progress",
  "未上报": "not reported",
  "模型": "Model",
  "等待 #{no}": "Waiting on #{no}",
  "默认模型 {m}": "Default model {m}",
  "将清空 {n} 项：进程记录与派单移进归档目录，列表里不再出现。":
    "About to clear {n} items: process records and dispatches move to the archive and disappear from this list.",
  "运行中的进程不会结束，完成后会重新出现在列表。":
    "Running processes are not terminated; they reappear in the list once finished.",
  "这 {n} 个进程不会结束，记录移出列表，完成后会重新出现。":
    "These {n} processes are not terminated; their records leave the list and reappear once finished.",
  "这 {n} 张排队中的派单会从队列撤下，监工不再派发。":
    "These {n} queued dispatches are withdrawn and will not be handed out again.",
  "这些进程的日志将移至归档目录。": "The logs of these processes will be moved to the archive.",
  "从队列撤下，监工不再派发": "Withdrawn from the queue; no longer dispatched",
  "结项并停止重派，运行中进程先结束":
    "Settled, no longer redispatched; a running process ends first",
  "：{why}": ": {why}",
  "调度于 {t}": "Dispatched at {t}",
  "输入 {a} + 输出 {b}；缓存命中 {c} 单列，不计入总量":
    "Input {a} + output {b}; cache hits {c} listed separately and excluded from the total",
  "金额取自日志 result 行的 total_cost_usd": "Amount taken from total_cost_usd on the log's result line",
  "这条读数有 usage 但没有 token 字段": "This reading has usage but no token fields",
  /* fast-model 别名的旁注：它在两个 flash 模型间轮换，名字本身按原 id 展示。 */
  "轮换": "rotation",

  /* ---- 会话区 / 工作树 / 全局提示 ---- */
  " {n} 条未读": " {n} unread",
  "{n} 个子单": "Sub-tasks: {n}",
  "{n} 个已完成": "Done: {n}",
  "{n} 个节点": "Nodes: {n}",
  "{n} 个落在断链子树": "In blocked sub-trees: {n}",
  "{n} 失败": "Failed: {n}",
  "{n} 待验收": "Awaiting review: {n}",
  "{n} 排队": "Queued: {n}",
  "{n} 条消息 最近 {t}": "Messages: {n} latest {t}",
  "{n} 棵树": "Trees: {n}",
  "{n} 等父节点": "Waiting on parent: {n}",
  "{n} token": "{n} tokens",
  "上下文": "Context",
  "上下文 {v}": "Context {v}",
  "超限": "over limit",
  "已用超过生效上限，按上限显示": "used exceeds the effective limit; shown at the limit",
  "按消息文本估算": "Estimated from message text",
  "上传中断 连接已断开，点击“重试”重新上传":
    "Upload interrupted connection lost; click Retry to upload again",
  "从上方监工条选择一个任务根": "Pick a task root from the supervisor bar above",
  "从左侧选择一个进程": "Pick a process from the left column",
  "全部完成": "all done",
  "卡在 #{id}": "Stuck on #{id}",
  "原消息不在当前窗口内 待确认": "Original message is outside this window awaiting confirmation",
  "受 #{id} 断链影响": "Affected by the broken chain at #{id}",
  "台账未记录": "not recorded in the ledger",
  "运行中": "Running",
  "复制失败": "Copy failed",
  "失败": "Failed",
  "失败原因：{why}": "Failure reason: {why}",
  /* 重启蒙版副标题。 */
  "重启中…": "Restarting…",
  "重启期间界面暂停，完成后自动恢复调度。未恢复时，重新执行 capitalist supervise。":
    "The UI is paused while the supervisor restarts; scheduling resumes automatically when it finishes. If it does not resume, run capitalist supervise again.",
  "尚未选择任务根": "No task root selected",
  /* ---- 离线面板 ---- */
  /* 离线状态：未启动、心跳失联、看板连接失败。 */
  "派单与查看消息需先启动监工。": "Dispatching and reading messages require a running supervisor.",
  "心跳已 {n} 秒未更新，进程可能已退出。重新启动监工后可继续。":
    "No heartbeat for {n} seconds; the process may have exited. Restarting the supervisor resumes operation.",
  "接口未响应，页面读数可能已过期。":
    "The API is not responding; readings on screen may be out of date.",
  "上一轮任务已结束。继续任务需重新启动监工。":
    "The previous run has finished. Continuing requires a supervisor restart.",
  "复制命令": "Copy command",
  "该命令需在任务目录执行；监工启动后页面自动连接。":
    "The command must run in the task directory; the page reconnects once the supervisor starts.",
  /* ---- 动作状态词 ---- */
  "执行回执": "Report receipt",
  "运行测试": "Running tests",
  "构建": "Building",
  "执行命令": "Running command",
  "正在生成回复": "Generating reply",
  "等待外部结果": "Waiting for external result",
  "回执中": "Acknowledging report",
  "监管中": "Supervising",
  "工作进程": "Worker",
  "已关": "Closed",
  "已复制": "Copied",
  "已执行": "Executed",
  /* 执行回执整句带任务编号。 */
  "已执行 #{no}": "Executed #{no}",
  "已结束": "Finished",
  /* 监工介入状态气泡只报状态本身，按当前进展分三段推进。 */
  "介入中": "Involving",
  "已介入": "Involved",
  /* habit 指用户习惯与运行环境等既有事实。 */
  "习惯 / 环境": "Habits / environment",
  "待验收": "Awaiting review",
  /* 消息块头的小标签（msgTone.js 的 PENDING_NOTE）：结论未落定。 */
  "待确认": "Pending",
  "记欠账": "Outstanding",
  "未达标": "Not met",
  "成环 无可达根节点": "Cycle no reachable root",
  "截图": "screenshot",
  "给监工派单或发送消息": "Dispatch or message the supervisor",
  "给执行中的进程发消息 会在下一个动作间隙收到，不打断当前执行":
    "Message the running process it arrives at the next action gap; current work is not interrupted",
  "描述要修改的内容": "Describe what to change",
  "描述要修改的内容 执行中的进程会在下一个动作间隙收到，不打断当前执行":
    "Describe what to change the running process receives it at the next action gap; current work is not interrupted",
  "断链": "Broken chain",
  "断链 其下子树无法推进": "Broken chain its sub-tree cannot proceed",
  "无读数": "no reading",
  "实际调用 {m}": "actually calls {m}",
  "日志没有上下文读数": "the log has no context reading",
  "日志里没有原因": "no reason in the log",
  "暂无监工记录": "No supervisor records yet",
  "未完成：{list}": "Unfinished: {list}",
  "未开始": "not started",
  "未记录": "not recorded",
  "模型未记录": "model not recorded",
  "正文不能为空": "Content cannot be empty",
  "没有上下文读数": "No context reading",
  "没有可发送的进程 请先在左栏选择": "No process to send to pick one in the left column first",
  "派单与日志都没有模型字段": "No model field in the dispatch or the log",
  "派单模型": "Dispatch model",
  "消耗": "Cost",
  "消耗 {v}": "Cost {v}",
  "消耗 未上报": "cost not reported",
  "用户习惯": "User habits",
  "看这几张图": "See these images",
  "等待下一轮调度": "waiting for the next dispatch",
  "等父节点": "Waiting on parent",
  "耗时": "Duration",
  "被拒": "Rejected",
  "输入": "Input",
  "输出": "Output",
  "还差 {list}": "{list}",
  "这一单在排队 此时发送的内容会并入这一单，启动时一并带入":
    "This task is queued what is sent now is merged into it and carried in at start",
  "派单已结束，消息在原会话中回复":
    "Dispatch finished; messages are answered in the original session",
  "排队中的派单不计耗时": "Queued dispatches have no duration",
  "本轮进程已退出，等待下一轮派发（{why}）":
    "This round's process exited; waiting for the next dispatch ({why})",
  "这个进程尚无消息": "This process has no messages yet",
  "本阶段分片均已完成": "all shards in this stage are complete",
  "进程异常 {why}": "Process failed {why}",
  "重派 {n} 次": "redispatched {n} times",
  "附件": "attachment",

  /* ---- 会话区控件与对话框 ---- */
  "Enter 发送": "Enter to send",
  "Shift + Enter 换行": "Shift + Enter for a new line",
  "{n} 个断链": "Broken: {n}",
  "{n} 张上传失败": "{n} uploads failed",
  "{n} 条": "{n} items",
  "{n} 条新消息": "New messages: {n}",
  "一条对当前任务有用的记忆：用户习惯、运行环境、项目约定、卡点等":
    "A memory useful to the current task: user habits, runtime environment, project conventions, blockers",
  "上一张": "Previous (←)",
  "上下文 未上报": "context not reported",
  "上传中，完成后可发送": "Uploading; send once it finishes",
  "下一张": "Next (->)",
  "个旧任务": "old tasks",
  "个旧任务（结束超过 3 小时）": "old tasks (finished over 3 hours ago)",
  "中断": "Interrupt",
  "中断后这一单会被重派，除非同时登记阻塞。":
    "Interrupting redispatches this task unless a blocker is recorded at the same time.",
  "中断这一单？": "Interrupt this task?",
  "交还监工": "Hand back to supervisor",
  "任务列表已折叠": "Task list collapsed",
  "任务引用详情": "Task reference",
  "任务队列": "Task queue",
  "任务队列宽度": "Task queue width",
  "保存": "Save",
  "停止调度": "Stop dispatch",
  "全局读数": "Global readings",
  "关": "Off",
  "关停": "Shut down",
  "关闭工作树看板": "Close the work tree",
  "关闭预览（Esc）": "Close preview (Esc)",
  "删除": "Delete",
  "刷新": "Refresh",
  "功能提示": "Feature tip",
  "单号": "Dispatch",
  "历史重派": "Redispatch history",
  "发送": "Send",
  "取消关闭": "Cancel closing",
  "取消引用": "Remove quote",
  "取消立即执行": "Cancel run-now",
  "没有派单记录": "No dispatch records",
  "读取失败：{e}": "Failed to read: {e}",
  "同时登记阻塞（不重派，等外部条件解决后手动解除）":
    "Also record a blocker (no redispatch until it is cleared manually)",
  "图片/路径": "Image / path",
  "图片上传中，完成后可发送": "Uploading the image; send once it finishes",
  "图片加载失败": "Image failed to load",
  "复制引擎调试全文": "Copy the full engine debug output",
  "复制这一段": "Copy this passage",
  "复制这条": "Copy this message",
  "失败节点带“断链”标记，其下整棵子树降亮并注明受影响的单号":
    "Failed nodes carry a “broken chain” mark; their whole sub-tree is dimmed and the affected task numbers are noted",
  "对话层": "Chat layer",
  "对话模型": "Chat model",
  "展开": "Expand",
  "展开历史重派": "Expand redispatch history",
  "展开更早的消息": "Load earlier messages",
  "展开任务队列": "Expand the task queue",
  "展开辅助面板": "Expand the auxiliary panel",
  "工作树看板": "Work tree",
  "工作进程面板": "Worker panel",
  "工具调用": "Tool calls",
  "已发出 仍可继续发送": "Sent · further messages can still be sent",
  "已回执": "Acknowledged",
  "已复制到剪贴板": "Copied to clipboard",
  "已折叠 {n} 行日志": "{n} log lines collapsed",
  "已让位给立即执行单": "Yielded to a run-now task",
  "已隐藏 {n} 行引擎调试输出": "{n} engine debug lines hidden",
  "开": "On",
  "引擎调试": "Engine debug",
  "引用": "Quote",
  "引用到输入框": "Quote into the input",
  "待回执": "Awaiting acknowledgement",
  "恢复初始大小": "Reset size",
  "点击编号查看任务详情": "Click a number to see task details",
  "成环": "Cycle",
  "我：": "Me:",
  "打开任务面板": "Open the task panel",
  "拖动调整输入框高度": "Resize the input",
  "按状态筛选": "Filter by state",
  "搜索任务 / 编号 / PID / 批次": "Search task / no. / PID / batch",
  "清除搜索": "Clear search",
  "收起": "Collapse",
  "收起任务队列": "Collapse the task queue",
  "收起历史重派": "Collapse earlier redispatches",
  "收起日志": "Collapse log",
  "收起辅助面板": "Collapse the auxiliary panel",
  "收起这条状态": "Dismiss this status",
  "调度指令": "Dispatch",
  "放大": "Zoom in",
  "无在途": "Nothing in flight",
  "显示": "Show",
  "最近一次：{t}": "Latest: {t}",
  "查看任务": "View task",
  "查看任务 #{no}": "View task #{no}",
  "模型 未记录": "model not recorded",
  "正在读取派单记录…": "Reading dispatch records…",
  "正在读宿主模型…": "Loading host models…",
  "正在读记忆…": "Loading memory…",
  "正在载入消息…": "Loading messages…",
  "没有匹配的进程": "No matching processes",
  "派单正文里没有编号条目，按报告要求逐条交付":
    "The dispatch body has no numbered items; deliver one by one as the report requires",
  "消息流": "Messages",
  "清空": "Clear",
  "清空“{label}”": "Clear “{label}”",
  "点标题切到监工会话": "Click the title to switch to the supervisor chat",
  "点此展开": "click to expand",
  "状态": "Status",
  "界面风格": "UI style",
  "监工与任务列表分界": "Divider between the supervisor and the task list",
  "监工介入": "Supervisor involvement",
  "监工指标": "Supervisor metrics",
  "监工派单后会出现在这里": "Dispatches appear here once the supervisor sends them",
  "监工派单：": "Supervisor dispatch:",
  "监工消息流": "Supervisor messages",
  "监工裁决：": "Supervisor verdict:",
  "监工：": "Supervisor:",
  "目录为空": "Empty directory",
  "相对路径或绝对路径，回车跳转": "Relative or absolute path; press Enter to go",
  "看板操作": "Board actions",
  "确认": "Confirm",
  "确认关闭": "Confirm close",
  "确认删除": "Confirm delete",
  "确认立即执行": "Confirm run-now",
  "下发派单": "Dispatch task",
  "确认下发": "Dispatch",
  "移除这张附件": "Remove this attachment",
  "立即执行": "Run now",
  "提到队首，必要时让运行中的单让位":
    "Move to the front; a running task yields its slot if needed",
  "查看派单节点关系": "Parent-child links and blockers between dispatches",
  "插队失败": "Jump-the-queue failed",
  "编辑": "Edit",
  "缩小": "Zoom out",
  "脏数据：成环节点": "Bad data: nodes in a cycle",
  "记忆": "Memory",
  "记忆类别": "Memory category",
  "读取中…": "Loading…",
  "项目记忆": "Project memory",
  "账号": "Account",
  "宿主": "Host",
  "当前宿主": "Current host",
  "输入框中的内容会先登记，重派时携带。":
    "What is in the input is recorded first and carried into the redispatch.",
  "过程日志": "Process log",
  "还没有记忆。清空任务不会删这里的条目。":
    "No memory entries yet. Clearing tasks does not remove entries here.",
  "这一单的消息": "Messages for this task",
  "这一单的验收项": "Acceptance items for this task",
  "进程号": "PID",
  "选择文件": "Choose a file",
  "选择监工对话层的模型": "Choose the model for the supervisor chat layer",
  "重复": "Duplicate",
  "重派": "Redispatch",
  "重派记录": "Redispatch records",
  "重试": "Retry",
  "错误": "Error",
  "阶段": "Stage",
  "附件可能已被清理，或取图接口出错。":
    "The attachment may have been cleaned up, or the image API failed.",
  "附件预览": "Attachment preview",
  "项": "items",
  "验收项": "Acceptance",
  "＋ 新增一条": "+ Add an entry",
  "{a}/{b} 字": "{a}/{b} chars",
  "保留 {n} 天": "kept {n} days",
  /* 单位：token 保留原词，不译为中文。 */
  "token": "tokens",
  "积分": "credits",
  "计费接口增量摊算（输入 {a} + 输出 {b} token）；面板未开启期间不摊算":
    "Attributed from billing API deltas (input {a} + output {b} tokens); no attribution while the board is closed",
  "按积分计费，本线程未分摊到读数；输入 {a} + 输出 {b} token":
    "Credit-based host; no credits attributed to this thread; input {a} + output {b} tokens",
  "积分按计费接口已用积分的增量摊算到这条线程；面板未开启期间的消耗没有摊算依据，读数可能偏小":
    "Credits are attributed to this thread from the increment of the billing API's used-credits; consumption while the panel was closed has no attribution basis, so the figure may be low",
  "这条线程没有用量读数": "this thread has no usage reading",
  "这条读数有用量但没有 token 字段": "this reading has usage but no token fields",
  "展开列表": "Expand list",
  "收起列表": "Collapse list",

  /* ---- 监工事件 / 指令标签（服务端 terms.ts 的中文标签，界面按语言换掉）---- */
  "派发任务": "Dispatched",
  "任务完成": "Task done",
  "任务失败": "Task failed",
  "手动结项": "Closed manually",
  "消息唤醒": "Woken by message",
  "判死重派": "Dead, redispatched",
  "重派任务": "Redispatch",
  "回收进程": "Process reaped",
  "任务作废": "Task superseded",
  "超时结单": "Closed on timeout",
  "启动进程": "Process started",
  "中断进程": "Process interrupted",
  "进程退出": "Process exited",
  "循环中断": "Loop interrupted",
  "心跳恢复": "Heartbeat restored",
  "进程启动失败": "Process failed to start",
  "门槛评估": "Gate check",
  "阶段推进": "Stage advanced",
  "收工": "Work finished",
  "跳过阶段": "Stage skipped",
  "阶段停滞": "Stage stalled",
  "任务列表热加载": "Contract hot-reloaded",
  "任务列表变更": "Contract changed",
  "任务列表解析失败": "Contract failed to parse",
  "任务列表被拒": "Contract refused",
  "看板启动": "Board started",
  "看板重启": "Board restarted",
  "重派达到上限": "Redispatch cap reached",
  "欠账清算": "Debt settled",
  "模型回退": "Model fallback",
  "指令回执": "Command receipt",
  "回答": "Answer",
  "用户发言": "User message",
  "监工回话": "Supervisor reply",
  "申报": "Report",
  "申报回执": "Report receipt",
  "人工接管": "Manual takeover",
  "插话登记": "Interjection recorded",
  "钩子异常": "Hook error",
  "心跳": "Heartbeat",
  "心跳稀疏": "Sparse heartbeats",
  "重建派单树": "Dispatch tree rebuilt",
  "其他事件": "Other event",
  "监工记录": "Supervisor record",
  "插队派单": "Priority dispatch",
  "已派单": "Dispatched",
  "其他指令": "Other command",
  "设定下一步": "Set next step",
  "诊断": "Diagnose",
  "修复": "Fix",
  "重载任务列表": "Reload contract",
  "调整并行度": "Adjust concurrency",
  "并行度上限": "Concurrency limit",
  "请填写并行度数字": "Enter a concurrency number",
  "并行度需要正整数": "Concurrency must be a positive integer",
  "提交": "Submit",
  "提问": "Ask",
  "自然语言调度": "Natural-language dispatch",
  "留言": "Message",
  "插话": "Interject",
  /* ---- 消息折叠块 ---- */
  "已并入派单 随该单启动生效": "Merged into the dispatch takes effect when it starts",
  "已并入派单 #{no} 随该单启动生效": "Merged into dispatch #{no} takes effect when it starts",
  "已送达 执行中的进程已收到": "Delivered the running process received it",
  "已送达 #{no} 执行中的进程已收到": "Delivered to #{no} the running process received it",
  "随派单启动带入": "Carried in when the dispatch starts",
  "已登记，进程下一次动作间隙送达": "Registered delivered at the process's next tool gap",
  "已登记，随归属单带入": "Registered carried in with its dispatch",
  "待补投递": "Awaiting re-delivery",
  "正在思考…": "thinking…",
  "（无正文）": "(no text)",
  "（无命令原文）": "(no command text)",
  "隐藏 {n} 行 ": "{n} lines hidden ",
  "{n} 行": "{n} lines",
  /* ---- 输入区轮播提示 ---- */
  "已结束的派单可在原会话中回复，也可由监工介入唤醒":
    "A finished dispatch can be answered in its original session or woken by the supervisor",
  "拖动输入框上沿可改变高度，双击恢复默认":
    "Drag the top edge of the input box to change its height; double-click to reset",
  "通过“图片/路径”选择文件后，任务根内的相对路径会插入输入框":
    "Picking a file under Image / path inserts its path relative to the task root",
  "截图可直接粘贴或拖入输入框，上传完成后随消息一并发送":
    "Screenshots can be pasted or dropped into the input and are sent with the message once uploaded",
  "在工作进程会话中开启“监工介入”，消息将转由监工处理，工作进程不会收到":
    "With Supervisor involvement on in a worker session, the supervisor handles the message and the worker does not receive it",
  "“派单模型”选定后对之后的新单持续生效，更换或清除后失效":
    "Once chosen, Dispatch model applies to every later dispatch until changed or cleared",
  "顶部的并行度与上下文读数可点击切换":
    "Click the concurrency and context readings at the top to switch them",
  "发消息可指定技能，作用于下一张派单，如“下一条派单加上 caveman-scene 技能”":
    "A message can name a skill for the next dispatch, e.g. “add the caveman-scene skill to the next dispatch”",
  "消息卡片上的“#”可引用该条信息，引用随下一条消息一起发出":
    "The “#” on a message card quotes it; the quote goes out with your next message",
  "点击“中断”可结束当前进程并重派；“中断”时勾选“同时登记阻塞”则不再重派":
    "Interrupt ends the current process and redispatches it; ticking “Also record a blocker” in that dialog skips the redispatch",
  "连续失败达到上限会停下等用户裁决，不再自动重派":
    "Consecutive failures reaching the limit stop for the user's decision and are not retried automatically",
  /* 繁忙提醒分三段渲染，各段分别取词条；“繁忙中”标提醒色。 */

  /* ---- 全局提示与操作回执 ---- */
  "capitalist 监工看板": "capitalist Supervisor board",
  "正在调用 {tool}": "Running {tool}",
  "思考中": "Thinking",
  "已发出 模型在想": "Sent model is thinking",
  "工具": "tool",
  "对话失败": "Chat failed",
  "已处理": "Done",
  "没有可发送的进程": "No process to send to",
  "请求失败 {m}": "Request failed {m}",
  "脚本异常": "Script error",
  "未处理的 Promise": "Unhandled promise",
  "未知错误": "unknown error",
  "未知原因": "unknown reason",
  "插话失败": "Failed to send",
  "已登记（{eff}生效）": "Recorded (takes effect {eff})",
  "下一次派单": "on the next dispatch",
  "用户中断工作进程后登记阻塞": "Blocker recorded after the user interrupted the work process",
  "登记阻塞失败": "Failed to record the blocker",
  "已中断": "Interrupted",
  "下一轮调度重派": "redispatched on the next scheduling round",
  "中断失败": "Interrupt failed",
  "已交还监工，下一轮调度起恢复自动裁定": "Handed back; automatic adjudication resumes next round",
  "交还失败": "Handback failed",
  "已结项": "Closed",
  "监工不再为它补单": "the supervisor will not dispatch for it again",
  "结项失败": "Close failed",
  "已清空": "Cleared",
  "清空失败": "Clear failed",
  "清除任务卡": "Clear task card",
  "移出列表，记录保留": "Removed from the list; records are kept",
  "结项并停止重派，记录保留": "Settled, no longer redispatched; records are kept",
  "清除中…": "Clearing…",
  /* 整卡蒙版只有一行进行中文案，不带省略号。 */
  "清除中": "Clearing",
  "停止中": "Stopping",
  "确认清除": "Confirm clear",
  "取消清除": "Cancel clear",
  "已清除该任务卡": "Task card cleared",
  "清除失败": "Clear failed",

  /* ---- 验收清单与日志行 ---- */
  "{n} 条 派单原文": "{n} item(s) from the dispatch",
  "派单没有编号验收项": "The dispatch has no numbered acceptance items",
  "验收清单还有未完成的检查项：": "The acceptance list still has open checks: ",
  "；": "; ",
  "{n} 次": "{n}×",

  /* ---- 会话区：用量行 / 上传提示 / 块标签 ---- */
  "（进程 {w}）": " (process {w})",
  "仅显示最近 {a} 条（共 {b} 条），更早记录见任务目录": "Showing the latest {a} of {b} messages; earlier records are in the task directory",
  "图片 {n}MB，超过 8MB 上限": "Image is {n}MB, over the 8MB limit",
  "上传超时（{n} 秒） 图片未上传，点击“重试”重新上传":
    "Upload timed out ({n}s) image not uploaded; click Retry to upload again",
  "上传失败": "Upload failed",
  "（拖入的 {list} 拿不到本机路径，请用“图片/路径”选）":
    "(Cannot read local paths for dropped files {list}; use Image / path instead)",
  "、": ", ",
  "思考过程": "Thinking",
  "工作进程输出": "Work process output",
  "启动中": "Starting",
  "已领取": "Claimed",
  /* 同一次派单的归属标识与关联提示。 */
  "同一派单": "Same dispatch",
  /* 记忆条目的图标按钮。 */
  "编辑这条记忆": "Edit this memory",
  "删除这条记忆": "Delete this memory",
  "再点一次确认删除": "Click again to confirm deletion",

  /* ---- 操作确认与状态提示 ---- */
  "工作进程 {id}": "Work process {id}",
  "正在续接这一单的会话": "Resuming this dispatch's session",
  "已置顶": "Pinned",
  "上下文窗口": "Context window",
  "当前模型未知": "Current model unknown",
  "仍然设置": "Apply anyway",
  "正在设置…": "Applying…",
  "工作树重建记录": "Work tree rebuild log",
  "调度已暂停": "Scheduling paused",
  "点击右上角“恢复调度”继续": "Click Resume scheduling in the top right to continue",
  "重启监工": "Restart supervisor",
  "当前进程立即退出，正在执行的工作进程一并结束；新进程随后自动拉起。任务记录、阶段与看板地址都不变。": "The current process exits immediately and running work processes end with it; a new process starts automatically. Task records, stages and the board address are unchanged.",
  "关停监工": "Stop supervisor",
  "进程立即退出，正在执行的工作进程一并结束。恢复需要重新执行 capitalist supervise。":
    "The process exits immediately and running work processes end with it. Recovery requires running capitalist supervise again.",
  "进程已退出": "Process exited",
  "待重派": "Pending redispatch",
  "取消中": "Cancelling…",
  "关闭中": "Closing…",
};

/**
 * 当前语言：zh / en。显式落盘值优先，否则按 navigator.languages 首选项判定（zh 前缀为中文，其余为英文），
 * 读不到存储或语言标签时回落中文。只在模块加载时判一次，组件不重复判定。
 */
export const lang = ref(readLang());

/** 取文案：t("暂停调度") / t("监工 {n}", { n: 2 })。 */
export function t(zh, vars) {
  let s = lang.value === "en" ? EN[zh] ?? zh : zh;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

export function setLang(next) {
  lang.value = next === "en" ? "en" : "zh";
  /* 显式选择落盘：之后每次进来优先用它（系统语言变了也不覆盖用户习惯）。 */
  try {
    localStorage.setItem(LANG_KEY, lang.value);
  } catch {
    /* 存不进去（隐私模式等）仅影响下次进入的默认值，当前会话仍生效。 */
  }
  applyLang();
}

/** 把当前语言写到 <html lang>，供读屏与拼写检查使用。 */
export function applyLang() {
  document.documentElement.lang = lang.value === "en" ? "en" : "zh-CN";
}

export function toggleLang() {
  setLang(lang.value === "en" ? "zh" : "en");
}

/* 初次加载：把当前语言应用到 <html lang>（模板靠 t() 自己会重渲染）。 */
if (typeof document !== "undefined") applyLang();
