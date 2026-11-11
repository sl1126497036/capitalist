/**
 * 把派单台账投影为森林视图，供 `GET /api/forest` 只读返回。
 * 数据来自 `.capitalist/inbox/dispatch.jsonl`（派单台账）与 `.capitalist/board-cleared.json`（看板清除标记），
 * 每请求重算，不缓存。状态归一、断链标记与成环降级均在服务端计算；递归带 visited 集合，
 * 脏数据不会成环。
 */

import { join } from "node:path";

import { readJson } from "../core/json";
import { supervisorDir } from "../core/paths";
import { dispatchForest, listWorkers, parentOf, pendingPrerequisites, readDispatches, type Dispatch } from "../core/supervisor";
import { workerUsage } from "./usage";
import { shardTitle, summarizeTitle } from "./taskTitle";

/** 看板上被用户清除掉的派单 id。标记按线程键存，值里带派单 id。 */
function clearedDispatches(root: string): Set<string> {
  const marks = readJson<Record<string, { dispatch?: string }>>(join(supervisorDir(root), "board-cleared.json"), {});
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
 * 同一血缘的尝试一起摘：清掉的是“这条任务”，不是某一次重派。被摘节点的子节点改判为根，
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
    if (p && !ids.has(p)) r.parent = "";
    if (Array.isArray(r.after)) r.after = r.after.filter((x) => String(x) === "*" || ids.has(String(x)));
  }
  return kept;
}

/** 展示态。`waiting` = 排队中且前置未满足；`review` = 已上报/待验收。 */
export type ForestNodeState = "running" | "queued" | "waiting" | "review" | "done" | "failed" | "closed";

/** 打开弹窗时一张卡片要的全部字段。 */
export interface ForestNodeView {
  id: string;
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
  /** 重派次数：同一血缘在它之前出现过几次，与 `attempt - 1` 取大。 */
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

function clip(text: string, max = MAX_REASON): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** 派单标题口径与 board.ts 的 `dispatchTitle` 一致：依次取 title、分片短名、正文摘要，不回落到分片 id。 */
function ledgerTitle(d: Dispatch): string {
  const v = (d as unknown as Record<string, unknown>).title;
  const stored = typeof v === "string" ? v.trim() : "";
  if (stored) return stored;
  return shardTitle(d.shard) || summarizeTitle(d.action);
}

/** 失败原因摘要：优先取复盘理由，其次取台账备注。 */
function failureReason(d: Dispatch): string {
  const r = (d as unknown as Record<string, unknown>).retry_why;
  if (typeof r === "string" && r.trim()) return clip(r);
  return clip(String(d.note ?? ""));
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
 * 返回第一个未满足的前置 id，无则空串。判定复用 core 的 {@link pendingPrerequisites}，视图不重复推导。
 * `"*"` 屏障不是具体节点，不计入卡点。
 */
function pendingPrereqOf(d: Dispatch, rows: Dispatch[]): string {
  return pendingPrerequisites(d, rows).filter((id) => id !== "*")[0] ?? "";
}

/**
 * 从给定的根构建扁平先序列表。`breakAt` 为链上的断链祖先 id，子节点继承；
 * `visited` 防环，`limit` 限制节点数。
 */
function walkTree(
  rootIds: string[],
  rows: Map<string, Dispatch>,
  children: Record<string, string[]>,
  seqOf: Map<string, number>,
  stateOf: (d: Dispatch) => ForestNodeState,
  stuckOf: (d: Dispatch) => string,
  reasonOf: (d: Dispatch) => string,
  retriesOf: (d: Dispatch) => number,
  cycleSet: Set<string>,
  noOf?: (id: string) => string,
  infoOf?: (d: Dispatch) => { model: string; started_at: string; ended_at: string },
): { nodes: ForestNodeView[]; maxDepth: number } {
  const nodes: ForestNodeView[] = [];
  const visited = new Set<string>();
  const limit = rows.size * 2 + 8;

  const walk = (id: string, depth: number, breakAt: string): void => {
    if (visited.has(id) || nodes.length >= limit) return;
    const d = rows.get(id);
    if (!d) return;
    visited.add(id);
    const state = stateOf(d);
    /*
     * 断链来源为祖先失败或自身在环上；`chain` 向下传递。
     * 仅未启动的节点标 blocked，运行中或待验收的节点按自身状态显示。
     */
    const ownBreak = state === "failed" || cycleSet.has(id);
    const chain = breakAt || (ownBreak ? id : "");
    const blocked = Boolean(chain) && (ownBreak || state === "queued" || state === "waiting");
    const info = infoOf?.(d) ?? { model: "", started_at: "", ended_at: "" };
    nodes.push({
      id,
      no: noOf?.(id) ?? "",
      title: ledgerTitle(d),
      state,
      status: String(d.status ?? ""),
      model: info.model,
      started_at: info.started_at,
      ended_at: info.ended_at,
      retries: retriesOf(d),
      reason: reasonOf(d),
      childCount: (children[id] ?? []).length,
      depth,
      parent: depth === 0 ? "" : parentOf(d),
      /* 失败节点自身的 `chain` 等于其 id，不写入 `stuckOn`，避免显示为自环。 */
      stuckOn: blocked ? (chain === id ? "" : chain) : state === "waiting" ? stuckOf(d) : "",
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
   * 重派次数取 `attempt - 1`。`lineage` 为同支根节点共用，按它计数会把兄弟节点算成重派。
   */
  const retriesOfMap = new Map<string, number>();
  for (const r of rows) {
    const attempt = Number((r as unknown as Record<string, unknown>).attempt ?? 1);
    retriesOfMap.set(String(r.id), Number.isFinite(attempt) ? Math.max(0, attempt - 1) : 0);
  }

  const pendingPrereq = (d: Dispatch): string => pendingPrereqOf(d, rows);

  /* 同一 lineage 里已有完成的尝试时，早先的失败记录视为已归并，不再计断链。 */
  const lineageDone = new Set<string>();
  for (const r of rows) {
    const st = String(r.status ?? "");
    if (st !== "done" && st !== "closed") continue;
    lineageDone.add(String((r as unknown as Record<string, unknown>).lineage || r.id));
  }

  const stateOf = (d: Dispatch): ForestNodeState => {
    const status = String(d.status ?? "");
    if (status === "claimed") return "running";
    if (status === "reported" || status === "review") return "review";
    if (status === "done") return "done";
    if (status === "failed") {
      const lin = String((d as unknown as Record<string, unknown>).lineage || d.id);
      return lineageDone.has(lin) ? "closed" : "failed";
    }
    if (status === "closed") return "closed";
    /* `open` 及其它未知值：前置满足为 queued，未满足为 waiting。 */
    return pendingPrereq(d) ? "waiting" : "queued";
  };

  const stuckOf = (d: Dispatch): string => pendingPrereq(d);

  const reasonOf = (d: Dispatch): string => (String(d.status ?? "") === "failed" ? failureReason(d) : "");
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

  const pushTree = (rootIds: string[], cycle: boolean): void => {
    const built = walkTree(rootIds, byId, forest.children, seqOf, stateOf, stuckOf, reasonOf, retriesOf, cycleSet, noOf, infoOf);
    if (built.nodes.length === 0) return;
    for (const n of built.nodes) placed.add(n.id);
    const stats = emptyStats();
    for (const n of built.nodes) countInto(stats, n);
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
    const groupText = forest.cycles.map((g) => g.map((id) => id).join(" ↔ ")).join("；");
    parts.push(`台账存在成环的父节点关系（${groupText}），这些节点收进“脏数据”树，调度侧不会推动它们。`);
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
