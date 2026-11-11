/**
 * 监工判定层：按申报与证据产出 `TriageVerdict`，动作由 `loop.ts` 执行。
 *
 * 判定覆盖卡点、方向、红线、质量与报告审查；模型通道不可用或输出无法解析时返回 `continue`，并在 `why` 写明原因。
 */

import type { Contract } from "../core/contract";
import type { MqMessage } from "../core/mq";
import type { TaskState } from "../core/types";
import { decide } from "./brain";
import { acceptanceFacts } from "./closeOut";

export type TriageDecision =
  | "continue" /* 不影响推进，仅记录 */
  | "nudge" /* 方向或做法偏了：给出纠正说明，工作进程继续执行 */
  | "requeue" /* 做法走不通：重开并改用其它做法 */
  | "pause_shard" /* 暂停该分片 */
  | "escalate" /* 需人工裁决：红线、权限、需求冲突 */
  | "accept" /* 报告审查通过 */
  | "reject"; /* 报告审查不通过，打回 */

export interface TriageVerdict {
  decision: TriageDecision;
  why: string;
  /** `nudge` / `reject` 时送达工作进程的话，写入 direct 队列，下一次派单生效。 */
  say?: string;
  /** 模型判定的严重度，覆盖申报方自报值。 */
  severity?: "info" | "warn" | "critical";
  /** 解析或通道失败时置 true，调用方回落确定性流程，不执行动作。 */
  fallback?: boolean;
  /** `fallback` 的具体原因，随事件与界面回执一并传递。 */
  error?: string;
}

export interface TriageInput {
  root: string;
  contract: Contract;
  state: TaskState;
  msg: MqMessage;
  /** 这一单原本要做什么（派单 action），供判断偏航。 */
  action: string;
  /** 同一片/同一单最近的失败次数。 */
  failures: number;
  /** 当前运行的进程数 / 并行度上限。 */
  live: number;
  capacity: number;
  /** 当前阶段门槛的缺项。 */
  gateMissing: string[];
  /** 最近的失败原因（截断）。 */
  recent: string[];
  /** 工作进程在报告中承认的执行期间新增/更正要求（`capitalist report --added`），供按最新口径审查。 */
  addedReqs?: string[];
  /** 报告证据（`capitalist report --evidence`）；优先取 `msg.evidence`，两者都无时按“只有自述”处理。 */
  evidence?: string;
  /** 代码采集的工作区版本控制变动；非版本控制目录下为空数组，段不占位。 */
  workspace?: string[];
  /** 用户针对这一单的定向插话，时间正序。 */
  userWords?: string[];
  /** 逐条对账材料：系统按送达记录列全的每条要求及执行侧结论，与 {@link addedReqs} 的自行申报不同；未给结论记为“未给结论”。 */
  directiveLedger?: string[];
}

/** 判定提示词，输出格式固定为三行。 */
function buildPrompt(input: TriageInput): string {
  const m = input.msg;
  return [
    "你是 capitalist 监工的判定层。一个工作进程刚刚发来一条申报，你要决定监工怎么处理。",
    "",
    "【这一单原本要做什么】",
    String(input.action || "(未记录)").slice(0, 900),
    "",
    "【它申报了什么】",
    `类型：${m.kind} ｜ 自报严重度：${m.severity} ｜ 是否需要监工：${m.needs}`,
    `内容：${String(m.text || "").slice(0, 1200)}`,
    ...(m.evidence ? ["", "【它给的证据】", String(m.evidence).slice(0, 1600)] : []),
    "",
    "【当前局面】",
    `阶段：${input.state.stage} ｜ 运行中 ${input.live}/${input.capacity} 个进程 ｜ 这一片已失败 ${input.failures} 次`,
    `门槛还缺：${input.gateMissing.length ? input.gateMissing.join("；") : "(无)"}`,
    ...(input.recent.length ? ["最近失败：", ...input.recent.slice(-3).map((x) => `  - ${x}`)] : []),
    "",
    "【可选动作，只能选一个】",
    "continue    不影响推进（误报、已知问题、可自行解决）",
    "nudge       方向或做法偏了，无需重开：给出简要纠正，继续执行",
    "requeue     这一单的做法走不通，需要重开（问题出在“要求本身做不到”时，",
    "            选 escalate 而不是 requeue，重开只会再撞一次）",
    "pause_shard 继续做下去代价更大（正在改错地方、正在扩大破坏面），先停这一片",
    "escalate    必须由人拍板：红线风险、权限、需求自相矛盾、代价不可逆",
    "accept      只用于类型 done：报告与证据足以结单",
    "reject      只用于类型 done：报告撑不住结单（没证据、只做了表面、和原要求不符）",
    "",
    "【判断要求】",
    "- 先看证据，不要只看它怎么说。它说“已全部完成”但证据里没有产出，那是 reject，不是 accept。",
    "- 它说卡住了，先分清是“不会做”还是“要求有问题”。前者 nudge，后者 escalate 或 requeue。",
    "- 它报的是 progress（只是告知），几乎总是 continue。",
    "- 沉默也是成本：不需要干预就不要干预，nudge 误判一次会让它多做一小时无效功。",
    "",
    "【输出格式，三行，一行都不能少】",
    "DECISION: <上面七选一>",
    "WHY: <一句话说清凭什么>",
    "SAY: <要送给它的话，二十字以内；没有就写 —>",
  ].join("\n");
}

/** 解析模型输出；关键字段缺失时返回 null，由调用方回落。 */
export function parseVerdict(raw: string): TriageVerdict | null {
  const text = String(raw ?? "");
  const dm = /DECISION:\s*([a-z_]+)/i.exec(text);
  if (!dm) return null;
  const decision = String(dm[1]).toLowerCase() as TriageDecision;
  const allowed: TriageDecision[] = ["continue", "nudge", "requeue", "pause_shard", "escalate", "accept", "reject"];
  if (!allowed.includes(decision)) return null;
  const why = (/WHY:\s*(.+)/i.exec(text)?.[1] ?? "").trim().slice(0, 200);
  const sayRaw = (/SAY:\s*(.+)/i.exec(text)?.[1] ?? "").trim();
  const say = sayRaw && sayRaw !== "—" && sayRaw !== "-" ? sayRaw.slice(0, 200) : "";
  const sevM = /SEVERITY:\s*(info|warn|critical)/i.exec(text);
  return {
    decision,
    why: why || "(模型未给出理由)",
    ...(say ? { say } : {}),
    ...(sevM ? { severity: String(sevM[1]).toLowerCase() as "info" | "warn" | "critical" } : {}),
  };
}

/** 判一条申报；与判死重试共用 `brain.decide`，仅动作集不同。 */
export async function triage(input: TriageInput): Promise<TriageVerdict> {
  const m = input.msg;
  const facts: string[] = [
    `这一单原本要做什么：${String(input.action || "(未记录)").replace(/\s+/g, " ").slice(0, 700)}`,
    `它申报的类型：${m.kind}（自报严重度 ${m.severity}，是否需要监工：${m.needs}）`,
    `它说的话：${String(m.text || "").replace(/\s+/g, " ").slice(0, 900)}`,
  ];
  const evidence = String(m.evidence ?? "").trim() || String(input.evidence ?? "").trim();
  if (evidence) facts.push(`它给的证据：${evidence.replace(/\s+/g, " ").slice(0, 1400)}`);
  if (input.workspace && input.workspace.length) {
    facts.push("", "【工作区版本控制变动 · 系统采集】", ...input.workspace);
  }
  /* 要求变更后按最新口径验收，不按初始 action 判定。 */
  const added = (input.addedReqs ?? []).map((x) => String(x).trim()).filter(Boolean);
  const words = (input.userWords ?? []).map((x) => String(x).trim()).filter(Boolean);
  const ledger = (input.directiveLedger ?? []).map((x) => String(x).trim()).filter(Boolean);
  if (added.length || words.length || ledger.length) {
    facts.push("【验收以本单最新要求为准，逐条核对送达记录】");
    if (added.length) facts.push(`它在报告里承认的用户新增/更正：${added.join("；").slice(0, 900)}`);
    for (const w of words.slice(-6)) facts.push(`本单收到的消息：${w.slice(0, 300)}`);
  }
  /* 对账清单由系统按送达记录列全，不由工作进程决定。 */
  if (ledger.length) {
    facts.push(
      "",
      "【这一单送达过的要求，逐条核对：未给结论的按未完成处理】",
      ...ledger.map((x) => `  - ${x}`),
      "判定口径：出现“未给结论”，或结论写 not_mine 但内容明显属于本单 -> 不许 accept，按 reject 打回并点明是哪一条；",
      "结论写 done 但证据里找不到对应改动 -> 同样 reject。只有每条都有可信结论时才 accept。",
    );
  }
  facts.push(
    `当前阶段 ${input.state.stage}：运行中 ${input.live}/${input.capacity} 个进程；这一片已失败 ${input.failures} 次`,
    `门槛还缺：${input.gateMissing.length ? input.gateMissing.join("；") : "（无）"}`,
  );
  for (const r of input.recent.slice(-3)) facts.push(`最近一次失败：${r}`);
  /* 验收标准随判定下发，口径与 closeOut.ts 共用，使执行侧与审查侧一致。 */
  facts.push("", ...acceptanceFacts());
  const gate = input.gateMissing;

  const r = await decide({
    root: input.root,
    question: "一个工作进程发来这条申报，监工该怎么做？",
    facts,
    actions: [
      { name: "continue", desc: "不用管：误报、已知问题、它自己能处理，知道了就行" },
      { name: "nudge", desc: "方向或做法偏了但不用重开：参数里写明纠正内容（二十字以内）" },
      {
        name: "requeue",
        desc: "这一单的做法走不通要重开（如果问题出在“要求本身做不到”，选 escalate 而不是这个）",
      },
      { name: "pause_shard", desc: "继续执行代价更大（正在改错地方、在扩大破坏面），先停这一片" },
      { name: "escalate", desc: "必须人拍板：红线风险、权限、需求自相矛盾、代价不可逆" },
      {
        name: "accept",
        desc: "只用于它报完成：代码证据足以结单（行为对得上要求、相关单元测试结果一致）；不要求全量测试、不要求截图",
      },
      {
        name: "reject",
        desc: "只用于它报完成：报告撑不住结单（没有代码证据、只做了表面、行为与最新要求不符）；不得因没跑全量测试、没附截图而打回",
      },
    ],
    session: "capitalist-brain-triage",
  });

  if (r.fallback) {
    return {
      decision: "continue",
      why: "判定通道不可用，按确定性流程走",
      fallback: true,
      error: String(r.error ?? "").slice(0, 400),
    };
  }
  const first = r.actions[0];
  if (!first) return { decision: "continue", why: "模型没给出动作", fallback: true, error: "模型返回了内容但没有第一个动作" };
  const decision = first.name as TriageDecision;
  const say = decision === "nudge" || decision === "reject" ? String(first.arg ?? "").trim() : "";
  return {
    decision,
    why: String(first.why ?? "").slice(0, 240) || "(模型未给理由)",
    ...(say ? { say: say.slice(0, 200) } : {}),
  };
}

export function worthTriaging(m: MqMessage): boolean {
  if (m.needs === "decision" || m.needs === "intervention") return true;
  if (m.severity === "warn" || m.severity === "critical") return true;
  return new Set(["stuck", "risk", "deviation", "quality", "done", "question"]).has(String(m.kind));
}
