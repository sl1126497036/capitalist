
import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export type LockMode = "read" | "write";

/** 单条锁。`depth` 用于重入，`beat` 用于判活。 */
export interface LockEntry {
  mode: LockMode;
  /** 持有者：workerId（`CAPITALIST_WORKER_ID`）；人手工加的锁是 `user`。 */
  holder: string;
  pid: number;
  /** 原始路径（保留大小写，便于在界面上原样展示）。 */
  path: string;
  since: string;
  beat: string;
  /** 秒。到期且持有者不存活时回收。 */
  ttl: number;
  depth: number;
  /**
   * 由一次工具调用申请、并应在下一次工具调用前释放的锁。
   *
   * hook 没有“执行后”这个生命周期点（只有 on_action），所以拿不到“写完了”这个时刻。
   * 但 worker 的工具调用是串行的：下一次 on_action 到来时，上一次写操作必然已经做完。
   * 于是用 transient 标记，每次 on_action 开头先 `releaseTransient`，等价于“写完即放”。
   */
  transient?: boolean;
}

/** 排队中的申请。`at` 决定先后，写优先靠它比较。 */
export interface LockWaiter {
  path: string;
  mode: LockMode;
  holder: string;
  at: string;
}

export interface LockTable {
  version: 1;
  locks: Record<string, LockEntry>;
  queue: LockWaiter[];
}

export interface AcquireOpts {
  /** 锁存活上限（秒）。 */
  ttlSec: number;
  /** 读是否也进锁表（严格读）。 */
  strictRead: boolean;
  /** 申请的是“一次工具调用”级别的锁，下一次调用前应被释放。 */
  transient?: boolean;
  /**
   * 记进锁表的 pid：持有者 worker 的 pid，不是 hook 自己的。
   *
   * hook 是宿主 fork 出来的短命进程，写完就退了。如果记它的 pid，判活永远为假，
   * 回收逻辑会以为持有者死了，面板上也会显示成一个不存在的进程。调用方拿不到时
   * 才回落到 `process.pid`。
   */
  pid?: number;
}

export interface AcquireResult {
  ok: boolean;
  mode: LockMode;
  path: string;
  /** 冲突时：当前持有者。 */
  holder?: string | undefined;
  holderSince?: string | undefined;
  /** 冲突时：建议等多久（毫秒）。 */
  waitMs?: number | undefined;
  /** 冲突时：前面还有几个在等。 */
  ahead?: number | undefined;
  reason?: string | undefined;
}

const DEFAULT_TTL = 600;

/** 锁表路径。 */
export function lockTablePath(root: string): string {
  return join(root, ".capitalist", "locks", "files.json");
}

/** 元锁路径：保护锁表本身的读改写。 */
function metaLockPath(root: string): string {
  return join(root, ".capitalist", "locks", "files.lock");
}

/** 读版本台账。 */
export function readLedgerPath(root: string): string {
  return join(root, ".capitalist", "locks", "reads.jsonl");
}

/**
 * 路径归一化成锁表的 key。
 *
 * Windows 上同一个文件可能以 `S:\a\b` / `s:\A\B` 出现两次，按原样当 key 会各锁一份，
 * 等于没锁。所以 key 一律小写；展示用 entry 里保留的原始 `path`。
 */
export function lockKey(p: string): string {
  const abs = resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function emptyTable(): LockTable {
  return { version: 1, locks: {}, queue: [] };
}

/** 元锁：跨进程互斥地读改写锁表。 */
function withTableLock<T>(root: string, fn: () => T): T {
  const dir = join(root, ".capitalist", "locks");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 已存在 */
  }
  const mp = metaLockPath(root);
  const started = Date.now();
  let fd = -1;
  for (;;) {
    try {
      fd = openSync(mp, "wx");
      break;
    } catch {
      if (Date.now() - started > 400) return fn(); // 抢不到就裸跑一次，避免工具调用被卡死
      sleepSync(10 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (fd >= 0) closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      rmSync(mp, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** 同步睡眠（Atomics.wait 不烧 CPU；hook 进程里没有别的事可做）。 */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

export function readTable(root: string): LockTable {
  const p = lockTablePath(root);
  try {
    const raw = readFileSync(p, "utf8");
    const j = JSON.parse(raw) as Partial<LockTable>;
    return {
      version: 1,
      locks: j.locks && typeof j.locks === "object" ? (j.locks as Record<string, LockEntry>) : {},
      queue: Array.isArray(j.queue) ? (j.queue as LockWaiter[]) : [],
    };
  } catch {
    /* 锁表不存在或损坏时按空表处理，避免阻断工具调用。 */
    return emptyTable();
  }
}

function writeTable(root: string, table: LockTable): void {
  const p = lockTablePath(root);
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(table, null, 1)}\n`, "utf8");
    renameSync(tmp, p);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** 进程还在不在（判活用）。Windows 上 `process.kill(pid, 0)` 对已退出的进程会抛。 */
export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function expired(entry: LockEntry, now: number): boolean {
  const beat = Date.parse(entry.beat);
  if (!Number.isFinite(beat)) return true;
  const ttl = Number.isFinite(entry.ttl) && entry.ttl > 0 ? entry.ttl : DEFAULT_TTL;
  return now - beat > ttl * 1000;
}

/**
 * 冲突判定。
 *
 * 读与读永远不冲突（默认模式下读根本不进表）；写与任何模式冲突；
 * 同一持有者不算冲突（重入）。
 */
function conflicts(entry: LockEntry | undefined, mode: LockMode, holder: string): boolean {
  if (!entry) return false;
  if (entry.holder === holder) return false;
  if (mode === "write") return true;
  return entry.mode === "write";
}

/** 申请锁（不等待）。 */
export function acquire(root: string, path: string, mode: LockMode, holder: string, opts: AcquireOpts): AcquireResult {
  /* 默认模式下读不进锁表，并发读不承担锁表改写开销。 */
  if (mode === "read" && !opts.strictRead) {
    return { ok: true, mode, path };
  }
  const key = lockKey(path);
  return withTableLock(root, () => {
    const table = readTable(root);
    const now = Date.now();
    for (const [k, e] of Object.entries(table.locks)) {
      if (expired(e, now) && !pidAlive(e.pid)) delete table.locks[k];
    }
    table.queue = table.queue.filter((w) => {
      const e = table.locks[lockKey(w.path)];
      /* 排队者自己已经拿到锁、或者持有者已经换了，就不该还挂在队里。 */
      return !(e && e.holder === w.holder);
    });

    const cur = table.locks[key];
    const mine = cur && cur.holder === holder;

    if (!conflicts(cur, mode, holder)) {
      if (mine && cur) {
        cur.depth += 1;
        cur.beat = new Date(now).toISOString();
      } else {
        table.locks[key] = {
          mode,
          holder,
          pid: Number(opts.pid) > 0 ? Number(opts.pid) : process.pid,
          path: resolve(path),
          since: new Date(now).toISOString(),
          beat: new Date(now).toISOString(),
          ttl: opts.ttlSec,
          depth: 1,
          ...(opts.transient ? { transient: true } : {}),
        };
      }
      table.queue = table.queue.filter((w) => !(lockKey(w.path) === key && w.holder === holder));
      writeTable(root, table);
      return { ok: true, mode, path };
    }

    /*
     * 冲突：排队。写优先体现在“新读者不能越过已经在等的写者”，
     * 否则一直有读者进来，写者永远排不到。
     */
    const aheadList = table.queue.filter((w) => lockKey(w.path) === key && w.holder !== holder);
    const aheadWriters = aheadList.filter((w) => w.mode === "write").length;
    const ahead = aheadList.length;
    if (!table.queue.some((w) => lockKey(w.path) === key && w.holder === holder && w.mode === mode)) {
      table.queue.push({ path: resolve(path), mode, holder, at: new Date(now).toISOString() });
      /* 队里只留最近的 40 条，防止异常情况下无限长。 */
      if (table.queue.length > 40) table.queue = table.queue.slice(-40);
      writeTable(root, table);
    }

    const since = cur?.since ?? "";
    const beat = cur ? Date.parse(cur.beat) : now;
    const ttl = cur && cur.ttl > 0 ? cur.ttl : DEFAULT_TTL;
    const ageLeftMs = Math.max(0, beat + ttl * 1000 - now);

    return {
      ok: false,
      mode,
      path,
      holder: cur?.holder ?? "",
      holderSince: since,
      /* 建议等待：持有者剩余寿命的一半，封顶 5 秒；前面还有写者就再多等一轮。 */
      waitMs: Math.min(5000, Math.max(500, Math.round(ageLeftMs / 2))) + (mode === "read" ? aheadWriters * 500 : 0),
      ahead,
      reason: cur
        ? `${cur.holder} 正持有${cur.mode === "write" ? "写锁" : "读锁"}（自 ${since}）`
        : "排队中",
    };
  });
}

/**
 * 申请并在超时内轮询等待。
 *
 * 这是“别的 worker 要写需要等”的真正落点：hook 侧调它，等到就给过，等不到就拒。
 * 轮询间隔从 120ms 起、每次 +80ms 退避，最多等到 `waitMs`。
 */
export function acquireWithWait(
  root: string,
  path: string,
  mode: LockMode,
  holder: string,
  opts: AcquireOpts & { waitMs: number },
): AcquireResult {
  const deadline = Date.now() + Math.max(0, opts.waitMs);
  let last = acquire(root, path, mode, holder, opts);
  if (last.ok) return last;
  let gap = 120;
  while (Date.now() < deadline) {
    sleepSync(Math.min(gap, Math.max(0, deadline - Date.now())));
    gap = Math.min(400, gap + 80);
    last = acquire(root, path, mode, holder, opts);
    if (last.ok) return last;
  }
  /* 等不到了：把自己从队列里撤掉，否则后来者会以为还有人在排。 */
  dropWaiter(root, path, holder, mode);
  return last;
}

function dropWaiter(root: string, path: string, holder: string, mode: LockMode): void {
  const key = lockKey(path);
  withTableLock(root, () => {
    const table = readTable(root);
    const before = table.queue.length;
    table.queue = table.queue.filter((w) => !(lockKey(w.path) === key && w.holder === holder && w.mode === mode));
    if (table.queue.length !== before) writeTable(root, table);
  });
}

/** 释放某个持有者的 transient 锁（“写完即放”的落地方式）。 */
export function releaseTransient(root: string, holder: string): number {
  return withTableLock(root, () => {
    const table = readTable(root);
    let n = 0;
    for (const [k, e] of Object.entries(table.locks)) {
      if (e.holder === holder && e.transient) {
        delete table.locks[k];
        n += 1;
      }
    }
    if (n > 0) {
      const freed = new Set(Object.keys(table.locks));
      table.queue = table.queue.filter((w) => !freed.has(lockKey(w.path)));
      writeTable(root, table);
    }
    return n;
  });
}

/** 释放一层重入计数，减到 0 时删除锁文件。 */
export function release(root: string, path: string, holder: string): boolean {
  const key = lockKey(path);
  return withTableLock(root, () => {
    const table = readTable(root);
    const entry = table.locks[key];
    if (!entry || entry.holder !== holder) return false;
    entry.depth -= 1;
    if (entry.depth > 0) {
      entry.beat = new Date().toISOString();
      writeTable(root, table);
      return false;
    }
    delete table.locks[key];
    table.queue = table.queue.filter((w) => lockKey(w.path) !== key);
    writeTable(root, table);
    return true;
  });
}

/**
 * 强制解锁（不看持有者）。
 *
 * 只在人明确要求时用：`capitalist lock release <path> --force`。典型场景是持有者进程还活着
 * 但已经卡死，而它占的文件别人急着改，这时候等 ttl 到期太慢。
 */
export function forceRelease(root: string, path: string): boolean {
  const key = lockKey(path);
  return withTableLock(root, () => {
    const table = readTable(root);
    if (!table.locks[key]) return false;
    delete table.locks[key];
    table.queue = table.queue.filter((w) => lockKey(w.path) !== key);
    writeTable(root, table);
    return true;
  });
}

/** 释放某个持有者的全部锁（worker 结单 / 判死时用）。 */
export function releaseAll(root: string, holder: string): number {
  return withTableLock(root, () => {
    const table = readTable(root);
    let n = 0;
    for (const [k, e] of Object.entries(table.locks)) {
      if (e.holder === holder) {
        delete table.locks[k];
        n += 1;
      }
    }
    const before = table.queue.length;
    table.queue = table.queue.filter((w) => w.holder !== holder);
    if (n > 0 || table.queue.length !== before) writeTable(root, table);
    return n;
  });
}

/**
 * 回收：持有者进程已死、或心跳超过 ttl。
 *
 * 两个条件都满足才回收。仅超时一项不判死：visible 模式的工作进程不写心跳
 * （见 `WorkerRecord.mode`），单凭超时会回收仍在执行的进程。
 */
export function reap(root: string): { reclaimed: { path: string; holder: string; why: string }[] } {
  return withTableLock(root, () => {
    const table = readTable(root);
    const now = Date.now();
    const out: { path: string; holder: string; why: string }[] = [];
    for (const [k, e] of Object.entries(table.locks)) {
      if (!expired(e, now)) continue;
      if (pidAlive(e.pid)) continue;
      out.push({ path: e.path, holder: e.holder, why: `心跳超时且进程 ${e.pid} 已不在` });
      delete table.locks[k];
    }
    if (out.length > 0) {
      const freed = new Set(out.map((x) => lockKey(x.path)));
      table.queue = table.queue.filter((w) => !freed.has(lockKey(w.path)));
      writeTable(root, table);
    }
    return { reclaimed: out };
  });
}

/** 锁表快照（面板 / `capitalist lock status`）。 */
export function lockStatus(root: string, only?: string): { locks: LockEntry[]; queue: LockWaiter[] } {
  const table = readTable(root);
  const all = Object.values(table.locks);
  const locks = only ? all.filter((e) => lockKey(e.path) === lockKey(only)) : all;
  return { locks, queue: table.queue };
}

/** 某路径当前有没有别人持有写锁（调度亲和用）。 */
export function writeHolderOf(root: string, path: string): LockEntry | null {
  const table = readTable(root);
  const e = table.locks[lockKey(path)];
  return e && e.mode === "write" ? e : null;
}


export interface ReadMark {
  path: string;
  holder: string;
  mtime: number;
  size: number;
  sha: string;
  at: string;
}

function shaOf(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex").slice(0, 12);
}

/** 登记“谁在什么版本上读过这个文件”。 */
export function noteRead(root: string, holder: string, path: string): void {
  try {
    const abs = resolve(path);
    const st = statSync(abs);
    const buf = readFileSync(abs);
    const mark: ReadMark = {
      path: abs,
      holder,
      mtime: st.mtimeMs,
      size: st.size,
      sha: shaOf(buf),
      at: new Date().toISOString(),
    };
    const p = readLedgerPath(root);
    mkdirSync(dirname(p), { recursive: true });
    const fd = openSync(p, "a");
    try {
      writeSync(fd, `${JSON.stringify(mark)}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* 文件不存在 / 无权限：不登记，写的时候也就不会因为“没读过”被拦 */
  }
}

/** 取某持有者对某文件最近一次读到的版本。 */
export function lastRead(root: string, holder: string, path: string): ReadMark | null {
  const p = readLedgerPath(root);
  if (!existsSync(p)) return null;
  const key = lockKey(path);
  try {
    const lines = readFileSync(p, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      const m = JSON.parse(line) as ReadMark;
      if (m.holder === holder && lockKey(m.path) === key) return m;
    }
  } catch {
    /* 台账坏了就当没读过 */
  }
  return null;
}

export interface StaleResult {
  stale: boolean;
  why?: string;
  /** 谁的改动：能从台账里认出最近写过的人就填上。 */
  by?: string;
}

/** 写之前校验：我读到的版本还是不是现在这个。 */
export function checkStale(root: string, holder: string, path: string): StaleResult {
  const mark = lastRead(root, holder, path);
  if (!mark) return { stale: false };
  try {
    const abs = resolve(path);
    const st = statSync(abs);
    if (st.mtimeMs === mark.mtime && st.size === mark.size) return { stale: false };
    const now = shaOf(readFileSync(abs));
    if (now === mark.sha) return { stale: false };
    const other = recentWriter(root, path, holder);
    return {
      stale: true,
      why: `已读取 ${mark.at} 的版本，之后文件被改过（mtime ${new Date(mark.mtime).toLocaleTimeString("zh-CN", { hour12: false })} -> ${new Date(st.mtimeMs).toLocaleTimeString("zh-CN", { hour12: false })}）`,
      ...(other ? { by: other } : {}),
    };
  } catch {
    /* 文件已删除时由调用方按新建处理，此处不判 stale */
    return { stale: false };
  }
}

/** 从事件台账里找最近写过这个文件的别人（给拒绝理由用，认不出就空）。 */
function recentWriter(root: string, path: string, holder: string): string {
  const key = lockKey(path);
  try {
    const p = join(root, ".capitalist", "events.jsonl");
    if (!existsSync(p)) return "";
    const lines = readFileSync(p, "utf8").split("\n");
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 400); i -= 1) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      const e = JSON.parse(line) as Record<string, unknown>;
      const w = String(e.worker ?? "");
      const fp = String((e.file as string) ?? "");
      if (w && w !== holder && fp && lockKey(fp) === key && /write/i.test(String(e.tool ?? ""))) return w;
    }
  } catch {
    /* ignore */
  }
  return "";
}
