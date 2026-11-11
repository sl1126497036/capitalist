/**
 * 任务编号由后端分配、落盘，只增不复用；同一任务的号在队列重排、重派、重启后不变。
 *
 * 分配按任务创建时刻升序，不按队列顺序。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { laneKeyOf } from "../core/commands";
import { supervisorDir } from "../core/paths";
import { readDispatches } from "../core/supervisor";
import type { Dispatch } from "../core/supervisor";

/** 编号表文件名（在 `.capitalist/` 下）。 */
const FILE = "thread-no.json";

interface ThreadNoFile {
  /** 下一个待分配的号。缺省时按已有最大值 +1 推出。 */
  next?: number;
  /** 线程 id -> 号。线程 id 是 `阶段/分片`（无分片为 `阶段/x血缘尾号`）。 */
  ids?: Record<string, number>;
}

function pathOf(root: string): string {
  return join(supervisorDir(root), FILE);
}

function read(root: string): ThreadNoFile {
  try {
    const raw = readFileSync(pathOf(root), "utf8");
    const data = JSON.parse(raw) as ThreadNoFile;
    return data && typeof data === "object" ? data : {};
  } catch {
    /* 文件缺失、损坏或读取失败时按空表处理。 */
    return {};
  }
}

/** 先写临时文件再 rename：`/api/threads` 与对话接口可能并发写同一份表，原子替换避免读端解析到半写文件。 */
function write(root: string, data: ThreadNoFile): void {
  const p = pathOf(root);
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(tmp, p);
  } catch {
    /* Windows 上目标文件被其它进程占用时 `renameSync` 返回 EPERM，回落为直接覆盖写。 */
    try {
      writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    } catch {
      /* 写盘失败时号仅在当前进程内有效，重启后重排。 */
    }
  }
}

/**
 * @param orderedIds 须按创建时刻升序排列；调用方为唯一且顺序稳定的入口（`buildThreadsPage` 末尾）。
 * @returns 线程 id -> 号（正整数）；已有号原样返回，不改、不复用。
 */
export function assignThreadNos(root: string, orderedIds: readonly string[]): Map<string, number> {
  const data = read(root);
  const ids: Record<string, number> = { ...(data.ids ?? {}) };
  const used = Object.values(ids).filter((n) => Number.isFinite(n) && n > 0) as number[];
  let next = Math.max(Number(data.next) || 1, ...used.map((n) => n + 1));

  let dirty = false;
  for (const raw of orderedIds) {
    const id = String(raw ?? "").trim();
    if (!id || ids[id]) continue;
    ids[id] = next;
    next += 1;
    dirty = true;
  }
  if (dirty) write(root, { next, ids });

  const out = new Map<string, number>();
  for (const id of orderedIds) {
    const n = ids[String(id ?? "").trim()];
    if (n !== undefined && Number.isFinite(n) && n > 0) out.set(String(id), n);
  }
  return out;
}

/** 号 -> 显示串，至少两位；超过 99 时显示三位，不截断。 */
export function threadNoLabel(n: number | undefined | null): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "";
  return String(Math.trunc(v)).padStart(2, "0");
}

/** 直接读某条线程的号（不分配）；没有号时返回空串。 */
export function threadNoOf(root: string, id: string): string {
  const data = read(root);
  return threadNoLabel(data.ids?.[String(id ?? "").trim()] ?? NaN);
}

/** 号 -> 线程键；按号定位的入口经此转换，本函数只查不建。 */
export function threadIdByNo(root: string, no: number | string): string {
  const want = Number(no);
  if (!Number.isFinite(want) || want <= 0) return "";
  const ids = read(root).ids ?? {};
  for (const [id, n] of Object.entries(ids)) {
    if (Number(n) === Math.trunc(want)) return String(id);
  }
  return "";
}

/**
 * 任务号 -> 该线程上的在途单：先按号取线程键，血缘线程按 `lineage` 尾号匹配，分片线程按分片名匹配；不按队列顺序近似。
 *
 * @param rows 传入已读的台账可省一次 IO；不传时自行读取。
 * @returns 在途（open/claimed/reported/review）的那张单；号不存在或已终结时为 undefined。
 */
export function dispatchOfThreadNo(
  root: string,
  no: number,
  rows: Dispatch[] = readDispatches(root),
): Dispatch | undefined {
  const key = threadIdByNo(root, no);
  if (!key) return undefined;
  const [st, tailRaw] = key.split("/");
  const stage = String(st ?? "").trim().toLowerCase();
  const tail = String(tailRaw ?? "").trim().toLowerCase();
  const linTail = tail.startsWith("x") ? tail.slice(1) : "";
  const live = (s: string): boolean => ["open", "claimed", "reported", "review"].includes(s);
  return [...rows].reverse().find((x) => {
    if (!live(String(x.status ?? ""))) return false;
    if (stage && String(x.stage ?? "").toLowerCase() !== stage) return false;
    const lin = String((x as Dispatch & { lineage?: string }).lineage ?? x.id);
    if (linTail) return lin.slice(-6).toLowerCase() === linTail;
    if (!tail || tail === "main") return !String(x.shard ?? "").trim();
    return String(x.shard ?? "").toLowerCase() === tail;
  });
}

/** 整表只读导出，供 /api/forest 一次取号；缺表时返回空对象。 */
export function threadNoTable(root: string): Record<string, number> {
  return read(root).ids ?? {};
}

/**
 * 派单 id -> 任务编号：派单先按 {@link laneKeyOf} 折到线程键再查 `thread-no.json`，同一任务重派过的派单共用同一个号。
 *
 * 只查不建，表里没有时返回空串；整表一次读完返回 Map。
 */
export function dispatchNoTable(root: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const table = threadNoTable(root);
    for (const d of readDispatches(root)) {
      const key = laneKeyOf({
        stage: String(d.stage ?? ""),
        shard: d.shard,
        lineage: String((d as Dispatch & { lineage?: string }).lineage ?? ""),
        id: String(d.id ?? ""),
      });
      const no = threadNoLabel(table[key]);
      if (no) out.set(String(d.id), no);
    }
  } catch {
    /* 台账或编号表读不到只影响显示前缀，不能让消息回执整体失败。 */
  }
  return out;
}

export function threadNoFileExists(root: string): boolean {
  return existsSync(pathOf(root));
}
