/**
 * 编号关系表：任务号 / 派单号 / 进程号的关联，落 `.capitalist/id-map.json`。
 *
 * 全系统只有这一套编号，任务、派单、进程在一个工作空间内互不冲突：
 *
 *   任务号   `#01` `#02`       自增，建任务时发行，永不回收
 *   派单号   `#02-2` `#02-3`   任务号 + 该任务的派发序（第几次派单）
 *   进程号   `#02-P1` `#02-P2` 任务号 + 该任务的进程序（P 大写）
 *
 * 落盘键用无 `#` 形式（任务 `"2"`、派单 `"2-2"`、进程 `"2-P1"`），`#` 只在显示层补，
 * 因此文件名校验、路径拼接不接触 `#`。对外显示用 {@link taskNoLabel}、{@link dispatchNoLabel}、
 * {@link workerNoLabel} 统一加 `#`。
 *
 * 关系表维护两类关联：
 *   1. 进程号 -> 拉起它的派单号；
 *   2. 进程号 -> 系统 pid。
 *
 * 与其它落盘协议一致：整份 JSON、原子写；读侧缺字段按空表兼容旧档。
 */

import { join } from "node:path";

import { readJson, writeJson } from "./json";
import { config as configLoc } from "./locations";

/** 关系表文件路径：`<root>/.capitalist/config/id-map.json`。 */
export function idMapPath(root: string): string {
  return configLoc.idMap(root);
}

/** 任务号段补零到两位；超过 99 原样（不截断）。只用于显示，落盘不变。 */
function padTaskNo(n: string): string {
  return /^\d+$/.test(n) ? n.padStart(2, "0") : n;
}

/**
 * 裸编号里第一段任务号补零到两位：`2-2` -> `02-2`、`2-P1` -> `02-P1`、`2` -> `02`；
 * 非数字开头原样（如 `S0-S-<毫秒>`、旧 `D-` 号）。
 *
 * 编号显示的唯一补零入口：任务号、派单号、进程号、消息编号都经这里，避免各自实现。
 */
export function padBareNo(s: string): string {
  const bare = String(s ?? "").replace(/^#/, "").trim();
  const m = /^(\d+)(.*)$/.exec(bare);
  return m ? `${padTaskNo(m[1] ?? "")}${m[2] ?? ""}` : bare;
}

/** 任务号显示形式：`#01`。入参为任务号数字，显示补零到两位；无效号返回空串。 */
export function taskNoLabel(no: number): string {
  const n = Math.trunc(Number(no));
  if (!Number.isFinite(n) || n <= 0) return "";
  return `#${padTaskNo(String(n))}`;
}

/** 派单号显示形式：`#02-2`。入参为落盘形式 `2-2`。 */
export function dispatchNoLabel(no: string): string {
  return `#${padBareNo(no)}`;
}

/** 进程号显示形式：`#02-P1`。入参为落盘形式 `2-P1`。 */
export function workerNoLabel(no: string): string {
  return `#${padBareNo(no)}`;
}

/**
 * 剥掉编号开头的 `#`，得落盘形式。
 *
 * 解析输入的唯一入口：容忍用户带 `#`（`#02-2`）或不带（`02-2`），统一回落到盘形式。
 * 任何地方解析编号都走这里，不得各自拼 `#` 或自行去 `#`。
 */
export function stripHash(no: string): string {
  return String(no ?? "").replace(/^#/, "").trim();
}

/** 一个任务。任务号即任务唯一标识。 */
export interface IdMapTask {
  /** 任务号（`#` 后的数字）。 */
  no: number;
  title: string;
  /** 该任务累计派出的派单号（落盘形式 `2-2`）。 */
  dispatches: string[];
  /** 该任务累计拉起的进程号（落盘形式 `2-P1`）。 */
  workers: string[];
}

/** 一张派单。 */
export interface IdMapDispatch {
  /** 派单号（落盘形式 `2-2`）。 */
  no: string;
  /** 所属任务号。 */
  taskNo: number;
  /** 该单拉起的进程号（落盘形式 `2-P1`）。 */
  workers: string[];
}

/** 一个进程。 */
export interface IdMapWorker {
  /** 进程号（落盘形式 `2-P1`）。 */
  no: string;
  /** 所属任务号。 */
  taskNo: number;
  /** 拉起它的派单号（落盘形式 `2-2`）。 */
  dispatchNo: string;
  /** 系统进程号（pid）。0 表示拉起时未取到。 */
  osPid: number;
}

/** 关系表结构。 */
export interface IdMapFile {
  /** 任务号（落盘形式 `"2"`）-> 任务。 */
  tasks: Record<string, IdMapTask>;
  /** 派单号（落盘形式 `"2-2"`）-> 派单。 */
  dispatches: Record<string, IdMapDispatch>;
  /** 进程号（落盘形式 `"2-P1"`）-> 进程。 */
  workers: Record<string, IdMapWorker>;
}

/** 空表。 */
function empty(): IdMapFile {
  return { tasks: {}, dispatches: {}, workers: {} };
}

/** 读关系表；文件缺失或损坏返回空表，不抛。 */
export function readIdMap(root: string): IdMapFile {
  const raw = readJson<Partial<IdMapFile> | null>(idMapPath(root), null);
  if (!raw || typeof raw !== "object") return empty();
  return {
    tasks: raw.tasks && typeof raw.tasks === "object" ? (raw.tasks as Record<string, IdMapTask>) : {},
    dispatches:
      raw.dispatches && typeof raw.dispatches === "object"
        ? (raw.dispatches as Record<string, IdMapDispatch>)
        : {},
    workers:
      raw.workers && typeof raw.workers === "object" ? (raw.workers as Record<string, IdMapWorker>) : {},
  };
}

/** 写关系表。整份覆盖、原子写；写失败不抛（关系表是增强，不是主流程前置）。 */
export function writeIdMap(root: string, map: IdMapFile): void {
  try {
    writeJson(idMapPath(root), map);
  } catch {
    /* 写不进只影响编号关联展示，不影响派单与执行。 */
  }
}

/**
 * 登记任务，发行任务号。
 *
 * @returns 任务号。已登记按任务号复用，不重发。
 */
export function registerTask(root: string, no: number, title: string): number {
  const map = readIdMap(root);
  const key = String(no);
  if (!map.tasks[key]) {
    map.tasks[key] = { no, title, dispatches: [], workers: [] };
    writeIdMap(root, map);
  }
  return no;
}

/**
 * 登记派单，并把派单挂到所属任务。
 *
 * @param attempt 派发序（第几次派单，从 1 起）。
 * @returns 派单号（落盘形式 `2-2`）。
 */
export function registerDispatch(root: string, taskNo: number, attempt: number): string {
  const map = readIdMap(root);
  const no = `${taskNo}-${Math.max(1, attempt)}`;
  if (!map.dispatches[no]) {
    map.dispatches[no] = { no, taskNo, workers: [] };
    const task = map.tasks[String(taskNo)];
    if (task && !task.dispatches.includes(no)) task.dispatches.push(no);
    writeIdMap(root, map);
  }
  return no;
}

/**
 * 登记进程，并把进程挂到所属派单与任务，记录系统 pid。
 *
 * @param seq 任务内进程序（第几个进程，从 1 起）。
 * @returns 进程号（落盘形式 `2-P1`）。
 */
export function registerWorker(
  root: string,
  taskNo: number,
  dispatchNo: string,
  seq: number,
  osPid: number,
): string {
  const map = readIdMap(root);
  const no = `${taskNo}-P${Math.max(1, seq)}`;
  if (!map.workers[no]) {
    map.workers[no] = { no, taskNo, dispatchNo, osPid };
    const dispatch = map.dispatches[dispatchNo];
    if (dispatch && !dispatch.workers.includes(no)) dispatch.workers.push(no);
    const task = map.tasks[String(taskNo)];
    if (task && !task.workers.includes(no)) task.workers.push(no);
    writeIdMap(root, map);
  } else if (osPid > 0 && map.workers[no].osPid !== osPid) {
    map.workers[no].osPid = osPid;
    writeIdMap(root, map);
  }
  return no;
}

/** 更新进程的系统 pid（worker 拉起拿到 pid 后回填）。 */
export function setWorkerOsPid(root: string, workerNo: string, osPid: number): void {
  const map = readIdMap(root);
  const w = map.workers[workerNo];
  if (!w || w.osPid === osPid) return;
  w.osPid = osPid;
  writeIdMap(root, map);
}

/** 按任务号取任务；未登记返回 undefined。 */
export function taskMapOf(root: string, no: number): IdMapTask | undefined {
  return readIdMap(root).tasks[String(no)];
}

/** 按派单号取派单；未登记返回 undefined。 */
export function dispatchMapOf(root: string, no: string): IdMapDispatch | undefined {
  return readIdMap(root).dispatches[no];
}

/** 按进程号取进程；未登记返回 undefined。 */
export function workerMapOf(root: string, no: string): IdMapWorker | undefined {
  return readIdMap(root).workers[no];
}

/** 整表只读导出，供看板 API 一次取全。 */
export function idMapTable(root: string): IdMapFile {
  return readIdMap(root);
}
