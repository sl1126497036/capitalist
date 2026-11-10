/** 注册表：注册表键到 impl 实例的映射，以及能力查询。 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { HostId, HostImpl } from "./contract";
import { IMPL_LOADERS, implIds } from "./impl/manifest";

const cache = new Map<string, HostImpl>();

/**
 * 取一个 impl。未知 id 返回 null，不抛。
 *
 * 清单键与 impl 自报的 id 必须相等，不相等时返回 null。入口对 null 给出可操作提示。
 */
export function byId(id: string | null | undefined): HostImpl | null {
  if (!id) return null;
  const cached = cache.get(id);
  if (cached) return cached;
  const load = IMPL_LOADERS[id];
  if (!load) return null;
  const impl = load();
  if (impl.id !== id) return null;
  cache.set(id, impl);
  return impl;
}

/** 全部 impl，顺序等于清单顺序。 */
export function all(): HostImpl[] {
  return implIds().map((id) => byId(id)).filter((x): x is HostImpl => x !== null);
}

/** 宽松归一：忽略大小写与空白 / 下划线 / 连字符差异，也认别名。 */
export function normalize(input: unknown): HostId | null {
  const s = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (!s) return null;
  if (s in IMPL_LOADERS) return s;
  const hyphenless = s.replace(/-/g, "");
  for (const impl of all()) {
    for (const alias of impl.aliases) {
      const a = alias.toLowerCase().replace(/[\s_]+/g, "-");
      if (s === a || hyphenless === a.replace(/-/g, "")) return impl.id;
    }
  }
  return null;
}

/** 家目录下已存在的宿主配置目录（绝对路径，可直接用于 fs）。 */
export function existingDirs(): Array<{ id: HostId; dir: string; label: string }> {
  const out: Array<{ id: HostId; dir: string; label: string }> = [];
  for (const impl of all()) {
    const full = join(homedir(), impl.configDir);
    if (existsSync(full)) out.push({ id: impl.id, dir: full, label: impl.label });
  }
  return out;
}

/**
 * 猜宿主：按各 impl 的 `hook.guessPriority` 降序，命中第一个存在的配置目录。
 *
 * 排序由 impl 声明。只在 `--agent` 缺失时使用，不抛。都没有命中时返回回退 impl 的 id；
 * 清单里没有回退项时返回 null，由调用方决定怎么报。
 */
export function detect(): HostId | null {
  const ranked = all()
    .filter((impl) => impl.hook.guessPriority !== undefined)
    .sort((a, b) => (b.hook.guessPriority ?? 0) - (a.hook.guessPriority ?? 0));
  for (const impl of ranked) {
    if (existsSync(join(homedir(), impl.configDir))) return impl.id;
  }
  return fallbackId();
}

/**
 * 监工启动时经 `--agent` 声明的宿主；null 表示未声明，按环境特征推断。
 *
 * CodeBuddy CLI 仅注入 `CLAUDE_PROJECT_DIR` / `CLAUDE_SESSION_ID`，不注入 `CODEBUDDY_HOST`，
 * 与 Claude Code 的环境特征相同，推断结果恒为 claude-code，凭证随之取自该族。
 * 显式声明优先于特征推断。
 */
let hostOverride: HostId | null = null;

/** 设定（或清除）显式声明的宿主；只影响本进程，不写环境。 */
export function setHostOverride(id: HostId | null): void {
  hostOverride = id;
}

/** 当前是否由 `--agent` 显式指定过。 */
export function hostOverrideOf(): HostId | null {
  return hostOverride;
}

/**
 * 当前宿主：监工运行所在的宿主。
 *
 * 显式声明优先；其次逐条比对各 impl 声明的 `hostEnv`，宿主注入的环境变量比配置目录更准。
 * 带 `contains` 的特征优先于「存在即命中」：同族宿主共用一个变量时，只有更具体的
 * 无法判定时回落到 {@link detect}。
 *
 * 返回值决定工作进程所属的产品族；跨族选用会借用另一产品线的登录态。
 */
export function currentHost(): HostId | null {
  if (hostOverride) return hostOverride;
  let fallback: HostId | null = null;
  for (const impl of all()) {
    for (const hint of impl.hostEnv ?? []) {
      const value = String(process.env[hint.name] ?? "")
        .trim()
        .toLowerCase();
      if (!value) continue;
      if (hint.contains === undefined) {
        if (fallback === null) fallback = impl.id;
      } else if (value.includes(hint.contains.toLowerCase())) {
        return impl.id;
      }
    }
  }
  return fallback ?? detect();
}

/**
 * 与给定宿主同族的 impl，按清单顺序，不含自身。
 *
 * 同族的判据是 `family` 相等；未声明 `family` 的 impl 单独成族，不与其他宿主实现互换。
 */
export function siblings(id: string | null | undefined): HostImpl[] {
  const self = byId(id);
  const fam = self?.family;
  if (!fam) return [];
  return all().filter((impl) => impl !== self && impl.family === fam);
}

/**
 * 回退 impl 的 id。清单里恰好有一个，测试对此有断言。
 */
export function fallbackId(): HostId | null {
  return all().find((impl) => impl.fallback)?.id ?? null;
}

/** 面向路径派生的目录表：id / 家目录下的配置目录名 / 展示名。 */
export function dirs(): Array<{ id: HostId; dir: string; label: string }> {
  return all().map((impl) => ({ id: impl.id, dir: impl.configDir, label: impl.label }));
}

/** 能做 worker 的 impl，按自动探测优先级降序；不参与探测的排在最后。 */
export function workerHosts(): HostImpl[] {
  return all()
    .filter((impl) => impl.worker)
    .sort((a, b) => (b.worker?.detectPriority ?? -1) - (a.worker?.detectPriority ?? -1));
}

/** 按工作进程宿主的取值取 impl。取值与注册表 id 可以不同（历史兼容面）。 */
export function workerByKey(key: string | null | undefined): HostImpl | null {
  if (!key) return null;
  const k = key.trim().toLowerCase();
  /* 经 aliases 归一：旧任务根里记过 worker key `claude`，改名为 claude-code 后仍要能读回。 */
  const id = normalize(k);
  for (const impl of all()) {
    if (!impl.worker) continue;
    if (impl.worker.key === k || impl.id === k || (id !== null && impl.id === id)) return impl;
  }
  return null;
}

