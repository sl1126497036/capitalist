/**
 * 看板线程基础工具：线程键、清理标记、状态判读。
 *
 * 线程列表、消息流、命令执行三处都要用，所以放在最底层，不引用任何看板上层模块。
 */

import { laneKeyOf } from "../../core/dispatch/commands";
import { readJson, writeJson } from "../../core/record/json";
import { board as boardLoc } from "../../core/record/locations";
/**
 * 线程键的前段解析：分片与派生链尾号二选一，`main` 表示既无分片也无链。
 *
 * 线程键形如分片名、`x` 加派生链尾号、或 `main`。历史键形如“阶段/分片”，
 * 只取后段：阶段已不参与身份，旧链接仍要能读。`shardNames` 是当前在册的分片名，
 * 形如 `x` 开头但确实是分片的名字不会被误当成派生链。
 */
export function parseThreadKey(
  threadId: string,
  shard = "",
  shardNames: readonly string[] = [],
): { shard: string; lineageTail: string } {
  const rawKey = String(threadId ?? "").trim().toLowerCase();
  let s = String(shard ?? "").trim().toLowerCase();
  if (!s && rawKey.startsWith("shard:")) s = rawKey.slice(6);
  const tail = rawKey.includes("/") ? String(rawKey.split("/").pop() ?? "").trim() : rawKey;
  if (s || !tail || tail === "main") return { shard: s, lineageTail: "" };
  if (/^x[0-9a-z]{3,}$/.test(tail) && !shardNames.some((n) => String(n).trim().toLowerCase() === tail)) {
    return { shard: "", lineageTail: tail.slice(1) };
  }
  return { shard: tail, lineageTail: "" };
}

export interface ClearedMark {
  at: string;
  dispatch: string;
}

export function clearedMarksPath(root: string): string {
  return boardLoc.cleared(root);
}

export function readClearedMarks(root: string): Record<string, ClearedMark> {
  return readJson<Record<string, ClearedMark>>(clearedMarksPath(root), {});
}

export function markThreadCleared(root: string, key: string, dispatch: string): void {
  const marks = readClearedMarks(root);
  marks[key] = { at: new Date().toISOString(), dispatch: dispatch || "" };
  writeJson(clearedMarksPath(root), marks);
}

export function threadStatusTerminal(status: string): boolean {
  return status === "done" || status === "exited" || status === "finished" || status === "canceled";
}

export const ABNORMAL_THREAD_STATUS = new Set(["failed", "missing", "orphan", "gone"]);

export function threadStatusAbnormal(status: string): boolean {
  return ABNORMAL_THREAD_STATUS.has(status);
}

/** 线程页缓存有效期：短于前端 2 秒轮询，避免一次刷新重复读盘。 */