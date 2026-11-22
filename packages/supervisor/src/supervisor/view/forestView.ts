/**
 * 把派单台账投影为森林视图，供 `GET /api/forest` 只读返回。
 * 数据来自 `.capitalist/inbox/dispatch.jsonl`（派单台账）与 `.capitalist/board-cleared.json`（看板清除标记），
 * 每请求重算，不缓存。状态归一、断链标记与成环降级均在服务端计算；递归带 visited 集合，
 * 脏数据不会成环。
 */

import { join } from "node:path";

import { readJson } from "../../core/record/json";
import { board as boardLoc } from "../../core/record/locations";
import { clipLine } from "../../core/text";
import { dispatchForest, listWorkers, parentOf, readDispatches, type Dispatch } from "../../core/record/supervisor";
import { isFailed, isSettled } from "../../core/record/dispatchState";
import { firstBlocker } from "../../core/dispatch/deps";
import { groupIndexOf, readGroups, type GroupIndex } from "../../core/record/groups";
import { normalizeGroupId } from "../../core/record/idMap";
import { isGroupRef, label } from "../../core/record/nodeRef";
import { groupStatusOf, type GroupState } from "../../core/dispatch/groupGraph";
import { workerUsage } from "../usage/usage";
import { shardTitle, summarizeTitle } from "../usage/taskTitle";

/** 看板上被用户清除掉的派单 id。标记按线程键存，值里带派单 id。 */
function clearedDispatches(root: string): Set<string> {
  const marks = readJson<Record<string, { dispatch?: string }>>(boardLoc.cleared(root), {});
  const out = new Set<string>();
  for (const m of Object.values(marks ?? {})) {
    const id = String(m?.dispatch ?? "").trim();
    if (id) out.add(id);
  }
  return out;
}

/**
 * 从派单行里摘掉被清除的任务。
 *
 * 同一派生链的尝试一起摘：清掉的是“这条任务”，不是某一次重派。被摘节点的子节点改判为根，
 * 否则 `dispatchForest` 会把它们记成孤立前置，树上看不出它们只是父节点被隐藏了。
 */
function dropCleared(rows: Dispatch[], cleared: Set<string>): Dispatch[] {
  if (cleared.size === 0) return rows;
  const lineageOf = (r: Dispatch): string => String((r as unknown as { lineage?: string }).lineage || r.id);
  const gone = new Set<string>();
  for (const r of rows) if (cleared.has(String(r.id))) gone.add(lineageOf(r));
  if (gone.size === 0) return rows;
  const kept = rows.filter((r) => !cleared.has(String(r.id)) && !gone.has(lineageOf(r)));
  const ids = new Set(kept.map((r) => String(r.id)));
  for (const r of kept) {
    const p = String(r.parent ?? "");
    /*
     * 组号不是派单 id，不在 `ids` 里是正常的：清除某个任务不该让挂组的派单失去父节点。
     * 不排除组号会把“挂在组上”变成“孤儿”，看板上表现为突然断链。
     */
    if (p && !ids.has(p) && !isGroupRef(p)) r.parent = "";
    if (Array.isArray(r.after)) {
      r.after = r.after.filter((x) => String(x) === "*" || isGroupRef(String(x)) || ids.has(String(x)));
    }
  }
  return kept;
}

/** 展示态。`waiting` = 排队中且前置未满足；`review` = 已上报/待验收。 */
export type ForestNodeState = "running" | "queued" | "waiting" | "review" | "done" | "failed" | "closed";

/** 打开弹窗时一张卡片要的全部字段。 */
export interface ForestNodeView {
  id: string;
  /**
   * 节点类型。`group` 是分组：组内并行、整组完成才放行挂在组上的单。
   * 组不是任务，不占任务编号，也不计入节点总数。
   */
  kind: "dispatch" | "group";
  /** 组节点专有：已完成成员数。 */
  groupDone?: number;
  /** 组节点专有：成员总数。 */
  groupTotal?: number;
  /** 组节点专有：断链的成员 id；未断链为空。 */
  groupBroken?: string;
  /** 相对父节点的边类型：组成员（`member`）或挂在组后的下游（`after`）。 */
  edge?: "member" | "after";
  /** 任务编号（`01`、`21`…，任务编号表里的号）；表里还没有时为空串。 */
  no: string;
  title: string;
  state: ForestNodeState;
  /** 台账原始状态，排障时对照用。 */
  status: string;
  /** 派单记录里的模型 id；老记录没有这一项时为空串。 */
  model: string;
  /** 启动时刻（ISO）：取认领时刻，未被认领时取建单时刻；与左栏任务卡的“启动”同义。 */
  started_at: string;
  /** 结束时刻（ISO）：终态的完成或关闭时刻；非终态为空串，由前端计算时长。 */
  ended_at: string;
  /** 重派次数：同一派生链在它之前出现过几次，与 `attempt - 1` 取大。 */
  retries: number;
  /** 失败原因摘要（只对失败节点有值），已截断。 */
  reason: string;
  /** 直接子节点数。 */
  childCount: number;
  /** 相对树根的层数；根为 0。 */
  depth: number;
  /** 父节点 id；根为空串。 */
  parent: string;
  /** 阻塞来源：等前置时为前置 id，断链时为断链祖先 id，否则空串。 */
  stuckOn: string;
  /**
   * 等待的前置单编号（如 `05`）。
   *
   * `stuckOn` 是台账派单号（`2-2`），界面上写“等待 #2-2”既不是任务编号，也不便阅读；
   * 编号表能查到就填这里，查不到留空串，由前端改为显示 id 本身。
   */
  stuckOnNo: string;
  /** 自身失败、处于环上或祖先失败时置真；运行中或待验收的节点不标记。 */
  blocked: boolean;
  /** 断链的祖先 id（含自己失败的情况）；未断链为空串。 */
  blockedBy: string;
  /** 处于环上或环的下游，按脏数据展示。 */
  inCycle: boolean;
  /** 台账里的先后序号：前端只在同一层内按它排，保证兄弟顺序与台账一致。 */
  seq: number;
}

export interface ForestTreeStats {
  total: number;
  done: number;
  failed: number;
  running: number;
  queued: number;
  waiting: number;
  review: number;
  closed: number;
  /** 尚未完成的数量：total - done - closed。 */
  remaining: number;
  /** 断链子树中未完成节点数（含失败节点）。 */
  blocked: number;
}

export interface ForestTreeView {
  /** 树根派单 id；成环树用环上第一个节点。 */
  rootId: string;
  /** 树中存在未完成节点（running / queued / waiting / review）。 */
  alive: boolean;
  /** 成环树：图上按降级样式展示。 */
  cycle: boolean;
  maxDepth: number;
  stats: ForestTreeStats;
  /** 先序扁平列表，父节点排在子节点之前；前端按 `parent` 构建层级。 */
  nodes: ForestNodeView[];
}

export interface ForestView {
  root: string;
  /** 一棵树都没有（台账为空）。 */
  empty: boolean;
  trees: ForestTreeView[];
  totals: ForestTreeStats;
  anomalies: {
    /** 成环节点组，每组按回边顺序给出。 */
    cycles: string[][];
    /** 父节点不在台账里的节点。 */
    orphans: string[];
    /** 既不在任何树下、也不在环上的节点（正常数据为空）。 */
    unplaced: string[];
  };
  /** 降级说明：脏数据时说明处理方式，正常为空串。 */
  degraded: string;
  generatedAt: string;
}

const MAX_REASON = 120;

/** 派单标题口径与 board/snapshot.ts 的 `dispatchTitle` 一致：依次取 title、分片短名、正文摘要，不回落到分片 id。 */
function ledgerTitle(d: Dispatch): string {
  const v = (d as unknown as Record<string, unknown>).title;
  const stored = typeof v === "string" ? v.trim() : "";
  if (stored) return stored;
  return shardTitle(d.shard) || summarizeTitle(d.action);
}

/** 失败原因摘要：优先取复盘理由，其次取台账备注。 */
function failureReason(d: Dispatch): string {
  const r = (d as unknown as Record<string, unknown>).retry_why;
  if (typeof r === "string" && r.trim()) return clipLine(r, MAX_REASON);
  return clipLine(String(d.note ?? ""), MAX_REASON);
}

/** 结束原因：取台账备注，缺失时按状态给默认说明。 */
function closeReason(d: Dispatch): string {
  const note = clipLine(String(d.note ?? ""), MAX_REASON);
  if (note) return note;
  return String(d.status ?? "") === "superseded" ? "阶段已推进，本单的验收口径不再适用" : "";
}

function emptyStats(): ForestTreeStats {
  return { total: 0, done: 0, failed: 0, running: 0, queued: 0, waiting: 0, review: 0, closed: 0, remaining: 0, blocked: 0 };
}

function countInto(stats: ForestTreeStats, n: ForestNodeView): void {
  stats.total += 1;
  stats[n.state] += 1;
  if (n.state !== "done" && n.state !== "closed") stats.remaining += 1;
  if (n.blocked) stats.blocked += 1;
}

/**
 * 返回第一个未满足的前置 id，无则空串。判定统一走 `core/dispatch/deps`，视图不重复推导。
 * `"*"` 屏障不是具体节点，不计入卡点。
 *
 * 必须传组索引：组前置的满足条件是“整组了结”，缺索引时派单前置判定会把组号当成
 * 找不到的行而永远判未满足。组已解散或已全部完成，界面仍显示“等待 #G1”，
 * 与调度侧（`groupSettled`）分叉。
 */
function pendingPrereqOf(d: Dispatch, rows: Dispatch[], gidx: GroupIndex): string {
  return firstBlocker(d, rows, gidx);
}

/** 组节点在视图里要展示的派生信息。 */
interface GroupBadge {
  done: number;
  total: number;
  broken: string;
  /**
   * 挂在组上的下游单数（`parent` 指向组号）。
   *
   * 组成员不算子单：成员是组的组成部分，界面上由「组内完成 n/m」表达，
   * 计入子单数会与成员数重复，也会把组读成一个有四个下游的任务。
   */
  downstream: number;
}

/** 构建一棵树所需的上下文。参数收进对象：树、组、边三类信息各自成组，避免长参数列表。 */
interface WalkContext {
  rows: Map<string, Dispatch>;
  children: Record<string, string[]>;
  seqOf: Map<string, number>;
  stateOf: (d: Dispatch) => ForestNodeState;
  stuckOf: (d: Dispatch) => string;
  reasonOf: (d: Dispatch) => string;
  retriesOf: (d: Dispatch) => number;
  cycleSet: Set<string>;
  noOf?: ((id: string) => string) | undefined;
  infoOf?: ((d: Dispatch) => { model: string; started_at: string; ended_at: string }) | undefined;
  /** 组节点 id -> 成员统计。出现键即表示该节点是组。 */
  groupOf: Map<string, GroupBadge>;
  /** 子节点 id -> 它相对父节点的边类型。 */
  edgeOf: Map<string, "member" | "after">;
  /** 子节点 id -> 展示用父 id。组成员的数据父是组的上游，树上应挂在组下。 */
  parentViewOf?: Map<string, string> | undefined;
}

/**
 * 从给定的根构建扁平先序列表。`breakAt` 为链上的断链祖先 id，子节点继承；
 * `visited` 防环，`limit` 限制节点数。
 */
function walkTree(rootIds: string[], ctx: WalkContext): { nodes: ForestNodeView[]; maxDepth: number } {
  const { rows, children, seqOf, stateOf, stuckOf, reasonOf, retriesOf, cycleSet, noOf, infoOf, groupOf, edgeOf, parentViewOf } = ctx;
  const nodes: ForestNodeView[] = [];
  const visited = new Set<string>();
  const limit = rows.size * 2 + 8;

  const walk = (id: string, depth: number, breakAt: string): void => {
    if (visited.has(id) || nodes.length >= limit) return;
    const d = rows.get(id);
    if (!d) return;
    visited.add(id);
    const badge = groupOf.get(id);
    const state = stateOf(d);
    /*
     * 断链来源为祖先失败或自身在环上；`chain` 向下传递。
     * 仅未启动的节点标 blocked，运行中或待验收的节点按自身状态显示。
     */
    const ownBreak = state === "failed" || cycleSet.has(id);
    const chain = breakAt || (ownBreak ? id : "");
    const blocked = Boolean(chain) && (ownBreak || state === "queued" || state === "waiting");
    const info = infoOf?.(d) ?? { model: "", started_at: "", ended_at: "" };
    const waitingOn = !blocked && state === "waiting" ? stuckOf(d) : "";
    nodes.push({
      id,
      kind: badge ? "group" : "dispatch",
      ...(badge ? { groupDone: badge.done, groupTotal: badge.total } : {}),
      ...(badge?.broken ? { groupBroken: badge.broken } : {}),
      ...(edgeOf.get(id) ? { edge: edgeOf.get(id)! } : {}),
      /* 组节点不在任务编号表里，直接给未格式化的组号（`G1`），前端统一补零成 `#G01`。 */
      no: badge ? String(id) : (noOf?.(id) ?? ""),
      title: ledgerTitle(d),
      state,
      status: String(d.status ?? ""),
      model: info.model,
      started_at: info.started_at,
      ended_at: info.ended_at,
      retries: retriesOf(d),
      reason: reasonOf(d),
      childCount: badge ? badge.downstream : (children[id] ?? []).length,
      depth,
      parent: depth === 0 ? "" : (parentViewOf?.get(id) ?? parentOf(d)),
      /* 失败节点自身的 `chain` 等于其 id，不写入 `stuckOn`，避免显示为自环。 */
      stuckOn: blocked ? (chain === id ? "" : chain) : waitingOn,
      stuckOnNo: waitingOn ? (noOf?.(waitingOn) ?? "") : "",
      blocked,
      blockedBy: blocked ? chain : "",
      inCycle: cycleSet.has(id),
      seq: seqOf.get(id) ?? 0,
    });
    /* 断链从失败节点或环上节点开始向下传递。 */
    for (const c of children[id] ?? []) walk(c, depth + 1, chain);
  };

  for (const id of rootIds) walk(id, 0, "");
  const maxDepth = nodes.reduce((m, n) => Math.max(m, n.depth), 0);
  return { nodes, maxDepth };
}

/**
 * 从台账构建森林视图，纯读纯算。
 * 树排序：含未完成节点的优先，同档按树根在台账中的先后，与队列顺序一致。
 */
/**
 * 同一 lineage 的多次尝试归并为一条：保留终态最好的一条作代表，其余从树里摘掉，
 * 依赖它们的 `parent` / `after` 重定向到代表，避免摘掉后变成孤立节点。
 */
function mergeAttempts(rows: Dispatch[]): Dispatch[] {
  const rank = (s: string): number => {
    if (s === "done") return 4;
    if (s === "closed" || s === "reported" || s === "review") return 3;
    if (s === "claimed") return 2;
    if (s === "failed") return 1;
    return 2;
  };
  const groups = new Map<string, Dispatch[]>();
  for (const r of rows) {
    const key = String((r as unknown as Record<string, unknown>).lineage || r.id);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const repOf = new Map<string, string>();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    let best = list[0] as Dispatch;
    for (const d of list) {
      const a = rank(String(best.status ?? ""));
      const b = rank(String(d.status ?? ""));
      if (b > a || (b === a && String(d.at ?? "") > String(best.at ?? ""))) best = d;
    }
    for (const d of list) {
      const id = String(d.id);
      if (id !== String(best.id)) repOf.set(id, String(best.id));
    }
  }
  if (repOf.size === 0) return rows;
  const mapId = (v: string): string => repOf.get(v) ?? v;
  return rows
    .filter((r) => !repOf.has(String(r.id)))
    .map((r) => {
      const parent = String(r.parent ?? "");
      const after = Array.isArray(r.after) ? r.after.map((x) => mapId(String(x))) : r.after;
      const nextParent = parent ? mapId(parent) : parent;
      const changed =
        nextParent !== parent || JSON.stringify(after) !== JSON.stringify(r.after);
      return changed ? ({ ...r, parent: nextParent, after } as Dispatch) : r;
    });
}

export function buildForestView(root: string, noOf?: (id: string) => string): ForestView {
  const rows = dropCleared(mergeAttempts(readDispatches(root)), clearedDispatches(root));
  const generatedAt = new Date().toISOString();
  if (rows.length === 0) {
    return {
      root,
      empty: true,
      trees: [],
      totals: emptyStats(),
      anomalies: { cycles: [], orphans: [], unplaced: [] },
      degraded: "",
      generatedAt,
    };
  }

  const forest = dispatchForest(rows);
  const byId = new Map(rows.map((r) => [String(r.id), r] as const));
  const seqOf = new Map(rows.map((r, i) => [String(r.id), i] as const));
  const cycleSet = new Set(forest.cycles.flat());

  /*
   * 把组叠到派单森林上。
   *
   * 组没有自己的派单行，直接在树上会缺席，形成“两个互不相干的根 + 一个隐式依赖”。
   * 界面因此无法解释下游为何不动。此处为组构造一条虚拟行并入 `byId`，再把成员从原父节点
   * 摘下挂到组下：组在树上占一个节点，成员与挂组的派单都是它的子节点。
   *
   * 组的状态由成员派生（`groupStatusOf`），映射成派单状态后交给同一套 `stateOf`，
   * 于是断链沿组向下传递，不需要第二套阻断逻辑。
   */
  const GROUP_STATUS: Record<GroupState, string> = {
    queued: "open",
    waiting: "open",
    running: "claimed",
    review: "reported",
    done: "done",
    blocked: "failed",
    closed: "closed",
  };
  const groups = readGroups(root);
  const gidx = groupIndexOf(rows, groups);
  const groupOf = new Map<string, GroupBadge>();
  const edgeOf = new Map<string, "member" | "after">();
  const parentViewOf = new Map<string, string>();
  const rootSet = new Set(forest.roots);
  const orphanSet = new Set(forest.orphans);

  groups.forEach((g, gi) => {
    const st = groupStatusOf(g.id, rows, gidx);
    if (!st) return;
    const members = gidx.members.get(g.id) ?? [];
    /* 挂在该组上的下游：`parent` 指向组号（归一后比较，`#G01` 与 `G1` 是同一个）。 */
    const attached = rows
      .filter((d) => normalizeGroupId(parentOf(d)) === g.id)
      .map((d) => String(d.id));
    groupOf.set(g.id, { done: st.done, total: st.total, broken: st.brokenAt, downstream: attached.length });
    const parent = members
      .map((m) => byId.get(m))
      .map((d) => (d ? parentOf(d) : ""))
      .find((p) => p) ?? "";

    byId.set(g.id, {
      id: g.id,
      at: g.at,
      stage: String(g.stage ?? ""),
      shard: "",
      title: g.title,
      action: "",
      status: GROUP_STATUS[st.state],
      ...(parent ? { parent } : {}),
    } as Dispatch);
    seqOf.set(g.id, rows.length + gi);
    parentViewOf.set(g.id, parent);

    /* 移除成员的原始父边：它们在树上只出现在组下面，不再同时挂在组的上游。 */
    for (const m of members) {
      const md = byId.get(m);
      const mp = md ? parentOf(md) : "";
      if (mp && forest.children[mp]) forest.children[mp] = forest.children[mp].filter((x) => x !== m);
      rootSet.delete(m);
      orphanSet.delete(m);
      edgeOf.set(m, "member");
      parentViewOf.set(m, g.id);
    }
    for (const a of attached) {
      rootSet.delete(a);
      orphanSet.delete(a);
      edgeOf.set(a, "after");
      parentViewOf.set(a, g.id);
    }
    forest.children[g.id] = [...members, ...attached];

    if (parent && parent !== g.id) {
      (forest.children[parent] ??= []).push(g.id);
      rootSet.delete(g.id);
    } else {
      rootSet.add(g.id);
    }
  });
  forest.roots = [...rootSet];
  forest.orphans = [...orphanSet];

  /*
   * 重派次数取 `attempt - 1`。`lineage` 为同支根节点共用，按它计数会把兄弟节点算成重派。
   */
  const retriesOfMap = new Map<string, number>();
  for (const r of rows) {
    const attempt = Number((r as unknown as Record<string, unknown>).attempt ?? 1);
    retriesOfMap.set(String(r.id), Number.isFinite(attempt) ? Math.max(0, attempt - 1) : 0);
  }

  const pendingPrereq = (d: Dispatch): string => pendingPrereqOf(d, rows, gidx);

  /* 同一 lineage 里已有完成的尝试时，早先的失败记录视为已归并，不再计断链。 */
  const lineageDone = new Set<string>();
  for (const r of rows) {
    const st = String(r.status ?? "");
    if (!isSettled(st)) continue;
    lineageDone.add(String((r as unknown as Record<string, unknown>).lineage || r.id));
  }

  const stateOf = (d: Dispatch): ForestNodeState => {
    const status = String(d.status ?? "");
    if (status === "claimed") return "running";
    if (status === "reported" || status === "review") return "review";
    if (status === "done") return "done";
    if (isFailed(status)) {
      const lin = String((d as unknown as Record<string, unknown>).lineage || d.id);
      return lineageDone.has(lin) ? "closed" : "failed";
    }
    if (isSettled(status) || status === "superseded") return "closed";
    /* `open` 及其它未知值：前置满足为 queued，未满足为 waiting。 */
    return pendingPrereq(d) ? "waiting" : "queued";
  };

  /* 组号给显示形态（`G1` -> `#G1`），由 `nodeRef.label` 统一补，界面不再自己拼。 */
  const stuckOf = (d: Dispatch): string => {
    const s = pendingPrereq(d);
    return s && isGroupRef(s) ? label(s) : s;
  };

  const reasonOf = (d: Dispatch): string => {
    const status = String(d.status ?? "");
    if (status === "failed") return failureReason(d);
    /* 已结束的单同样给出原因。 */
    if (status === "closed" || status === "superseded") return closeReason(d);
    return "";
  };
  const retriesOf = (d: Dispatch): number => retriesOfMap.get(String(d.id)) ?? 0;

  /*
   * 每张单的模型与起止时刻。`d.model` 仅在显式指定时有值，默认模型复用 `usage.workerUsage` 从工作进程日志读取。
   * 重派多次时取 `started_at` 最新的工作进程，与左栏任务卡一致。
   */
  const latestWorker = new Map<string, ReturnType<typeof listWorkers>[number]>();
  for (const w of listWorkers(root)) {
    const key = String(w.dispatch ?? "");
    if (!key) continue;
    const prev = latestWorker.get(key);
    if (!prev || String(w.started_at ?? "") > String(prev.started_at ?? "")) latestWorker.set(key, w);
  }

  /*
   * 启动时刻取认领时刻，未被认领时取建单时刻；与左栏“启动”同义。
   * 结束时刻仅取终态时间，非终态留空，由前端计算时长。
   */
  const infoOf = (d: Dispatch): { model: string; started_at: string; ended_at: string } => {
    const w = latestWorker.get(String(d.id));
    const declared = String((d as unknown as Record<string, unknown>).model ?? "");
    const model = declared || (w ? String(workerUsage(w, rows, root).model ?? "") : "");
    return {
      model,
      started_at: String(d.claimed_at ?? "") || String(d.at ?? ""),
      ended_at: String(d.done_at ?? "") || String((d as unknown as Record<string, unknown>).closed_at ?? ""),
    };
  };

  const trees: ForestTreeView[] = [];
  const placed = new Set<string>();

  const walkCtx: WalkContext = {
    rows: byId,
    children: forest.children,
    seqOf,
    stateOf,
    stuckOf,
    reasonOf,
    retriesOf,
    cycleSet,
    noOf,
    infoOf,
    groupOf,
    edgeOf,
    parentViewOf,
  };

  const pushTree = (rootIds: string[], cycle: boolean): void => {
    const built = walkTree(rootIds, walkCtx);
    if (built.nodes.length === 0) return;
    for (const n of built.nodes) placed.add(n.id);
    const stats = emptyStats();
    /* 组是结构节点，不是任务：计入节点总数会让“还剩几单”多出几个虚假计数。 */
    for (const n of built.nodes) if (n.kind !== "group") countInto(stats, n);
    trees.push({
      rootId: built.nodes[0]?.id ?? rootIds[0] ?? "",
      /* alive 只统计未阻塞且处于运行、排队、等待或验收状态的节点；断链子树节点不计入。 */
      alive: built.nodes.some(
        (n) =>
          !n.blocked &&
          (n.state === "running" || n.state === "queued" || n.state === "waiting" || n.state === "review"),
      ),
      cycle,
      maxDepth: built.maxDepth,
      stats,
      nodes: built.nodes,
    });
  };

  for (const id of forest.roots) pushTree([id], false);

  /* 成环：每组环连同其下游节点收进降级树。 */
  for (const group of forest.cycles) {
    if (group.every((id) => placed.has(id))) continue;
    pushTree(
      group.filter((id) => !placed.has(id)),
      true,
    );
  }

  /* 无根可达且不在环组中的节点单独成降级树，不静默丢弃。 */
  const unplaced = rows.map((r) => String(r.id)).filter((id) => !placed.has(id));
  if (unplaced.length > 0) pushTree(unplaced, true);

  const order = (t: ForestTreeView): number => seqOf.get(t.rootId) ?? 0;
  trees.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    if (b.stats.running !== a.stats.running) return b.stats.running - a.stats.running;
    if (b.stats.remaining !== a.stats.remaining) return b.stats.remaining - a.stats.remaining;
    return order(a) - order(b);
  });

  const totals = emptyStats();
  for (const t of trees) {
    totals.total += t.stats.total;
    totals.done += t.stats.done;
    totals.failed += t.stats.failed;
    totals.running += t.stats.running;
    totals.queued += t.stats.queued;
    totals.waiting += t.stats.waiting;
    totals.review += t.stats.review;
    totals.closed += t.stats.closed;
    totals.remaining += t.stats.remaining;
    totals.blocked += t.stats.blocked;
  }

  const parts: string[] = [];
  if (forest.cycles.length > 0) {
    const groupText = forest.cycles.map((g) => g.map((id) => id).join(" - ")).join("；");
    parts.push(`任务记录存在成环的父子关系（${groupText}）。这些节点归入异常树，调度不会推动它们。`);
  }
  if (forest.orphans.length > 0) parts.push(`${forest.orphans.length} 个节点的父节点不在台账里，按独立树处理。`);

  return {
    root,
    empty: false,
    trees,
    totals,
    anomalies: {
      cycles: forest.cycles,
      orphans: forest.orphans,
      unplaced,
    },
    degraded: parts.join(""),
    generatedAt,
  };
}
