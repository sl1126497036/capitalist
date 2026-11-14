/**
 * 看板线程基础工具：线程键、清理标记、状态判读。
 *
 * 线程列表、消息流、命令执行三处都要用，所以放在最底层，不引用任何看板上层模块。
 */

import { join } from "node:path";

import { laneKeyOf } from "../../core/commands";
import { readJson, writeJson } from "../../core/json";
import { supervisorDir } from "../../core/paths";
export function taskKeyOf(stage: string, shardName: string | null | undefined, lineage?: string): string {
  return laneKeyOf({ stage, shard: shardName, lineage });
}

export interface ClearedMark {
  at: string;
  dispatch: string;
}

export function clearedMarksPath(root: string): string {
  return join(supervisorDir(root), "board-cleared.json");
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