/**
 * 组操作的唯一门面：建组、入组、把下游挂到组上。
 *
 * 单独一层的理由：这三件事都要读组台账、都要校验成员父一致、都要拒绝成环。
 * 若散落在调度主循环中，“建单”“重派”与 `fillSlots` 三处会各自判定一遍，
 * 组一旦判错，下游会在成员未完成时启动，且不会留下报错记录。
 *
 * 三条硬约束都收在这里：
 *   1. 组号一律经 `normalizeGroupId` 归一，`#G01` 与 `G1` 是同一个组；
 *   2. 同一组的成员必须共享同一个父节点。组没有自己的父字段，位置由成员父推导，
 *      成员父一旦不一致，组在树上就没有位置；
 *   3. 挂了已解散（`closed`）的组一律拒绝：解散的语义是“下游按已收尾放行”，
 *      新单挂上去会立刻启动，相当于绕过前置判定。
 */

import { checkTreeEdge, parentOf, type Dispatch } from "../record/supervisor";
import { normalizeGroupId } from "../record/idMap";
import {
  groupIndexOf,
  issueGroupNo,
  readGroups,
  resolveGroupRef,
  type GroupIndex,
} from "../record/groups";

/** 派单指令里的分组声明。 */
export type GroupSpec =
  /** 新建一个组，本单是第一个成员。 */
  | { mode: "new"; title: string }
  /** 加入已有组。`id` 已归一（`G1`）。 */
  | { mode: "join"; id: string }
  /** 明确不属于任何组。与“未写”同义，保留是为了让提示词能显式表达。 */
  | { mode: "none" };

/**
 * 把指令里的 `GROUP:` 取值解析成规格。
 *
 * 接受三种写法：`new <标题>`、`#G1` / `G1` / `G01`、`none`。
 * 无法识别的写法返回 `null`，由调用方拒绝。不作推测：推测可能把派单归入错误的组。
 */
export function parseGroupSpec(raw: unknown): GroupSpec | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  if (/^(none|no|无|-|—)$/i.test(t)) return { mode: "none" };
  const m = /^new\s+(.+)$/i.exec(t);
  if (m) {
    const title = String(m[1] ?? "").trim();
    return title ? { mode: "new", title } : null;
  }
  const id = normalizeGroupId(t);
  if (id) return { mode: "join", id };
  return null;
}

/** 组索引：调用方已有台账时传进来，避免同一次判定读两遍盘。 */
export function groupIndexFrom(root: string, rows: readonly Dispatch[]): GroupIndex {
  return groupIndexOf(rows, readGroups(root));
}

/**
 * 新建组并返回组号。
 *
 * 取号失败（锁被占用、台账不可写）时返回原因，调用方整单拒绝。半截状态更难排查：
 * 派单建成却没有组，重派时继承不到组，树结构也不显示缺失。
 */
export function openGroup(
  root: string,
  input: { title: string; stage?: string | undefined; createdBy?: string | undefined },
): { ok: true; id: string } | { ok: false; error: string } {
  const made = issueGroupNo(root, {
    title: input.title,
    ...(input.stage ? { stage: input.stage } : {}),
    ...(input.createdBy ? { created_by: input.createdBy } : {}),
  });
  if (!made.ok) return { ok: false, error: `建组失败：${made.error}` };
  return { ok: true, id: made.group.id };
}

/**
 * 加入已有组，并校验成员父一致。
 *
 * @param parentId 本单将要落的父节点（空串表示根）。
 * @returns 归一后的组号；拒绝时给出可操作的修正指引。
 */
export function joinGroup(
  root: string,
  ref: string,
  input: { parentId: string; rows: readonly Dispatch[]; idx?: GroupIndex | undefined },
): { ok: true; id: string } | { ok: false; error: string } {
  const id = normalizeGroupId(ref);
  if (!id) return { ok: false, error: `“${ref}”不是组号：写成 #G1 或 GROUP: new <组标题>` };
  const group = resolveGroupRef(root, id);
  if (!group) {
    return {
      ok: false,
      error:
        `分组 ${id} 不存在：先建组（GROUP: new <组标题>），或核对组号后重发。`,
    };
  }
  if (String(group.state ?? "") === "closed") {
    return {
      ok: false,
      error: `分组 ${id} 已解散：不能作为前置。新建一个组后重试。`,
    };
  }
  const idx = input.idx ?? groupIndexFrom(root, input.rows);
  const conflict = parentConflictOf(id, input.parentId, input.rows, idx);
  if (conflict) {
    return {
      ok: false,
      error:
        `分组 ${id} 的成员父节点为 ${conflict}，本单要挂 ${input.parentId || "（根）"}。` +
        `同一组成员必须共享父节点。` +
        `执行 tree group attach ${id} <父节点> 改挂整组，或不加入该组。`,
    };
  }
  return { ok: true, id };
}

/**
 * 执行一条 `GROUP:` 声明，返回本单应落的组号（空串表示不属于任何组）。
 *
 * 建组与入组都带校验：建组失败（取号锁、台账不可写）与入组被拒（组不存在、已解散、
 * 成员父不一致）都是整单拒绝。派单建成却没有组，重派时继承不到组，树结构也不会显示缺失。
 *
 * 调用方传入 `parentId` 是已解析的父节点（派单 id 或组号），因为成员父一致性
 * 要拿它比对；解析父节点的顺序由调用方决定，本函数不读引用。
 */
export function applyGroupDecl(
  root: string,
  decl: unknown,
  input: { parentId: string; stage: string; rows: readonly Dispatch[]; createdBy?: string },
): { ok: true; id: string } | { ok: false; error: string } {
  /* 台账里存的是结构；手写台账可能存原话，两种都认。 */
  const spec = typeof decl === "string" ? parseGroupSpec(decl) : (decl as GroupSpec | null | undefined);
  if (!spec || spec.mode === "none") return { ok: true, id: "" };
  if (spec.mode === "new") {
    const made = openGroup(root, {
      title: spec.title,
      stage: input.stage,
      createdBy: input.createdBy ?? "llm",
    });
    if (!made.ok) return { ok: false, error: made.error };
    return { ok: true, id: made.id };
  }
  const joined = joinGroup(root, spec.id, { parentId: input.parentId, rows: input.rows });
  if (!joined.ok) return { ok: false, error: joined.error };
  return { ok: true, id: joined.id };
}

/**
 * 解析 `PARENT:` 指向的节点：先按派单找，找不到再按组找。
 *
 * 两者的差别不是书写形式，而是语义：挂派单是“等这一张单完成”，挂组是“等整组完成”。
 * 因此拒绝文案必须分开：父派单找不到要提示补派单，组号找不到要提示建组。
 * 混成一句会让调用方补错内容。
 *
 * `resolveDispatch` 由调用方传入：编号到台账 id 的换算要看编号表，属于带 IO 的解析，
 * 本模块不读盘。
 */
export function resolveParentNode(
  root: string,
  tok: string,
  reason: string,
  rows: readonly Dispatch[],
  resolveDispatch: (tok: string) => Dispatch | undefined,
): { ok: true; id: string; asGroup: boolean } | { ok: false; error: string } {
  const hit = resolveDispatch(tok);
  if (hit) {
    /* 传全量台账：`checkTreeEdge` 的成环检测要看父子链，只传父单会漏判。 */
    const chk = checkTreeEdge(rows as Dispatch[], String(hit.id), reason);
    if (!chk.ok) return { ok: false, error: chk.reason };
    return { ok: true, id: String(hit.id), asGroup: false };
  }
  if (!normalizeGroupId(tok)) {
    return {
      ok: false,
      error: `PARENT 里的父派单“${tok}”不存在：先派父节点，或核对编号后重发。`,
    };
  }
  const gchk = checkGroupPrerequisite(root, tok);
  if (!gchk.ok) return { ok: false, error: gchk.error };
  if (!String(reason ?? "").trim()) {
    return {
      ok: false,
      error: "声明了分组前置但未写 PARENT_REASON：说明为何必须等整组完成（一两句），否则无法判定该边是否成立",
    };
  }
  return { ok: true, id: gchk.id, asGroup: true };
}

/**
 * 组内成员父是否一致。返回已有成员使用的父（不一致时给出该值），一致或组为空返回空串。
 *
 * 这条校验只在“入组”时做。建组时第一个成员作为基准，后续成员逐个对齐。
 */
export function parentConflictOf(
  groupId: string,
  parentId: string,
  rows: readonly Dispatch[],
  idx: GroupIndex,
): string {
  const key = normalizeGroupId(groupId);
  if (!key) return "";
  const members = idx.members.get(key) ?? [];
  const byId = new Map(rows.map((d) => [String(d.id), d] as const));
  const want = String(parentId ?? "").trim();
  for (const m of members) {
    const d = byId.get(m);
    /* 成员已归档或手动删除：无法比对父节点，跳过。 */
    if (!d) continue;
    const have = parentOf(d);
    if (have !== want) return have || "（根）";
  }
  return "";
}

/**
 * 校验“把下游挂到组上”是否成立，返回归一后的组号。
 *
 * 只做三件事：组号合法、组存在、组未解散。建新单时不会成环：
 * 新单的 id 才刚发行，任何既有的父链都不包含它。
 */
export function checkGroupPrerequisite(
  root: string,
  ref: string,
): { ok: true; id: string } | { ok: false; error: string } {
  const id = normalizeGroupId(ref);
  if (!id) return { ok: false, error: `“${ref}”不是组号` };
  const group = resolveGroupRef(root, id);
  if (!group) {
    return {
      ok: false,
      error: `PARENT 里的分组 ${id} 不存在：先建组，或核对组号后重发。`,
    };
  }
  if (String(group.state ?? "") === "closed") {
    return {
      ok: false,
      error: `分组 ${id} 已解散：请改挂仍在推进的前置。`,
    };
  }
  return { ok: true, id };
}
