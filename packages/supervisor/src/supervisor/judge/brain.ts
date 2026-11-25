/**
 * 调度决策入口：代码提供事实与可选动作，模型选择动作。
 * 数值仅作为事实，不作为放弃或重试的判据。
 */

import { askModel } from "../channel/llm";
import { brainSessionOf, recentVerdicts } from "./brainLane";
import { loadSupervisor } from "../../core/record/supervisor";
import { supervisorModelOf } from "./supervisorModel";

/** 可执行动作；name 必须由调用方在 actions 中声明。 */
export interface BrainAction {
  name: string;
  /** 动作参数：派单内容、分片名或派单 id。 */
  arg: string;
  /** 模型给出的理由，用于记录事件。 */
  why: string;
}

export interface BrainResult {
  actions: BrainAction[];
  /** 模型原始输出，用于排查。 */
  raw: string;
  /** 通道不可用或解析失败时为 true；调用方不得执行动作。 */
  fallback: boolean;
  /** fallback 原因，由调用方写入事件。 */
  error?: string;
}

export interface DecideOptions {
  root: string;
  /** 待判定事项，使用单句描述。 */
  question: string;
  /** 由代码采集的事实，不包含结论。 */
  facts: string[];
  /** 可选动作；模型只能选择其中声明的动作。 */
  actions: { name: string; desc: string }[];
  /** 同类判断复用的会话 id。 */
  session: string;
  timeoutMs?: number;
  /** 推理强度，默认 high；低档位可能退化为关键词匹配。 */
  effort?: string;
}

/**
 * 首轮发送完整规范，后续轮次只发送事实；会话换代时重发规范。
 * 每轮事实自包含，不依赖会话前文。
 */
function buildPrompt(opts: DecideOptions, first: boolean, carry: string[]): string {
  return [
    "你是 capitalist 的判定层。根据事实，从可用动作中选择下一步。",
    "",
    "【待判定事项】",
    opts.question,
    "",
    "【事实】",
    ...opts.facts.map((f) => `- ${f}`),
    ...(carry.length
      ? [
        "",
        "【上一代结论摘要】",
        "仅供参考；必须依据本轮事实重新判定。",
        ...carry,
      ]
      : []),
    "",
    "【可用动作】",
    ...opts.actions.map((a) => `  ${a.name} — ${a.desc}`),
    ...(first
      ? [
        "",
        "【判定要求】",
        "1. 以完整事实为依据，不根据日志末行单独下结论。",
        "2. 区分暂时未成功与客观不可行：前者可调整条件重试，后者重试无效。",
        "3. 已送达的用户要求优先于规则和统计，不得以数据推翻明确要求。",
        "4. 证据不足或无法确定时不执行操作：若可用动作中包含 wait，则选择 wait；否则不输出 DO 动作。",
        "5. 派单类动作的参数将直接作为工作进程的任务说明，须符合以下规范：",
        "   - 先阅读用户提供的材料（skill、任务描述及相关上下文）；无法理解时选择澄清类动作，不得转发未理解的原文。",
        "   - 参数必须自包含：明确任务对象、现状、目标、修改边界及验收标准。工作进程无法访问对话上下文，禁止使用“如上所述”“继续上一单”等跨上下文指代。",
        "   - 参数只描述本单任务，明确任务内容、作用对象和完成判据；先后顺序及依赖关系由调度层处理，不写入任务正文。",
        "   - 并列事项逐条换行并编号（1. 2. 3. 或 ① ② ③）；条目内不拆行，JSON、路径和命令不得跨行，段落之间空一行。",
        "   - 按用户当前使用的语言撰写任务说明，并在末尾注明：思考、回复及产出文案均使用该语言，代码和既有标识符除外。",
        "6. 按任务相关性复用工作进程会话，避免无差别新建或全部合并：",
        "   - 与运行中任务属于同一对象或作用面，且其会话上下文未接近上限时，复用该会话，以利用已读取的相关材料。",
        "   - 任务无关或原会话上下文接近上限时，新建会话；不得将所有任务合并到同一工作进程。",
      ]
      : ["", "判定要求及派单参数规范沿用本会话首轮内容。"]),
    "",
    "【输出格式：每个动作一行，最后一行给出理由】",
    "  DO <动作名> <参数>",
    "  WHY <一句话>",
    "无须执行动作时，仅输出：",
    "  DO wait",
    "  WHY <一句话>",
  ].join("\n");
}

/** 解析模型输出，仅接受已声明的动作名。 */
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
  /* 将理由写入每个动作，供事件记录直接使用。 */
  return { actions: actions.map((a) => ({ ...a, why })), why };
}

/** 调用方负责采集事实；本函数只调用模型并解析输出。 */
export async function decide(opts: DecideOptions): Promise<BrainResult> {
  const allowed = opts.actions.map((a) => a.name);
  /* 会话 id 可带代数；达到阈值后换代并记录事件，详见 brainLane.ts。 */
  const lane = brainSessionOf(opts.root, opts.session);
  /* 新一代首轮附带上一代结论摘要；其他轮次不携带。 */
  const carry = lane.fresh && lane.gen > 0 ? recentVerdicts(opts.root, 6) : [];
  const r = await askModel({
    prompt: buildPrompt(opts, lane.fresh, carry),
    sessionId: lane.id,
    cwd: opts.root,
    /* timeoutMs 是无输出超时；总时长上限由 llm 层控制，详见 AskModelOptions。 */
    timeoutMs: opts.timeoutMs ?? 120_000,
    effort: opts.effort ?? "high",
    /* 使用监工配置的模型（--capitalist-model），保持判定口径一致。 */
    model: supervisorModelOf(opts.root),
  });
  if (!r.ok) {
    /* 调用失败时，r.text 保存失败原因。 */
    return { actions: [], raw: r.text ?? "", fallback: true, error: r.text || "模型调用失败，未给出原因" };
  }
  const parsed = parseActions(r.text, allowed);
  if (!parsed) {
    /* 输出不符合 DO <动作> 格式时，保留原文供排查。 */
    return {
      actions: [],
      raw: r.text,
      fallback: true,
      error: `模型没有给出可执行的动作。`,
    };
  }
  return { actions: parsed.actions, raw: r.text, fallback: false };
}
