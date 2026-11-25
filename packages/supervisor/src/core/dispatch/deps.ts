/**
 * 前置判定的唯一实现：一张单要等谁、还差谁。
 *
 * 判定分两段：
 *   1. 派单前置（`parent` / `after` 里的派单 id）沿用原有规则：同 lineage 的后续尝试
 *      完成即视为满足，同分片已有完成单也视为满足；
 *   2. 组前置（`parent` / `after` 里的 `G` 号）交给 {@link groupSettled}：整组了结才放行。
 *
 * 两段分开的理由：组是“多个成员的集合”，它的满足条件与单张派单不同（要么全完成，
 * 要么断链），不能复用单张单的宽容规则，否则“组里有一份完成”会被误判成“整组完成”。
 *
 * 本模块只做判定，不读盘。调用方传入台账与组索引；没有组时行为保持不变。
 */

import type { Dispatch } from "../record/supervisor";
import { prerequisitesOf, pendingPrerequisites } from "../record/supervisor";
import { isGroupRef } from "../record/nodeRef";
import { normalizeGroupId } from "../record/idMap";
import type { GroupIndex } from "../record/groups";
import { groupSettled } from "./groupGraph";

/** 一张单的前置拆分结果：哪些是派单前置、哪些是组前置、是否需要等待所有其他派单。 */
export interface SplitPrerequisites {
  /** 派单 id（已排除组号）。 */
  dispatchIds: string[];
  /** 组号（大写）。 */
  groupIds: string[];
  /** `after` 里带 `"*"`：等所有其它单到终态。 */
  barrier: boolean;
}

/** 把一张单的前置拆成派单与组两类。 */
export function splitPrerequisites(d: { id?: string; parent?: string; after?: string[] }): SplitPrerequisites {
  const { ids, barrier } = prerequisitesOf(d);
  const dispatchIds: string[] = [];
  const groupIds: string[] = [];
  for (const id of ids) {
    const gid = isGroupRef(id) ? normalizeGroupId(id) : "";
    if (gid) groupIds.push(gid);
    else dispatchIds.push(id);
  }
  return { dispatchIds, groupIds, barrier };
}

/**
 * 组边覆盖它的成员边：同一张单同时挂着组与组内成员时，只按组计一次。
 *
 * 组边是整批前置的概括，成员边是其中一条。挂组之后仍留着指向成员的 `after`
 * 会让同一批前置被记两遍：界面只报成员号，组解散后也仍被成员边挡住。
 */
function coveredByGroups(groupIds: readonly string[], idx: GroupIndex | undefined): Set<string> {
  const out = new Set<string>();
  if (!idx) return out;
  for (const gid of groupIds) {
    for (const m of idx.members.get(gid) ?? []) out.add(String(m));
    /* 组号本身也常被重复写进 `after`，与 `parent` 指向同一个组，同样去重。 */
    out.add(gid);
  }
  return out;
}

/**
 * 还差哪些前置没满足。
 *
 * 返回值里组号原样给出（`G1`），供界面显示“等待 #G1”。顺序固定：
 * 先组后派单，各自保持声明顺序。界面取第一个未满足项作为卡点，顺序必须稳定；
 * 组比单条成员更能说明“还差整组”，所以排在前面。
 *
 * 指向已声明组的成员的派单前置不再单独计入：组边已覆盖这一批，避免同一批前置记两遍。
 */
export function pendingOf(
  d: { id: string; parent?: string; after?: string[] },
  rows: readonly Dispatch[],
  idx?: GroupIndex | undefined,
): string[] {
  const { dispatchIds, groupIds, barrier } = splitPrerequisites(d);
  const pending: string[] = [];

  if (groupIds.length > 0 && idx) {
    for (const gid of groupIds) {
      if (!groupSettled(gid, rows, idx).settled) pending.push(gid);
    }
  } else if (groupIds.length > 0 && !idx) {
    /*
     * 没有组索引时，既不视为满足，也不视为不满足：记入结果，由调用方决定如何上报。
     * 调度侧一律传索引；命令行只读视图缺索引说明组台账缺失，应显式提示该组状态未知。
     */
    pending.push(...groupIds);
  }

  /* 缺索引时查不到成员，无法去重，按原样逐条判定。 */
  const covered = coveredByGroups(groupIds, idx);
  const ownDispatchIds = dispatchIds.filter((id) => !covered.has(id));

  if (ownDispatchIds.length > 0 || barrier) {
    /*
     * 交给原判定：把拆出的派单前置重新装成 `after`，不传 `parent`，
     * 因为 `parent` 可能正是组号。只有一个派单前置时 `parentOf` 会把它当父节点，
     * 但原判定内部走的是 `prerequisitesOf`，两条路径结果相同。
     */
    const view = {
      id: d.id,
      ...(barrier ? { after: ["*", ...ownDispatchIds] } : { after: ownDispatchIds }),
    };
    pending.push(...pendingPrerequisites(view, rows as Dispatch[]));
  }

  return pending;
}

/** 前置是否全部满足。`pendingOf` 为空的简写，调度与视图共用。 */
export function isReady(
  d: { id: string; parent?: string; after?: string[] },
  rows: readonly Dispatch[],
  idx?: GroupIndex | undefined,
): boolean {
  return pendingOf(d, rows, idx).length === 0;
}

/** 第一个未满足的前置；`"*"` 屏障不是具体节点，跳过。没有则空串。 */
export function firstBlocker(
  d: { id: string; parent?: string; after?: string[] },
  rows: readonly Dispatch[],
  idx?: GroupIndex | undefined,
): string {
  return pendingOf(d, rows, idx).find((id) => id !== "*") ?? "";
}
