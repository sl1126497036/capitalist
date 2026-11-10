/** 「立即执行」的插队租约（`.capitalist/preempt.json`）。 */

import { join } from "node:path";

import { readJson, writeJson, writeJsonl } from "./json";
import { supervisorDir } from "./paths";
import { compareQueueOrder, dispatchPath, readDispatches, type Dispatch } from "./supervisor";

/** 一份插队租约：谁在立即执行、谁为它让了位。 */
export interface PreemptLease {
  /** 立即执行的那张派单 id。 */
  dispatch: string;
  /** 它的工作进程 id；还没拉起时为空串。 */
  worker: string;
  /** 租约建立的时刻（ISO）。 */
  at: string;
  /**
   * 被让位的派单 id，按让位前的队列顺序。
   *
   * 恢复的顺序就照这份清单，所以「按原顺序恢复」不依赖台账行序，也不依赖谁先被领走。
   */
  yielded: string[];
}

/** 租约文件路径。 */
export function preemptPath(root: string): string {
  return join(supervisorDir(root), "preempt.json");
}

/**
 * 读租约。
 *
 * 结构不完整时按「没有租约」处理：一份读不懂的租约如果被当真，监工会一直以为
 * 已经有一个立即执行在跑，从此不再插队，也不会恢复被让位的单。
 */
export function readPreemptLease(root: string): PreemptLease | null {
  const raw = readJson<PreemptLease | null>(preemptPath(root), null);
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.dispatch !== "string" || !raw.dispatch) return null;
  const yielded = Array.isArray(raw.yielded) ? raw.yielded.map((x) => String(x ?? "")).filter(Boolean) : [];
  return {
    dispatch: raw.dispatch,
    worker: String(raw.worker ?? ""),
    at: String(raw.at ?? ""),
    yielded,
  };
}

export function savePreemptLease(root: string, lease: PreemptLease): void {
  writeJson(preemptPath(root), lease);
}

/** 结束租约：写一份空记录等于「没有立即执行在跑」（读侧按 null 处理）。 */
export function clearPreemptLease(root: string): void {
  writeJson(preemptPath(root), {});
}

/**
 * 这一单是不是「立即执行」。
 *
 * 只认 `promoted_at`：它是用户在队列行上按下「立即执行」留下的事实。
 * `urgent` 是建单时自带的插队语义（`capitalist dispatch` / 修复单），按约定它只排到队首、
 * 不腾槽，否则每建一张插队单都要挂起一个正在跑的进程，那是另一种失控。
 */
export function isImmediate(d: Pick<Dispatch, "promoted_at">): boolean {
  return Boolean(String(d.promoted_at ?? "").trim());
}

export function leaseEnded(lease: PreemptLease, rows: readonly Dispatch[]): boolean {
  const cur = rows.find((d) => d.id === lease.dispatch);
  if (!cur) return true;
  return cur.status !== "claimed";
}

/** 让位候选：此刻所有还开着的单，按当前的队列顺序排好。 */
export function yieldOrder(rows: readonly Dispatch[], immediateId: string): Dispatch[] {
  return rows
    .map((d, i) => ({ d, i }))
    .filter((x) => x.d.id !== immediateId && (x.d.status === "open" || x.d.status === "claimed"))
    .sort((a, b) => compareQueueOrder(a.d, b.d, a.i, b.i))
    .map((x) => x.d);
}

/**
 * 给一批单打上让位标记，并让它们回到排队。
 *
 * 三件事一次落盘，避免中途被打断留下半截状态：
 *   - `claimed` 的退回 `open`。先改台账再结束进程，退出回调据此判定该单已不在途，
 *     不按失败结单；
 *   - 写 `yielded_at` / `yielded_by`，界面据此标「已让位」，与失败、取消区分开；
 *   - 写 `yield_rank`（按传入顺序），恢复时据此还原先后。
 *
 * @returns 真正被改动的派单 id。
 */
export function markYielded(
  root: string,
  ids: readonly string[],
  by: string,
  at = new Date().toISOString(),
): string[] {
  const rows = readDispatches(root);
  const want = new Map<string, number>();
  ids.forEach((id, i) => {
    if (!want.has(id)) want.set(id, i);
  });
  const changed: string[] = [];
  for (const d of rows) {
    const rank = want.get(d.id);
    if (rank === undefined) continue;
    if (d.status !== "open" && d.status !== "claimed") continue;
    d.status = "open";
    d.yielded_at = at;
    d.yielded_by = by;
    d.yield_rank = rank;
    changed.push(d.id);
  }
  if (changed.length > 0) writeJsonl(dispatchPath(root), rows);
  return changed;
}

/**
 * 恢复：清掉某张立即执行单留下的让位标记。
 *
 * 没有像 `markYielded` 那样把 `yield_rank` 一起清掉，因为恢复不是「回到台账顺序」，
 * 而是「回到让位前的位置」，顺序信息要留到它真正被领走（`claimDispatch` 会清）。
 *
 * @returns 被恢复的派单，按恢复后的队列顺序。
 */
export function releaseYielded(root: string, by: string): Dispatch[] {
  const rows = readDispatches(root);
  const restored: Dispatch[] = [];
  for (const d of rows) {
    if (String(d.yielded_by ?? "") !== by) continue;
    delete d.yielded_at;
    delete d.yielded_by;
    restored.push(d);
  }
  if (restored.length > 0) writeJsonl(dispatchPath(root), rows);
  return restored
    .map((d, i) => ({ d, i }))
    .sort((a, b) => compareQueueOrder(a.d, b.d, a.i, b.i))
    .map((x) => x.d);
}

/**
 * 台账里所有还挂着让位标记的单。
 *
 * 租约文件是唯一权威；这个函数只服务一种情况：租约文件被外部删掉 / 写坏，而标记
 * 还留在台账上。那时按「没有租约」收尾，把标记清掉，不让那些单一直挂着「已让位」。
 */
export function yieldedDispatches(root: string): Dispatch[] {
  return readDispatches(root).filter((d) => Boolean(String(d.yielded_by ?? "").trim()));
}
