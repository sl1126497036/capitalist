/**
 * 归档：把已收尾的 worker 与派单移出工作目录，只留最近需要的记录。
 *
 * 从 `supervisor.ts` 抽出，两个原因：一是该模块已到结构上限，二是归档只依赖
 * “读台账 + 移目录”这批原语，与协议定义无关，混在一起会降低协议文件的可读性。
 *
 * 只做文件搬运与台账裁剪，不判定业务结论：哪些算“已完成”“已失败”由
 * `dispatchState` 的口径决定。
 */

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import { readJsonl, writeJsonl } from "./json";
import { archive, rootIndex, workers } from "./locations";
import { isFailed, isSettled } from "./dispatchState";
import { groupIndexOf, readGroups, writeGroups, type Group } from "./groups";
import { normalizeGroupId } from "./idMap";
import {
  dispatchPath,
  invalidateWorkersCache,
  isSafeWorkerId,
  listWorkers,
  parentOf,
  readDispatches,
  workersDir,
  type Dispatch,
  type WorkerRecord,
} from "./supervisor";

/**
 * 组随成员归档。
 *
 * 组的成员全部被移走后，组在树上不再有任何内容，留着只会在 `tree group ls` 里
 * 显示一行 0/0 的空记录，还会让建组取号继续跳过它。
 *
 * 但有一条硬约束：台账里还有派单挂着这个组时不能归档。组记录一移走，那些派单的
 * `parent` 就指向不存在的节点，变成永久等待的孤儿。它们本来是“等整组做完”，
 * 组记录被移除不等于组已完成。此时保留组记录，待下游收尾后在下次归档时清理。
 *
 * 只归档原有成员且当前无成员的组：`tree group new` 之后尚未 `add` 的空组是
 * 合法中间态，不能当成已收尾。
 */
function archiveOrphanGroups(
  root: string,
  dir: string,
  before: readonly Dispatch[],
  after: readonly Dispatch[],
): Group[] {
  const groups = readGroups(root);
  if (groups.length === 0) return [];
  const beforeIdx = groupIndexOf(before, groups);
  const afterIdx = groupIndexOf(after, groups);
  const stillAttached = new Set(
    after.map((d) => normalizeGroupId(parentOf(d))).filter((gid) => gid !== ""),
  );
  const gone: Group[] = [];
  const kept: Group[] = [];
  for (const g of groups) {
    const hadMembers = (beforeIdx.members.get(g.id) ?? []).length > 0;
    const hasMembers = (afterIdx.members.get(g.id) ?? []).length > 0;
    if (hadMembers && !hasMembers && !stillAttached.has(g.id)) gone.push(g);
    else kept.push(g);
  }
  if (gone.length === 0) return [];
  writeJsonl(join(dir, "groups.jsonl"), gone);
  writeGroups(root, kept);
  return gone;
}

export function archiveFinished(
  root: string,
  bucket: "all" | "done" | "bad" | "run" | "queue" = "all",
): { dir: string; workers: number; dispatches: number } {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dir = archive.cleared(root, stamp);
  mkdirSync(join(dir, "workers"), { recursive: true });

  const ALIVE = new Set(["running", "starting", "claimed"]);
  const BAD = new Set(["failed", "orphan", "missing", "gone"]);

  /*
   * 分档与界面使用同一套口径。
   *
   * 手动取消的派单（`closed_by: "user"`）在看板归入“已完成”档，台账中的原始状态仍可能是
   * `failed`。只按 `closed_by` 判：`note` 会带用户填写的理由，按固定文案匹配会漏掉这类派单。
   */
  const rows0 = readDispatches(root);
  const canceledDispatch = new Set(
    rows0
      .filter((d) => d.status === "closed" && d.closed_by === "user")
      .map((d) => d.id),
  );
  const failedDispatch = new Set(
    rows0.filter((d) => d.status === "failed").map((d) => String(d.id)),
  );

  const wantWorker = (w: WorkerRecord): boolean => {
    const s = String(w.status || "");
    const alive = ALIVE.has(s);
    if (bucket === "all") return true;
    if (bucket === "run") return alive;
    /* 排队派单没有 worker 记录，该档只处理派单。 */
    if (bucket === "queue") return false;
    if (alive) return false;
    const isCanceled = Boolean(w.dispatch) && canceledDispatch.has(String(w.dispatch));
    const onFailedDispatch = Boolean(w.dispatch) && failedDispatch.has(String(w.dispatch));
    const bad = (BAD.has(s) || onFailedDispatch) && !isCanceled;
    if (bucket === "bad") return bad;
    return !bad;
  };

  const wdir = workersDir(root);
  const drop = new Set<string>();

  for (const w of listWorkers(root)) {
    if (!wantWorker(w)) continue;
    const id = String(w.id || "");
    if (!id || !isSafeWorkerId(id)) continue;
    /* per-worker 目录整体归档：record/output/brief 一并移走。 */
    const from = workers.of(root, id);
    if (!existsSync(from)) {
      drop.add(id);
      continue;
    }
    try {
      renameSync(from, join(dir, "workers", id));
    } catch {
      /* 无法移动的保留，下次归档再处理 */
    }
    if (!existsSync(workers.record(root, id))) drop.add(id);
  }

  if (drop.size) {
    const index = rootIndex.worker(root);
    try {
      const rows = readJsonl<{ id?: string }>(index);
      const kept = rows.filter((r) => !drop.has(String(r.id ?? "")));
      if (kept.length !== rows.length) writeJsonl(index, kept);
    } catch {
      /* 索引读取失败时，多出的空条目会被 listWorkers 跳过。 */
    }
    invalidateWorkersCache();
  }

  let dispatches = 0;
  try {
    const rows = readDispatches(root);
    /* 派单侧同样按档处理：`all` 同时撤出排队与已领取的派单，`queue` 只撤出排队派单。 */
    const movesIn = (d: Dispatch): boolean => {
      const s = String(d.status);
      if (bucket === "all") return true;
      if (bucket === "queue") return s === "open";
      if (bucket === "run") return s === "claimed";
      if (isSettled(s)) return bucket === "done";
      if (isFailed(s)) return bucket === "bad";
      return false;
    };
    const keep = rows.filter((d) => !movesIn(d));
    const moved = rows.filter((d) => movesIn(d));
    if (moved.length) {
      writeJsonl(join(dir, "dispatch.jsonl"), moved);
      writeJsonl(dispatchPath(root), keep);
      dispatches = moved.length;
      /* 成员刚被移走的组随之归档；还有下游挂着的组保留，避免下游失去父节点。 */
      archiveOrphanGroups(root, dir, rows, keep);
    }
  } catch {
    /* 台账读取失败时保留原样。 */
  }

  return { dir, workers: drop.size, dispatches };
}
