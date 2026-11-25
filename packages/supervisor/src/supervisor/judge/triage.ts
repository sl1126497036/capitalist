/**
 * 监工判定层：按申报与证据产出 `TriageVerdict`，动作由 `loop.ts` 执行。
 *
 * 判定覆盖卡点、方向、红线、质量与报告审查；模型通道不可用或输出无法解析时返回 `continue`，并在 `why` 写明原因。
 */

import type { MqMessage } from "../../core/dispatch/mq";
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
  msg: MqMessage;
  /** 这一单的原始任务（派单 action），供判断偏航。 */
  action: string;
  /** 同一片/同一单最近的失败次数。 */
  failures: number;
  /** 当前运行的进程数 / 并行度上限。 */
  live: number;
  capacity: number;
  /** 这一单的验收判据（随派单下发），审查侧据此判断报告是否足以结束；空串表示未声明，按通用口径审。 */
  acceptance?: string;
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
    if (added.length) facts.push(`报告中记录的用户新增/更正要求：${added.join("；").slice(0, 900)}`);
    for (const w of words.slice(-6)) facts.push(`本单收到的消息：${w.slice(0, 300)}`);
  }
  /* 对账清单由系统按送达记录列全，不由工作进程决定。 */
  if (ledger.length) {
    facts.push(
      "",
      "【这一单送达过的要求，逐条核对：未给结论的按未完成处理】",
      ...ledger.map((x) => `  - ${x}`),
      "判定口径：出现“未给结论”，或结论写 not_mine 但内容明显属于本单 -> 判 reject 退回并指明具体条目；",
      "结论为 done 但证据中无对应改动 -> 同样 reject。仅当每条均有可信结论时才 accept。",
    );
  }
  facts.push(`当前状态：运行中 ${input.live}/${input.capacity} 个工作进程；同一分片已失败 ${input.failures} 次`);
  /* 本单验收判据由派单携带；没声明时只留通用口径，不另设门槛。 */
  const acceptance = String(input.acceptance ?? "").trim();
  if (acceptance) facts.push(`这一单的验收判据：${acceptance.replace(/\s+/g, " ").slice(0, 700)}`);
  for (const r of input.recent.slice(-3)) facts.push(`最近一次失败：${r}`);
  /* 两种“不合格”处置不同：能继续做的打回继续做，做不到的转用户决策。 */
  facts.push(
    "不合格分两种：报告不足但工作可继续（缺证据、仅完成表面工作、与新要求不符）-> reject，退回后同一单继续执行；",
    "任务本身无法继续（缺权限或凭据、需求自相矛盾、外部依赖不可用、代价不可逆）-> escalate，该单转为等待用户决策。",
  );
  /* 验收标准随判定下发，口径与 closeOut.ts 共用，使执行侧与审查侧一致。 */
  facts.push("", ...acceptanceFacts());

  const r = await decide({
    root: input.root,
    question: "收到工作进程提交的申报，监工应如何处理？",
    facts,
    actions: [
      { name: "continue", desc: "无需干预：误报、已知问题、可自行解决" },
      { name: "nudge", desc: "方向或做法有偏差但无需重开：参数里写明纠正内容（二十字以内）" },
      {
        name: "requeue",
        desc: "本单做法不可行，应重开（要求本身不可行时选 escalate）",
      },
      { name: "pause_shard", desc: "继续执行代价更大（正在改动错误位置、扩大影响范围），先暂停该分片" },
      {
        name: "escalate",
        desc: "需人工裁决，任务无法继续：缺权限或凭据、需求自相矛盾、外部依赖不可用、代价不可逆。该单转为等待用户决策，不再重派",
      },
      {
        name: "accept",
        desc: "仅用于工作进程报告完成：证据足以结束（产出物与要求相符、核对结果一致）",
      },
      {
        name: "reject",
        desc: "仅用于工作进程报告完成：证据尚不充分但任务可继续（无可核对证据、仅完成表面工作、与最新要求不符）。退回后同一单重新执行",
      },
    ],
    session: "capitalist-brain-triage",
  });

  if (r.fallback) {
    const detail = String(r.error ?? "").replace(/\s+/g, " ").trim();
    return {
      decision: "continue",
      why: detail
        ? `自动判定不可用：${detail.slice(0, 160)}。流程继续。`
        : "自动判定不可用：模型未给出失败原因。流程继续。",
      fallback: true,
      error: String(r.error ?? "").slice(0, 400),
    };
  }
  const first = r.actions[0];
  if (!first) return { decision: "continue", why: "模型未给出动作", fallback: true, error: "模型有输出但无可执行的动作。" };
  const decision = first.name as TriageDecision;
  const say = decision === "nudge" || decision === "reject" ? String(first.arg ?? "").trim() : "";
  return {
    decision,
    why: String(first.why ?? "").slice(0, 240) || "(模型未给出理由)",
    ...(say ? { say: say.slice(0, 200) } : {}),
  };
}

export function worthTriaging(m: MqMessage): boolean {
  if (m.needs === "decision" || m.needs === "intervention") return true;
  if (m.severity === "warn" || m.severity === "critical") return true;
  return new Set(["stuck", "risk", "deviation", "quality", "done", "question"]).has(String(m.kind));
}
