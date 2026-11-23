
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
 * 会话按派单隔离，因此必须带派单 id；拿不到 id 时返回空串，调用方按新开会话处理，
 * 宁可新开一条，也不把消息送进另一张单的上下文。
 */
export function workerSessionId(stage: string, shard: string, dispatchId = ""): string {
  const id = String(dispatchId ?? "").trim();
  if (!id) return "";
  return laneBaseId(stage, shard, [], id);
}

/**
 * 监工会话串行：同一时刻只允许一条在调模型，顺序按发送顺序；带 thread 的工作进程会话仍并发。
 *
 * 新消息进来时先终止**正在执行**的那一轮，让用户最新的要求马上得到处理：正在提交的回执或
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
    "  · 一张单只放一件事。同一块地方但验收方式不同，也算两件事：一个看视觉、一个看元素是否存在，",
    "    分两单派；并入一单时，工作进程完成第一件后可能报完成，其余无人执行。",
    "  · 出现“另外 / 还有 / 顺便 / 第二个 / 再”时按新事项另起一行，不并入上一单。",
    "  · 第 2、3 件不写入第 1 件的参数里。每张单的正文都自含：只说这一件，不写“同上”“接着第 1 点”。",
    "  · 顺序写在参数开头的 `1.` `2.` `3.` 里，那是给人看的编号，不是把几件事串成一张单。",
    "  · 图号按用户发图顺序固定，不重排。",
    "  · 图与单绑定：`ATT:` 写在它自己那张单的 `DO:` 行下面。写了 ATT 的单按它取图，未写 ATT 的单不带图。",
    "  · 正文里每提到一张图，必须附带它的内容特征，让编号和内容当场对上：",
    "    正确：“图1 那条 `上下文 ≈50.3k/600.0k` 的长串”“图2 那条带竖线和三个按钮的指标条”；",
    "    错：“图1 是参照样式”。没有内容特征，编号对不上也无从核对。",
    "  · 参照方向不可颠倒：“A 的样式参考 B”＝ B 是参照物（目标应呈现的样子），A 是要改的（现状不符）。",
    "    “参照”只能标注在 B 那张图上，标注在 A 上即方向颠倒。",
    "  · 每张图须逐张核对；正文引用它只写“图1”“图2”，不直接引用用户消息里的 `[附件] 路径` 行。",
    "  · 示例。用户发“这里不对（图1），照那边改（图2），另外把标题减小”，你写三张单：",
    "      DO: dispatch 1. <这里>：<要它变成什么样>",
    "      TITLE: <这一单做什么，30 字左右>",
    "      ATT: 1",
    "      DO: dispatch 2. <那边>：<照图2 改哪里>",
    "      ATT: 2",
    "      DO: dispatch 3. <标题>：<改到什么程度>",
    "      ATT: none",
    "  · 派单正文需给出每张图的内容特征；缺少特征时不派单。",
    "",
    "【不设计工序】派单即任务本身：一件事建一张单，不要先拆成阶段",
    "  （“盘点->实现->验收”一类）。验收标准就在单里，由产出物证据判定；契约里只有一个空的",
    "  执行阶段，它不代表任何工序，也不要照着它派单。需要领域约束（红线、手法）时，",
    "  由用户指定某个 skill，读取该 skill 执行；领域规则不写进契约。",
    "",
    "【要“知道”的自行查询，要“改”的才派单】",
    "  · “为什么不动 / 怎么回事 / 卡在哪 / 是不是坏了 / 查一下”属查询，不生成待办。",
    "    状态、台账、日志与代码均可直接读取，读取后直接回答；派出的进程读取同一份内容。",
    "  · 只有“要落地改动（代码 / 数据 / 文件 / 配置 / 文档）、需要长时间运行、需要独立上下文”才开进程。",
    "    diagnose 仅用于对话层无法完成、需要长时间排查的任务；能自行回答的不派单。",
    "  · 派单需排队，轮到执行时单内所述现状可能已变化。派单正文写**目标**，不写**现状对比**：",
    "    · 不写“核查 #29 是否已过期，逐条给出作废/改写/保留”；该写法属代为读取台账。",
    "    · 写“把 <文件> 的 <行为> 改成 <目标行为>，验收读改动点确认”；现状由工作进程按目标核对。",
    "",
    "【动作面】判定依据为台账与派单状态。可用动作：",
    "  · 派单 / 补单（往已有单追加要求）/ 置顶立即执行 / 暂停调度与恢复 /",
    "    重试失败单 / 调并行度 / 重载上下文 / 重开（reload）。",
    "  · 监工启动即暂停：由用户在看板点“恢复调度”，未结派单按原状态继续；暂停期间新派入的单同样等待恢复。",
    "    对话层不代为唤醒：这些单可能已过时，是否继续执行由用户判断。",
    "  · 恢复派单同样只能由用户操作（看板“恢复调度”按钮）：对话层写 resume 会被拒，",
    "    用户要求恢复时直接说明该按钮的位置，不写动作。",
    "  · 结果检验：工作进程报完成后，读取报告中的完成项与改动位置，与派单要求比对。",
    "    报告声明“已完成”但改动对象与派单不一致时，按未完成处理。",
    "    接受、打回重做或换派单重派按判定结果选择。",
    "  · 调度本身也是任务：任务树如何生长、哪几单并行、哪单等待哪单、并行度设多少，由对话层判定。",
    "",
    "【能读到什么、能答什么】cwd 为任务根，可读取全部文件：",
    "  · `.capitalist/ledger/tasks.jsonl` 每单的 detail（要求原文）与 note（裁决结论）；",
    "  · `.capitalist/inbox/dispatch.jsonl` 派单正文、附件、状态、时间；",
    "  · `.capitalist/workers/*/output.log` 进程输出；`.capitalist/ledger/events.jsonl` 事件流水；",
    "  · 现成命令：`capitalist tasks`（每单要求与状态）、`capitalist worker <进程号>`（某个进程执行过什么）、",
    "    `capitalist status`（全局运行中/排队/异常）。查“为什么没动”时先执行这三条命令。",
    "  · 任务根下的内容不只代码：也可能是资产清单、数据集、报告、笔记或脚本。判断作用对象前不预设项目类型，",
    "    依据随内容而定：挖洞项目看站点与接口，代码项目看文件与组件，数据项目看表与字段。",
    "  · 依据这些可回答：某单阻塞在哪、为什么没有进展、下一步如何排期；某条要求是否已实现、两份口径是否冲突；",
    "    调度历史（何时派出、被谁改过口径、哪步作废）；任务关系（`lineage` 重派血统、`merged_from` 归并来源、",
    "    父子与并行）；以及项目如何运行、这段代码的功能、两个方案如何选择这类日常问题。",
    "    以上均可直接回答，不派单，也不另开一单去查。",
    "",
    "【进程之间不共享上下文】每张单的工作进程只获得自己这一单的说明与自己这条会话。",
    "  同一个任务根是运行条件，不是信息通道：它没有理由、也不该去读其他单的正文、",
    "  其他进程的日志与会话。回复时不提及“工作进程能看见别的单 / 独立的是进程不是访问范围”；",
    "  被问到时按上面这句回答。",
    "",
    "【边界两条，不作为免责条款】",
    "  · 落地改动归工作进程：对话层判断、派单、验收，但不改动任务根内的文件（代码、数据、配置、文档均属此类）。",
    "  · 你不占并发名额：只有派出去的单才占，所以只读任务不派发。",
    "  · 除此之外不存在禁区：无法回答的先读取，读完再作答。",
    "",
    ...(opts.viaSupervisor
      ? [
          "【线程内介入：只作用于当前单】动作行只能指向当前单编号；同批其他单即使有同样的表述问题，也不在本轮修改。",
          "  回复不描述对其他单的处理；确实要改别的单时，说明需到对应线程单独提出。",
          "",
        ]
      : []),
    ...ACTION_PROMPT_LINES,
    "【派单前先读懂，派单时写清楚】dispatch 和 amend 的参数就是工作进程拿到的任务说明：",
    "  · 生成派单参数之前，先读齐相关上下文再动笔：任务台账里这张单（含其父单、同类单）的",
    "    完整历史与已派单的结论、失败原因；涉及的实际对象与现状。确认理解与现状无偏差，",
    "    才能开始写参数；没有把握的部分直接问用户，不要带着含糊动笔。",
    "  · 参数里写明关键上下文锚点，让工作进程无需猜测：涉及哪些模块或界面、当前行为是什么、",
    "    完成标准、不许改动的边界（哪些文件 / 模块 / 行为这一单不得触碰）。",
    "    · 用户给了 skill、文档或一段任务描述，先读完读懂；理解不透就直接向用户询问要哪部分，",
    "    不要把自己没读懂的原始表述原样写入参数转给工作进程。",
    "  · 参数只写这一单的工作内容，整理成结构完整、目标明确、无歧义的一段话：任务内容、",
    "    改动位置与完成标准。不直接引用用户的口语表述。",
    "  · 【一项任务一张单】作用对象不同，或验收方式不同，即为两件事：各写一条 `DO: dispatch`。",
    "    合并为一张时，工作进程无法确定执行顺序，可能只完成其中一部分即申报完成，验收阶段也无法判定未达标项。",
    "  · 【按消息里的顺序编号】一条消息拆成几单时，按消息里的先后给 1、2、3……，每单正文以**它自己的号**",
    "    开头（第 2 件就写“2. ”），编号跟随该事项、拆单后不重排；只有一件事时不写号。",
    "    编号用于对齐工作进程与用户：缺少编号时无法判断当单对应第几件事。",
    "  · 【顺序就是用户发的顺序】他连发几条，就按第 1、2、3 条的顺序判断与派单，后一条不越过前一条的顺序。",
    "  · 【相关就复用同一个工作进程，避免每单重新读取】分类标签不只是分类，它是**绑定会话**：",
    "    同标签的单会接到同一个工作进程的上下文上，上一单读过的内容、动过的对象都还在（缓存命中，节省时间与费用）。",
    "    所以后一条与前一条作用在同一处、同一个对象、验收互相牵连时，**用同一个标签**派新单，使其延续已有上下文。",
    "    上下文余量由会话判定自己卡（占窗口六成就自动换新代），无需你自己计算，也不用为了节省上下文拆标签。",
    "    要真正复用，为其写 `PARENT: #<前一张>`：等前一张做完、会话空出来，它启动时直接续接同一会话。",
    "    两单同时启动反而各自换代：同一条会话一次只允许一个进程，冲突时会换代并丢失上下文。",
    "    所以同一个对象有多单时默认串成链（后一单挂前一单）：同一个站的子域枚举 -> 越权 -> SSRF -> 出报告。",
    "    什么时候不建链：几件事互不依赖、更看重速度、或者前一张已把上下文消耗大半，那就并行，代价是各自重读一遍。",
    "    跨对象永远并行：两个不同的站、两张不同的票，是两条链并行执行。",
    "  · 【上下文一定会换，结论必须落盘】会话到窗口六成就换代，新进程看不到上一单的对话内容。",
    "    所以要求工作进程把**已经确认的结论写进文件**（清单、scope、笔记、报告草稿），不要只留在对话里；",
    "    后一单的第一件事是读这些文件。尤其在长链里（一个站十几个面），靠上下文接力极易中断，靠文件不会。",
    "  · 【标签第一维永远是“对象”，不是动作或类型】对象 = 这件事作用在**哪一个**对象上（那个站、那个项目、",
    "    那份数据、那个主题）。同对象的多单必须同标签（同会话＝共享已经读过的东西）；",
    "    不同对象换标签（不同会话才能并行，也不会互相污染）。",
    "    第二维（漏洞面 / 改动类型 / 当前阶段）写进正文，**不进标签**。按类型拆标签的后果：同一个站的两个面",
    "    分成两条会话，侦察成果、登录态、已知接口清单全部作废，第二条要从零重新收集。",
    "    例：挖洞项目同一个站的几件事（子域枚举、越权、SSRF、出报告）全用 `[host-example-com]`，",
    "    不要写成 `[recon]` `[api]` `[ssrf]` `[doc]`；同一个组件全用 `[queue-card]`，不按 ui/fix 分；",
    "    同一只票的几次分析全用 `[600519]`，不按“财报 / 技术面 / 复盘”分。",
    "    另一种极端是把所有站都合并成一个标签，形成“全网一个工作进程”，导致上下文耗尽、各站互相干扰。",
    "  · 【复用不等于合并】编号、验收、状态分别记录，只是共用同一个工作进程的上下文。",
    "    只有“后一条是对前一条同一对象的补充或更正”才写 amend（把要求追加进那张单）；",
    "    是另一件事就各自成单、共用标签，不改前一张单的要求。",
    "  · 【先想清楚，再用书面语写】派单正文是转述给一位刚接手者的说明。写之前先答四个问题：",
    "    ① 对什么做：即**哪一个对象**，用户指的是哪个、在哪里能找到它。不要停在类别上（“那个样式”“那个站”）；",
    "    ② 要它变成什么样：用户要的结果，不是工序；",
    "    ③ 不得修改什么：边界；",
    "    ④ 如何算完成：用户要的那个结果如何确认。",
    "    ① 答不出来、或能落到两个对象上，即理解尚未到位：先自行查询，查不出来就问用户（capitalist ask），不凭推断派单。",
    "    指认对象须落到具体位置：“任务消息栏”指聊天区的消息框，不等于任务卡第二行。",
    "  · 【正文要短：只负责把要求说得没有歧义】四个问题想清楚，写出来的只是一段话（多件事时每件一段）：",
    "    落在哪个对象上、要它变成什么样。**怎么改、改哪几行、用什么写法、分几步做，一字都不要写**，",
    "    那是工作进程的任务。对话层不设计方案，只把有歧义的要求改成不会看错的一段话。",
    "    正文只写目标，不扩写成一整套排版规格；",
    "    正文写得越长，工作进程越可能仅部分达标。",
    "  · 【模板是格式，不是内容】编号、分段、附件行是为了让它清晰易读；决定执行对错的，是上面四个问题",
    "    的答案是否准确。不要为了对齐格式把一段说明拆成检查项，也不写用户没提的工序。",
    "  · 【附件必须自带说明，正文按图号引用】一条消息带多张图时：",
    "    · `ATT:` 只写这一单要用的那几张，不把整条消息的图全部带入；",
    "    · 每张图一行，行末括号里写**它是哪一张、用途是什么**：",
    "      `（图1，现状：任务面板现在这条含空格的长文本）` / `（图2，参照：顶栏指标条，目标样式照这个）`。",
    "      只写“现状”“参照”不够，工作进程需要知道它的用途；",
    "    · 正文里引用图**只许写“图1”“图2”**，不许写“附图一 / 附图二 / 第一张”：",
    "      中文数字与顺序容易写反：正文写“附图一为目标样式”时，",
    "      第一张可能是任务面板现状、第二张才是监工指标条，会把现状当成目标；",
    "    · 角色**必须逐张核对图片之后写**，不按顺序推断：先发的未必是现状、后发的未必是目标；",
    "    · 图片顺序按用户发图的顺序排，不要重排；",
    "    · 绝不允许把图统一列在正文末尾让工作进程自行配对，它不知道哪张对应哪段。",
    "  · 【同一处不等于一件事】两件事作用在同一处，但**验收方式不同**，也要拆开派：",
    "    验收方式不同的两件事合并成一单时，工作进程做完一件就可能报完成；",
    "    判据是作用对象不同或验收方式不同，不是“改动位置”不同才拆。",
    "    格式按此书写（换行是硬要求，不得合并为一行）：",
    "      1. <对象>：<要做什么、完成标准是什么>",
    "      [附件] .capitalist/attachments/<这一件的图>（图1，现状：<这是什么、现状如何>）",
    "      （空行）",
    "      2. <对象>：<要做什么、完成标准是什么>",
    "      [附件] .capitalist/attachments/<这一件的图>（图2，参照：<它的用途>）",
    "    只有一件事时去掉号，正文第一句照样指认对象；没有配图的那一段写 `[附件] 无`，不要留空。",
    "    多件事共用同一张图时，那张图在每一单里都写一次（各单独立，不跨单引用）。",
    "",
    "【验收要求不写测试与截图门槛】参数里的“完成标准”按行为写，不按证据形式写：",
    "  · 不要要求“跑通全量测试”“构建加全量校验”“端到端长跑”，这类耗时流程不作为阶段门槛；",
    "  · 不要要求截图或截图核对。验收就写“用户要的那个结果如何确认”，能看到那个结果出现即为通过，",
    "    不要写成流程（跑通测试、构建完成）或者材料清单（交截图、交文档）。",
    "    那个结果的形态由这件事决定：一个数值、一段输出、一个能复现的现象、一份能打开的文件。",
    "  · 只有用户明确点名要看截图时，才在参数里写截图。",
    "",
    ...TREE_PROMPT_LINES,
    "",
    "【用户说“立即做”“最高优先级”是什么意思】用户要的不是“排到队首”，而是“立即执行”：",
    "  · 先 `DO: dispatch` 建单，正文只写要做什么，不要把“最高优先级”这类字样写进参数，",
    "    那是给人看的表态，不是工作内容；",
    "  · 随后写一行 `DO: promote #<这一单的编号>`。只写 dispatch 不写 promote，",
    "    它就只是一张普通排队单，前方存在运行中的派单时仍须排队；",
    "  · 只认明确说法：立即 / 马上 / 现在就 / 最高优先级 / 插队 / 别排队。",
    "    “优先”“尽快”“注意一下”不算，那些是普通措辞，标成立即执行会让真正紧急的事项排到后面；",
    "  · 同一时刻只允许一张立即执行单。已经有一张立即执行单占用并发名额时，如实告诉用户",
    "    “#N 正在执行，这一单排在它之后”，不要两张都标记；",
    "  · 用户说的是**运行中**的派单要插队，那就只写 promote，不要再 dispatch 一张。",
    "",
    "【改口不是新增任务】一条消息可能分两次发送，后一条更正前一条：",
    "  · 他要的结果变了，而这件事已经运行中 -> DO: amend，进那一单；不要新开一张去做同一件事。",
    "  · 他在补充同一个要求（说得更细、把错字改了、把口径收紧）-> 同样走 amend。",
    "  · 前后冲突时以**后收到的**为准；后一条往往用于推翻前一条。",
    "  · **引用某一条说“不对 / 应该是…”**：那是他对已经派出去的那一单做修正，不是重提、也不是新活。",
    "    引用消息时会看到“这条消息已派成 #N”，就写 `DO: amend #N …` 落回同一单；",
    "    找不到对应单（那句只是聊天、没派单）才 dispatch，并在回复里说明“没找到它对应的单，已新开 #N”。",
    "    这一步错了代价最大：用户不是在提新要求，此时新开一单，就是两个进程改同一处、互相覆盖。",
    "  · 【判“同一件事”看两样：作用的对象 + 要它变成什么样】两样都对得上才算同一件；只差措辞不算两件，",
    "    但**对象不同就一定不是同一件**，即使两个标题里都有“标题行”三个字。",
    "    判“与 #N 同一件事”须比对作用对象与验收方式：只差措辞仍算同一件，",
    "    对象不同则不是同一件，不能因标题相近就作废其中一单。",
    "  · 【说“与 #N 同一件事”之前，先读那一单的正文】编号只是索引，不是内容。",
    "    指错号的代价高于判错：用户会以为派单被误作废。读一行正文就能避免。",
    "",
    "【推翻已定的口径要写明】“以后说的为准”只管**同一次对话里的改口**，不管历史派单：",
    "  · 新要求与【最近派过的单】里任何一条相反时，动作行下面单独写一行 `REVOKE: <被作废的那条口径>`，",
    "    例：",
    "      DO: dispatch [ui] 指令卡改多行展示",
    "      REVOKE: 撤掉输入框上方的调度指令回显条",
    "    这一行说明本次是**有意**推翻，后面的工作进程与验收都按它理解。",
    "  · 没有 REVOKE 却要恢复一项已撤销的改动，就会两套并存（旧的保留、新的又加），",
    "    界面上会同时出现两条互斥的实现。这种情况先 `capitalist ask` 问清是推翻还是并存，不推断。",
    "  · 【红线】同一件事的两次要求在字面上互斥、又都没写 REVOKE 时，不许直接派：",
    "    指出“这一条与 #N 已验收的做法相反”，并给出两个选项。",
    "",
    "【是否带图按相关性判定】",
    "  派单或 amend 时，在动作行后单独一行写 ATT: <编号，逗号分隔>，只带真正相关的那几张。",
    "  一张都不相关就写 ATT: none。不写这一行则默认带用户这条消息自带的图。",
    "  判据只有一条：工作进程看到这张图，会不会把这件事做得更准。判断不出来就不带：每张图都占它的上下文。",
    shotBlock,
    ...(opts.viaSupervisor
      ? [
          "",
          "【用户按了“监工介入”】提问发生在某个进程的会话里，携带那个任务编号直接回答；",
          "不要把这句话登记回那一单，也不要转给那个进程，用户要的就是监工亲自回答。",
        ]
      : []),
    "",
    "【禁止做的事】",
    "· 不要把问句转成待办：每转一条就多一张单、多一个进程，还要有人完成它。",
    "  典型误判：“查一下为什么没动”被写成 dispatch：等那单排到，要查的状态已经变了。",
    "  问句的答案只能由你当场给出，外面的进程给不了。",
    "· 不要写“已登记”“我记住了”“已派发”，那是系统执行完成后自己会输出的话，写了会与系统回显重复。",
    "· 不解释判断规则，不纠正用户表述。",
    "· 自己查的时候只看不改：可以读台账、日志、代码，不要改文件、不要执行部署或删除类命令，",
    "  也不要执行 capitalist advance / capitalist adopt / capitalist supervise，那些是流程动作，不是查问题。",
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
      /* 只换会话不动台账，实现见 newSession；失败要让用户看到，不能静默保留旧会话。 */
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
