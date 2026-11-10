/**
 * 积分台账：账号级已用积分的增量按时间窗分摊给当时活跃的工作进程。
 * 无快照时 `credit` 为 null，界面回落到 token；已用积分变小不摊负数，只更新基线。
 * 只写 `.capitalist/credits.json`，读写失败静默降级。
 */

import { join } from "node:path";
import { statSync } from "node:fs";

import { listWorkers } from "../core/supervisor";
import { statCached } from "../core/fsCache";
import { readJson, writeJson } from "../core/json";
import { supervisorDir } from "../core/paths";

interface CreditFile {
  at: string;
  /** 上一次快照的账号级已用积分；null = 还没读到过真实读数 */
  last_used: number | null;
  /** 上一次快照时刻（ISO） */
  last_at: string;
  /** 单位（照计费接口，一般是「积分」） */
  unit: string;
  /** 上一次读数所属账号 uid；换账号后基线不可沿用 */
  uid?: string;
  /** 按工作进程 id 累计的积分消耗 */
  by_worker: Record<string, number>;
}

const EMPTY: CreditFile = { at: "", last_used: null, last_at: "", unit: "", by_worker: {} };

/** 非工作进程消耗的独立桶：无活跃进程期间的账号增量（宿主侧对话、监工自身调用等）。 */
export const CAPITALIST_BUCKET = "capitalist";

/**
 * 归因窗口的最大跨度。相邻两次快照间隔可能很长（面板未打开时不读余额），
 * 把下界收到这个跨度以内，避免把数小时前跑过的进程算进本次窗口。
 */
const MAX_SPAN_MS = 10 * 60_000;

export function creditLedgerPath(root: string): string {
  return join(supervisorDir(root), "credits.json");
}

/**
 * 进程内缓存，按 mtime/size 判失效。看板高频轮询，避免逐次读盘；
 * 外部写入导致 mtime 变化后，下一轮读到新值。
 */
const cache = new Map<string, { mtimeMs: number; size: number; file: CreditFile }>();

/**
 * 数值字段解析。空值返回 null：`Number(null)` 与 `Number("")` 都是 0，
 * 直接转换会把「没有基线」读成「基线为 0」，让首次真实读数整体算成一笔增量。
 */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function load(root: string): CreditFile {
  const p = creditLedgerPath(root);
  /* 一次请求里这条被查十几遍；缓存 stat 后只碰一次盘。 */
  const st = statCached(p);
  const hit = st ? cache.get(root) : undefined;
  if (st && hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.file;
  if (!st) {
    cache.delete(root);
    return { ...EMPTY, by_worker: {} };
  }
  const raw = readJson<CreditFile>(p, EMPTY);
  const file: CreditFile =
    raw && typeof raw === "object"
      ? {
          at: String(raw.at ?? ""),
          last_used: numOrNull(raw.last_used),
          last_at: String(raw.last_at ?? ""),
          unit: String(raw.unit ?? ""),
          uid: typeof raw.uid === "string" ? raw.uid : "",
          by_worker:
            raw.by_worker && typeof raw.by_worker === "object"
              ? Object.fromEntries(
                  Object.entries(raw.by_worker)
                    .map(([k, v]) => [String(k), Number(v)])
                    .filter(([, v]) => Number.isFinite(v) && (v as number) > 0),
                )
              : {},
        }
      : { ...EMPTY, by_worker: {} };
  cache.set(root, { mtimeMs: st.mtimeMs, size: st.size, file });
  return file;
}

function persist(root: string, file: CreditFile): void {
  try {
    writeJson(creditLedgerPath(root), file);
    const st = statSync(creditLedgerPath(root));
    cache.set(root, { mtimeMs: st.mtimeMs, size: st.size, file });
  } catch {
    /* 写入失败按未记快照处理；积分分摊是辅助读数，不阻断调度。 */
  }
}

/** 分摊精度：积分保留两位小数，多留两位吸收均摊零头。 */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * 工作进程最后一次有动作的时刻：心跳时间与日志最后写入时间取较晚者。
 * 日志是宿主输出的落点，只有产生内容时才变，可作为「这段时间确有消耗」的判据。
 */
function lastActivityMs(w: ReturnType<typeof listWorkers>[number]): number {
  let ms = Date.parse(String(w.heartbeat_at ?? ""));
  if (!Number.isFinite(ms)) ms = 0;
  if (w.log) {
    try {
      const m = statSync(w.log).mtimeMs;
      if (m > ms) ms = m;
    } catch {
      /* 日志已删除时只按心跳判断。 */
    }
  }
  return ms;
}

/**
 * 记录账号级已用积分快照，并把相邻快照的增量分摊给活跃工作进程。
 * 由 balance.ts 在真实读数后调用；`used` 为 null 时只记单位、不动基线。
 */
export function noteCreditUsed(root: string, used: number | null, unit: string, uid = ""): void {
  const file = load(root);
  const now = new Date().toISOString();
  if (unit) file.unit = unit;
  if (used === null || !Number.isFinite(used)) {
    file.at = now;
    persist(root, file);
    return;
  }
  /*
   * 换账号（或台账此前没记账号）时旧基线不可沿用：它是另一个账号的累计已用，
   * 与本次读数相减会得出一笔与任何进程都无关的增量。只重置基线，不分摊。
   */
  const accountSwitch = uid !== "" && file.uid !== uid;
  if (uid) file.uid = uid;
  if (accountSwitch) {
    file.last_used = used;
    file.last_at = now;
    file.at = now;
    persist(root, file);
    return;
  }
  const last = file.last_used;
  const prevAt = file.last_at;
  /*
   * 读数变小时分两种处理：跌去一半以上视为额度耗尽的不可信读数，保留基线；
   * 小幅回退视为套餐重置，按新基线重立，不分摊负数。
   */
  if (last !== null && used < last) {
    file.at = now;
    if (last > 0 && used < last * 0.5) {
      persist(root, file);
      return;
    }
    file.last_used = used;
    file.last_at = now;
    persist(root, file);
    return;
  }
  file.last_used = used;
  file.last_at = now;
  file.at = now;
  if (last === null || used === last) {
    /* 首次快照只立基线；与上次持平则无增量可分摊。 */
    persist(root, file);
    return;
  }
  const delta = used - last;
  /*
   * 归因窗口取 [上次快照时刻, 本次读数时刻]，下界再收到 MAX_SPAN_MS 以内。
   * 没有上次快照时刻时无法确定增量属于哪一段时间，只立基线，不摊历史累计。
   */
  const from = Date.parse(prevAt);
  if (!Number.isFinite(from)) {
    persist(root, file);
    return;
  }
  const windowFrom = Math.max(from, Date.now() - MAX_SPAN_MS);
  let workers: ReturnType<typeof listWorkers> = [];
  try {
    workers = listWorkers(root);
  } catch {
    return;
  }
  /*
   * 活跃判据取「窗口内有过动作」，不看进程状态：监工停止或判死延迟时，
   * 记录会长期停在 running，只按状态判断会把此后的账号增量持续记给这个进程。
   */
  const active = workers.filter((w) => lastActivityMs(w) >= windowFrom);
  if (active.length === 0) {
    /* 账号级读数含同账号其它调用；无活跃工作进程时记入独立桶，不计入已停止的派单。 */
    file.by_worker[CAPITALIST_BUCKET] = round4((file.by_worker[CAPITALIST_BUCKET] ?? 0) + delta);
    persist(root, file);
    return;
  }
  const share = round4(delta / active.length);
  for (const w of active) file.by_worker[w.id] = round4((file.by_worker[w.id] ?? 0) + share);
  persist(root, file);
}

/** 一个工作进程的累计积分；无分摊记录时为 null，界面回落到 token。 */
export function creditOfWorker(root: string, workerId: string): number | null {
  if (!root || !workerId) return null;
  const v = load(root).by_worker[workerId];
  return Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
}

/** 非工作进程消耗独立桶的累计积分；无记录时为 null。 */
export function creditOfSupervisor(root: string): number | null {
  return creditOfWorker(root, CAPITALIST_BUCKET);
}

/** 积分单位，取自计费接口；无快照时为空串。 */
export function creditUnit(root: string): string {
  return root ? load(root).unit : "";
}

/** 一组工作进程的积分合计；全部无读数时为 null。 */
export function creditOfWorkers(root: string, workerIds: readonly string[]): number | null {
  if (!root) return null;
  const file = load(root);
  let sum = 0;
  let hit = 0;
  for (const id of workerIds) {
    const v = file.by_worker[id];
    if (Number.isFinite(Number(v)) && Number(v) > 0) {
      sum += Number(v);
      hit++;
    }
  }
  return hit > 0 ? sum : null;
}

/** 测试用：清除盘上与内存中的分摊记录。 */
export function __resetCreditLedger(): void {
  cache.clear();
}
