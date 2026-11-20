/**
 * 树结构的唯一写入口：改组成员、改挂父节点、摘成根、解散组。
 *
 * 为什么必须收成一处：`parent` / `group` 是两个字段，但它们共同表达“树的结构”。
 * 建单、重派、命令行、界面都在改同一棵树，各写各的会出现半截结构：
 * 单点改挂可能把组成员改到不同父节点，新单写组却无人校验组是否存在。
 *
 * 写盘口径与台账其他写路径一致：读全量、改内存、整份覆盖写。一次调用只写一次盘，
 * 中途校验失败即整批拒绝，不留半截树。
 */

import type { Dispatch } from "../record/supervisor";
import { dispatchPath, parentOf, readDispatches } from "../record/supervisor";
import { writeJsonl } from "../record/json";
import { syncTaskForDispatch } from "../record/tasks";
import { normalizeGroupId } from "../record/idMap";
import { groupIndexOf, readGroups, resolveGroupRef, writeGroups } from "../record/groups";
import { groupStatusOf, ancestorsOf } from "./groupGraph";
import { groupIndexFrom } from "./groupOps";

/** 一次结构变更的结果。`changed` 是真正改了字段的派单 id。 */
export interface TreeChangeResult {
  ok: boolean;
  changed: string[];
  /** 逐条拒绝原因。非空时 `ok` 为 false，且台账未改动。 */
  errors: Array<{ id: string; reason: string }>;
}

function fail(errors: TreeChangeResult["errors"]): TreeChangeResult {
  return { ok: false, changed: [], errors };
}

/**
 * 把一批派单收进一个组（`groupId` 为空表示移出组）。
 *
 * 校验三件事：
 *   1. 每一条派单都在台账里；
 *   2. 组存在且未解散（移出组时不校验）；
 *   3. 成员的父节点一致。组的位置由成员父推导，父节点不一致等于组在树上没有位置。
 *
 * 已在组里的成员允许改到另一个组，但同样受父一致约束。
 */
export function assignGroup(root: string, ids: readonly string[], groupId: string): TreeChangeResult {
  const want = normalizeGroupId(groupId);
  const rows = readDispatches(root);
  const byId = new Map(rows.map((d) => [String(d.id), d] as const));
  const errors: TreeChangeResult["errors"] = [];

  const ids_ = [...new Set(ids.map((x) => String(x ?? "").trim()).filter(Boolean))];
  if (ids_.length === 0) return fail([{ id: "", reason: "没有指定派单" }]);

  if (want) {
    const group = resolveGroupRef(root, want);
    if (!group) return fail([{ id: want, reason: `分组 ${want} 不存在：先执行 capitalist tree group new <标题> 建组` }]);
    if (String(group.state ?? "") === "closed") {
      return fail([{ id: want, reason: `分组 ${want} 已解散：新建一个组后重试` }]);
    }
  }

  /* 父一致：以批内第一条的父为基准，与批内其余成员及组内既有成员逐一比对。 */
  const base = ((): string => {
    for (const id of ids_) {
      const d = byId.get(id);
      if (d) return parentOf(d);
    }
    return "";
  })();

  for (const id of ids_) {
    const d = byId.get(id);
    if (!d) {
      errors.push({ id, reason: "派单不在台账里（可能已归档）：先核对编号" });
      continue;
    }
    if (parentOf(d) !== base) {
      errors.push({
        id,
        reason: `本单父节点是 ${parentOf(d) || "（根）"}，与同组其他成员 ${base || "（根）"} 不一致：同一组成员必须共享父节点`,
      });
    }
  }
  if (want) {
    const idx = groupIndexFrom(root, rows);
    for (const m of idx.members.get(want) ?? []) {
      if (ids_.includes(m)) continue;
      const d = byId.get(m);
      if (!d) continue;
      if (parentOf(d) !== base) {
        errors.push({
          id: m,
          reason: `组内已有成员 ${m} 的父节点是 ${parentOf(d) || "（根）"}，与本批 ${base || "（根）"} 不一致`,
        });
      }
    }
  }
  if (errors.length > 0) return fail(errors);

  const changed: string[] = [];
  const next = rows.map((d) => {
    if (!ids_.includes(String(d.id))) return d;
    changed.push(String(d.id));
    const row = { ...d } as Dispatch & { group?: string };
    if (want) row.group = want;
    else delete row.group;
    return row;
  });
  if (changed.length > 0) writeJsonl(dispatchPath(root), next);
  return { ok: true, changed, errors: [] };
}

/**
 * 把一批派单改挂到同一个父节点（`parentId` 为空表示摘成根）。
 *
 * 三条拒绝条件：派单不存在、父节点不存在、改挂后成环。成环检测走 `ancestorsOf`，
 * 派单与组共用同一条上溯路径：挂组与挂单的环是同一种环。
 */
export function reassignParent(
  root: string,
  ids: readonly string[],
  parentId: string,
  reason: string,
): TreeChangeResult {
  /*
   * 落盘一律写归一形态：调用方可能写 `#G01`、`G01` 或 `g1`，台账里只应有 `G1`。
   * 判定侧虽然会把它们归到一起，但两种形态并存会让“按 parent 字段 grep”查不全，
   * 也让导出与人工核对多一层换算。
   */
  const rawParent = String(parentId ?? "").trim();
  const parent = normalizeGroupId(rawParent) || rawParent;
  const rows = readDispatches(root);
  const byId = new Map(rows.map((d) => [String(d.id), d] as const));
  const errors: TreeChangeResult["errors"] = [];
  const ids_ = [...new Set(ids.map((x) => String(x ?? "").trim()).filter(Boolean))];
  if (ids_.length === 0) return fail([{ id: "", reason: "没有指定派单" }]);

  if (parent) {
    const gid = normalizeGroupId(parent);
    if (gid) {
      const group = resolveGroupRef(root, gid);
      if (!group) return fail([{ id: gid, reason: `分组 ${gid} 不存在` }]);
      if (String(group.state ?? "") === "closed") {
        return fail([{ id: gid, reason: `分组 ${gid} 已解散` }]);
      }
    } else if (!byId.has(parent)) {
      return fail([{ id: parent, reason: `父节点 ${parent} 不在台账里` }]);
    }
    if (!String(reason ?? "").trim()) {
      return fail([{ id: "", reason: "改挂必须写理由（PARENT_REASON）：说明为何必须先完成父节点" }]);
    }
  }

  /* 成环：新父的上溯链里出现本批任一节点即拒绝。 */
  const idx = groupIndexFrom(root, rows);
  if (parent) {
    const up = new Set([parent, ...ancestorsOf(parent, rows, idx)]);
    for (const id of ids_) {
      if (up.has(id)) errors.push({ id, reason: `改挂到 ${parent} 会成环：${parent} 已在 ${id} 的下游` });
    }
  }
  for (const id of ids_) if (!byId.has(id)) errors.push({ id, reason: "派单不在台账里" });
  if (errors.length > 0) return fail(errors);

  const next = rows.map((d) => {
    if (!ids_.includes(String(d.id))) return d;
    const row = { ...d } as Dispatch;
    if (parent) {
      row.parent = parent;
      row.parent_reason = String(reason);
    } else {
      delete row.parent;
      delete row.parent_reason;
    }
    return row;
  });
  writeJsonl(dispatchPath(root), next);
  return { ok: true, changed: [...ids_], errors: [] };
}

/** 解散组：下游按已收尾放行。不改成员记录，成员的 `group` 字段保留供追溯。 */
export function closeGroup(root: string, groupId: string, note: string): TreeChangeResult {
  const id = normalizeGroupId(groupId);
  if (!id) return fail([{ id: String(groupId), reason: "不是组号" }]);
  const groups = readGroups(root);
  const hit = groups.find((g) => g.id === id);
  if (!hit) return fail([{ id, reason: `分组 ${id} 不存在` }]);
  const next = groups.map((g) =>
    g.id === id
      ? { ...g, state: "closed" as const, ...(note ? { note } : {}) }
      : g,
  );
  writeGroups(root, next);
  return { ok: true, changed: [id], errors: [] };
}

/** 组的当前状态，供命令行打印。组不存在返回 null。 */
export function groupStatusFor(root: string, groupId: string) {
  const rows = readDispatches(root);
  const groups = readGroups(root);
  return groupStatusOf(groupId, rows, groupIndexOf(rows, groups));
}

/** 插入位置：插在锚点之前，或之后（之后＝锚点原有下游之前）。 */
export type InsertWhere = "before" | "after";

/** 插入时在途节点的处置。 */
export type InsertMode = "halt" | "keep" | "drop";

export interface InsertOptions {
  /** 已建好的新单 id。插入要改挂锚点，锚点必须已经有新单可挂。 */
  newId: string;
  /** 锚点：派单 id 或组号。 */
  anchor: string;
  where: InsertWhere;
  /** 缺省 `halt`：在途节点退回重做。 */
  mode?: InsertMode | undefined;
}

/** 插入结果。`stopDispatches` 是退回或作废的在途单，调用方负责结束它们的进程。 */
export interface InsertResult extends TreeChangeResult {
  stopDispatches: string[];
}

/** 在途状态：这些节点正在被某个进程做，插入会动它们的上游。 */
const IN_FLIGHT = new Set(["claimed", "reported", "review"]);

/**
 * 把新单插到锚点之前或之后。
 *
 * `before`：新单接管锚点的位置，锚点（整组时是全部成员）改挂新单。
 * `after`：新单挂到锚点下，锚点原有的下游改挂新单。否则新单只是与锚点成为兄弟，
 *          无法插入中间。
 *
 * 在途节点的处置三档：
 *   - `halt`（默认）：退回 `open` 并写 `restructured_at`，父未完成时不会进队列；
 *   - `keep`：不中断，继续运行（产出可能基于旧上游，正确性由调用方承担）；
 *   - `drop`：转 `closed`，备注“结构变更作废”。
 *
 * 结构变更不写 `yield_rank`：让位专用于“立即执行抢槽”，两套语义共用标记会让界面
 * 把“待重做”显示成“已让位”，恢复顺序也会互相干扰。
 */
export function insertNode(root: string, opt: InsertOptions): InsertResult {
  const rows = readDispatches(root);
  const byId = new Map(rows.map((d) => [String(d.id), d] as const));
  const groups = readGroups(root);
  const idx = groupIndexOf(rows, groups);
  const mode: InsertMode = opt.mode ?? "halt";

  const newRow = byId.get(String(opt.newId));
  if (!newRow) {
    return { ok: false, changed: [], errors: [{ id: opt.newId, reason: "新单还不在台账里" }], stopDispatches: [] };
  }

  const gid = normalizeGroupId(opt.anchor);
  const isGroup = Boolean(gid && idx.byId.has(gid));
  const anchorId = isGroup ? gid : String(opt.anchor ?? "").trim();
  const anchorRows = isGroup
    ? (idx.members.get(gid) ?? []).map((m) => byId.get(m)).filter((d): d is Dispatch => Boolean(d))
    : [byId.get(anchorId)].filter((d): d is Dispatch => Boolean(d));
  if (anchorRows.length === 0) {
    return { ok: false, changed: [], errors: [{ id: anchorId, reason: "锚点不在台账里" }], stopDispatches: [] };
  }
  /* 终态锚点没有产出，插在它前后都没有意义。 */
  const deadAnchor = anchorRows.find((d) => ["closed", "done"].includes(String(d.status ?? "")));
  if (deadAnchor) {
    return {
      ok: false,
      changed: [],
      errors: [{ id: String(deadAnchor.id), reason: "锚点已收尾，插在它前后不会改变任何顺序" }],
      stopDispatches: [],
    };
  }

  /* 新单的父与新位置：before 时接管锚点的父，after 时挂到锚点下。 */
  const nextParentOf = new Map<string, string>();
  if (opt.where === "before") {
    const anchorParent = parentOf(anchorRows[0] as Dispatch);
    if (String(newRow.parent ?? "") !== anchorParent) nextParentOf.set(String(newRow.id), anchorParent);
    for (const a of anchorRows) nextParentOf.set(String(a.id), String(newRow.id));
  } else {
    if (String(newRow.parent ?? "") !== anchorId) nextParentOf.set(String(newRow.id), anchorId);
    /* 锚点原有下游改挂新单：组成员不算下游（它们是组的成员，不是组的下游）。 */
    const memberSet = new Set(isGroup ? anchorRows.map((d) => String(d.id)) : []);
    for (const d of rows) {
      const id = String(d.id);
      if (id === String(newRow.id) || memberSet.has(id)) continue;
      if (parentOf(d) === anchorId) nextParentOf.set(id, String(newRow.id));
    }
  }

  /* 在途处置：只动被改挂的节点与其下游，`keep` 时一个都不动。 */
  const stopDispatches: string[] = [];
  const statusOf = new Map<string, Partial<Dispatch> & { restructured_at?: string; closed_at?: string }>();
  if (mode !== "keep") {
    for (const d of rows) {
      const id = String(d.id);
      if (!nextParentOf.has(id)) continue;
      if (!IN_FLIGHT.has(String(d.status ?? ""))) continue;
      if (mode === "halt") {
        statusOf.set(id, { status: "open", restructured_at: new Date().toISOString() } as Partial<Dispatch>);
        stopDispatches.push(id);
      } else {
        statusOf.set(id, {
          status: "closed",
          closed_at: new Date().toISOString(),
          note: "结构变更作废：上游已改，基于旧上游的产出不再适用",
        } as Partial<Dispatch>);
        stopDispatches.push(id);
      }
    }
  }

  const changed: string[] = [];
  const next = rows.map((d) => {
    const id = String(d.id);
    const patch = statusOf.get(id);
    const p = nextParentOf.get(id);
    if (!patch && p === undefined) return d;
    const row = { ...d, ...(p === undefined ? {} : { parent: p }), ...(patch ?? {}) } as Dispatch;
    changed.push(id);
    return row;
  });
  writeJsonl(dispatchPath(root), next);
  /*
   * 状态变了就要同步任务池：任务池是派单状态的投影，不同步会让左栏一直显示
   * “执行中”，而下单已经在等重做。
   */
  for (const d of next) if (statusOf.has(String(d.id))) syncTaskForDispatch(root, d);
  return { ok: true, changed, errors: [], stopDispatches };
}
