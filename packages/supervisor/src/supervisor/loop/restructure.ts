/**
 * 结构插入的执行层：把一条 `INSERT:` 声明落实到台账，并结束需要退回的进程。
 *
 * 从 `loop.ts` 抽出：调度主循环只负责决定“是否执行”，而“锚点如何解析、
 * 失败如何提示、哪些进程要停”是插入操作自身的细节。留在一起会把主循环撑到规模上限，
 * 也让插入规则散在两处（core 的 treeOps 与 loop 各判一半）。
 *
 * 顺序是刻意的：先改台账，再结束进程。退出回调看到该单已不在途，不会按失败记一次；
 * 反过来则会先记一次失败，再被结构变更改写，台账上留下两条互相矛盾的事实。
 */

import { readDispatches } from "../../core/record/supervisor";
import { listWorkers } from "../../core/record/supervisor";
import { stopWorker } from "../../core/dispatch/commands";
import { insertNode } from "../../core/dispatch/treeOps";
import { normalizeGroupId } from "../../core/record/idMap";
import { isGroupRef } from "../../core/record/nodeRef";
import type { Dispatch } from "../../core/record/supervisor";

/** 指令里的插入声明。 */
export interface InsertDecl {
  where: "before" | "after";
  anchor: string;
  now?: boolean | undefined;
}

/**
 * 执行一条插入声明。
 *
 * 失败只播报、不回滚建单：派单已写入台账，退化为普通排队单后仍可执行，
 * 优于留下部分修改的树结构。
 *
 * @param resolveDispatch 把锚点引用换成派单（编号到台账 id 的换算需要编号表，由调用方给）。
 * @param out 播报出口，通常是监工流。
 */
export function applyInsert(
  root: string,
  newId: string,
  decl: InsertDecl,
  mode: "halt" | "keep" | "drop" | undefined,
  resolveDispatch: (tok: string) => Dispatch | undefined,
  out: (s: string) => void,
): void {
  const hit = resolveDispatch(decl.anchor);
  const anchorId = hit ? String(hit.id) : isGroupRef(decl.anchor) ? normalizeGroupId(decl.anchor) : "";
  const moved = insertNode(root, {
    newId,
    anchor: anchorId || decl.anchor,
    where: decl.where,
    mode,
  });
  if (!moved.ok) {
    out(`[监工] 插入未生效：${moved.errors.map((e) => e.reason).join("；")}（派单已建，按普通派单处理）`);
  }
  for (const sid of moved.stopDispatches) {
    for (const w of listWorkers(root)) {
      if (String(w.dispatch ?? "") !== sid) continue;
      if (w.status !== "running" && w.status !== "starting") continue;
      stopWorker(root, String(w.id), { requeue: false });
    }
  }
}

/** 读当前台账并解析锚点，供 `loop.ts` 一处调用。 */
export function applyInsertNow(
  root: string,
  newId: string,
  decl: InsertDecl,
  mode: "halt" | "keep" | "drop" | undefined,
  resolveDispatch: (rows: Dispatch[], tok: string) => Dispatch | undefined,
  out: (s: string) => void,
): void {
  applyInsert(root, newId, decl, mode, (tok) => resolveDispatch(readDispatches(root), tok), out);
}
