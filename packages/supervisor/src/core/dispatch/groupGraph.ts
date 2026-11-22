/**
 * 分组的状态派生与放行判定。
 *
 * 组不落状态：组记录只存标题与解散状态，其余全部由成员派单实时算出。
 * 这一处理与派单状态口径一致。同一事实保存在两处，容易产生不一致；成员失败后重派成功时，
 * 落盘状态需要一次回写才能纠正，回写失败即长期错误。
 *
 * 三项判定：
 *   - {@link groupStatusOf}：组当前处于哪一档（给界面与命令行）；
 *   - {@link groupSettled}：挂在该组下的下游能不能放行（给调度）；
 *   - {@link ancestorsOf}：从某个节点一路上溯（给成环检测，派单与组共用）。
 *
 * 成员按 `lineage` 聚合成“事项”再计完成：同一件事重派多次只算一项，否则重派会把
 * 完成数分母撑大（实测一轮重试把 11 项撑成 26 项）。事项是组的计数与判定单位，
 * {@link groupItemsOf} 是唯一聚合入口。
 *
 * 接替单（`supersedes`）与被接替事项合并为同一事项：补单顶替失败成员时，组的成员数
 * 不变，完成情况以接替单为准。
 */

import type { Dispatch } from "../record/supervisor";
import { parentOf } from "../record/supervisor";
import { isFailed } from "../record/dispatchState";
import { normalizeGroupId } from "../record/idMap";
import type { GroupIndex } from "../record/groups";

/** 组状态。优先级：`closed` > `blocked` > `running` > `review` > `waiting` > `queued` > `done`。 */
export type GroupState = "queued" | "running" | "review" | "waiting" | "done" | "blocked" | "closed";

/**
 * 组状态的中文说法。命令行与提示词共用这一处，避免一边写“断链”一边写“失败”。
 *
 * 这不是界面文案出口（界面文案仍走 `board/render.ts`）：这里是给调用方与模型看的
 * 结构状态，取值集合与 {@link GroupState} 一一对应，改一处即全局一致。
 */
export function groupStateWord(s: GroupState): string {
  switch (s) {
    case "queued":
      return "排队中";
    case "running":
      return "执行中";
    case "review":
      return "待复核";
    case "waiting":
      return "等重派";
    case "done":
      return "已完成";
    case "blocked":
      return "已断链";
    case "closed":
      return "已解散";
    default:
      return String(s);
  }
}

/** 一个组的派生状态。 */
export interface GroupStatus {
  id: string;
  state: GroupState;
  /** 事项总数：同一件事重派多次只算一项，接替的单与被接替事项算一项。 */
  total: number;
  /** 已完成的事项数（`done`；人工结束的 `closed` 不计入，但阻塞放行时按已了结算）。 */
  done: number;
  /** 还没到终态的事项，取各自代表单的 id（含待重试的失败）。 */
  pending: string[];
  /** 判定为不再重试的失败事项，取各自代表单的 id。 */
  failed: string[];
  /** 断链位置：第一个不再重试的失败事项的代表单；未断链为空串。 */
  brokenAt: string;
}

/** 组内一件事：同一 lineage 的全部派单，加上接替过来的链。 */
export interface GroupItem {
  /** 事项键：被接替事项的 lineage；没有接替时就是该事项自身的 lineage。 */
  key: string;
  /** 该事项的全部派单 id，按台账顺序。 */
  ids: string[];
  /** 代表单：台账里最新的一张，用于显示与按号操作。 */
  head: string;
  /** 合并后的状态。 */
  state: "done" | "closed" | "dead" | "pending";
}

/** 一条派生链（同一件事）的键。 */
export function lineageOf(d: Dispatch): string {
  return String((d as { lineage?: unknown }).lineage ?? d.id);
}

/**
 * 一件事的合并状态。
 *
 * `dead` 只认“失败且不再重试”：`retry_verdict === "give_up"`，或该单被级联判定
 * 失败（`cascade_at` 有值）。可重试的失败不算终态，它还在等重派。
 * 优先级与旧口径一致：完成 > 人工结束 > 断链 > 等待。
 */
function itemStateOf(rows: readonly Dispatch[]): GroupItem["state"] {
  let closed = false;
  let dead = false;
  for (const d of rows) {
    const status = String(d.status ?? "");
    if (status === "done") return "done";
    if (status === "closed") {
      closed = true;
      continue;
    }
    if (!isFailed(status)) continue;
    const verdict = String((d as { retry_verdict?: unknown }).retry_verdict ?? "");
    const cascaded = Boolean(String((d as { cascade_at?: unknown }).cascade_at ?? ""));
    if (verdict === "give_up" || cascaded) dead = true;
  }
  if (closed) return "closed";
  if (dead) return "dead";
  return "pending";
}

/**
 * 把一个组的成员聚合成事项。组的计数、判定、展示都从这里取，不另写推导。
 *
 * 两步：先按 `supersedes` 把接替单与被接替事项并到同一集合（并查集，键取被接替者的
 * lineage，保证事项键在接替前后不变），再按集合汇总状态。目标已归档或不在本组时跳过
 * 合并，不抛错：建单时已校验，归档是后续变化。
 */
export function groupItemsOf(gid: string, rows: readonly Dispatch[], idx: GroupIndex): GroupItem[] {
  const key = normalizeGroupId(gid);
  if (!key) return [];
  const memberIds = idx.members.get(key) ?? [];
  if (memberIds.length === 0) return [];
  const byId = new Map(rows.map((d) => [String(d.id), d] as const));
  const memberSet = new Set(memberIds);

  const up = new Map<string, string>();
  const find = (x: string): string => {
    let cur = x;
    while (up.has(cur) && up.get(cur) !== cur) cur = up.get(cur) as string;
    if (cur !== x) up.set(x, cur);
    return cur;
  };
  /** 让接替单所在的集合指向被接替事项，合并后事项键仍是原来的 lineage。 */
  const union = (target: string, superseder: string): void => {
    const a = find(target);
    const b = find(superseder);
    if (a !== b) up.set(b, a);
  };

  for (const id of memberIds) {
    const d = byId.get(id);
    const sup = String((d as { supersedes?: unknown } | undefined)?.supersedes ?? "").trim();
    if (!d || !sup || !memberSet.has(sup)) continue;
    const target = byId.get(sup);
    if (!target) continue;
    union(lineageOf(target), lineageOf(d));
  }

  const buckets = new Map<string, { ids: string[]; rows: Dispatch[] }>();
  for (const id of memberIds) {
    const d = byId.get(id);
    /* 成员记录已不在台账（归档或手动删除）：按已了结处理，不占分母，也不计完成。 */
    if (!d) continue;
    const root = find(lineageOf(d));
    const cur = buckets.get(root) ?? { ids: [], rows: [] };
    cur.ids.push(String(d.id));
    cur.rows.push(d);
    buckets.set(root, cur);
  }

  return [...buckets.entries()].map(([k, v]) => ({
    key: k,
    ids: v.ids,
    head: v.ids[v.ids.length - 1] ?? k,
    state: itemStateOf(v.rows),
  }));
}

/** 派生一个组的状态。组不存在时返回 `null`。 */
export function groupStatusOf(
  gid: string,
  rows: readonly Dispatch[],
  idx: GroupIndex,
): GroupStatus | null {
  const key = normalizeGroupId(gid);
  const group = key ? idx.byId.get(key) : undefined;
  if (!key || !group) return null;

  const items = groupItemsOf(key, rows, idx);
  const byId = new Map(rows.map((d) => [String(d.id), d] as const));

  let done = 0;
  const pending: string[] = [];
  const failed: string[] = [];
  let running = false;
  let review = false;
  let waiting = false;

  for (const item of items) {
    if (item.state === "done") {
      done += 1;
      continue;
    }
    /* 人工结束的事项按已了结处理：不阻塞放行，也不计入完成数。 */
    if (item.state === "closed") continue;
    if (item.state === "dead") {
      failed.push(item.head);
      continue;
    }
    pending.push(item.head);
    const st = String(byId.get(item.head)?.status ?? "");
    if (st === "claimed") running = true;
    else if (st === "reported" || st === "review") review = true;
    /* 可重试的失败：尚未到终态，等待重派。整组因此处于等待，不显示成排队。 */
    else if (isFailed(st)) waiting = true;
    /*
     * `open` 归 queued：该事项自己的前置是否满足，由派单侧判定（`deps` / 森林视图），
     * 组这一层看不到事项之间的依赖关系，不重复推导。组的 waiting 只表示“等待重派”。
     */
  }

  const brokenAt = failed[0] ?? "";
  let state: GroupState;
  if (String(group.state ?? "") === "closed") state = "closed";
  else if (failed.length > 0) state = "blocked";
  else if (running) state = "running";
  else if (review) state = "review";
  else if (waiting) state = "waiting";
  else if (pending.length === 0) state = "done";
  else state = "queued";

  return { id: key, state, total: items.length, done, pending, failed, brokenAt };
}

/**
 * 挂在该组下的下游能否放行。
 *
 * 可放行有两种情形：
 *   1. 组被人工解散（`state: closed`）：人工决定不再以它作为前置；
 *   2. 组内没有“不再重试的失败”，且全部成员已了结（`done` / `closed` / 记录缺失）。
 *
 * 可重试的失败不算放行，也不算断链：它还在等重派，下游应当继续等。
 * 这条与“等待一个可恢复的父节点”是同一件事，区别只是父节点换成了一个组。
 */
export function groupSettled(
  gid: string,
  rows: readonly Dispatch[],
  idx: GroupIndex,
): { settled: boolean; pending: string[]; failed: string[] } {
  const st = groupStatusOf(gid, rows, idx);
  if (!st) return { settled: false, pending: [], failed: [] };
  if (st.state === "closed") return { settled: true, pending: [], failed: [] };
  if (st.failed.length > 0) return { settled: false, pending: st.pending, failed: st.failed };
  return { settled: st.pending.length === 0, pending: st.pending, failed: [] };
}

/**
 * 从节点出发一路上溯的父链（不含自身）。
 *
 * 派单的父是 `parent`；组的父是“任一成员的父”。组没有自己的父字段，位置由成员推导，
 * 因此成员的父必须一致（建组时校验）。遇到记录缺失即停止，不抛。
 */
export function ancestorsOf(
  nodeId: string,
  rows: readonly Dispatch[],
  idx: GroupIndex,
  limit = 256,
): string[] {
  const byId = new Map(rows.map((d) => [String(d.id), d] as const));
  const out: string[] = [];
  const seen = new Set<string>([String(nodeId)]);

  const parentNodeOf = (id: string): string => {
    const key = normalizeGroupId(id);
    if (key && idx.byId.has(key)) {
      const members = idx.members.get(key) ?? [];
      for (const m of members) {
        const d = byId.get(m);
        const p = d ? parentOf(d) : "";
        if (p) return p;
      }
      return "";
    }
    const d = byId.get(String(id));
    return d ? parentOf(d) : "";
  };

  let cur = parentNodeOf(String(nodeId));
  while (cur && out.length < limit) {
    const gid = normalizeGroupId(cur);
    const norm = gid && idx.byId.has(gid) ? gid : cur;
    if (seen.has(norm)) break;
    seen.add(norm);
    out.push(norm);
    cur = parentNodeOf(norm);
  }
  return out;
}
