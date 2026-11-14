/** 简报：每轮注入的短状态块。 */

import { join } from "node:path";

import type { Contract } from "../contract/contract";
import { openInboxAsks } from "../dispatch/inbox";
import { readJsonl } from "../record/json";
import { supervisorDir } from "../record/paths";
import type { Mode, TaskState } from "../types";

/** 简报语言。 */
export type BriefLang = "zh" | "en";

/** 简报入参。 */
export interface BriefInput {
  root: string;
  state: TaskState;
  contract: Contract;
  mode: Mode;
  /** 门槛未满足的项；空数组表示已达标 */
  missing: string[];
  /** 缺省中文 */
  lang?: BriefLang;
}

interface Texts {
  fallbackHead: string;
  fallbackBody: string[];
  mode: (m: string) => string;
  head: (domain: string, target: string, stage: string, name: string) => string;
  goal: (g: string) => string;
  next: (n: string) => string;
  missing: string;
  satisfied: string;
  asks: (n: number) => string;
  genericDomain: string;
}

const TEXTS: Record<BriefLang, Texts> = {
  zh: {
    fallbackHead: "▸ 通用任务列表 · 无领域判据（不阻断，但别当它有）",
    fallbackBody: [
      "  未指定领域任务列表，跑的是通用三阶段：通用红线（破坏性删除 / SQL 清库 / 凭据）生效，",
      "  但“这个领域什么算做完、哪些动作绝对禁”没有定义。",
      "  若这是明确领域任务：capitalist adopt --contract <任务列表名>",
    ],
    mode: (m) => `▸ 权限档位：${m}（非默认，动作被拦可能由档位导致，而非任务列表红线）`,
    head: (domain, target, stage, name) => `【capitalist · ${domain}】${target} ｜ 阶段 ${stage} ${name}`,
    goal: (g) => `  本阶段目标：${g}`,
    next: (n) => `  下一步：${n}`,
    missing: "  未达门槛：",
    satisfied: "  门槛：已满足，可用 capitalist advance 推进",
    asks: (n) => `  待裁决 ${n} 条（答完才能继续）：`,
    genericDomain: "通用任务",
  },
  en: {
    fallbackHead: "▸ generic contract — no domain criteria (it will not block, but do not rely on it)",
    fallbackBody: [
      "  No domain contract was selected, so the generic three-stage flow runs. Generic redlines",
      "  (destructive deletes / SQL drops / credentials) apply, but what counts as done for this",
      "  domain is undefined. If this is a domain task: capitalist adopt --contract <name>",
    ],
    mode: (m) => `▸ mode: ${m} (non-default — a blocked action may come from the mode, not a redline)`,
    head: (domain, target, stage, name) => `[capitalist · ${domain}] ${target} | stage ${stage} ${name}`,
    goal: (g) => `  stage goal: ${g}`,
    next: (n) => `  next: ${n}`,
    missing: "  gate not met:",
    satisfied: "  gate satisfied — run `capitalist advance`",
    asks: (n) => `  ${n} open question(s) — answer before continuing:`,
    genericDomain: "general",
  },
};

/**
 * 生成简报正文。调用方负责把它包进注入结构。
 *
 * @returns 多行文本。未达门槛项最多列 6 条，未决问题最多列 3 条。
 */
export function buildBrief(input: BriefInput): string {
  const { root, state, contract, mode, missing } = input;
  const t = TEXTS[input.lang ?? "zh"];
  const lines: string[] = [];

  if (state.contract_fallback) {
    lines.push(t.fallbackHead, ...t.fallbackBody, "");
  }

  if (mode !== "default") {
    lines.push(t.mode(mode), "");
  }

  /*
   * 只有用户自己定了契约，才提阶段与门槛。
   *
   * 默认的 `generic` 是调度层的容器键，不对应工序。
   * 未指定契约时不显示阶段与推进提示，只输出目标、任务池与在途进度。
   */
  const custom = Boolean(state.contract && state.contract !== "generic");
  const stage = custom ? contract.stages.find((s) => s.id === state.stage) : undefined;
  lines.push(
    custom
      ? t.head(contract.domain || t.genericDomain, state.target, state.stage, stage?.name ?? "")
      : `【capitalist · ${contract.domain || t.genericDomain}】${state.target}`,
  );

  if (custom && stage?.goal) lines.push(t.goal(stage.goal));
  if (custom && state.next_action) lines.push(t.next(state.next_action));

  if (custom && missing.length > 0) {
    lines.push(t.missing);
    for (const m of missing.slice(0, 6)) lines.push(`    - ${m}`);
  } else if (custom && contract.stages.length > 0) {
    lines.push(t.satisfied);
  }

  // 只列本阶段的提问：旧阶段的提问已失效，继续显示会让每一轮都重复催同一件已了结的事。
  // 走校验读取：缺 id / 空 text / status 越界的记录不参与，它们连“问的是什么”都说不清，
  // 却足以让监工判定“有待裁决”而停派。
  const open = openInboxAsks(root).filter((q) => !q.stage || q.stage === state.stage);
  if (open.length > 0) {
    lines.push(t.asks(open.length));
    for (const q of open.slice(0, 3)) lines.push(`    · ${String(q.text ?? "")}`);
  }

  return lines.join("\n");
}
