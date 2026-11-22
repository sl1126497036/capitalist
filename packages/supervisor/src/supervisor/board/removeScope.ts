/**
 * 移除范围：把“要清掉哪些任务”收敛成一处解析。
 *
 * 单卡清除、按档批量清除都从这里取范围，避免两处各自按状态推导。
 * 范围只由线程视图决定：界面显示哪几张卡，就清哪几张卡引用的派单与进程记录。
 * 档与档之间因此互不吞并，“清空已取消”不会再带走“已完成”。
 */

import { buildThreads } from "./threads";
import type { TaskBucket } from "./threads";
import type { ThreadSummary } from "./snapshot";

export interface RemoveScope {
  /** 命中的线程键，与界面卡片一一对应。 */
  keys: string[];
  /** 这些线程引用的派单 id。 */
  dispatches: string[];
  /** 这些线程引用的进程 id。 */
  workers: string[];
  /** 命中的线程对象，调用方据此取状态、标题与派单。 */
  threads: ThreadSummary[];
}

function collect(threads: readonly ThreadSummary[]): RemoveScope {
  const keys: string[] = [];
  const dispatches: string[] = [];
  const workers: string[] = [];
  const seenD = new Set<string>();
  const seenW = new Set<string>();
  for (const t of threads) {
    keys.push(t.id);
    for (const id of [t.dispatch ?? "", ...(t.dispatches ?? [])]) {
      const s = String(id ?? "");
      if (!s || seenD.has(s)) continue;
      seenD.add(s);
      dispatches.push(s);
    }
    for (const id of [t.worker ?? "", ...(t.workers ?? [])]) {
      const s = String(id ?? "");
      if (!s || seenW.has(s)) continue;
      seenW.add(s);
      workers.push(s);
    }
  }
  return { keys, dispatches, workers, threads: threads.slice() };
}

/** 某一档的全部线程。`all` 表示当前列表里的所有任务卡。 */
export function removeScopeOfBucket(root: string, bucket: TaskBucket | "all"): RemoveScope {
  const threads = buildThreads(root).filter((t) => bucket === "all" || t.bucket === bucket);
  return collect(threads);
}

/** 单张任务卡。键不存在时返回空范围，调用方据此回 404。 */
export function removeScopeOfKey(root: string, key: string): RemoveScope {
  const hit = buildThreads(root).filter((t) => t.id === key);
  return collect(hit);
}
