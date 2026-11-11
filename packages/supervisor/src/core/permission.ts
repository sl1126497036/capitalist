/** 权限档位。 */

import type { ActionKind, Mode, Verdict } from "./types";

/** 判定强度排序，用于取最严一档。 */
const SEVERITY: Record<Verdict, number> = { allow: 0, ask: 1, deny: 2 };

/** 既有契约里的旧判定名，映射到三值形式。 */
const ALIASES: Record<string, Verdict> = {
  BLOCK: "deny",
  NEED_USER: "ask",
  WARN: "allow",
  PASS: "allow",
  PASS_WITH_WARN: "allow",
  justify: "ask",
};

interface ModeSpec {
  /** 本档位允许的最宽判定。 */
  cap: Verdict;
  /** false 表示不拦任何动作；调用方仍需记账。 */
  enforce: boolean;
  desc: string;
}

/** 全部档位定义。键序即 {@link modeNames} 的返回顺序。 */
export const MODES: Record<Mode, ModeSpec> = {
  plan: { cap: "deny", enforce: true, desc: "只读：写与删一律拒，读不设限" },
  default: { cap: "allow", enforce: true, desc: "默认：红线按自身强度生效，越界要理由" },
  accept_edits: { cap: "allow", enforce: true, desc: "接受编辑：文件写入跳过 ask，命令类不变" },
  bypass: {
    cap: "allow",
    enforce: false,
    // 只停用档位层。红线在 `dispatch` 里于任何档位生效之前就已执行，
    // 因此 bypass 下的 BLOCK 仍然拦下，此处若写“不拦任何东西”，
    // 就是一个代码并不兑现的承诺。
    desc: "不拦档位与本机边界，但仍记账；任务列表红线照旧生效",
  },
};

/** 未显式指定档位时使用的默认档位。 */
export const DEFAULT_MODE: Mode = "default";

/**
 * 归一化档位名：转小写，`-` 换作 `_`。
 *
 * @returns 已知档位名；输入不是字符串或不是已知档位时返回 null。
 */
export function normalizeMode(input: unknown): Mode | null {
  if (typeof input !== "string" || !input.trim()) return null;
  const m = input.trim().toLowerCase().replace(/-/g, "_");
  return Object.prototype.hasOwnProperty.call(MODES, m) ? (m as Mode) : null;
}

/** 返回全部档位名（按 `MODES` 对象键序）。 */
export function modeNames(): Mode[] {
  return Object.keys(MODES) as Mode[];
}

/**
 * 返回档位的中文说明。
 *
 * 入参非法或非已知档位时返回“未知档位：<原值>”。
 */
export function describeMode(mode: unknown): string {
  const m = normalizeMode(mode);
  return m ? MODES[m].desc : `未知档位：${String(mode)}`;
}

/**
 * 归一化判定名。
 *
 * 未知判定名按 `deny` 处理，而不是 `default`。
 *
 * `hasOwnProperty` 而非 `in`：原型链会让 `constructor` 或 `toString` 看起来是合法判定，
 * 后续比较的对象将是一个函数。
 */
export function severity(action: unknown): Verdict {
  const raw = String(action ?? "").trim();
  const mapped = ALIASES[raw] ?? raw;
  return Object.prototype.hasOwnProperty.call(SEVERITY, mapped) ? (mapped as Verdict) : "deny";
}

/**
 * 把档位套用到规则判定上。
 *
 * 未知档位名判为 `deny`，不回落 `default`：配置里的拼写错误应表现为动作被拦，
 * 而不是判定被静默放宽。
 *
 * @param kind 动作类型。`command` 类判定原样返回。
 */
export function decide(mode: unknown, requested: unknown, kind: ActionKind = "command"): Verdict {
  const m = normalizeMode(mode);
  if (m === null) return "deny";

  const spec = MODES[m];
  if (!spec.enforce) return "allow";

  const req = severity(requested);
  if (kind === "command") return req;

  if (m === "plan") {
    return kind === "write" || kind === "delete" ? "deny" : req;
  }

  if (m === "accept_edits" && kind === "write" && req === "ask") return "allow";

  const cap = kind === "read" ? SEVERITY.allow : SEVERITY[spec.cap];
  return SEVERITY[req] >= cap ? req : spec.cap;
}

/**
 * 解析生效档位：命令行、环境变量、会话状态、契约默认，依次取第一个合法值。
 *
 * 会话状态排在契约之前：一次会话的显式选择比领域惯例更具体。
 */
export function resolveMode(opts: {
  cli?: unknown;
  env?: unknown;
  session?: unknown;
  contract?: { mode?: string; default_mode?: string } | undefined;
}): Mode {
  for (const candidate of [opts.cli, opts.env, opts.session]) {
    const m = normalizeMode(candidate);
    if (m) return m;
  }
  return normalizeMode(opts.contract?.mode ?? opts.contract?.default_mode) ?? DEFAULT_MODE;
}
