/**
 * 任务编号由后端分配、落盘，只增不复用；同一任务的号在队列重排、重派、重启后不变。
 *
 * 分配按任务创建时刻升序，不按队列顺序。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { laneKeyOf } from "../../core/dispatch/commands";
import { supervisorDir } from "../../core/record/paths";
import { readDispatches } from "../../core/record/supervisor";
import type { Dispatch } from "../../core/record/supervisor";

/** 编号表文件名（在 `.capitalist/` 下）。 */
const FILE = "thread-no.json";

interface ThreadNoFile {
  /** 下一个待分配的号。缺省时按已有最大值 +1 推出。 */
  next?: number;
  /** 线程 id -> 号。线程 id 是 `阶段/分片`（无分片为 `阶段/x派生链尾号`）。 */
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
    /* Windows 上目标文件被其它进程占用时 `renameSync` 返回 EPERM，改用直接覆盖写。 */
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
 * 任务号 -> 该任务名下的一张单。
 *
 * 新编号体系里派单号是 `任务号-派发序`（落盘无 `#`，如 `2-2`），任务号直接编码在派单号里，
 * 不再靠 `thread-no.json` 反查线程键。按派单 id 前缀 `2-` 匹配，取派发序最大的在途单。
 *
 * 默认只认在途状态，用于“该编号当前执行到哪一步”。重开（redo）要的恰恰是已经结束的那张单，
 * 该场合把 `includeDone` 打开，否则会被 live 过滤掉，表现为“没有编号 #01”。
 *
 * @param rows 传入已读的台账可省一次 IO；不传时自行读取。
 * @param opts.includeDone 为真时把已结束的单（`done` / `closed` / `failed`）也视为可取目标（仍取最近一条）。
 * @returns 命中的那张单；号不存在、或已终结且未开启 includeDone 时为 undefined。
 */
export function dispatchOfThreadNo(
  root: string,
  no: number,
  rows: Dispatch[] = readDispatches(root),
  opts: { includeDone?: boolean } = {},
): Dispatch | undefined {
  const prefix = `${Math.trunc(no)}-`;
  const live = (s: string): boolean => {
    if (["open", "claimed", "reported", "review"].includes(s)) return true;
    /*
     * 重开要的是已经结束的单，而“结束”有三种终态：done、closed（用户结束）、failed。
     * 只认 done 会让用户点“重开”时拿到“没有编号 #NN”，而那张单就在看板上。
     */
    return opts.includeDone === true && ["done", "closed", "failed"].includes(s);
  };
  /* 取派发序最大（最近）的一张；新编号 id 形如 `2-2`，按 `-` 后的序比较。 */
  return [...rows]
    .filter((x) => String(x.id ?? "").startsWith(prefix))
    .filter((x) => live(String(x.status ?? "")))
    .sort((a, b) => dispatchSeq(b.id) - dispatchSeq(a.id))[0];
}

/** 派单 id 里的派发序（`2-2` -> 2）；非新格式返回 0。 */
function dispatchSeq(id: string): number {
  const m = /^(\d+)-(\d+)$/.exec(String(id ?? ""));
  return m ? Number(m[2]) : 0;
}

/** 整表只读导出，供 /api/forest 一次取号；缺表时返回空对象。 */
export function threadNoTable(root: string): Record<string, number> {
  return read(root).ids ?? {};
}

/**
 * 派单 id -> 任务号（带 `#`，如 `#02`）。
 *
 * 新编号体系里任务号直接编码在派单号里（`2-2` -> `#02`），不再查 `thread-no.json`。
 *
 * 只查不建，取不到时返回空串；整表一次读完返回 Map。
 */
export function dispatchNoTable(root: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const table = threadNoTable(root);
    for (const d of readDispatches(root)) {
      const id = String(d.id ?? "");
      const m = /^(\d+)-(\d+)$/.exec(id);
      if (m) {
        out.set(id, `#${m[1]}`);
        continue;
      }
      /* 非新格式的派单 id：按线程键查旧编号表，仅兜底。 */
      const key = laneKeyOf({
        stage: String(d.stage ?? ""),
        shard: d.shard,
        lineage: String((d as Dispatch & { lineage?: string }).lineage ?? ""),
        id,
      });
      const no = threadNoLabel(table[key]);
      if (no) out.set(id, no);
    }
  } catch {
    /* 台账或编号表读不到只影响显示前缀，不能让消息回执整体失败。 */
  }
  return out;
}

export function threadNoFileExists(root: string): boolean {
  return existsSync(pathOf(root));
}
