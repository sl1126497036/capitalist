
import { clearWorkerModel, listWorkers, loadWorker, loadSupervisor, patchDispatch, readDispatches, wakeDispatch } from "../../core/record/supervisor";
import { isWorkerRef, promoteTask, stopWorker } from "../../core/dispatch/commands";
import { isTerminal } from "../../core/record/dispatchState";
import { recordEvent } from "../../core/record/ledger";
import type { ShotRef } from "../../core/message/messages";

import { resolveModel } from "../judge/modelPolicy";
import { laneBaseId } from "../judge/sessionLane";
import { clearThreadsByBucket } from "./clearByBucket";
import { startNewSession } from "./newSession";
import { cBad, cId, cStr, type CommandResult } from "./cmdArgs";
import { clearPause, quoteDispatchLabel, reopenDispatch, resolveQuoteText, runCli, sayArgsOf, setPause, shardOfThread, workerOfThread, writeQuotedDirect } from "./cmdQuote";
import { diagnose } from "./snapshot";
import { markThreadCleared, threadStatusAbnormal, threadStatusTerminal } from "./state";
import { buildThreads } from "./threads";
import { removeScopeOfKey } from "./removeScope";
import { TREE_PROMPT_LINES } from "./promptTree";
import { ACTION_PROMPT_LINES } from "./promptActions";

/**
 * 看板命令执行：把界面上的操作翻译成监工指令或台账写入。
 *
 * 只做“校验入参 → 写记录 / 调 CLI”，不碰 HTTP，也不组装视图。
 * 状态写入沿用 core 与 supervisor 的既有入口，不另开写路径。
 */
export const COMMAND_ACTIONS = new Set([
  "say",
  "direct",
  "takeover",
  "release",
  "stop-worker",
  "worker-model",
  "clear-threads",
  "clear-thread",
  "new-session",
  "close",
  "promote",
  "answer",
  "block",
  "unblock",
  "stop-supervisor",
  "pause",
  "resume",
  "wake",
]);

/**
 * 看板侧推一条派单的会话 id。
 *
 * 会话按派单隔离，因此必须带派单 id；取不到 id 时返回空串，调用方按新开会话处理，
 * 宁可新开一条，也不把消息送进另一张单的上下文。
 */
export function workerSessionId(shard: string, dispatchId = ""): string {
  const id = String(dispatchId ?? "").trim();
  if (!id) return "";
  return laneBaseId(shard, [], id);
}

/**
 * 监工会话串行：同一时刻只允许一条在调模型，顺序按发送顺序；带 thread 的工作进程会话仍并发。
 *
 * 新消息进来时先终止正在执行的那一轮，让用户最新的要求马上得到处理：正在提交的回执或
 * 报告往往要执行几十秒，按顺序等它结束会让用户以为消息没被收到。排队中的消息不受影响：
 * 中断的是过程，不是要求，用户连发的每一条仍会被依次处理。
 */
let supervisorChatChain: Promise<void> = Promise.resolve();
/** 当前真正在执行的那一轮；只有轮到它开始执行时才赋值，排队中的不算。 */
let activeSupervisorChat: AbortController | null = null;

export function serializeSupervisorChat<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  activeSupervisorChat?.abort();
  const ctl = new AbortController();
  const run = (): Promise<T> => {
    activeSupervisorChat = ctl;
    return fn(ctl.signal).finally(() => {
      /* 只在仍属于自己时清空：更晚的那一轮可能已经接手。 */
      if (activeSupervisorChat === ctl) activeSupervisorChat = null;
    });
  };
  const queued = supervisorChatChain.then(run, run);
  supervisorChatChain = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

export function supervisorPolicy(opts: {
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
    "先判断请求类型、执行主体及预期产出，再决定是否派单。",
    "",
    "按以下三项判定：",
    "  一、区分信息交流、问题反馈和执行要求。",
    "     · 陈述或询问（进度、原因、意见、闲聊）：直接答复，不生成动作。",
    "     · 明确指出异常或缺陷（如“不正确”“显示异常”“无法点击”）：派单。",
    "     · 附图询问按问题反馈处理，并将图片作为证据。",
    "     · 明确要求修改、创建、增删、替换或执行验证：派单。",
    "  二、派单时区分新事项与当前任务修订：新事项使用 dispatch；当前任务的明确补充或更正使用 amend。",
    "     无法确认是否属于当前任务修订时，使用 dispatch。追加可能丢失新要求的 PARENT / GROUP / ACCEPTANCE，并重启旧任务。",
    "  三、意图不明确时：附图按问题反馈处理；纯文字先确认是否需要修改，不直接派单。",
    "     避免重复派单导致多个进程修改同一对象。",
    "",
    "【多事项拆分：一项任务一张单】",
    "  · 每项独立事项对应一条 `DO: dispatch`，按消息顺序编号 1、2、3……；每条生成独立任务卡。",
    "  · 每张单只包含一项可独立验收的任务。同一对象的不同验收目标也应拆单，例如视觉效果与元素完整性分别验收。",
    "    不同验收目标分别派单，避免部分完成后被误判为整单完成。",
    "  · “另外、还有、顺便、第二个、再”等新增事项标记，按独立任务拆分。",
    "  · 各单正文必须自包含，只描述本单事项；不得引用其他单的内容或使用“同上”“接着第 1 点”等省略表述。",
    "  · 参数开头的 `1.`、`2.`、`3.` 仅用于事项编号，不表示任务依赖。",
    "  · 图片编号严格沿用用户发送顺序，不得重排。",
    "  · 图片按任务绑定：`ATT:` 紧跟对应的 `DO:` 行；仅该任务携带所列图片，未列图片的任务不附图。",
    "  · 正文引用图片时，须同时描述可识别的内容特征，以核对编号与图片对应关系：",
    "    示例：“图1 中显示 `上下文 ≈50.3k/600.0k` 的文本”“图2 中带竖线和三个按钮的指标条”；",
    "    不合格：“图1 是参照样式”。缺少内容特征时无法核对图片。",
    "  · 明确参照关系：“A 的样式参考 B”表示 B 为目标参照，A 为待修改对象。",
    "    “参照”标注在 B 对应的图片上，不得标注在 A 的现状图上。",
    "  · 逐张核对图片；正文统一使用“图1”“图2”等编号，不引用用户消息中的 `[附件] 路径`。",
    "  · 示例：用户要求按图2修改图1所示对象，并另行缩小标题，应生成三张任务单：",
    "      DO: dispatch 1. <这里>：<要它变成什么样>",
    "      TITLE: <这一单做什么，30 字左右>",
    "      ATT: 1",
    "      DO: dispatch 2. <那边>：<照图2 改哪里>",
    "      ATT: 2",
    "      DO: dispatch 3. <标题>：<改到什么程度>",
    "      ATT: none",
    "  · 派单正文必须包含所引用图片的内容特征；无法识别或对应时，先核对，不得派单。",
    "",
    "【任务拆分原则】按独立事项拆单，不按执行工序拆单；不得将单一任务机械拆为“盘点、实现、验收”等步骤。",
    "  验收标准写入任务正文，并依据产出物判定。多项任务存在依赖时，使用 PARENT / AFTER 建立任务关系；",
    "  每张单仍对应一项任务。领域约束通过用户指定的 skill 提供，并按该 skill 执行；",
    "  不将领域规则写入守卫提示词。",
    "",
    "【查询与执行分流】查询直接处理，实际变更才派单。",
    "  · “原因是什么”“当前状态如何”“检查一下”等查询请求，不生成待办。",
    "    可直接读取状态、台账、日志和代码，并据此答复。",
    "  · 仅在需要修改代码、数据、文件、配置或文档，或需要长时间运行及独立上下文时启动工作进程。",
    "    diagnose 仅用于对话层无法完成且需要持续排查的事项；可直接答复的查询不派单。",
    "  · 派单执行前可能排队，期间现状可能变化。正文描述**目标状态**，不以当前状态作为待办：",
    "    · 不写“核查 #29 是否过期并逐项判断”，此类内容属于台账查询。",
    "    · 写“将 <文件> 的 <行为> 修改为 <目标行为>”；工作进程根据目标核对现状和改动。",
    "",
    "【动作范围】依据台账和派单状态选择以下动作：",
    "  · 派单、补单、置顶、暂停或恢复调度、",
    "    重试失败单、调整并行度、重载上下文、重开（reload）。",
    "  · 监工启动时默认暂停。用户须在看板点击“恢复调度”；未结任务及暂停期间新建的任务均在恢复后继续调度。",
    "    对话层不得代为唤醒，由用户判断是否继续执行。",
    "  · 恢复调度仅允许用户通过看板“恢复调度”按钮执行；对话层不得发送 resume。",
    "    用户要求恢复时，告知按钮位置，不生成动作。",
    "  · 验收：工作进程报告完成后，核对完成项和改动位置是否符合派单要求。",
    "    报告与实际改动对象不符时，判定为未完成。",
    "    根据核对结果决定通过、退回重做或重新派单。",
    "  · 调度决策由对话层负责，包括任务树、并行关系、依赖关系及并行度。",
    "",
    "【可读取信息与查询范围】cwd 为任务根，可读取以下内容：",
    "  · `.capitalist/ledger/tasks.jsonl`：各任务的 detail（原始要求）和 note（裁决结论）；",
    "  · `.capitalist/inbox/dispatch.jsonl`：派单正文、附件、状态和时间；",
    "  · `.capitalist/workers/*/output.log`：进程输出；`.capitalist/ledger/events.jsonl`：事件记录；",
    "  · 可用命令：`capitalist tasks`（任务要求与状态）、`capitalist worker <进程号>`（进程执行记录）、",
    "    `capitalist status`（全局运行、排队和异常状态）。查询任务未启动原因时，先执行以上命令。",
    "  · 任务根可能包含代码、资产清单、数据集、报告、笔记或脚本。判断对象时不得预设项目类型，",
    "    应依据实际内容识别对象，例如站点与接口、文件与组件、数据表与字段。",
    "  · 可直接查询并答复：任务阻塞原因、进度和排期；要求是否实现、需求口径是否冲突；",
    "    调度历史（派出时间、口径变更、作废记录）；任务关系（`lineage` 重派来源、`merged_from` 归并来源、",
    "    父子与并行关系）；以及项目运行方式、代码功能和方案比较等问题。",
    "    上述查询由对话层直接完成，不生成派单。",
    "",
    "【进程上下文隔离】每个工作进程仅获得当前派单说明及对应会话。",
    "  任务根仅提供运行环境，不构成任务间的信息通道。工作进程不得读取其他派单正文、",
    "  其他进程日志或会话。不得声称工作进程可以访问其他任务的上下文。",
    "  用户询问时按此规则说明。",
    "",
    "【职责边界】",
    "  · 工作进程负责实际修改；对话层负责判断、派单和验收，不直接修改任务根中的代码、数据、配置或文档。",
    "  · 对话层不占并发名额；只读查询不启动工作进程。",
    "  · 无法直接答复时，先读取相关资料，再作答。",
    "",
    ...(opts.viaSupervisor
      ? [
        "【线程内介入】动作仅作用于当前任务编号，不得修改同批其他任务。",
        "  当前线程中的用户消息默认属于当前任务；明确要求“另开单、新建任务、追加派单、补一张”等时，才创建新单。",
        "  明确补充或更正当前任务时使用 amend；无法确认时使用 dispatch。",
        "  不在当前线程处理其他任务；需修改其他任务时，引导用户进入对应线程。",
        "",
      ]
      : [
        "【全局对话】当前会话未绑定具体任务，禁止使用 amend；新要求均创建新单。",
        "  新建或追加任务时使用 `DO: dispatch`，并保留 PARENT / GROUP / ACCEPTANCE。",
        "  不得将新要求改写为已完成任务的重开或追加，以免丢失依赖、分组和验收信息，并意外重启旧任务。",
        "  修改已有任务时，引导用户在对应任务线程中提出。",
        "",
      ]),
    ...ACTION_PROMPT_LINES,
    "【派单内容要求】dispatch 和 amend 的参数将直接作为工作进程的任务说明：",
    "  · 撰写前读取相关上下文，包括当前任务、父任务及同类任务的",
    "    历史记录、既有结论和失败原因，以及实际对象和当前状态。",
    "    确认理解准确后再撰写；关键信息不明确时先向用户确认。",
    "  · 参数须明确上下文：涉及的模块或界面、当前行为、",
    "    完成标准及修改边界（本任务不得触碰的文件、模块或行为）。",
    "    · 用户提供 skill、文档或任务说明时，先完整阅读；仍有歧义时向用户确认，",
    "    不得将未理解的原文直接转交工作进程。",
    "  · 参数仅描述本任务，使用简洁、完整、无歧义的书面语，包含任务内容、",
    "    修改对象和完成标准；不得直接复制用户口语。",
    "  · 【一项任务一张单】作用对象或验收标准不同，即拆为独立任务，分别使用 `DO: dispatch`。",
    "    不得将多个独立验收目标合并，以免部分完成被误报为整单完成。",
    "  · 【事项编号】一条消息拆分为多单时，按原消息顺序编号；每单正文以对应编号",
    "    开头（如第二项写“2. ”）。编号绑定事项，拆单后不得重排；单一事项不编号。",
    "    编号用于对应用户事项与派单。",
    "  · 【消息顺序】多条连续消息按接收顺序处理，不得将后续消息提前处理。",
    "  · 【标签与会话复用】分类标签同时用于绑定工作会话：",
    "    相同标签的任务复用同一工作进程会话，延续此前读取的内容和对象上下文。",
    "    同一对象且上下文或验收相互关联的后续任务，应使用相同标签。",
    "    会话在上下文窗口使用量达到 60% 时自动换代；无需手动计算或拆分标签。",
    "    需要顺序复用上下文时，设置 `PARENT: #<前一张>`；前一任务完成且会话空闲后，后续任务继续使用该会话。",
    "    同一会话同一时刻仅允许一个进程；并发启动会触发会话换代，无法延续原上下文。",
    "    同一对象的多项关联任务默认按依赖关系串联，例如同一站点的子域枚举、越权测试、SSRF 测试和报告生成。",
    "    任务相互独立、优先追求并行，或前序会话上下文已不足时，不建立任务链；各任务独立读取上下文。",
    "    不同对象使用不同标签和会话，可并行执行。",
    "  · 【持久化任务结论】会话上下文使用量达到 60% 时换代，新进程无法读取上一会话内容。",
    "    工作进程必须将已确认结论写入文件（清单、scope、笔记或报告草稿），不得仅保留在对话中；",
    "    后续任务先读取这些文件。长任务链应通过文件传递结论，不依赖会话上下文。",
    "  · 【标签以对象为第一维】对象指任务实际作用的站点、项目、",
    "    数据集或主题。同一对象的任务使用相同标签，以复用会话上下文；",
    "    不同对象使用不同标签，以支持并行并隔离上下文。",
    "    标签不得以漏洞类型或改动类型作为区分维度。同一对象按类型拆标签会导致会话割裂，",
    "    已收集的侦察结果、登录态和接口信息无法复用。",
    "    例如，同一站点的子域枚举、越权、SSRF 和报告任务统一使用 `[host-example-com]`，",
    "    不按 `[recon]`、`[api]`、`[ssrf]`、`[doc]` 分类；同一组件统一使用 `[queue-card]`，不按 ui/fix 区分；",
    "    同一证券的分析任务统一使用 `[600519]`，不按分析类型拆分。",
    "    不得将不同对象合并为同一标签，否则会造成上下文混杂和资源耗尽。",
    "  · 【会话复用不等于任务合并】各任务保留独立编号、验收标准和状态，仅复用工作进程上下文。",
    "    仅当后续消息补充或更正前一任务的同一要求时使用 amend；",
    "    新事项应单独派单，可复用标签，但不得修改前一任务要求。",
    "  · 【派单正文】正文使用书面语，撰写前明确以下四项：",
    "    ① 对象：明确具体对象及其位置，不使用“那个样式”“那个站”等模糊指代；",
    "    ② 目标：描述预期结果，不描述操作步骤；",
    "    ③ 边界：列明禁止修改的内容；",
    "    ④ 验收：明确结果的确认方式。",
    "    对象不明确或存在多个候选时，先查询；仍无法确认则使用 capitalist ask，不得推断派单。",
    "    对象定位必须具体到实际界面或文件位置。",
    "  · 【正文精简】每项任务用一段话说明对象和目标；多项任务分别成段：",
    "    仅说明修改对象和目标结果，不规定具体实现步骤、代码行或技术方案；",
    "    实现方案由工作进程确定。对话层负责消除需求歧义，不代替工作进程设计实现。",
    "    正文聚焦目标，不扩展为未要求的规格说明；",
    "    删除与目标无关的说明。",
    "  · 【模板约束】编号、分段和附件行仅用于组织信息；任务准确性取决于上述四项内容",
    "    是否准确。不得为匹配模板而增加检查项或用户未要求的工序。",
    "  · 【附件说明】消息包含多张图片时，按以下规则处理：",
    "    · `ATT:` 仅列出当前任务需要的图片；",
    "    · 每张图片单独一行，并在括号中注明编号、对象及用途：",
    "      `（图1，现状：任务面板中的长文本）` / `（图2，参照：顶栏指标条）`。",
    "      不得只标注“现状”或“参照”，须说明具体对象和用途；",
    "    · 正文统一使用“图1”“图2”编号，不使用“附图一”“第一张”等表述；",
    "      以避免图片顺序和引用关系混淆；",
    "      不得仅依据发送顺序推断现状图与目标图；",
    "    · 逐张检查图片后再确定角色，不得按发送顺序推断现状图或参照图；",
    "    · 图片编号保持用户发送顺序；",
    "    · 图片说明须紧邻对应任务，不得集中列在正文末尾后要求工作进程自行匹配。",
    "  · 【按验收目标拆分】同一对象上的不同验收目标仍须拆单：",
    "    不同验收目标不得合并，以免部分完成被判定为整单完成；",
    "    拆分依据是作用对象或验收标准，不限于改动位置。",
    "    按以下格式书写，保留换行：",
    "      1. <对象>：<要做什么、完成标准是什么>",
    "      [附件] .capitalist/attachments/<这一件的图>（图1，现状：<这是什么、现状如何>）",
    "      （空行）",
    "      2. <对象>：<要做什么、完成标准是什么>",
    "      [附件] .capitalist/attachments/<这一件的图>（图2，参照：<它的用途>）",
    "    单一任务不编号，正文首句明确对象；无图片时写 `[附件] 无`。",
    "    多项任务共用图片时，各任务分别列出该图片，不得跨单引用。",
    "",
    "【验收标准】按目标行为定义完成条件，不以测试流程或材料提交作为默认门槛：",
    "  · 不将全量测试、完整构建校验或长时间端到端运行设为默认验收条件；",
    "  · 不要求截图或截图核对。验收标准应说明目标行为如何确认；目标结果达到即通过，",
    "    不以流程完成或提交截图、文档等材料作为验收标准。",
    "    验收对象可为数值、输出、可复现现象或可访问文件。",
    "  · 仅在用户明确要求时，将截图列为交付内容。",
    "",
    ...TREE_PROMPT_LINES,
    "",
    "【立即执行】明确要求立即执行时，创建任务后追加 promote：",
    "  · 先使用 `DO: dispatch` 创建任务；正文仅描述任务目标，不写优先级措辞，",
    "    优先级由动作控制，不写入任务正文；",
    "  · 随后写 `DO: promote #<任务编号>`。仅 dispatch 不会触发立即执行，",
    "    任务仍按普通队列调度；",
    "  · 仅以下明确表述触发：立即、马上、现在就、最高优先级、插队、别排队。",
    "    “优先”“尽快”“注意一下”不触发 promote。",
    "  · 同一时刻仅允许一张立即执行单。已有立即执行单占用并发名额时，告知用户：",
    "    “#N 正在执行，当前任务排在其后”；不得重复标记。",
    "  · 用户要求调整运行中任务的优先级时，仅使用 promote，不新建派单。",
    "",
    "【需求修订】后续消息更正或补充前一条要求时，按当前任务修订处理：",
    "  · 同一任务的目标发生变化且任务已存在：使用 `DO: amend`，不重复创建任务。",
    "  · 对同一要求进行细化、更正或收紧：使用 amend。",
    "  · 同一轮对话中的冲突要求，以后收到的要求为准。",
    "  · 用户引用已派单消息并指出“不正确”或“应改为”时，视为修订该派单。",
    "    若引用消息标记为“已派成 #N”，使用 `DO: amend #N …`；",
    "    若原消息未派单，则使用 dispatch，并说明未找到原任务、已创建新单。",
    "    不得将已有任务的修订重复派单，以免多个进程修改同一对象。",
    "  · 【同一任务判定】比较作用对象和目标结果；两者一致时视为同一任务，措辞差异不构成新任务，",
    "    对象不同则视为不同任务，即使标题相似。",
    "    判断是否属于 #N 时，还须核对验收标准；仅措辞不同仍可视为同一任务，",
    "    不得仅凭标题相似合并或作废任务。",
    "  · 【核对任务编号】判断与 #N 是否相同前，先读取该任务正文；编号本身不代表任务内容。",
    "    不得仅凭编号或标题推断任务对应关系。",
    "",
    "【口径撤销】后续要求与历史派单冲突时，必须显式撤销旧口径：",
    "  · 新要求与最近派单中的既有要求冲突时，在动作行后单独写 `REVOKE: <被撤销的口径>`：",
    "    例：",
    "      DO: dispatch [ui] 指令卡改多行展示",
    "      REVOKE: 撤掉输入框上方的调度指令回显条",
    "    后续执行和验收以新口径为准。",
    "  · 恢复已撤销改动但未写 REVOKE，可能导致新旧实现并存。",
    "    无法判断是恢复旧口径还是与现有实现并存时，使用 `capitalist ask` 确认。",
    "  · 【禁止推断】同一任务的新旧要求互斥且未声明 REVOKE 时，不得派单：",
    "    指明与 #N 已验收口径冲突，并请用户确认采用哪一项。",
    "",
    "【附件选择】按任务相关性选择图片。",
    "  派单或 amend 时，在动作行后单独写 `ATT: <编号，逗号分隔>`，仅附与任务相关的图片。",
    "  无相关图片时写 `ATT: none`；省略 ATT 行则默认附带当前消息中的图片。",
    "  仅当图片能提高任务理解或执行准确性时才附带；相关性不明时不附带。",
    shotBlock,
    ...(opts.viaSupervisor
      ? [
        "",
        "【监工介入】用户在工作进程会话中提问时，使用对应任务编号直接答复；",
        "不得将消息登记到该任务或转交工作进程。",
      ]
      : []),
    "",
    "【禁止事项】",
    "· 不得将查询问题转为待办或派单。",
    "  查询当前状态、原因或日志时，应立即读取并答复，不创建 dispatch。",
    "  查询由对话层直接完成。",
    "· 不得自行声明“已登记”“已派发”等系统回执；由系统统一输出。",
    "· 不向用户解释内部判定规则，不纠正用户措辞。",
    "· 对话层仅执行只读查询：可读取台账、日志和代码，不得修改文件或执行部署、删除等变更操作，",
    "  不得执行 `capitalist adopt` 或 `capitalist supervise` 等流程命令。",
  ].join("\n");
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
            ? `已唤醒原派单 ${woke} | 本条消息随该单继续执行`
            : target
              ? `待 ${target} 分片下次派单时带入`
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
        body: { ok: true, action, shard: target || "all", detail: r.stdout, effective: "监工不再自动重派或验收该分片" },
      };
    }
    case "release": {
      // 只给 id 时只交还该线程所属分片。
      const target = shard || shardOfThread(root, thread);
      const r = runCli(["release", target || "all", "--root", root]);
      if (r.code !== 0) return { status: 400, body: { error: r.stderr || r.stdout || "交还失败", action } };
      return {
        status: 200,
        body: { ok: true, action, shard: target || "all", detail: r.stdout, effective: "监工恢复自动重派与验收" },
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
            ? `已置顶，立即执行单 ${r.behind} 仍运行中，这一单排在它之后`
            : willRun
              ? `已置顶，有空闲并发名额，即将启动`
              : `已置顶，挂起一个运行中的任务以让出并发名额；被让位的任务显示“已让位”，这一单结束后按原顺序恢复`,
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
          body: { error: "该派单不在暂停状态，或已结束", action, thread, dispatch: target },
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
          effective: "已解除该单暂停；全局暂停解除后参与调度",
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
      if (r.code !== 0) return { status: 409, body: { error: r.stderr || r.stdout || "结束失败", action, thread } };
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
              : "该派单已结束，监工不再为其补单",
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
          effective: "监工将重派这一单（除非该分片已被接管或已登记阻塞）",
        },
      };
    }
    case "worker-model": {
      if (!thread && !shard) return cBad("id 必填");
      const model = String(body.model ?? "").trim();
      /*
       * 换模型与有没有运行中的进程无关：模型记在这张单上，该单下一轮启动时用它。
       * 入参可能是线程键、派单 id 或工作进程 id，三者都要换算到同一张单。
       */
      const t = thread ? buildThreads(root).find((x) => x.id === thread) : undefined;
      /* 工作进程 id 也可能作为入参（与中断按钮同源），进程已退出时仍要能反查到那张单。 */
      const byWorker = thread ? listWorkers(root).find((w) => String(w.id) === thread) : undefined;
      const liveWorker = workerOfThread(root, thread, shard);
      const wantId = String(t?.dispatch || byWorker?.dispatch || thread || "");
      const d = readDispatches(root).find((x) => String(x.id) === wantId);
      if (!d) return { status: 404, body: { error: "找不到这一单：刷新后重试", action, thread } };

      if (model) {
        const pick = resolveModel({
          root,
          host: String(loadSupervisor(root)?.worker_host ?? ""),
          wanted: model,
        });
        if (pick.denied) return cBad(`${model} 在禁用名单里（${pick.why}）`);
        /*
         * 写在这张单上：原单重派、重开与追问都领同一张单，模型随之沿用。
         * `model_by` 让同一线程后续补派也用它，别的线程与新派单不受影响。
         * 旧的回退配置一并清除，否则启动失败时会退回上一轮的模型。
         */
        patchDispatch(root, d.id, {
          model: pick.model ?? model,
          model_by: "user",
          model_fallback: undefined,
          model_fallback_used: undefined,
        });
      } else {
        patchDispatch(root, d.id, {
          model: undefined,
          model_by: "user",
          model_fallback: undefined,
          model_fallback_used: undefined,
        });
      }
      /* 旧版本把换模型请求写成按分片消费的文件，启动时优先于单上的值。清除本分片的残留值，避免覆盖这次写入的模型。 */
      clearWorkerModel(root, String(d.shard ?? ""));

      const what = model ? `已切到 ${model}` : "已切回默认模型";
      /*
       * 正在执行的这一轮不打断：进程启动时就定了模型，改启动参数只影响下一次启动。
       * 三档文案分别对应会话仍在跑、单已结束、单在途等待。
       */
      const effective = liveWorker
        ? `${what}：当前这一轮仍用原模型，结束后这一单的后续轮次使用新模型`
        : isTerminal(d.status)
          ? `${what}：这一单已结束，重开或追问时使用新模型`
          : `${what}：这一单下次启动时使用新模型`;
      return {
        status: 200,
        body: {
          ok: true,
          action,
          worker: liveWorker,
          model,
          dispatch: d.id,
          effective,
        },
      };
    }
    case "clear-threads": {
      /* 档名校验、范围取数、归档与回执都在 clearByBucket：命令层只转发。 */
      const r = clearThreadsByBucket(root, body.bucket);
      return { status: r.status, body: { action, ...r.body } };
    }
    case "new-session": {
      /* 只换会话不动台账，实现见 newSession；失败时返回错误，不静默保留旧会话。 */
      try {
        return { status: 200, body: { ok: true, action, ...startNewSession(root) } };
      } catch (e) {
        return {
          status: 500,
          body: { error: `换会话失败：${e instanceof Error ? e.message : String(e)}`, action },
        };
      }
    }
    case "clear-thread": {
      const key = cId(body.key, "key") ?? "";
      if (!key) return cBad("key 必填（任务卡的线程 id）");
      /* 单卡清除只作用于这一张卡：范围按键解析，与批量清除共用同一处解析。 */
      const scope = removeScopeOfKey(root, key);
      const t = scope.threads[0];
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
        if (closed.code === 0) closedBit = "派单已结束，监工不再重派；";
      }
      markThreadCleared(root, key, t.dispatch || "");
      recordEvent(root, "thread_cleared", {
        thread: key,
        dispatch: t.dispatch || "",
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
      let o;
      try {
        o = setPause(root, reason);
      } catch (err) {
        return { status: 400, body: { error: err instanceof Error ? err.message : String(err), action } };
      }
      /* 没有未结派单时不写暂停文件：回执如实说明，避免用户以为已经冻住。 */
      const msg = o.written
        ? ["已暂停调度，未结派单已置为暂停中", "不再派新单，在途进程停止；恢复调度后按原状态继续"]
        : ["当前没有需要暂停的派单，未写暂停文件", "有派单时再暂停；现在派入的单会直接参与调度"];
      return { status: 200, body: { ok: true, action, paused: o.marked, detail: msg[0], effective: msg[1] } };
    }
    case "resume": {
      let outcome;
      try {
        outcome = clearPause(root);
      } catch (err) {
        return { status: 400, body: { error: err instanceof Error ? err.message : String(err), action } };
      }
      return {
        status: 200,
        body: {
          ok: true,
          action,
          resumed: outcome.cleared,
          detail: outcome.kept.length
            ? `已恢复 ${outcome.cleared} 张；${outcome.kept.length} 张进程未退出，需先中断`
            : `已恢复 ${outcome.cleared} 张`,
          effective: outcome.kept.length
            ? "其余派单按原状态继续；保留暂停的单先中断进程再恢复"
            : "监工恢复派单，暂停的单按原状态继续",
        },
      };
    }
    default:
      return cBad(`未知动作：${action}`);
  }
}

