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
 * 成员按 `lineage` 聚合：同一件事重派多次时，只要有一次完成，这个成员就算完成；
 * 只有“失败且判定不再重试”才算断链。这条规则与派单侧的前置判定一致，
 * 差别只在作用域：放宽只对单个成员有效，不扩展为“组里有一份完成就算整组完成”。
 */

import type { Dispatch } from "../record/supervisor";
import { parentOf } from "../record/supervisor";
import { isFailed, isSettled } from "../record/dispatchState";
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
  /** 成员总数。 */
  total: number;
  /** 已完成的成员数（`done`；人工结束的 `closed` 不计入，但阻塞放行时按已了结算）。 */
  done: number;
  /** 还没到终态的成员（含待重试的失败）。 */
  pending: string[];
  /** 判定为不再重试的失败成员。 */
  failed: string[];
  /** 断链位置：第一个不再重试的失败成员；未断链为空串。 */
  brokenAt: string;
}

/** 一条派生链（同一件事）的完成情况。 */
interface LineageState {
  done: boolean;
  closed: boolean;
  dead: boolean;
}

function lineageKey(d: Dispatch): string {
  return String((d as { lineage?: unknown }).lineage ?? d.id);
}

/**
 * 汇总每一件事的完成情况。
 *
 * `dead` 只认“失败且不再重试”：`retry_verdict === "give_up"`，或该单被级联判定
 * 失败（`cascade_at` 有值）。可重试的失败不计为终态，它还在等重派。
 */
function lineageStates(rows: readonly Dispatch[]): Map<string, LineageState> {
  const out = new Map<string, LineageState>();
  for (const d of rows) {
    const key = lineageKey(d);
    const cur = out.get(key) ?? { done: false, closed: false, dead: false };
    const status = String(d.status ?? "");
    if (status === "done") cur.done = true;
    else if (status === "closed") cur.closed = true;
    else if (isFailed(status)) {
      const verdict = String((d as { retry_verdict?: unknown }).retry_verdict ?? "");
      const cascaded = Boolean(String((d as { cascade_at?: unknown }).cascade_at ?? ""));
      if (verdict === "give_up" || cascaded) cur.dead = true;
    }
    out.set(key, cur);
  }
  return out;
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

  const memberIds = idx.members.get(key) ?? [];
  const byId = new Map(rows.map((d) => [String(d.id), d] as const));
  const lineages = lineageStates(rows);

  let done = 0;
  const pending: string[] = [];
  const failed: string[] = [];
  let running = false;
  let review = false;
  let waiting = false;

  for (const id of memberIds) {
    const d = byId.get(id);
    /* 成员记录已不在台账（归档或手动删除）：按已了结处理，不阻塞放行，也不计入完成数。 */
    if (!d) continue;
    const st = String(d.status ?? "");
    const lin = lineages.get(lineageKey(d));

    if (isSettled(st)) {
      if (st === "done") done += 1;
      continue;
    }
    if (isFailed(st)) {
      if (lin?.done || lin?.closed) {
        /* 同一件事已有一次完成，本次失败属于重试过程，不阻塞。 */
        continue;
      }
      if (lin?.dead) {
        failed.push(id);
        continue;
      }
      /* 可重试的失败：尚未到终态，等待重派。整组因此处于等待，不显示成排队。 */
      pending.push(id);
      waiting = true;
      continue;
    }
    pending.push(id);
    if (st === "claimed") running = true;
    else if (st === "reported" || st === "review") review = true;
    /*
     * `open` 归 queued：该成员自己的前置是否满足，由派单侧判定（`deps` / 森林视图），
     * 组这一层看不到成员之间的依赖关系，不重复推导。组的 waiting 只表示“等待重派”。
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

  return { id: key, state, total: memberIds.length, done, pending, failed, brokenAt };
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
