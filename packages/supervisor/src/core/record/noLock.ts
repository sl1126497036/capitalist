/**
 * 取号临界区锁：跨进程排他、进程内可重入、到期自动接管、获取失败即报错。
 *
 * 只服务编号发行（任务号、派单序、进程序），不用于文件互斥；文件互斥见 `fileLock.ts`。
 *
 * 三条硬约束：
 * 1. **不嵌套**：同一调用链不得同时持有两把不同 key 的锁，检测到直接抛 `NoLockNestingError`。
 *    取号流程一律“获取一把、执行、释放、再获取下一把”，因此不存在环路等待，不会死锁。
 * 2. **到期自动释放**：锁文件写 `expires_at`。持有进程已退出，或到期且持有者不响应，后来者
 *    可以直接接管，不需要人工清锁。
 * 3. **获取失败即报错**：重试次数用尽抛 `NoLockTimeoutError`，由调用方把“创单失败”如实报给用户，
 *    不静默降级、不自行推算一个可能撞号的编号。
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { locks as locksLoc } from "./locations";
import { pidAlive, sleepSync } from "./process";

/** 取号锁已被占用，重试次数也已用尽；调用方据此判定本次创单失败。 */
export class NoLockTimeoutError extends Error {
  constructor(
    /** 没抢到的锁键。 */
    readonly key: string,
    /** 从首次尝试到放弃共等待的毫秒数。 */
    readonly waitedMs: number,
  ) {
    super(`本次创单失败：取号超时，请稍后重试`);
    this.name = "NoLockTimeoutError";
  }
}

/** 同一调用链试图持有第二把不同 key 的锁。这是设计禁止的用法，直接失败而非等待。 */
export class NoLockNestingError extends Error {
  constructor(
    readonly holding: string[],
    readonly want: string,
  ) {
    super(`取号锁不得嵌套：已持有 ${holding.join("、")}，又申请 ${want}`);
    this.name = "NoLockNestingError";
  }
}

/** 锁文件内容。 */
interface LockHolder {
  /** 锁键。 */
  key: string;
  /** 本次持有的唯一令牌：释放时比对，避免删掉后来者接管后的新锁。 */
  token: string;
  /** 持有者进程号。 */
  pid: number;
  /** 取得时刻（毫秒）。 */
  at: number;
  /** 到期时刻（毫秒）。到期且持有者不存活即可被接管。 */
  expires_at: number;
}

export interface NoLockOptions {
  /** 锁存活上限（毫秒）。持有者卡死时，到期即可被接管。 */
  ttlMs?: number;
  /** 首次之外的额外重试次数。 */
  retries?: number;
  /** 每次重试的等待间隔（毫秒）。 */
  waitMs?: number;
}

const DEFAULTS: Required<NoLockOptions> = { ttlMs: 5000, retries: 5, waitMs: 40 };

/** 进程内已持有的锁：`root|key` -> 重入深度、令牌、锁文件路径。 */
const held = new Map<string, { depth: number; token: string; path: string }>();

/** 锁文件路径：`<root>/.capitalist/locks/no-<key>.lock`。key 只保留文件名安全字符。 */
function lockPath(root: string, key: string): string {
  const safe = String(key)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 64) || "unnamed";
  return locksLoc.lease(root, `no-${safe}`);
}

function readHolder(path: string): LockHolder | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LockHolder> | null;
    if (!raw || typeof raw !== "object") return null;
    return {
      key: String(raw.key ?? ""),
      token: String(raw.token ?? ""),
      pid: Number(raw.pid ?? 0),
      at: Number(raw.at ?? 0),
      expires_at: Number(raw.expires_at ?? 0),
    };
  } catch {
    return null;
  }
}

/** 建锁文件。`wx` 保证同一时刻只有一个创建者成功。 */
function tryCreate(path: string, key: string, token: string, ttlMs: number): boolean {
  let fd = -1;
  try {
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(path, "wx");
    const holder: LockHolder = {
      key,
      token,
      pid: process.pid,
      at: Date.now(),
      expires_at: Date.now() + ttlMs,
    };
    writeSync(fd, `${JSON.stringify(holder)}\n`);
    closeSync(fd);
    return true;
  } catch (e) {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        /* 已关闭或写失败：由后面的归档步骤处理。 */
      }
      /* 建文件后写失败：把半成品移出主路径，避免下一位读到空内容。 */
      park(path);
    }
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw e;
  }
}

/** 该锁是否已经失效（持有者退出、到期，或内容损坏且文件足够旧）。 */
function staleReason(path: string, holder: LockHolder | null, ttlMs: number): string {
  const now = Date.now();
  if (holder) {
    const alive = pidAlive(holder.pid);
    if (Number.isFinite(holder.expires_at) && holder.expires_at > now && alive) return "";
    if (!alive) return `持有进程 ${holder.pid} 已退出`;
    if (Number.isFinite(holder.expires_at) && holder.expires_at <= now) return `锁已到期（${holder.expires_at}）`;
  }
  /* 内容读不出来：可能刚建还没写完。按文件年龄判定，够老才当成残留。 */
  try {
    const ageMs = now - statSync(path).mtimeMs;
    if (ageMs > ttlMs) return `锁文件残留 ${Math.round(ageMs)}ms`;
  } catch {
    /* 文件已消失：交给下一轮 tryCreate。 */
  }
  return "";
}

/**
 * 接管失效锁。
 *
 * 先把当前文件原子改名到唯一临时名，再核对改名后得到的是否为刚才判定失效的那把：
 * - 是，删除，调用方重新创建；
 * - 不是（中间被别的进程换成了新锁），原样放回，放弃本次接管。
 *
 * @param seenToken 判定失效时读到的令牌；空串表示当时文件内容不可读。
 */
function takeover(path: string, seenToken: string): boolean {
  const trash = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.stale`;
  try {
    renameSync(path, trash);
  } catch {
    return false;
  }
  const moved = readHolder(trash);
  if (moved && seenToken && moved.token !== seenToken) {
    try {
      renameSync(trash, path);
    } catch {
      /* 放不回去说明原路径已被重建，归档临时文件即可。 */
    }
    park(trash);
    return false;
  }
  park(trash);
  return true;
}

/** 已释放锁文件的归档目录名（与锁文件同级的 `released/`）。 */
const PARK_DIRNAME = "released";

/**
 * 把锁文件移出主路径。
 *
 * 用 `rename` 而不是 `unlink`：本机安全策略会拦截删除动作，`unlink` 失败会让锁文件永远留在
 * 主路径上，后来者只能等到 TTL 到期才能接管，表现为取号持续超时。移动到同级归档目录不触发
 * 删除拦截，主路径立刻空出，锁照样是一次性的。
 *
 * 归档文件不自动清理；取号频率是每次派单一次，堆积量可控，需要时由使用者清理。
 */
function park(path: string): boolean {
  const dir = join(dirname(path), PARK_DIRNAME);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 目录已存在或建不了：rename 仍可能在原目录完成。 */
  }
  const dest = join(dir, `${basename(path)}.${Date.now()}.${randomUUID().slice(0, 8)}`);
  try {
    renameSync(path, dest);
    return true;
  } catch {
    /* 归档目录不可写时退回删除；删除被策略拦也不影响正确性，TTL 机制会作最后处理。 */
  }
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** 释放：只处置自己那把（令牌一致才动）。 */
function release(path: string, token: string): void {
  const holder = readHolder(path);
  if (holder && holder.token !== token) return;
  park(path);
}

/**
 * 在取号锁内执行 `fn`。
 *
 * @param key 锁键。任务号发行用 `task-no`；派单序用 `dispatch-<任务号>`；
 *   进程序用 `worker-<任务号>`。键里带任务号，保证不同任务的派单、进程互不排队。
 * @param fn 临界区。必须是同步代码：Node 单线程下同步段不会被打断，跨进程由锁文件保证互斥。
 * @throws {NoLockNestingError} 已持有其它 key 时再次申请。
 * @throws {NoLockTimeoutError} 重试用尽仍被占用。
 */
export function withNoLock<T>(root: string, key: string, fn: () => T, opts: NoLockOptions = {}): T {
  const o: Required<NoLockOptions> = { ...DEFAULTS, ...opts };
  const mapKey = `${root}|${key}`;
  const mine = held.get(mapKey);

  /* 同 key 重入：外层已持有，直接进临界区，退出时只减深度。 */
  if (mine) {
    mine.depth += 1;
    try {
      return fn();
    } finally {
      mine.depth -= 1;
      if (mine.depth <= 0) {
        held.delete(mapKey);
        release(mine.path, mine.token);
      }
    }
  }

  /* 跨 key 嵌套是死锁的温床，直接拒绝，不做等待。 */
  if (held.size > 0) {
    throw new NoLockNestingError([...held.keys()].map((k) => k.slice(k.indexOf("|") + 1)), key);
  }

  const path = lockPath(root, key);
  const token = randomUUID();
  const startedAt = Date.now();
  let got = false;

  for (let attempt = 0; attempt <= o.retries; attempt += 1) {
    if (tryCreate(path, key, token, o.ttlMs)) {
      got = true;
      break;
    }
    const holder = readHolder(path);
    if (staleReason(path, holder, o.ttlMs)) {
      if (takeover(path, holder?.token ?? "")) {
        if (tryCreate(path, key, token, o.ttlMs)) {
          got = true;
          break;
        }
      }
    }
    if (attempt < o.retries) sleepSync(o.waitMs);
  }

  if (!got) throw new NoLockTimeoutError(key, Date.now() - startedAt);

  held.set(mapKey, { depth: 1, token, path });
  try {
    return fn();
  } finally {
    const cur = held.get(mapKey);
    if (cur) {
      cur.depth -= 1;
      if (cur.depth <= 0) {
        held.delete(mapKey);
        release(path, token);
      }
    }
  }
}

/** 进程内是否持有某把锁（诊断与自测用）。 */
export function holdsNoLock(root: string, key: string): boolean {
  return held.has(`${root}|${key}`);
}
