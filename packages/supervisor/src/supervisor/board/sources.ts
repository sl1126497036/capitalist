/**
 * 看板的数据源层：把调度侧写入的文件读成对象，并按 800ms 缓存。
 *
 * 缓存只服务看板读请求；监工主循环直接读盘，派单判定不经过这里。
 * 因此缓存过期只会让界面短暂滞后，不会让判定读到旧状态。
 */

import { join, resolve } from "node:path";

import { attachmentsIn } from "../../core/message/attachments";
import { supervisorDir } from "../../core/record/paths";
import { listWorkers, readDispatches, type Dispatch, type WorkerRecord } from "../../core/record/supervisor";

export const BOARD_READ_TTL_MS = 800;
export const dispatchesBoardCache = new Map<string, { at: number; rows: Dispatch[] }>();
export const workersBoardCache = new Map<string, { at: number; rows: WorkerRecord[] }>();

export function readDispatchesBoard(root: string): Dispatch[] {
  const hit = dispatchesBoardCache.get(root);
  if (hit && Date.now() - hit.at < BOARD_READ_TTL_MS) return hit.rows;
  const rows = readDispatches(root);
  dispatchesBoardCache.set(root, { at: Date.now(), rows });
  return rows;
}
export function listWorkersBoard(root: string): WorkerRecord[] {
  const hit = workersBoardCache.get(root);
  if (hit && Date.now() - hit.at < BOARD_READ_TTL_MS) return hit.rows;
  const rows = listWorkers(root);
  workersBoardCache.set(root, { at: Date.now(), rows });
  return rows;
}
export function eventsFile(root: string): string {
  return join(supervisorDir(root), "events.jsonl");
}

export function atTs(s: unknown): number {
  const n = typeof s === "string" ? Date.parse(s) / 1000 : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** 附件路径只取本条记录落库时的 atts 与自身正文，不读其它记录或全局状态。 */
export function attachmentsOf(r: { atts?: unknown; text?: unknown }): string[] {
  if (Array.isArray(r.atts)) {
    const own = r.atts.map((x) => String(x)).filter(Boolean);
    if (own.length) return [...new Set(own)];
  }
  return attachmentsIn(String(r.text ?? ""));
}

export function dispatchModel(d: Dispatch | undefined): string {
  return d ? String((d as unknown as Record<string, unknown>).model ?? "") : "";
}
/** 写操作后清空数据源缓存，下一次读取必须反映刚落盘的状态。 */
export function clearSourceCache(): void {
  dispatchesBoardCache.clear();
  workersBoardCache.clear();
}

export function listTaskRoots(current: string): string[] {
  const out = new Set<string>([resolve(current)]);
  for (const part of (process.env.CAPITALIST_BOARD_ROOTS ?? "").split(/[;,]/)) {
    const v = part.trim();
    if (v) out.add(resolve(v));
  }
  return [...out];
}
