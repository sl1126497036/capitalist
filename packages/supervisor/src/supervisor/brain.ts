/**
 * 调度决策入口。代码提供事实与可选动作，由模型选择动作。
 * 各数值只作为事实呈现，不作为放弃或重试的判据。
 */

import { askModel } from "./llm";
import { brainSessionOf, recentVerdicts } from "./brainLane";
import { loadSupervisor } from "../core/supervisor";

/** 一个可执行动作。`name` 由调用方在 `actions` 里声明，模型只能选声明过的。 */
export interface BrainAction {
  name: string;
  /** 动作参数，可为派单内容、分片名或派单 id。 */
  arg: string;
  /** 模型给的理由，落事件用。 */
  why: string;
}

export interface BrainResult {
  actions: BrainAction[];
  /** 原文，排查用。 */
  raw: string;
  /** 通道不可用或解析失败时为真，调用方按保守路径处理，不执行动作。 */
  fallback: boolean;
  /** `fallback` 的具体原因，由调用方写入事件。 */
  error?: string;
}

export interface DecideOptions {
  root: string;
  /** 待判定的问题，单句描述。 */
  question: string;
  /** 事实行（代码采集，不带结论）。 */
  facts: string[];
  /** 可选动作：只能选这里声明过的。 */
  actions: { name: string; desc: string }[];
  /** 会话 id：同类判断复用同一会话。 */
  session: string;
  timeoutMs?: number;
  /** 推理强度，缺省 `high`；低档位会把语义判定退化为关键词匹配。 */
  effort?: string;
}

/**
 * 提示词首轮给出完整规范，后续轮次只发事实；换代时重发全量，不依赖宿主压缩后的历史。
 * 事实段自包含，不引用会话前文。
 */
function buildPrompt(opts: DecideOptions, first: boolean, carry: string[]): string {
  return [
    "你是 capitalist 的调度大脑。看下面这些事实，决定下一步做什么。",
    "",
    "【你要决定的事】",
    opts.question,
    "",
    "【事实】",
    ...opts.facts.map((f) => `- ${f}`),
    ...(carry.length
      ? [
          "",
          "【上一代判过的（摘要，只作参考——结论要按下面的事实重新判，不要照搬）】",
          ...carry,
        ]
      : []),
    "",
    "【可用动作】",
    ...opts.actions.map((a) => `  ${a.name} — ${a.desc}`),
    ...(first
      ? [
          "",
          "【怎么想】",
          "1. 先看事实，不依据最后一行日志下结论——日志末尾常常只是一行报错。",
          "2. 分清「这次没成」和「这件事做不成」：前者换个时机还能成，后者再试一百次也一样。",
          "3. 已送达的要求优先于规则与统计，不以数据推翻。",
          "4. 不动也是一种决定：拿不准就选 wait，比乱动好。",
          "5. 参数会成为工作进程任务说明的派单类动作，参数要这么写：",
          "   - 先把用户给的材料（skill、任务描述、上下文）读透；理解不透就选澄清类动作问人，",
          "     不要把自己没读懂的原始表述原样转给工作进程。",
          "   - 参数必须自含：工作进程接收不到对话上下文，这一单的对象、现状、目标、",
          "     边界（哪些不许动）与验收一次写全。不允许出现「按上面说的」「接着刚才那单」这类",
          "     指代前文或需要跨单理解的表述——工作进程拿到派单时，派单正文就是它的全部信息。",
          "   - 参数只写这一单的工作内容本身，整理成结构完整、目标明确、无歧义的文字：要做什么、",
          "     改哪里、做到什么程度算完。先做后做、依赖谁这类调度安排留在调度层执行，不写进单子。",
          "   - 排版：并列事项逐条换行，一条一行，用 1. 2. 3. 或 ① ② ③ 起头；条目内不折断，",
          "     JSON、路径与命令不跨行；段与段之间空一行。",
          "   - 识别用户当前使用的语言，在任务说明末尾追加一条语言要求：思考过程、回复与产出文案",
          "     一律使用与用户相同的语言，代码与既有标识符除外。语言跟随用户的实际语言，不固定为某一种。",
          "6. 工作进程会话的复用按相关性判断，两种极端都浪费上下文：每单必新开、",
          "   或把全部任务并入同一个工作进程。判断依据：",
          "   - 与在跑任务同一模块或同一改动面、且那条会话上下文未接近上限时，才复用已有会话——",
          "     复用是为了提高上下文命中率（工作进程已读过相关代码），不是为了省开新会话的事。",
          "   - 与在跑任务无关、或那条会话上下文已接近上限时，新开；不把所有任务并入一个工作进程。",
        ]
      : ["", "判定要求与派单参数写法沿用本会话开头那一份，不要另立一套。"]),
    "",
    "【输出格式。一行一个动作，最多两条；最后一行写理由】",
    "  DO <动作名> <参数>",
    "  WHY <一句话>",
    "不需要动作就只写：",
    "  DO wait",
    "  WHY <一句话>",
  ].join("\n");
}

/** 解析模型输出，只保留声明过的动作名。 */
export function parseActions(
  raw: string,
  allowed: readonly string[],
): { actions: BrainAction[]; why: string } | null {
  const text = String(raw ?? "");
  const actions: BrainAction[] = [];
  let why = "";
  for (const line of text.split(/\r?\n/)) {
    const dm = /^\s*DO\s+([a-z_]+)\s*([\s\S]*)$/i.exec(line);
    if (dm) {
      const name = String(dm[1]).toLowerCase();
      if (!allowed.includes(name)) continue;
      actions.push({ name, arg: String(dm[2] ?? "").trim(), why: "" });
      continue;
    }
    const wm = /^\s*WHY[:：]?\s*(.+)$/i.exec(line);
    if (wm) why = String(wm[1]).trim().slice(0, 240);
  }
  if (actions.length === 0) return null;
  /* 理由写入每个动作，落事件时无需重读原文。 */
  return { actions: actions.map((a) => ({ ...a, why })), why };
}

/** 调用方负责采齐事实；本函数只发起模型调用并解析输出。 */
export async function decide(opts: DecideOptions): Promise<BrainResult> {
  const allowed = opts.actions.map((a) => a.name);
  /* `opts.session` 为车道基名，实际 id 可带代数；超阈值时换代并落事件，下一轮从空上下文开始。见 brainLane.ts。 */
  const lane = brainSessionOf(opts.root, opts.session);
  /* 换代后的首轮附上一代结论摘要；其余轮次不带入。 */
  const carry = lane.fresh && lane.gen > 0 ? recentVerdicts(opts.root, 6) : [];
  const r = await askModel({
    prompt: buildPrompt(opts, lane.fresh, carry),
    sessionId: lane.id,
    cwd: opts.root,
    /* `timeoutMs` 为空闲超时，有输出即重置；总时长上限由 llm 层控制，语义见 llm.ts 的 AskModelOptions。 */
    timeoutMs: opts.timeoutMs ?? 120_000,
    effort: opts.effort ?? "high",
    /* 使用监工记录中的模型（--capitalist-model），判定与看板对话保持同一口径。 */
    model: loadSupervisor(opts.root)?.supervisor_model || undefined,
  });
  if (!r.ok) {
    /* 调用失败时 `r.text` 为失败原因。 */
    return { actions: [], raw: r.text ?? "", fallback: true, error: r.text || "模型调用失败，未给出原因" };
  }
  const parsed = parseActions(r.text, allowed);
  if (!parsed) {
    /* 模型未按 `DO <动作>` 格式回答，error 保留原文片段。 */
    return {
      actions: [],
      raw: r.text,
      fallback: true,
      error: `模型输出里没有可解析的动作行（允许：${allowed.join(" / ")}），原文前 200 字：${String(r.text ?? "").slice(0, 200)}`,
    };
  }
  return { actions: parsed.actions, raw: r.text, fallback: false };
}
