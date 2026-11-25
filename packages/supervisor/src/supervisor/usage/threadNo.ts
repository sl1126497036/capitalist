/**
 * 任务编号由后端分配、落盘，只增不复用；同一任务的号在队列重排、重派、重启后不变。
 *
 * 分配按任务创建时刻升序，不按队列顺序。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { laneKeyOf } from "../../core/dispatch/commands";
import { padBareNo } from "../../core/record/idMap";
import { ledger as ledgerLoc } from "../../core/record/locations";
import { loadWorker, readDispatches } from "../../core/record/supervisor";
import { parseRef } from "../../core/record/nodeRef";
import { taskNoOfDispatchId } from "../../core/record/tasks";
import type { Dispatch } from "../../core/record/supervisor";

interface ThreadNoFile {
  /** 下一个待分配的号。缺省时按已有最大值 +1 推出。 */
  next?: number;
  /**
   * 线程 id -> 号。线程 id 是分片名（无分片为 `x` 加派生链尾号）。
   * 旧档里还留着带阶段前缀的键，读取时按后段匹配。
   */
  ids?: Record<string, number>;
}

function pathOf(root: string): string {
  return ledgerLoc.threadNo(root);
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
/**
 * @deprecated 界面任务号已改为直接取派单号前缀，本函数不再为任何线程发号。
 *
 * 保留原因：旧格式单（`D-` 前缀）没有任务号，历史编号表仍需能读。但不得再调用本函数为新线程
 * 分配号：按列表顺序发号会让任务号随启动时刻漂移，正是历史错乱的成因。
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

/** 号 -> 显示串（裸，不带 `#`），任务号段补零到两位；超过 99 时三位，不截断。 */
export function threadNoLabel(n: number | undefined | null): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "";
  return padBareNo(String(Math.trunc(v)));
}

/**
 * 从派单号或派生链号取任务号显示串（裸，补零）。
 *
 * 派单号形如 `2-3`，前缀即任务号；这是界面任务号的唯一来源，不再另发流水号。
 * 取不到（旧 `D-` 单、空值）返回空串，由调用方决定是否回查历史表。
 */
export function taskNoOfRef(no: string): string {
  const m = /^(\d+)-/.exec(String(no ?? "").trim());
  return m ? padBareNo(String(Number(m[1]))) : "";
}

/** 直接读某条线程的号（不分配）；没有号时返回空串。 */
export function threadNoOf(root: string, id: string): string {
  const s = String(id ?? "").trim();
  /* 新格式：线程键 `s0/x2-3` 或派单号 `2-3`，任务号就在前缀里。 */
  const direct = taskNoOfRef(s);
  if (direct) return direct;
  const m = /\/x(\d+-\d+)$/.exec(s);
  if (m) return taskNoOfRef(m[1] ?? "");
  /* 旧格式：只读历史编号表，不新建。 */
  return threadNoLabel(read(root).ids?.[s] ?? NaN);
}

/** 号 -> 线程键；按号定位的入口经此转换，本函数只查不建。 */
export function threadIdByNo(root: string, no: number | string): string {
  const want = Math.trunc(Number(no));
  if (!Number.isFinite(want) || want <= 0) return "";

  /*
   * 新格式：任务号就在派单号前缀里。取该任务最新的一张单，按它与建单同一份 `laneKeyOf`
   * 算出线程键，不再依赖历史编号表。
   */
  const rows = readDispatches(root);
  const hit = [...rows]
    .filter((d) => taskNoOfDispatchId(String(d.id)) === want)
    .sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")))[0];
  if (hit) {
    return laneKeyOf({
      shard: hit.shard,
      lineage: String((hit as Dispatch & { lineage?: string }).lineage ?? hit.id),
      id: hit.id,
    });
  }

  /* 旧格式单：回查历史编号表，仅兼容旧档。 */
  const ids = read(root).ids ?? {};
  for (const [id, n] of Object.entries(ids)) {
    if (Number(n) === want) return String(id);
  }
  return "";
}

/**
 * 任务号 -> 该任务名下的一张单。
 *
 * 新编号体系里派单号是 `任务号-派发序`（落盘无 `#`，如 `2-2`），任务号直接编码在派单号里，
 * 不再靠 `thread-no.json` 反查线程键。按派单 id 前缀 `2-` 匹配，取派发序最大的在途单。
 *
 * 默认只认在途状态，用于“该编号当前执行到哪一步”。重开（redo）要的是已经结束的那张单，
 * 该场合把 `includeDone` 打开，否则会被 live 过滤掉，表现为“没有编号 #01”。
 *
 * 只取终态时用 `settledOnly`：取“派发序最大的单”可能命中同批新建的替代单，
 * 将其作为重开目标会使两张单重复执行同一事项。
 *
 * @param rows 传入已读的台账可省一次 IO；不传时自行读取。
 * @param opts.includeDone 为真时把已结束的单（`done` / `closed` / `failed`）也视为可取目标（仍取最近一条）。
 * @param opts.settledOnly 为真时只取终态，在途单不参与，优先于其余两个选项。
 * @returns 命中的那张单；号不存在、或已终结且未开启 includeDone 时为 undefined。
 */
export function dispatchOfThreadNo(
  root: string,
  no: number,
  rows: Dispatch[] = readDispatches(root),
  opts: { includeDone?: boolean; anyStatus?: boolean; settledOnly?: boolean } = {},
): Dispatch | undefined {
  const want = Math.trunc(no);
  const prefix = `${want}-`;
  const live = (s: string): boolean => {
    if (opts.settledOnly === true) return ["done", "closed", "failed"].includes(s);
    /* 排结构、挂依赖要能指向已经结束的单，这类场合由调用方打开 `anyStatus`。 */
    if (opts.anyStatus === true) return true;
    if (["open", "claimed", "reported", "review"].includes(s)) return true;
    /*
     * 重开要的是已经结束的单，而“结束”有三种终态：done、closed（用户结束）、failed。
     * 仅依据 done，用户点“重开”时会得到“没有编号 #NN”，而那张单就在看板上。
     */
    return opts.includeDone === true && ["done", "closed", "failed"].includes(s);
  };
  /* 新编号 id 形如 `2-2`，按 `-` 后的序比较，取最近一张。 */
  const pick = (list: Dispatch[]): Dispatch | undefined =>
    list
      .filter((x) => live(String(x.status ?? "")))
      .sort((a, b) => dispatchSeq(b.id) - dispatchSeq(a.id))[0];

  const fresh = pick(rows.filter((x) => String(x.id ?? "").startsWith(prefix)));
  if (fresh) return fresh;

  /*
   * 旧格式单（`D-` 前缀）没有任务号前缀，靠历史编号表把号映射到线程键再找。
   * 只读不建：新单不会走这条路径。
   */
  const ids = read(root).ids ?? {};
  const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase();
  /*
   * 历史表里的键可能由旧版规则生成：早期只记录“阶段 + 派生链尾号”，未包含分片。
   * 仅比较完整键会使这类旧档无法按号定位；先比完整键，不匹配时再比派生链形态。
   * `x` 前缀用于区分派生链键与分片名，避免两种形态互相误认。
   */
  const wanted = new Set(
    Object.entries(ids)
      .filter(([, n]) => Number(n) === want)
      .map(([id]) => norm(id)),
  );
  if (wanted.size === 0) return undefined;
  const lineageKeyOf = (d: Dispatch): string => {
    const lin = norm((d as Dispatch & { lineage?: string }).lineage || d.id);
    return `x${lin.slice(-6)}`;
  };
  return pick(
    rows.filter(
      (d) =>
        wanted.has(
          norm(
            laneKeyOf({
              shard: d.shard,
              lineage: String((d as Dispatch & { lineage?: string }).lineage ?? ""),
              id: d.id,
            }),
          ),
        ) || wanted.has(lineageKeyOf(d)),
    ),
  );
}

/**
 * 按任务号取一条追加（amend）的目标单。
 *
 * 在途优先：这条任务的追加应落到正在跑的那张单上。全部已终结时取最近一张终态单，
 * 由调用方重开——用户对已验收的任务提出更正或返工，是明确的重派意图，不能因为
 * “已完成”把追加拒掉；监工对已完成的验收也不一定正确。
 *
 * 与 `redo` 共用 `settledOnly` 口径：都取“派发序最大的已终结单”，不命中同批新建的替代单。
 *
 * @param rows 传入已读的台账可省一次 IO。
 * @returns 命中的单；该任务号不存在时为 undefined。
 */
export function amendTargetOf(
  root: string,
  no: number,
  rows: Dispatch[] = readDispatches(root),
): Dispatch | undefined {
  return dispatchOfThreadNo(root, no, rows) ?? dispatchOfThreadNo(root, no, rows, { settledOnly: true });
}

/**
 * 把一次编号引用解析成台账行：全系统统一入口。
 *
 * 命令行（`tree move` / `tree group`）、调度（`PARENT:` / `AFTER:`）、看板按号操作
 * 共用一套基准：任务号一律按“派单序最大”定位。此前调度侧另走“at 最新 → 线程键 →
 * 台账最后一行”，落盘顺序被并发打乱时会指向旧单；派生链与任务号脱钩时会落到别的任务上，且不报错。
 *
 * 形态判定交给 `nodeRef.parseRef`，与显示层使用同一处规则。组不是派单行，返回 undefined
 * 由调用方查组台账；无法识别的形态（历史 `D-` 号、线程键）同样返回 undefined，
 * 由调用方按原文精确匹配或给出错误提示。
 *
 * @param opts.rows 复用已读台账，避免重复读取。
 * @param opts.anyStatus 为真时不按状态过滤：排结构、挂依赖要能指向已结束的单。
 */
export function dispatchOfRef(
  root: string,
  tok: string,
  opts: { rows?: Dispatch[]; anyStatus?: boolean; includeDone?: boolean } = {},
): Dispatch | undefined {
  const ref = parseRef(tok);
  if (!ref.id || ref.kind === "group" || ref.kind === "other") return undefined;
  const rows = opts.rows ?? readDispatches(root);

  if (ref.kind === "task-no") {
    return dispatchOfThreadNo(root, Number(ref.id), rows, {
      ...(opts.anyStatus ? { anyStatus: true } : {}),
      ...(opts.includeDone ? { includeDone: true } : {}),
    });
  }

  if (ref.kind === "worker-no") {
    /*
     * 进程号指认对应的派单：派单 id 是 `任务号-派单序`，去掉 `-P1` 得到的是任务号，
     * 不是派单 id，必须查进程记录。记录已被回收时退回台账按 id 精确匹配。
     */
    const held = String(loadWorker(root, ref.id)?.dispatch ?? "");
    if (held) {
      const hit = rows.find((x) => String(x.id) === held);
      if (hit) return hit;
    }
    return rows.find((x) => String(x.id) === ref.id);
  }

  /* 派单 id：`2-3` 与 `02-3` 在 parseRef 里都已归一成 `2-3`。 */
  return rows.find((x) => String(x.id) === ref.id);
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
 * 派单 id -> 派单号（裸编号，不带 `#`，如 `"2-2"`）。
 *
 * 新编号体系里派单 id 即派单号（`2-2`），直接取 id 本身，不再查 `thread-no.json`。
 * 旧格式派单 id（随机串）按线程键查旧编号表兜底。
 *
 * 全系统编号的落盘/下发口径统一为不带 `#`，`#` 只在显示层经
 * {@link idMap.dispatchNoLabel} 等统一入口补，任何消费点都不得自行拼 `#` 或自行去 `#`。
 *
 * 只查不建，读取失败时返回空串；整表一次读完返回 Map。
 */
export function dispatchNoTable(root: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const table = threadNoTable(root);
    for (const d of readDispatches(root)) {
      const id = String(d.id ?? "");
      if (/^\d+-\d+$/.test(id)) {
        out.set(id, id);
        continue;
      }
      /* 非新格式的派单 id：按线程键查旧编号表，仅兜底。 */
      const key = laneKeyOf({
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
