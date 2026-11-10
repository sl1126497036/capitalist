
import {
  dispatchForest,
  dispatchPath,
  parentOf,
  readDispatches,
  workKeyOf,
  type Dispatch,
} from "./supervisor";
import { writeJsonl } from "./json";
import { syncTaskForDispatch } from "./tasks";

export type RebuildAction = "close" | "reopen" | "keep";

export interface RebuildItem {
  id: string;
  action: RebuildAction;
  title: string;
  status: string;
  /** 给人看的处置理由，会写进台账 `note`。 */
  reason: string;
  /** 改完之后挂的父节点（仅 reopen / keep 有值）。 */
  parent: string;
  parentReason: string;
  /**
   * 这条处置是否真的会改台账。
   *
   * 「再跑一次什么都不做」要能被说出口：幂等的前提是计划能分清「该关但已经关了」
   * 与「该关还没关」。`stats.close` / `stats.reopen` 只数 pending 的，
   * 命令行据此输出「没有需要改的行」。
   */
  pending: boolean;
}

export interface RebuildGroup {
  /** 组标签：标题或正文前 40 字。 */
  label: string;
  members: string[];
  /** 组内已完工的代表单；空串表示整组没完成。 */
  settledBy: string;
  /** 未完成时选出的代表（最近一张）；已完成时为空。 */
  representative: string;
}

export interface RebuildEdge {
  /** 子组代表单；父组已完成时为空。 */
  child: string;
  /** 父组代表单；父组已完成时为空。 */
  parent: string;
  /** 这条边是从哪条记录上的哪个字段看出来的，给人核对。 */
  why: string;
}

export interface RebuildPlan {
  root: string;
  groups: RebuildGroup[];
  items: RebuildItem[];
  edges: RebuildEdge[];
  stats: {
    total: number;
    inFlight: number;
    settled: number;
    close: number;
    reopen: number;
    keep: number;
    /** 重建后有几棵树（每个未完工的根算一棵）。 */
    trees: number;
  };
  warnings: string[];
}

function isSettledStatus(s: string): boolean {
  return s === "done" || s === "closed";
}

/**
 * 这一行是否算「这件事做完了」。
 *
 * 重建自己关掉的残留（`rebuilt_at` 有值）不算：它们是被重建关掉的，不是被做完的。
 * 不排除它们的后果是第二次重建把待办也关掉，第一轮把 A 并进 A2（A 记 closed），
 * 第二轮就会把 A 当成「同一件事已完成」，于是 A2 这个待办也被关，桌上什么都不剩。
 * 幂等的要害就在这里。
 */
function isCompletion(d: Dispatch): boolean {
  const row = d as { status?: unknown; rebuilt_at?: unknown };
  return isSettledStatus(String(row.status)) && !String(row.rebuilt_at ?? "");
}

function labelOf(d: Dispatch): string {
  const t = String((d as { title?: unknown }).title ?? "").trim();
  return (t || workKeyOf(d)).slice(0, 40);
}

/**
 * 读台账，产出重建计划。纯读，不改盘。
 *
 * 分两阶段是刻意的：先看要关哪些、重开哪些、连哪条边，再决定落不落。
 * `capitalist tree rebuild --dry` 打印的就是这份计划。
 */
export function planRebuild(root: string): RebuildPlan {
  const rows = readDispatches(root);
  const warnings: string[] = [];
  const byId = new Map(rows.map((d) => [String(d.id), d] as const));

  const byKey = new Map<string, Dispatch[]>();
  for (const d of rows) {
    const k = workKeyOf(d);
    const list = byKey.get(k);
    if (list) list.push(d);
    else byKey.set(k, [d]);
  }

  const groups: RebuildGroup[] = [];
  const groupOf = new Map<string, number>();

  for (const [key, members] of byKey) {
    const settled = members.filter((d) => isCompletion(d));
    const settledBy = settled.length
      ? settled
          .slice()
          .sort((a, b) => String(a.done_at ?? a.at ?? "").localeCompare(String(b.done_at ?? b.at ?? "")))[0]!.id
      : "";
    const pickable = members.filter(
      (d) => String((d as { closed_by?: string }).closed_by ?? "") !== "user",
    );
    const representative = settledBy || pickable.length === 0 ? "" : String(pickable[pickable.length - 1]!.id);
    const idx = groups.length;
    groups.push({
      label: labelOf(members[0]!),
      members: members.map((d) => String(d.id)),
      settledBy,
      representative,
    });
    for (const d of members) groupOf.set(String(d.id), idx);
    void key;
  }

  const seenEdge = new Set<string>();
  const rawEdges: Array<{ from: number; to: number; why: string }> = [];
  for (const d of rows) {
    const id = String(d.id);
    const from = groupOf.get(id);
    if (from === undefined) continue;
    const after = Array.isArray(d.after) ? d.after.filter((x) => x !== "*") : [];
    const targets = [parentOf(d), ...after].map((x) => String(x ?? "").trim()).filter(Boolean);
    for (const t of targets) {
      const to = groupOf.get(t);
      if (to === undefined || to === from) continue;
      const key = `${from}->${to}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      rawEdges.push({ from, to, why: `${id} 的记录上写着前置 ${t}` });
    }
  }

  const items: RebuildItem[] = [];
  for (const d of rows) {
    const id = String(d.id);
    const status = String(d.status);
    const g = groups[groupOf.get(id)!]!;

    if (g.settledBy) {
      /*
       * 已完工组：留下完工的那张，其余已完工的单也保留不动，它们是既成事实，
       * 关掉等于抹掉「这件事做过两遍」的记录。只关失败/在途的残留。
       */
      if (id === g.settledBy) {
        items.push({
          id,
          action: "keep",
          title: labelOf(d),
          status,
          reason: "这件事的完工记录，保留",
          parent: "",
          parentReason: "",
          pending: false,
        });
      } else if (isSettledStatus(status)) {
        items.push({
          id,
          action: "keep",
          title: labelOf(d),
          status,
          reason: "同一件事的另一条完工记录，保留不动",
          parent: "",
          parentReason: "",
          pending: false,
        });
      } else {
        items.push({
          id,
          action: "close",
          title: labelOf(d),
          status,
          reason: `同一件事已完成于 ${g.settledBy}`,
          parent: "",
          parentReason: "",
          pending: false,
        });
      }
      continue;
    }

    items.push(
      id === g.representative
        ? {
            id,
            action: "reopen",
            title: labelOf(d),
            status,
            reason: "这件事还没做完，作为代表重新排队",
            parent: "",
            parentReason: "",
            pending: false,
          }
        : {
            id,
            action: "close",
            title: labelOf(d),
            status,
            reason: `并入代表单 ${g.representative}（同一件事只留一条待办）`,
            parent: "",
            parentReason: "",
            pending: false,
          },
    );
  }

  const edges: RebuildEdge[] = [];
  for (const re of rawEdges) {
    const childRep = groups[re.from]!.representative;
    const parentRep = groups[re.to]!.representative;
    if (childRep && parentRep) {
      const it = items.find((x) => x.id === childRep)!;
      it.parent = parentRep;
      it.parentReason = `重建：${re.why}`;
      edges.push({ child: childRep, parent: parentRep, why: re.why });
      continue;
    }
    if (childRep && !parentRep) {
      /* 父组已完成：完成的单不进树，子单按根处理并留一句说明。 */
      edges.push({ child: childRep, parent: "", why: `${re.why}；但父组已完成（${groups[re.to]!.settledBy}），按根处理` });
      warnings.push(`${childRep} 原本挂在已完工的 ${groups[re.to]!.settledBy} 上：不连边（完成的单不进树），按根处理`);
      continue;
    }
    edges.push({ child: "", parent: parentRep, why: `${re.why}；子组已完成，边不保留` });
  }

  const live = groups.filter((g) => g.representative);
  const fake: Dispatch[] = live.map((g) => {
    const it = items.find((x) => x.id === g.representative)!;
    const row = { ...byId.get(g.representative)! } as Record<string, unknown>;
    delete row.after;
    if (it.parent) row.parent = it.parent;
    else delete row.parent;
    return row as unknown as Dispatch;
  });
  const forest = dispatchForest(fake);
  for (const cyc of forest.cycles) {
    warnings.push(`重建会造出环（${cyc.join(" ↔ ")}）：已放弃这些边，保持为根`);
    for (const id of cyc) {
      const it = items.find((x) => x.id === id);
      if (it) {
        it.parent = "";
        it.parentReason = "";
      }
    }
  }

  for (const it of items) {
    const cur = byId.get(it.id);
    if (!cur) continue;
    if (it.action === "close") {
      it.pending = !isSettledStatus(it.status);
    } else if (it.action === "reopen") {
      const curRow = cur as { parent?: unknown; retry_verdict?: unknown };
      /* 待裁决派单的状态不随重建改变，pending 按同一规则计算。 */
      const inReview = it.status === "reported" || it.status === "review";
      it.pending =
        !inReview &&
        (it.status !== "open" ||
          String(curRow.retry_verdict ?? "") === "give_up" ||
          String(curRow.parent ?? "") !== it.parent);
    }
  }

  const roots = new Set(items.filter((x) => x.action === "reopen" && !x.parent).map((x) => x.id));
  return {
    root,
    groups,
    items,
    edges,
    stats: {
      total: rows.length,
      inFlight: rows.filter((d) => d.status === "open" || d.status === "claimed" || d.status === "review").length,
      settled: rows.filter((d) => isSettledStatus(String(d.status))).length,
      close: items.filter((x) => x.action === "close" && x.pending).length,
      reopen: items.filter((x) => x.action === "reopen" && x.pending).length,
      keep: items.filter((x) => x.action === "keep").length,
      trees: roots.size,
    },
    warnings,
  };
}

/**
 * 落盘执行重建计划。
 *
 * 一次写完整个文件：中途失败不会留下「关了一半」的台账。
 * 只改 `status` / `parent` / `parent_reason` / `retry_verdict` / `note` 这几个字段，
 * 正文、编号、时间、血缘一律不动，重建的是结构，不是历史。
 */
export function applyRebuild(root: string, plan: RebuildPlan, by = "rebuild"): { closed: number; reopened: number } {
  const rows = readDispatches(root).slice();
  const at = new Date().toISOString();
  let closed = 0;
  let reopened = 0;
  /** 改过的行：收尾时逐条同步任务池投影。 */
  const changed: Dispatch[] = [];

  for (const it of plan.items) {
    const idx = rows.findIndex((d) => String(d.id) === it.id);
    if (idx < 0) continue;
    const cur = rows[idx]!;

    if (it.action === "close") {
      if (isSettledStatus(String(cur.status))) continue;
      /** `rebuilt_at` 是给重建自己看的记号：这一行是被重建关掉的，不是被做完的。 */
      const next = {
        ...cur,
        status: "closed",
        done_at: at,
        closed_at: at,
        closed_by: by,
        rebuilt_at: at,
        note: it.reason,
      } as Dispatch;
      rows[idx] = next;
      changed.push(next);
      closed += 1;
      continue;
    }

    if (it.action === "reopen") {
      const inReview = cur.status === "reported" || cur.status === "review";
      const patch: Record<string, unknown> = {};
      if (cur.status !== "open" && !inReview) {
        patch.status = "open";
        patch.done_at = "";
        patch.closed_at = "";
        patch.closed_by = "";
        reopened += 1;
      }
      if (String((cur as { retry_verdict?: string }).retry_verdict ?? "") === "give_up") {
        patch.retry_verdict = "retry";
        patch.retry_why = `重建树后重新排队（${it.reason}）`;
      }
      if (it.parent) {
        patch.parent = it.parent;
        patch.parent_reason = it.parentReason;
        /* `after` 是遗留形状，重建后统一用 `parent` 表达树边，删除以避免两套并存。 */
        patch.after = undefined;
      } else if (cur.parent) {
        patch.parent = "";
        patch.parent_reason = "";
      }
      if (Object.keys(patch).length > 0) {
        const next = { ...cur, ...patch } as Dispatch;
        rows[idx] = next;
        changed.push(next);
      }
      continue;
    }

    /* keep：已完工的单，只在需要补父边时动一下（不常见）。 */
    if (it.parent && String(cur.parent ?? "") !== it.parent) {
      const next = { ...cur, parent: it.parent, parent_reason: it.parentReason } as Dispatch;
      rows[idx] = next;
      changed.push(next);
    }
  }

  writeJsonl(dispatchPath(root), rows);
  /*
   * 任务池是派单的投影，重建改了状态就必须同步。
   * 不同步的后果很直接：「已验收 10 / 失败待重试 11 / 未完成 11」会原地不动，
   * 用户看着面板以为重建没生效，面板上还能看见旧数字，就是没做完。
   */
  for (const n of changed) syncTaskForDispatch(root, n);
  return { closed, reopened };
}

/** 未完工的状态集合：与调度口径一致（`open` 等拉起、`claimed` 在跑、`review` 待复核）。 */
const IN_FLIGHT_STATUS = new Set(["open", "claimed", "review"]);

export interface FlatCheck {
  /** 未完工单是否一条父边都没有，台账是平的，不是树。 */
  flat: boolean;
  /** 未完工单数。 */
  inFlight: number;
}

/** 判「台账是平的」：未完工单超过 1 张，且每一张都没有父节点。 */
export function looksFlat(root: string): FlatCheck {
  const rows = readDispatches(root);
  const live = rows.filter((d) => IN_FLIGHT_STATUS.has(String(d.status)));
  return { flat: live.length > 1 && live.every((d) => !parentOf(d)), inFlight: live.length };
}

/** 监工启动时的一次性结构修复：台账是平的才重建，返回播报文案（空串表示不需要动）。 */
export function autoRebuild(root: string): string {
  const check = looksFlat(root);
  if (!check.flat) return "";

  const plan = planRebuild(root);
  if (plan.stats.close === 0 && plan.stats.reopen === 0) return "";
  applyRebuild(root, plan, "auto-rebuild");
  return `已重建 ${plan.stats.trees} 棵树（未完工 ${check.inFlight} 单）`;
}
