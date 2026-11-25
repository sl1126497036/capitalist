/**
 * 分组台账（`.capitalist/inbox/groups.jsonl`）：树上的一个结构节点，不是任务。
 *
 * 组只表达“多条派单共同作为某个后继的前置，且缺一不可”：
 *   - 组成员彼此并行，没有先后；
 *   - 组在树上看作一个节点，后继挂在组上；
 *   - 组完成 = 全体成员完成；任一成员失败即断链。
 *
 * 成员归属不写在这里，而由派单上的 `group` 字段表达。组记录只保存组自身属性，
 * 避免组记录与派单记录的成员数不一致。组的树位置同样由成员父节点推导，
 * 组记录不存 `parent`。
 *
 * 组号 `G1` 不属于任务号 / 派单号 / 进程号三套编号：不发行任务号、不占派单序、不启动进程。
 * 落盘不带 `#`，显示经 {@link groupNoLabel} 统一补零。
 */

import { statSync } from "node:fs";

import { appendJsonl, readJsonl, writeJsonl } from "./json";
import { normalizeGroupId } from "./idMap";
import { inbox } from "./locations";
import { withNoLock } from "./noLock";
import type { Dispatch } from "./supervisor";

/** 组记录。 */
export interface Group {
  /** 组号（落盘形式 `G1`）。 */
  id: string;
  /** 组标题，由建组时给出，用于看板与命令行显示。 */
  title: string;
  /** 建组时刻（ISO）。 */
  at: string;
  /** 建组来源：`llm`（派单指令）或 `user`（命令行）。 */
  created_by?: string;
  /** `closed` 表示人工解散：挂在组下的下游按已收尾放行。缺省按 `open`。 */
  state?: "open" | "closed";
  /** 解散原因或补充说明。 */
  note?: string;
}

/** 成员索引：由派单台账与组记录推导，是判定与视图的唯一来源。 */
export interface GroupIndex {
  /** 组号 -> 组记录。 */
  byId: Map<string, Group>;
  /** 组号 -> 成员派单 id（按台账顺序）。 */
  members: Map<string, string[]>;
  /** 派单 id -> 组号。只登记指向真实组的派单。 */
  groupOf: Map<string, string>;
  /** 写着组号、但台账里没有这个组的派单 id。用于报 `group_missing`。 */
  dangling: string[];
}

/** 组台账文件路径。 */
export function groupsPath(root: string): string {
  return inbox.groups(root);
}

/**
 * 读全部组记录，按文件顺序返回。坏行跳过。
 *
 * 与派单台账同样按 `size + mtime` 缓存：看板每几秒轮询一次，监工每轮都要读一遍，
 * 重复解析没有意义。写路径立即失效缓存，写入后可立即读到新值。
 */
let groupsCache: { root: string; key: string; rows: Group[] } | null = null;

export function readGroups(root: string): Group[] {
  const file = groupsPath(root);
  let key = "";
  try {
    const st = statSync(file);
    key = `${st.size}:${st.mtimeMs}`;
  } catch {
    /* 台账尚未建立：返回空列表，不写缓存，建好后要能读到 */
    return [];
  }
  if (groupsCache && groupsCache.root === root && groupsCache.key === key) return groupsCache.rows.slice();
  /*
   * 读盘时即归一：历史档可能写成 `G01`（由显示形态 `#G01` 去掉 `#` 得来）。
   * 归一后同一组只保留第一条记录，避免 `G1` 与 `G01` 分成两个组、成员被分散。
   */
  const seen = new Set<string>();
  const rows: Group[] = [];
  for (const g of readJsonl<Group>(file)) {
    if (!g || typeof g.title !== "string") continue;
    const id = normalizeGroupId(g.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({ ...g, id });
  }
  groupsCache = { root, key, rows };
  return rows.slice();
}

/** 整份覆盖写。只用于改状态（解散）；新建一律使用 {@link appendGroup}。 */
export function writeGroups(root: string, rows: readonly Group[]): void {
  writeJsonl(groupsPath(root), rows);
  groupsCache = null;
}

/** 追加一个组。返回是否写入成功。 */
export function appendGroup(root: string, g: Group): boolean {
  const ok = appendJsonl(groupsPath(root), g);
  groupsCache = null;
  return ok;
}

/** 组号里的序号（`G12` -> 12）；非组号返回 0。 */
export function groupNoOf(id: string): number {
  const norm = normalizeGroupId(id);
  return norm ? Number(norm.slice(1)) : 0;
}

/** 是否是组号形式（不校验是否存在）。归一化是唯一判据，不另写正则。 */
export function looksLikeGroupRef(ref: string): boolean {
  return normalizeGroupId(ref) !== "";
}

/**
 * 发行组号并写入组记录。
 *
 * 号在 `group-no` 锁内取：临界区内读完全部组记录、取最大序号 +1、立刻追加占位记录，
 * 号离开临界区时已被占用。读接口不产生发号副作用。
 *
 * 组号只增不复用；建组失败不回滚已发行的号（与任务号同一口径）。
 *
 * @returns 成功给出组记录；取号锁被占用时给出原因，调用方据此拒绝建组。
 */
export function issueGroupNo(
  root: string,
  input: { title: string; created_by?: string | undefined; at?: string | undefined },
): { ok: true; group: Group } | { ok: false; error: string } {
  const title = String(input.title ?? "").trim();
  if (!title) return { ok: false, error: "建组缺少标题" };
  try {
    return withNoLock(root, "group-no", () => {
      const rows = readGroups(root);
      const next = rows.reduce((m, g) => Math.max(m, groupNoOf(g.id)), 0) + 1;
      const group: Group = {
        id: `G${next}`,
        title: title.slice(0, 120),
        at: String(input.at ?? "") || new Date().toISOString(),
        state: "open",
        ...(input.created_by ? { created_by: String(input.created_by) } : {}),
      };
      if (!appendGroup(root, group)) return { ok: false, error: "组台账写入失败：检查 .capitalist 目录权限" };
      return { ok: true, group };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 把 `#G1` / `G1` 解析成组记录。
 *
 * 只认组号形式，不做模糊匹配：组号与派单号不会互相误判（派单号不以 G 开头）。
 */
export function resolveGroupRef(root: string, ref: string): Group | null {
  const id = normalizeGroupId(ref);
  if (!id) return null;
  return readGroups(root).find((g) => g.id === id) ?? null;
}

/**
 * 由台账与组记录推导成员索引。纯函数，判定与视图共用这一份。
 *
 * 派单写着不存在的组号时，不计为组成员（否则组会始终显示缺员），
 * 而是记进 `dangling`，由调用方报 `group_missing`。
 */
export function groupIndexOf(rows: readonly Dispatch[], groups: readonly Group[]): GroupIndex {
  const byId = new Map(groups.map((g) => [normalizeGroupId(g.id), g] as const));
  const members = new Map<string, string[]>();
  const groupOf = new Map<string, string>();
  const dangling: string[] = [];
  for (const g of groups) members.set(normalizeGroupId(g.id), []);
  for (const d of rows) {
    const gid = normalizeGroupId((d as { group?: unknown }).group);
    if (!gid) continue;
    const list = members.get(gid);
    if (!list) {
      dangling.push(String(d.id));
      continue;
    }
    list.push(String(d.id));
    groupOf.set(String(d.id), gid);
  }
  return { byId, members, groupOf, dangling };
}

/** 组标题；组不存在时返回空串。 */
export function groupTitleOf(idx: GroupIndex, gid: string): string {
  return idx.byId.get(normalizeGroupId(gid))?.title ?? "";
}
