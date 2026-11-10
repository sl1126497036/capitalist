/**
 * 路径解析：任务根、`.capitalist` 目录、路径原语。
 *
 * 本模块只放原语。由宿主配置目录派生的路径（skill 搜索、watch 配置）在
 * `host/locations.ts`，与各 impl 的 `configDir` 共用同一份目录表。
 *
 * 两类辅助函数不可混用。`normalizeForCompare` 返回小写正斜杠字符串，仅用于比较，
 * 不可传给 `fs`。`expandHome` 与 `absolutize` 返回真实路径。两类混用是本模块
 * 跨平台缺陷的主要来源。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** 任务根标记目录。 */
export const CAPITALIST_DIR = ".capitalist";

/**
 * 用于比较的路径归一：正斜杠、小写、末尾无斜杠。不得回传给 fs。
 *
 * @returns 小写正斜杠串，仅可用于比较。
 */
export function normalizeForCompare(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 把 `~` 展开成家目录，其余原样。
 *
 * @returns 展开后的路径；输入为空时原样返回。
 */
export function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * 把 Git Bash 风格的 `/d/work` 还原成 `d:/work`（仅 Windows）。
 *
 * 必要性：hook 的 `cwd` 字段来自宿主，通常是原生路径；但用户手工调用、或者
 * 某些宿主在 Git Bash 下启动时，会传 `/d/work` 这种 POSIX 写法。Windows 的 fs
 * 会把它当成当前盘符下的 `\d\work`，于是「任务根明明在，却报未纳管」，
 * 这类失败极难从现象反推原因，必须在入口处就抹平。
 *
 * @returns 非 Windows 平台或不符合该写法时原样返回。
 */
export function toNativePath(p: string): string {
  if (process.platform !== "win32") return p;
  const m = /^\/([A-Za-z])\/(.*)$/.exec(p);
  if (m) return `${(m[1] ?? "").toUpperCase()}:/${m[2] ?? ""}`;
  return p;
}

/**
 * 向上查找任务根：返回最近一个含 `.capitalist/state.json` 的祖先目录。
 *
 * 判定依据是祖先目录下存在 `state.json`，不只看 `.capitalist/` 目录。只剩该目录的残留
 * 不构成任务根：此时命令会因读不到状态而失败，报错位置远离根因。
 *
 * @param start 起始目录，默认取当前工作目录。
 * @returns 任务根路径；找不到时返回 null。
 */
export function findRoot(start?: string): string | null {
  let cur: string;
  try {
    cur = resolve(toNativePath(start ?? process.cwd()));
  } catch {
    return null;
  }
  for (;;) {
    if (existsSync(join(cur, CAPITALIST_DIR, "state.json"))) return cur;
    const parent = join(cur, "..");
    const next = resolve(parent);
    if (next === cur) return null;
    cur = next;
  }
}

/** 任务根下的 `.capitalist` 目录。 */
export function supervisorDir(root: string): string {
  return join(root, CAPITALIST_DIR);
}

/**
 * 绝对化并展开 `~`；相对路径按给定基准解析。
 *
 * @param base 相对路径的解析基准，默认取当前工作目录。
 * @returns 真实路径，可直接交给 fs。
 */
export function absolutize(p: string, base?: string): string {
  const expanded = expandHome(p);
  if (isAbsolute(expanded)) return resolve(expanded);
  return resolve(base ?? process.cwd(), expanded);
}

/**
 * 判断 child 是否落在 parent 之内（含相等）。用归一化比较，避免分隔符差异。
 *
 * @returns parent 为空串时恒为 false（没有可归属的边界，不能当成「全在内」）。
 */
export function isInside(child: string, parent: string): boolean {
  // 小写归一只在大小写不敏感的平台成立（Windows、macOS 默认 APFS）。Linux 上仅大小写
  // 不同的两个目录是两个目录，一律小写化会把根外的兄弟目录判成根内，这是边界放宽，
  // 方向性错误，所以 Linux 也只归一分隔符。
  const fold = (p: string): string =>
    process.platform === "linux" ? p.replace(/\\/g, "/").replace(/\/+$/, "") : normalizeForCompare(p);
  const c = fold(child);
  const p = fold(parent);
  if (!p) return false;
  return c === p || c.startsWith(`${p}/`);
}
