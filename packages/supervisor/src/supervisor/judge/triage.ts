/**
 * 监工判定层：按申报与证据产出 `TriageVerdict`，动作由 `loop.ts` 执行。
 *
 * 判定覆盖卡点、方向、红线、质量与报告审查；模型通道不可用或输出无法解析时返回 `continue`，并在 `why` 写明原因。
 */

import type { Contract } from "../../core/contract/contract";
import type { MqMessage } from "../../core/dispatch/mq";
import type { TaskState } from "../../core/types";
import { decide } from "./brain";
import { acceptanceFacts } from "./closeOut";

export type TriageDecision =
  | "continue" /* 不影响推进，仅记录 */
  | "nudge" /* 方向或做法偏了：给出纠正说明，工作进程继续执行 */
  | "requeue" /* 做法不可行：重开并改用其他做法 */
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
  /** 这一单的原始任务（派单 action），供判断偏航。 */
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
    "你是 capitalist 监工的判定层。工作进程发来一条申报，你要决定监工怎么处理。",
    "",
    "【这一单的原始任务】",
    String(input.action || "（未记录）").slice(0, 900),
    "",
    "【工作进程申报了什么】",
    `类型：${m.kind} ｜ 自报严重度：${m.severity} ｜ 是否需要监工：${m.needs}`,
    `内容：${String(m.text || "").slice(0, 1200)}`,
    ...(m.evidence ? ["", "【工作进程提供的证据】", String(m.evidence).slice(0, 1600)] : []),
    "",
    "【当前局面】",
    `阶段：${input.state.stage} ｜ 运行中 ${input.live}/${input.capacity} 个进程 ｜ 这一片已失败 ${input.failures} 次`,
    `缺少的门槛：${input.gateMissing.length ? input.gateMissing.join("；") : "(无)"}`,
    ...(input.recent.length ? ["最近失败：", ...input.recent.slice(-3).map((x) => `  - ${x}`)] : []),
    "",
    "【可选动作，只能选一个】",
    "continue    不影响推进（误报、已知问题、可自行解决）",
    "nudge       方向或做法有偏差，无需重开：给出简要纠正，继续执行",
    "requeue     这一单的做法不可行，需要重开（问题出在“要求本身做不到”时，",
    "            选 escalate，重开无法解决该问题）",
    "pause_shard 继续做下去代价更大（正在改动错误位置、正在扩大破坏面），先暂停这一片",
    "escalate    需人工裁决：红线风险、权限、需求自相矛盾、代价不可逆",
    "accept      只用于类型 done：报告与证据足以结束",
    "reject      只用于类型 done：报告不足以结束（无证据、仅完成表面工作、与要求不符）",
    "",
    "【判断要求】",
    "- 以证据为准，不只看申报内容。申报“已全部完成”但证据无产出的，判 reject。",
    "- 申报受阻的，先区分是执行方能力不足还是要求本身有问题：前者 nudge，后者 escalate 或 requeue。",
    "- 申报类型为 progress（只是告知）的，通常判 continue。",
    "- 不需要干预时不干预：nudge 误判会使工作进程做无效工作。",
    "- 不写进程编号（形如 6-P1）：SAY 与 WHY 都是界面可读文字，要指代执行方时写“工作进程”，",
    "  要标明归属时写任务号（#06）或派单号（#06-2）。",
    "",
    "【输出格式：三行，缺一不可】",
    "DECISION: <上面七选一>",
    "WHY: <一句话说明依据>",
    "SAY: <要发给工作进程的话，二十字以内；没有则写 —>",
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

/** 判一条申报；与判定失败重试共用 `brain.decide`，仅动作集不同。 */
export async function triage(input: TriageInput): Promise<TriageVerdict> {
  const m = input.msg;
  const facts: string[] = [
    `这一单的原始任务：${String(input.action || "（未记录）").replace(/\s+/g, " ").slice(0, 700)}`,
    `工作进程申报的类型：${m.kind}（自报严重度 ${m.severity}，是否需要监工：${m.needs}）`,
    `工作进程的表述：${String(m.text || "").replace(/\s+/g, " ").slice(0, 900)}`,
  ];
  const evidence = String(m.evidence ?? "").trim() || String(input.evidence ?? "").trim();
  if (evidence) facts.push(`工作进程提供的证据：${evidence.replace(/\s+/g, " ").slice(0, 1400)}`);
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
      "判定口径：出现“未给结论”，或结论写 not_mine 但内容明显属于本单 -> 判 reject 退回并指明具体条目；",
      "结论写 done 但证据里找不到对应改动 -> 同样 reject。只有每条都有可信结论时才 accept。",
    );
  }
  facts.push(
    `当前阶段 ${input.state.stage}：运行中 ${input.live}/${input.capacity} 个进程；这一片已失败 ${input.failures} 次`,
    `缺少的门槛：${input.gateMissing.length ? input.gateMissing.join("；") : "（无）"}`,
  );
  for (const r of input.recent.slice(-3)) facts.push(`最近一次失败：${r}`);
  /* 两种“不合格”处置不同：能继续做的打回继续做，做不到的转用户决策。 */
  facts.push(
    "不合格分两种：报告不足但工作可继续（缺证据、仅完成表面工作、与新要求不符）-> reject，退回后同一单继续执行；",
    "任务本身无法继续（缺权限或凭据、需求自相矛盾、外部依赖不可用、代价不可逆）-> escalate，该单转为等待用户决策。",
  );
  /* 验收标准随判定下发，口径与 closeOut.ts 共用，使执行侧与审查侧一致。 */
  facts.push("", ...acceptanceFacts());
  const gate = input.gateMissing;

  const r = await decide({
    root: input.root,
    question: "一个工作进程发来这条申报，监工应如何处理？",
    facts,
    actions: [
      { name: "continue", desc: "无需干预：误报、已知问题、可自行解决" },
      { name: "nudge", desc: "方向或做法有偏差但无需重开：参数里写明纠正内容（二十字以内）" },
      {
        name: "requeue",
        desc: "这一单的做法不可行要重开（要求本身不可行时选 escalate）",
      },
      { name: "pause_shard", desc: "继续执行代价更大（正在改动错误位置、在扩大破坏面），先停这一片" },
      {
        name: "escalate",
        desc: "需人工裁决，任务无法继续：缺权限或凭据、需求自相矛盾、外部依赖不可用、代价不可逆。该单转为等待用户决策，不再重派",
      },
      {
        name: "accept",
        desc: "只用于工作进程报完成：代码证据足以结束（行为与要求相符、相关单元测试结果一致）；根据情况看是否需要追加全量测试",
      },
      {
        name: "reject",
        desc: "只用于工作进程报完成：报告还不足但工作可以继续（无代码证据、仅完成表面工作、行为与最新要求不符）。退回后同一单重新执行；全量测试与界面截图视耗时与测试难度酌情要求",
      },
    ],
    session: "capitalist-brain-triage",
  });

  if (r.fallback) {
    const detail = String(r.error ?? "").replace(/\s+/g, " ").trim();
    return {
      decision: "continue",
      why: detail
        ? `判定通道不可用：${detail.slice(0, 160)}。流程继续。`
        : "判定通道不可用：模型未给出失败原因。流程继续。",
      fallback: true,
      error: String(r.error ?? "").slice(0, 400),
    };
  }
  const first = r.actions[0];
  if (!first) return { decision: "continue", why: "模型未给出动作", fallback: true, error: "模型返回了内容但没有第一个动作" };
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
