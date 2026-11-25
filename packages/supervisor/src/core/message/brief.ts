/** 简报：每轮注入的短状态块。 */

import type { Policy } from "../policy/policy";
import { openInboxAsks } from "../dispatch/inbox";
import type { Mode, TaskState } from "../types";

/** 简报语言。 */
export type BriefLang = "zh" | "en";

/** 简报入参。 */
export interface BriefInput {
  root: string;
  state: TaskState;
  policy: Policy;
  mode: Mode;
  /** 缺省中文 */
  lang?: BriefLang;
}

interface Texts {
  fallbackHead: string;
  fallbackBody: string[];
  mode: (m: string) => string;
  head: (domain: string, target: string) => string;
  next: (n: string) => string;
  asks: (n: number) => string;
  genericDomain: string;
}

const TEXTS: Record<BriefLang, Texts> = {
  zh: {
    fallbackHead: "通用守卫，无领域判据（不阻断）",
    fallbackBody: [
      "  未指定领域守卫，只启用通用红线（破坏性删除、SQL 清库、凭据）。",
      "  若这是明确领域任务：capitalist adopt --policy <守卫名>",
    ],
    mode: (m) => `权限档位：${m}（非默认）。动作被拦截可能与档位有关，而非守卫红线。`,
    head: (domain, target) => `【capitalist | ${domain}】${target}`,
    next: (n) => `  下一步：${n}`,
    asks: (n) => `  待裁决 ${n} 条，答复后才能继续：`,
    genericDomain: "通用任务",
  },
  en: {
    fallbackHead: "▸ generic guard — no domain criteria (it will not block, but do not rely on it)",
    fallbackBody: [
      "  No domain guard was selected, so only the generic redlines apply (destructive deletes,",
      "  SQL drops, credentials). If this is a domain task: capitalist adopt --policy <name>",
    ],
    mode: (m) => `▸ mode: ${m} (non-default — a blocked action may come from the mode, not a redline)`,
    head: (domain, target) => `[capitalist · ${domain}] ${target}`,
    next: (n) => `  next: ${n}`,
    asks: (n) => `  ${n} open question(s) — answer before continuing:`,
    genericDomain: "general",
  },
};

/**
 * 生成简报正文。调用方负责把它包进注入结构。
 *
 * @returns 多行文本。未决问题最多列 3 条。
 */
export function buildBrief(input: BriefInput): string {
  const { root, state, policy, mode } = input;
  const t = TEXTS[input.lang ?? "zh"];
  const lines: string[] = [];

  if (state.policy_fallback) {
    lines.push(t.fallbackHead, ...t.fallbackBody, "");
  }

  if (mode !== "default") {
    lines.push(t.mode(mode), "");
  }

  lines.push(t.head(policy.domain || t.genericDomain, state.target));
  if (state.next_action) lines.push(t.next(state.next_action));

  // 走校验读取：缺 id / 空 text / status 越界的记录不参与，它们无法识别其提问内容，
  // 却足以让监工判定“有待裁决”而停派。
  const open = openInboxAsks(root);
  if (open.length > 0) {
    lines.push(t.asks(open.length));
    for (const q of open.slice(0, 3)) lines.push(`    - ${String(q.text ?? "")}`);
  }

  return lines.join("\n");
}
