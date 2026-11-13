/**
 * 命令行参数解析与取值。
 *
 * 解析只做一次，命令统一通过 `flagString` / `flagBool` / `flagNumber` / `flagInt` 取值。
 * 缺省语义集中在取值函数里，同一个选项在各命令下行为一致。
 */

/** 解析结果：命令名、位置参数、`--键 值` 形式的选项。 */
export interface Parsed {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * 解析 argv（不含 node 与脚本路径）。
 *
 * `--key=value` 与 `--key value` 等价；后面紧跟另一个 `--` 开头的参数时，当前键取 true，
 * 不消费下一个选项。位置参数按出现顺序保留。
 */
export function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    const eq = key.indexOf("=");
    if (eq >= 0) {
      flags[key.slice(0, eq)] = key.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  const [cmd = "", ...rest] = positional;
  return { cmd, positional: rest, flags };
}

/**
 * 取字符串选项。
 *
 * 缺省或写成裸开关（`--root` 后面没有值）时返回 undefined。
 */
export function flagString(p: Parsed, key: string): string | undefined {
  const v = p.flags[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * 取开关选项。
 *
 * 只认显式 true，`--flag=0` 这类带值的写法不算打开。
 */
export function flagBool(p: Parsed, key: string): boolean {
  return p.flags[key] === true;
}

/**
 * 取数字选项。
 *
 * 非数字或非有限值按没给处理，由调用方决定默认值。
 */
export function flagNumber(p: Parsed, key: string): number | undefined {
  const v = flagString(p, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 取“token 数量”选项：支持 `300000`、`300k`、`1m`、`1M` 三种写法。
 *
 * 上下文上限就是按 token 说话的，用户不会愿意数六个零；写 `1m` 更不容易错。
 * 只认 k/m 后缀（大小写不敏感），其它写法按没给处理。
 */
export function flagTokens(p: Parsed, key: string): number | undefined {
  const v = flagString(p, key);
  if (v === undefined) return undefined;
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([km])?\s*$/i.exec(v);
  if (!m) return undefined;
  const base = Number(m[1]);
  if (!Number.isFinite(base) || base <= 0) return undefined;
  const mult = (m[2] || "").toLowerCase() === "m" ? 1_000_000 : (m[2] || "").toLowerCase() === "k" ? 1_000 : 1;
  return Math.round(base * mult);
}

/**
 * 取正整数选项并夹在区间内。
 *
 * 用于端口、条数、超时这类有明确边界的参数。缺省或非数字时取 `fallback`。
 */
export function flagInt(p: Parsed, key: string, opts: { min: number; max: number; fallback: number }): number {
  const n = flagNumber(p, key);
  if (n === undefined) return opts.fallback;
  return Math.min(Math.max(Math.floor(n), opts.min), opts.max);
}

/**
 * 带空格的多个位置参数拼回一句话。
 *
 * `capitalist say 文本` 与 `capitalist say "文本"` 等价。
 */
export function positionalText(p: Parsed): string {
  return p.positional.join(" ").trim();
}
