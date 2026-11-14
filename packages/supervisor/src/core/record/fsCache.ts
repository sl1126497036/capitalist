/**
 * 进程内文件状态缓存。
 *
 * 看板高频轮询，一次请求里同一个文件常被多个模块各查一遍（工作进程日志、
 * 积分台账、事件台账）。单次 `statSync` 本身不贵，但在同步文件调用被代理的环境里
 * stat 调用需经过 IPC，Windows 上另有杀软扫描；重复调用产生数百毫秒延迟。
 *
 * 按路径缓存 stat 结果，TTL 内复用；写路径调用 {@link invalidatePath} 立即失效，
 * 使写入后的读取返回新内容。缓存只影响文件是否存在、大小与修改时间，不影响读取内容。
 */

import { statSync, type Stats } from "node:fs";

/**
 * 默认有效期。
 *
 * 取值要覆盖“一次页面构建”的耗时：构建中十几个模块会先后查同一个文件，
 * 缓存比构建还短就等于没缓存。500ms 略短于一次构建，跨构建能重新看到最新状态。
 *
 * 只用于“本进程不写、且不是唯一数据源”的读取路径。日志增量扫描这类
 * 必须立刻看到另一个进程追加内容的场景，直接用 statSync，不经过这里。
 */
const DEFAULT_TTL_MS = 500;

/** 缓存上限：任务根里的文件数一般远小于它，超了整体清空，避免无界增长。 */
const MAX_ENTRIES = 8_192;

const cache = new Map<string, { at: number; st: Stats | null }>();

/**
 * 取文件状态；不存在返回 null。
 *
 * @param file 绝对路径。
 * @param ttlMs 有效期，默认 {@link DEFAULT_TTL_MS}。
 */
export function statCached(file: string, ttlMs: number = DEFAULT_TTL_MS): Stats | null {
  const hit = cache.get(file);
  if (hit && Date.now() - hit.at < ttlMs) return hit.st;
  let st: Stats | null = null;
  try {
    st = statSync(file);
  } catch {
    st = null;
  }
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(file, { at: Date.now(), st });
  return st;
}

/** 文件是否存在。 */
export function existsCached(file: string, ttlMs: number = DEFAULT_TTL_MS): boolean {
  return statCached(file, ttlMs) !== null;
}

/** 文件大小；不存在返回 0。 */
export function sizeCached(file: string, ttlMs: number = DEFAULT_TTL_MS): number {
  return statCached(file, ttlMs)?.size ?? 0;
}

/** 写完之后让这个路径的缓存立即失效，下一次查询重新读盘。 */
export function invalidatePath(file: string): void {
  cache.delete(file);
}

/** 测试用：清空全部缓存。 */
export function clearFsCache(): void {
  cache.clear();
}
