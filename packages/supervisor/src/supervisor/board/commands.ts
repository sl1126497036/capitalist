
import { archiveFinished, listWorkers, loadWorker, loadSupervisor, readDispatches, setWorkerModel, wakeDispatch, workerModelPath } from "../../core/record/supervisor";
import { isWorkerRef, promoteTask, stopWorker } from "../../core/dispatch/commands";
import { loadState, updateState } from "../../core/record/state";
import { readJson } from "../../core/record/json";
import { recordEvent } from "../../core/record/ledger";
import type { ShotRef } from "../../core/message/messages";
import { unlinkSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";

import { resolveModel } from "../judge/modelPolicy";
import { rotateChatSession } from "../context/reload";
import { laneBaseId } from "../judge/sessionLane";
import { cBad, cId, cStr, type CommandResult } from "./cmdArgs";
import { clearPause, quoteDispatchLabel, reopenDispatch, resolveQuoteText, runCli, sayArgsOf, setPause, shardOfThread, workerOfThread, writeQuotedDirect } from "./cmdQuote";
import { diagnose } from "./snapshot";
import { markThreadCleared, threadStatusAbnormal, threadStatusTerminal } from "./state";
import { buildThreads } from "./threads";

/**
 * 看板命令执行：把界面上的操作翻译成监工指令或台账写入。
 *
 * 只做「校验入参 → 落盘 / 调 CLI」，不碰 HTTP，也不组装视图。
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
  "close",
  "promote",
  "answer",
  "block",
  "unblock",
  "stop-supervisor",
  "pause",
  "resume",
]);

export function workerSessionId(stage: string, shard: string): string {
  return laneBaseId(stage, shard);
}

export function clearRuntimeLedger(root: string): { dir: string; moved: number; stage: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(root, ".capitalist", "archive", `clear-${stamp}`);
  let moved = 0;
  try {
    mkdirSync(dir, { recursive: true });
    const targets = [
      join(root, ".capitalist", "tasks.jsonl"),
      join(root, ".capitalist", "inbox", "dispatch.jsonl"),
      join(root, ".capitalist", "workers", "index.jsonl"),
      join(root, ".capitalist", "direct.jsonl"),
      join(root, ".capitalist", "supervisor-direct.jsonl"),
      join(root, ".capitalist", "events.jsonl"),
    ];
    for (const f of targets) {
      try {
        if (!existsSync(f)) continue;
        renameSync(f, join(dir, basename(f)));
        moved += 1;
      } catch {
      }
    }
  } catch {
  }

  let stage = "";
  try {
    const st = loadState(root);
    const specPath = String((st as unknown as { contract_path?: string } | null)?.contract_path ?? "");
    const spec = specPath ? readJson<{ stages?: { id?: string }[] } | null>(specPath, null) : null;
    stage = String(spec?.stages?.[0]?.id ?? "");
    if (st && stage) {
      updateState(root, (s) =>
        Object.assign(s, {
          stage,
          stage_entered_at: new Date().toISOString(),
          counters: {},
          next_action: "",
          blockers: [],
        }),
      );
    }
  } catch {
  }
  return { dir, moved, stage };
}

/** 监工会话同一时刻只允许一条在调模型，顺序按发送顺序；带 thread 的工作进程会话仍并发。 */
let supervisorChatChain: Promise<void> = Promise.resolve();

export function serializeSupervisorChat<T>(fn: () => Promise<T>): Promise<T> {
  const run = supervisorChatChain.then(fn, fn);
  supervisorChatChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
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
    "  · 一张单只放一件事。同一块地方但验收方式不同，也算两件事：一个看视觉、一个看元素在不在，",
    "    分两单派；并入一单时，工作进程完成第一件后可能报完成，其余无人执行。",
    "  · 出现“另外 / 还有 / 顺便 / 第二个 / 再”时按新事项另起一行，不并入上一单。",
    "  · 第 2、3 件不写入第 1 件的参数里。每张单的正文都自含：只说这一件，不写“同上”“接着第 1 点”。",
    "  · 顺序写在参数开头的 `1.` `2.` `3.` 里，那是给人看的编号，不是把几件事串成一张单。",
    "  · 图号按用户发图顺序固定，不重排。",
    "  · 图跟单走：`ATT:` 写在它自己那张单的 `DO:` 行下面。写了 ATT 的单按它取图，未写 ATT 的单不带图。",
    "  · 正文里每提到一张图，必须附带它的内容特征，让编号和内容当场对上：",
    "    正确：“图1 那条 `上下文 ≈50.3k/600.0k` 的长串”“图2 那条带竖线和三个按钮的指标条”；",
    "    错：“图1 是参照样式”——没有内容特征，编号安错了也无从核对。",
    "  · 参照方向不可颠倒：“A 的样式参考 B”＝ B 是参照物（目标长这样），A 是要改的（现在不对）。",
    "    “参照”只能挂在 B 那张图上，挂在 A 上即方向颠倒。",
    "  · 每张图须逐张核对；正文引用它只写“图1”“图2”，不直接引用用户消息里的 `[附件] 路径` 行。",
    "  · 示例。用户发“这里不对（图1），照那边改（图2），另外把标题减小”，你写三张单：",
    "      DO: dispatch 1. <这里>：<要它变成什么样>",
    "      ATT: 1",
    "      DO: dispatch 2. <那边>：<照图2 改哪里>",
    "      ATT: 2",
    "      DO: dispatch 3. <标题>：<改到什么程度>",
    "      ATT: none",
    "  · 派单正文需给出每张图的内容特征；缺少特征时不派单。",
    "",
    "【不设计工序】派单就是任务本身：一件事建一张单，不要先拆成阶段",
    "  （“盘点->实现->验收”这种）。验收标准就在单里，由产出物证据判定；契约里只有一个空的",
    "  执行阶段，它不代表任何工序，也不要照着它派活。需要领域约束（红线、手法）时，",
    "  由用户指定某个 skill，读取该 skill 执行；领域规则不写进契约。",
    "",
    "【要“知道”的自己查，要“改”的才派】",
    "  · “为什么不动 / 怎么回事 / 卡在哪 / 是不是坏了 / 查一下”属查询，不生成待办。",
    "    状态、台账、日志与代码均可直接读取，读取后直接回答；派出的进程读取同一份内容。",
    "  · 只有“要落地改动（代码 / 数据 / 文件 / 配置 / 文档）、需要长时间运行、需要独立上下文”才开进程。",
    "    diagnose 仅用于对话层无法完成、需要长时间排查的任务；能自行回答的不派单。",
    "  · 派单需排队，轮到执行时单内所述现状可能已变化。派单正文写**目标**，不写**现状对比**：",
    "    · 不写“核查 #29 是否已过期，逐条给出作废/改写/保留”——该写法属代读台账。",
    "    · 写“把 <文件> 的 <行为> 改成 <目标行为>，验收读改动点确认”——现状由工作进程按目标核对。",
    "",
    "【动作面】判定依据为台账与派单状态。可用动作：",
    "  · 派单 / 补单（往已有单追加要求）/ 置顶立即执行 / 暂停调度与恢复 /",
    "    重试失败单 / 调并行度 / 重载上下文 / 重开（reload）。",
    "  · 启动时被暂停的旧派单只能由用户唤醒（看板“已暂停”筛选下逐单唤醒，或 capitalist wake --user）。",
    "    对话层不代为唤醒：这些单可能已过时，是否继续执行由用户判断。",
    "  · 结果检验：工作进程报完成后，读取报告中的完成项与改动位置，与派单要求比对。",
    "    报告声明“已完成”但改动对象与派单不一致时，按未完成处理。",
    "    接受、打回重做或换派单重派按判定结果选择。",
    "  · 调度本身也是任务：任务树怎么长、哪几单并行、哪单等哪单、并行度设几，由对话层判定。",
    "",
    "【能读到什么、能答什么】cwd 为任务根，可读取全部文件：",
    "  · `.capitalist/tasks.jsonl` 每单的 detail（要求原文）与 note（裁决结论）；",
    "  · `.capitalist/inbox/dispatch.jsonl` 派单正文、附件、状态、时间；",
    "  · `.capitalist/workers/*.log` 进程输出；`.capitalist/events.jsonl` 事件流水；",
    "  · 现成命令：`capitalist tasks`（每单要求与状态）、`capitalist worker <进程号>`（某个进程执行过什么）、",
    "    `capitalist status`（全局运行中/排队/异常）。查“为什么没动”时先执行这三条命令。",
    "  · 任务根下的内容不只代码：也可能是资产清单、数据集、报告、笔记或脚本。判断作用对象前不预设项目类型，",
    "    依据随内容而定：挖洞项目看站点与接口，代码项目看文件与组件，数据项目看表与字段。",
    "  · 凭这些能答：某单卡在哪、为什么没动、下一步怎么排；某条要求是否已实现、两份口径是否冲突；",
    "    调度历史（何时派出、被谁改过口径、哪步作废）；任务关系（`lineage` 重派血统、`merged_from` 归并来源、",
    "    父子与并行）；以及项目怎么跑、这段代码做什么、两个方案怎么选这类日常问题。",
    "    以上均可直接回答，不派单，也不另开一单去查。",
    "",
    "【进程之间不共享上下文】每张单的工作进程只拿到自己这一单的说明与自己这条会话。",
    "  同一个任务根是运行条件，不是信息通道：它没有理由、也不该去读别的单的正文、",
    "  别人的日志与会话。回复时不提及“工作进程能看见别的单 / 独立的是进程不是访问范围”；",
    "  被问到时按上面这句回答。",
    "",
    "【边界两条，不作为免责条款】",
    "  · 落地改动归工作进程：对话层判断、派单、验收，但不改动任务根内的文件（代码、数据、配置、文档都算）。",
    "  · 你不占并发槽：只有派出去的单才占，所以只读任务不派发。",
    "  · 除此之外没有禁区：答不上来的就去读，读完再答。",
    "",
    "【可写的动作行，一行一个，写在正文最后】",
    "  DO: dispatch [分类] <要做什么>   加一件新活。分类按**作用面**打一个词（组件 / 文件 / 脚本 / 数据 / 接口 / 配置），",
    "      同一块东西共用一个词、不同东西用不同的词——同词即同车道，工作进程会复用上一单的上下文。",
    "      分类**必须**用方括号包住，紧跟在 dispatch 后面：`dispatch [queue-card] 把第二行改成标签加数值`。",
    "      不写方括号，这个词就成了正文的第一个字——界面上这一单的标题会变成“ui 把顶部那行指标”，",
    "      而且它不会和其它同类活共用上下文。宁可写 [misc] 也不要省掉括号。",
    "  DO: amend #<编号> <补充或更正的内容>     这句话是在改已经开始的那一单（见下面“改口”）",
    "      编号就是上面【任务编号表】里的号，**必须写**，且写在正文最前面。不写号会被拒绝，",
    "      系统不代为推断目标单。",
    "      例：`DO: amend #02 顶栏不许再渲染状态徽章`。",
    "  DO: diagnose <查什么>  /  DO: fix <卡在哪>   查根因 / 查完直接修",
    "  DO: pause  /  DO: resume  /  DO: retry <分片>  /  DO: concurrency <数字>  /  DO: reload",
    "  DO: promote #<编号>   把这张排队中的单置顶并立刻执行（槽满时挂起一张运行中的任务腾槽）",
    "  没写成动作行就没有执行。不要声称已追加或已派单，回执由系统在动作执行后给出。",
    "",
    "【重派前先核对卡点】retry 一个失败过（或中途被结）的任务之前，必须先核对原任务的卡点：",
    "  上次失败的原因、阻塞项（缺依赖、缺权限、前置单未完成、要求矛盾等）现在是否已经消除。",
    "  卡点仍然存在的任务不要重派——重派只会在同一处再次失败。核对后仍不重派的，",
    "  在回复里写明具体原因（卡点是什么、为何暂不重派）；卡点已消除（依赖装好、前置完成、口径已改）才写 retry。",
    "",
    "【派单前先读懂，派单时写清楚】dispatch 和 amend 的参数就是工作进程拿到的任务说明：",
    "  · 生成派单参数之前，先读齐相关上下文再下笔：任务台账里这张单（含其父单、同类单）的",
    "    完整历史与已派单的结论、失败原因；涉及的实际对象与现状。确认理解与现状无偏差，",
    "    才能开始写参数；读不出把握的部分直接问用户，不要带着含糊下笔。",
    "  · 参数里写明关键上下文锚点，让工作进程无需猜测：涉及哪些模块或界面、当前行为是什么、",
    "    做到什么程度算完、不许改动的边界（哪些文件 / 模块 / 行为这一单不许碰）。",
    "    · 用户给了 skill、文档或一段任务描述，先读完读懂；理解不透就直接问用户要哪部分，",
    "    不要把自己没读懂的原始表述原样写入参数转给工作进程。",
    "  · 参数只写这一单的工作内容，整理成结构完整、目标明确、无歧义的一段话：要做什么、",
    "    改哪里、做到什么程度算完。不直接引用用户的口语表述。",
    "  · 【一件活一张单】作用对象不同，或验收方式不同，即为两件事：各写一条 `DO: dispatch`。",
    "    合并为一张时，工作进程无法确定执行顺序，可能只完成其中一部分即申报完成，验收阶段也无法判定未达标项。",
    "  · 【按消息里的顺序编号】一条消息拆成几单时，按消息里的先后给 1、2、3……，每单正文以**它自己的号**",
    "    开头（第 2 件就写“2. ”），号跟着这件事走、拆单后不重排；只有一件事时不写号。",
    "    编号用于对齐工作进程与用户：缺少编号时无法判断当单对应第几件事。",
    "  · 【顺序就是用户发的顺序】他连发几条，就按第 1、2、3 条的顺序判断与派单，后一条不越过前一条的顺序。",
    "  · 【相关就复用同一个工作进程，避免每单重新读取】分类标签不只是分类，它是**工作车道**：",
    "    同标签的单会接到同一个工作进程的上下文上，上一单读过的东西、动过的对象都还在（缓存命中，省时省钱）。",
    "    所以后一条与前一条作用在同一处、同一个对象、验收互相牵连时，**用同一个标签**派新单，使其延续已有上下文。",
    "    上下文余量由车道自己卡（占窗口六成就自动换新代），你不用自己算，也不用为了省上下文拆标签。",
    "    要真正复用上，给它写 `PARENT: #<前一张>`：等前一张做完、车道空出来，它启动时直接续接同一会话。",
    "    两单同时拉起反而各自换新代——同一条车道一次只允许一个进程，冲突时会换代并丢失上下文。",
    "    所以同一个对象有多单时默认串成链（后一单挂前一单）：同一个站的子域枚举 -> 越权 -> SSRF -> 出报告。",
    "    什么时候不建链：几件事互不依赖、更看重速度、或者前一张已经把上下文用掉大半——那就并行，代价是各自重读一遍。",
    "    跨对象永远并行：两个不同的站、两只不同的票，是两条链同时跑。",
    "  · 【上下文一定会换，结论必须落盘】车道到窗口六成就换代，新进程看不到上一单说过什么。",
    "    所以要求工作进程把**已经确认的结论写进文件**（清单、scope、笔记、报告草稿），别只留在对话里；",
    "    后一单的第一件事是读这些文件。尤其在长链里（一个站十几个面），靠上下文接力一定会断，靠文件不会。",
    "  · 【标签第一维永远是“对象”，不是动作或类型】对象 = 这件事作用在**哪一个**东西上（那个站、那个项目、",
    "    那份数据、那个主题）。同对象的多单必须同标签（同车道＝共享已经读过的东西）；",
    "    不同对象换标签（不同车道才能并行，也不会互相污染）。",
    "    第二维（漏洞面 / 改动类型 / 当前阶段）写进正文，**不进标签**。按类型拆标签的后果：同一个站的两个面",
    "    落到两条车道，侦察成果、登录态、已知接口清单全部作废，第二条从零再来一遍。",
    "    例：挖洞项目同一个站的几件事（子域枚举、越权、SSRF、出报告）全用 `[host-example-com]`，",
    "    不要写成 `[recon]` `[api]` `[ssrf]` `[doc]`；同一个组件全用 `[queue-card]`，不按 ui/fix 分；",
    "    同一只票的几次分析全用 `[600519]`，不按“财报 / 技术面 / 复盘”分。",
    "    另一种极端是把所有站都打成一个标签，形成“全网一个工作进程”——上下文耗尽、各站互相干扰。",
    "  · 【复用不等于合并】编号、验收、状态各记各的，只是落在同一个工作进程的上下文里。",
    "    只有“后一条是对前一条同一对象的补充或更正”才写 amend（把要求追加进那张单）；",
    "    是另一件事就各自成单、共用标签，不改前一张单的要求。",
    "  · 【先想清楚，再用书面语写】派单正文是转述给一个刚接手的人的一段话。写之前先答四个问题：",
    "    ① 对什么做——就是**哪一个东西**：用户说的是哪个、在哪能找到它。不要停在类别上（“那个样式”“那个站”）；",
    "    ② 要它变成什么样——用户要的结果，不是工序；",
    "    ③ 不许碰什么——边界；",
    "    ④ 怎么算做完——他要的那个结果怎么确认。",
    "    ① 答不出来、或者能落到两个东西上，就是还没懂：先自己查，查不出来就问用户（capitalist ask），不凭推断派单。",
    "    指认对象须落到具体位置：“任务消息栏”指聊天区的消息框，不等于任务卡第二行。",
    "  · 【正文要短：只负责把要求说得没有歧义】四个问题想清楚，写出来的只是一段话（多件事时每件一段）：",
    "    落在哪个东西上、要它变成什么样。**怎么改、改哪几行、用什么写法、分几步做，一个字都不要写**——",
    "    那是工作进程的任务。对话层不设计方案，只把有歧义的要求改成不会看错的一段话。",
    "    正文只写目标，不扩写成一整套排版规格；",
    "    正文写得越长，它越可能只做对一半。",
    "  · 【模板是格式，不是内容】编号、分段、附件行是为了让它读得清；决定它做对做错的，是上面四个问题",
    "    答得准不准。不要为了对齐格式把一段说明拆成检查项，也不写用户没提的工序。",
    "  · 【附件必须自带说明，正文按图号引用】一条消息带多张图时：",
    "    · `ATT:` 只写这一单要用的那几张，不把整条消息的图全部带入；",
    "    · 每张图一行，行末括号里写**它是哪一张、干什么用的**：",
    "      `（图1 · 现状：任务面板现在这条空格长串）` / `（图2 · 参照：顶栏指标条，目标样式照这个）`。",
    "      只写“现状”“参照”不够——工作进程得知道拿它干什么；",
    "    · 正文里引用图**只许写“图1”“图2”**，不许写“附图一 / 附图二 / 第一张”：",
    "      中文数字与顺序容易写反：正文写“附图一为目标样式”时，",
    "      第一张可能是任务面板现状、第二张才是监工指标条，会把现状当成目标；",
    "    · 角色**必须逐张核对图片之后写**，不按顺序推断：先发的未必是现状、后发的未必是目标；",
    "    · 图片顺序按用户发图的顺序排，不要重排；",
    "    · 绝不许把图统一列在正文末尾让工作进程自己配对——它不知道哪张对应哪段。",
    "  · 【同一处不等于一件事】两件事作用在同一块地方，但**验收方式不同**，也要拆开派：",
    "    验收方式不同的两件事合并成一单时，工作进程做完一件就可能报完成；",
    "    判据是作用对象不同或验收方式不同，不是“改的地方”不同才拆。",
    "    格式照这个写（换行是硬要求，不许压成一行）：",
    "      1. <对象>：<要做什么、做到什么程度算完>",
    "      [附件] .capitalist/attachments/<这一件的图>（图1 · 现状：<这是什么、现在什么样>）",
    "      （空行）",
    "      2. <对象>：<要做什么、做到什么程度算完>",
    "      [附件] .capitalist/attachments/<这一件的图>（图2 · 参照：<拿它干什么>）",
    "    只有一件事时去掉号，正文第一句照样指认对象；没有配图的那一段写 `[附件] 无`，不要留空。",
    "    多件事共用同一张图时，那张图在每一单里都写一次（各单独立，不跨单引用）。",
    "",
    "【验收要求不写测试与截图门槛】参数里的“做到什么程度算完”按行为写，不按证据形式写：",
    "  · 不要要求“跑通全量测试”“构建加全量校验”“端到端长跑”——耗时流程不作为阶段门槛；",
    "  · 不要要求截图或截图核对。验收就写“他要的那个结果怎么确认”——能看到那个结果出现就算过，",
    "    不要写成流程（跑通测试、构建完成）或者材料清单（交截图、交文档）。",
    "    那个结果长什么样由这件事决定：一个数值、一段输出、一个能复现的现象、一份能打开的文件。",
    "  · 只有用户明确点名要看截图时，才在参数里写截图。",
    "",
    "【派单顺序是多节点，不是一条队】每张派单是树上一个节点：最多一个父节点（做完它才能开始），",
    "  同父的节点是兄弟（可以同时跑），没有父节点的节点自成一棵树，树与树之间互不影响。",
    "  派单时先判断这一单属于哪一种，判断写进数据，不写在参数里：",
    "  · 要先等某一单做完 -> 动作行下面写两行：",
    "      PARENT: #<编号>",
    "      PARENT_REASON: <为什么必须先做它，一两句，写清等的是它的哪个产出>",
    "    例：",
    "      DO: dispatch [ui] 重做顶栏布局",
    "      PARENT: #03",
    "      PARENT_REASON: 新顶栏按 #03 定稿的栅格尺寸排版，提前做会全部返工",
    "  · 可以同时做 -> 写 `PARENT: none`。先后关系不成立就不要挂父节点：为了整齐建立 A->B->C",
    "    的长链，会把本来能并行的活压成单列。",
    "  · 兄弟由“同父”自动形成：两张单都写 `PARENT: #03`，父节点完成后两张一起进队列。",
    "  · 父节点编号必须出现在【任务编号表】里。父节点不存在、已被结项（closed）、或成环时，",
    "    该派单会被拒绝并给出原因；不挂父节点重新提交，不会静默降级为无依赖。",
    "  · 老写法 `AFTER: #<编号>` 仍然有效（多个编号 = 多个前置；收尾单写 `AFTER: *`）。",
    "    只有确实要同时等多个单时才用它，单条先后关系写 PARENT。",
    "  · 【红线】参数里绝不许出现“等…完成再做…”“先做 X 再改 Y”这类顺序句。工作进程看不到别的单、",
    "    也没法等：它只会空转，同时占着并发槽，被等的那一单永远排不上——两边互相等死。",
    "    顺序一律用 `PARENT:` 表达：挂着父节点的单在父节点完成前不会启动，也就不占槽。",
    "    参数含顺序句时，工作进程会占住并发槽等待另一单完成，两条派单互相阻塞。",
    "    顺序关系一律写入数据，不写进参数。",
    "",
    "【他说“立即做”“最高优先级”是什么意思】他要的不是“排到队首”，是“马上跑”：",
    "  · 先 `DO: dispatch` 建单，正文只写要做什么——不要把“最高优先级”这几个字写进参数，",
    "    那是给人看的表态，不是工作内容；",
    "  · 紧跟着写一行 `DO: promote #<这一单的编号>`。只写 dispatch 不写 promote，",
    "    它就只是一张普通排队单，前方存在运行中的派单时仍须排队；",
    "  · 只认明确说法：立即 / 马上 / 现在就 / 最高优先级 / 插队 / 别排队。",
    "    “优先”“尽快”“注意一下”不算——那些是普通措辞，标成立即执行会把真正的急事挤掉；",
    "  · 同一时刻只允许一张立即执行单。已经有一张在抢槽时，如实告诉用户",
    "    “#N 正在执行，这一单排在它之后”，不要两张都标；",
    "  · 用户说的是**运行中**的派单要插队，那就只写 promote，不要再 dispatch 一张。",
    "",
    "【改口不是新增任务】一条消息可能分两次发送，后一条更正前一条：",
    "  · 他要的结果变了，而这件事已经运行中 -> DO: amend，进那一单；不要新开一张去做同一件事。",
    "  · 他在补充同一个要求（说得更细、把错字改了、把口径收紧）-> 同样走 amend。",
    "  · 前后冲突时以**后收到的**为准；后一条往往用于推翻前一条。",
    "  · **引用某一条说“不对 / 应该是…”**：那是他对已经派出去的那一单做修正，不是重提、也不是新活。",
    "    引用消息时会看到“这条消息已派成 #N”，就写 `DO: amend #N …` 落回同一单；",
    "    找不到对应单（那句只是聊天、没派单）才 dispatch，并在回复里说明“没找到它对应的单，已新开 #N”。",
    "    这一步错了代价最大：他不是在提新要求，你新开一单，就是两个进程改同一处、互相覆盖。",
    "  · 【判“同一件事”比两样：作用的对象 + 要它变成什么样】两样都对得上才算同一件；只差措辞不算两件，",
    "    但**对象不同就一定不是同一件**——哪怕两个标题里都有“标题行”三个字。",
    "    判“与 #N 同一件事”须比对作用对象与验收方式：只差措辞仍算同一件，",
    "    对象不同则不是同一件，不能因标题相近就作废其中一单。",
    "  · 【说“与 #N 同一件事”之前，先读那一单的正文】编号只是索引，不是内容。",
    "    指错号比判错更伤：用户会以为派单被误作废。读一行正文就能避免。",
    "",
    "【推翻已定的口径要写明】“以后说的为准”只管**同一次对话里的改口**，不管历史派单：",
    "  · 新要求与【最近派过的单】里任何一条相反时，动作行下面单独写一行 `REVOKE: <被作废的那条口径>`，",
    "    例：",
    "      DO: dispatch [ui] 指令卡改多行展示",
    "      REVOKE: 撤掉输入框上方的调度指令回显条",
    "    这一行说明本次是**有意**推翻，后面的工作进程与验收都按它理解。",
    "  · 没有 REVOKE 却要恢复一个已经撤掉的东西，就是两套并存（旧的不拆、新的又加），",
    "    界面上会同时出现两条互斥的实现。这种情况先 `capitalist ask` 问清是推翻还是并存，不推断。",
    "  · 【红线】同一件事的两次要求在字面上互斥、又都没写 REVOKE 时，不许直接派：",
    "    指出“这一条与 #N 已验收的做法相反”，并给出两个选项。",
    "",
    "【是否带图按相关性判定】",
    "  派单或 amend 时，在动作行后单独一行写 ATT: <编号，逗号分隔>，只带真正相关的那几张。",
    "  一张都不相关就写 ATT: none。不写这一行则默认带用户这条消息自带的图。",
    "  判据只有一条：工作进程看到这张图，会不会把这件事做得更准。看不出来就不带——每张图都占它的上下文。",
    shotBlock,
    ...(opts.viaSupervisor
      ? [
          "",
          "【用户按了“监工介入”】提问发生在某个进程的会话里，携带那个任务编号直接回答；",
          "不要把这句话登记回那一单，也不要转给那个进程——他要的就是监工自己来说。",
        ]
      : []),
    "",
    "【别做的事】",
    "· 不要把问句翻成待办：每翻一个就多一张单、多一个进程，还要有人做完它。",
    "  典型误判：“查一下为什么没动”被写成 dispatch——等那单排到，要查的状态已经变了。",
    "  问句的答案只能你当场给，外面的进程给不了。",
    "· 不要写“已登记”“我记住了”“已派发”——那是系统执行完自己会说的话，写了会与系统回显重复。",
    "· 不解释判断规则，不纠正用户表述。",
    "· 自己查的时候只看不改：可以读台账、日志、代码，不要改文件、不要跑部署或删除类命令，",
    "  也不要执行 capitalist advance / capitalist adopt / capitalist supervise——那些是流程动作，不是查问题。",
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
        recordEvent(root, "direct_inject", { thread: thread ?? "", shard: target ?? "", text: text.slice(0, 120) });
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
            ? `已唤醒原派单 ${woke} · 下一轮携带本条消息继续执行（保留原上下文）`
            : target
              ? `下一次 ${target} 分片派单`
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
        body: { ok: true, action, shard: target || "all", detail: r.stdout, effective: "下一 tick 起监工不再自动重派/验收该片" },
      };
    }
    case "release": {
      // 只给 id 时只交还该线程所属分片。
      const target = shard || shardOfThread(root, thread);
      const r = runCli(["release", target || "all", "--root", root]);
      if (r.code !== 0) return { status: 400, body: { error: r.stderr || r.stdout || "交还失败", action } };
      return {
        status: 200,
        body: { ok: true, action, shard: target || "all", detail: r.stdout, effective: "下一 tick 起恢复自动重派与验收" },
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
            ? `已置顶 · 立即执行单 ${r.behind} 仍运行中，这一单排在它之后`
            : willRun
              ? `已置顶 · 当前 ${live}/${cap} 槽有空，下一轮拉起`
              : `已置顶 · 下一轮挂起一个运行中的任务腾出槽位；被让位的任务显示“已让位”，这一单结束后按原顺序恢复`,
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
          body: { error: "该派单不在暂停状态，或已结项", action, thread, dispatch: target },
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
          effective: "下一 tick 起按队列顺序参与调度",
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
      if (r.code !== 0) return { status: 409, body: { error: r.stderr || r.stdout || "结项失败", action, thread } };
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
              : "该派单已结项，监工不再为其补单",
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
          effective: "下一 tick 重派这一单（除非该片已被接管或登记了阻塞）",
        },
      };
    }
    case "worker-model": {
      if (!thread && !shard) return cBad("id 必填");
      const model = String(body.model ?? "").trim();
      const wid = workerOfThread(root, thread, shard);
      if (!wid) {
        return { status: 409, body: { error: "该线程当前没有运行中的进程，无法切换模型", action, thread } };
      }
      const rec = loadWorker(root, wid);
      const sh = String(rec?.shard ?? shard ?? "").trim();
      const pick = resolveModel({
        root,
        host: String(loadSupervisor(root)?.worker_host ?? ""),
        wanted: model,
      });
      if (model && pick.denied) {
        return cBad(`${model} 在禁用名单里（${pick.why}）`);
      }
      if (pick.model) {
        setWorkerModel(root, sh, pick.model);
      } else {
        /** 选“默认”即不再指定，回到契约或启动参数里的模型。 */
        try {
          unlinkSync(workerModelPath(root));
        } catch {
        }
      }
      const stopped = stopWorker(root, wid, { requeue: true, reason: "换模型重启" });
      if (!stopped) return { status: 400, body: { error: "该进程记录已不存在，切换失败", action } };
      return {
        status: 200,
        body: {
          ok: true,
          action,
          worker: wid,
          model,
          dispatch: stopped.dispatch,
          effective: model
            ? `已切到 ${model}：当前进程随即结束，下一轮用新模型接着跑这一单，会话历史保留`
            : "已切回默认模型：当前进程随即结束，下一轮接着跑这一单",
        },
      };
    }
    case "clear-threads": {
      const raw = String(body.bucket ?? "all");
      const bucket = (
        ["all", "done", "bad", "run", "queue"].includes(raw) ? raw : "all"
      ) as "all" | "done" | "bad" | "run" | "queue";
      const r = archiveFinished(root, bucket);
      /** bucket=all 才做整根重置；顺序为先清台账与进度，再换会话，最后回执。 */
      let wiped: { dir: string; moved: number; stage: string } | null = null;
      if (bucket === "all") {
        try {
          wiped = clearRuntimeLedger(root);
        } catch {
          wiped = null;
        }
      }
      let sessionId = "";
      try {
        /* 换会话与本工作区换代共用 rotateChatSession，会话 id 构造口径只有一份。 */
        sessionId = rotateChatSession(root, "gen", 0).session_id;
      } catch {
        /** 换会话失败不让清空列表本身失败。 */
      }
      const bits: string[] = [];
      bits.push(`已清空 ${r.workers} 个进程记录、${r.dispatches} 张派单`);
      if (wiped && wiped.moved > 0) {
        bits.push(`台账已归档 ${wiped.moved} 份到 .capitalist/archive/${basename(wiped.dir)}`);
      }
      if (wiped?.stage) bits.push(`阶段进度回到 ${wiped.stage}`);
      if (sessionId) bits.push(`监工对话已换新会话（${sessionId}）`);
      return {
        status: 200,
        body: {
          ok: true,
          action,
          bucket,
          workers: r.workers,
          dispatches: r.dispatches,
          dir: r.dir,
          session: sessionId,
          effective: bits.join("，"),
        },
      };
    }
    case "clear-thread": {
      const key = cId(body.key, "key") ?? "";
      if (!key) return cBad("key 必填（任务卡的线程 id）");
      const t = buildThreads(root).find((x) => x.id === key);
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
        if (closed.code === 0) closedBit = "派单已结项，监工不再重派；";
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
      try {
        setPause(root, reason);
      } catch (err) {
        return { status: 400, body: { error: err instanceof Error ? err.message : String(err), action } };
      }
      return {
        status: 200,
        body: {
          ok: true,
          action,
          detail: "已暂停，.capitalist/pause.json 已写入",
          effective: "下一轮起不再派新单，手里的进程随后被停掉；恢复调度后按原样重派",
        },
      };
    }
    case "resume": {
      try {
        clearPause(root);
      } catch (err) {
        return { status: 400, body: { error: err instanceof Error ? err.message : String(err), action } };
      }
      return {
        status: 200,
        body: { ok: true, action, detail: "已恢复", effective: "下一 tick 起监工恢复派单" },
      };
    }
    default:
      return cBad(`未知动作：${action}`);
  }
}
