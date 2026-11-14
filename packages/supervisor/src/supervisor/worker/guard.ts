/**
 * 监工被强杀后结束其拉起的工作进程。硬杀不执行信号处理器，进程内定时器同时消失，故需独立进程监视监工 pid。
 * `taskkill /F` 不写状态文件，pid 消失是唯一判据。
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { supervisorDir } from "../../core/record/paths";
import { pidAlive } from "../../core/record/supervisor";
import { reapOrphans } from "./reapOrphans";

/** 落在 `.capitalist/guard.json` 的记录，保证同一任务根只有一个监视进程。 */
export interface GuardRecord {
  pid: number;
  /** 被监视的监工 pid；监工重启后随之更新。 */
  supervisor_pid: number;
  root: string;
  started_at: string;
}

/** 轮询间隔 2 秒；连续两次检测不到监工才动作，硬杀后最多 4 秒完成回收。 */
const TICK_MS = 2000;

/** 连续检测不到监工的次数阈值；单次未命中可能只是 pid 尚未释放，延迟判定避免误判。 */
const MISS_LIMIT = 2;

export function guardPath(root: string): string {
  return join(supervisorDir(root), "guard.json");
}

/** 监视进程单独写 `guard.log`，不依赖监工的 `supervisor.log`。 */
function guardLog(root: string): string {
  return join(supervisorDir(root), "guard.log");
}

export function readGuard(root: string): GuardRecord | null {
  try {
    const p = guardPath(root);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<GuardRecord>;
    const pid = Number(raw?.pid);
    const supervisorPid = Number(raw?.supervisor_pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      supervisor_pid: Number.isInteger(supervisorPid) ? supervisorPid : 0,
      root: String(raw?.root ?? root),
      started_at: String(raw?.started_at ?? ""),
    };
  } catch {
    return null;
  }
}

function writeGuard(root: string, rec: GuardRecord): void {
  try {
    writeFileSync(guardPath(root), JSON.stringify(rec, null, 2), "utf8");
  } catch {
    /* 写入失败只会导致下次重复启动，不影响回收。 */
  }
}

function clearGuard(root: string, pid: number): void {
  const cur = readGuard(root);
  if (cur && cur.pid !== pid) return; // 记录属于新实例，不删除
  try {
    unlinkSync(guardPath(root));
  } catch {
    /* 已经不在 */
  }
}

/**
 * 幂等启动监视进程。已有实例监视本进程时不处理；监视其它监工时先结束再启动，避免同一任务根出现两个实例。
 * `process.argv[1]` 为空时返回 0，调用方据此记录启动失败。
 */
export function ensureGuard(root: string): { pid: number; spawned: boolean } {
  const cur = readGuard(root);

  if (cur && cur.supervisor_pid === process.pid && pidAlive(cur.pid)) {
    return { pid: cur.pid, spawned: false };
  }
  if (cur && pidAlive(cur.pid)) {
    try {
      process.kill(cur.pid, "SIGTERM");
    } catch {
      /* 刚好退了 */
    }
  }

  const entry = process.argv[1];
  if (!entry) return { pid: 0, spawned: false };

  let pid = 0;
  try {
    const child = spawn(process.execPath, [entry, "guard", root, String(process.pid)], {
      cwd: root,
      // 脱离监工会话，监工被强杀时该进程仍存活。
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    pid = child.pid ?? 0;
  } catch {
    return { pid: 0, spawned: false };
  }

  if (pid > 0) {
    writeGuard(root, {
      pid,
      supervisor_pid: process.pid,
      root,
      started_at: new Date().toISOString(),
    });
  }
  return { pid, spawned: pid > 0 };
}

/**
 * 监工正常退出时结束监视进程。此时工作进程已由 `terminateWorkers` 结束，先撤掉监视进程可避免其延迟触发重复回收。
 * 仅结束 `supervisor_pid` 为本进程的实例；pid 不匹配说明已由新一轮监工启动。
 */
export function stopGuard(root: string, supervisorPid: number): void {
  const cur = readGuard(root);
  if (!cur) return;
  if (cur.supervisor_pid !== supervisorPid) return;
  if (pidAlive(cur.pid)) {
    try {
      process.kill(cur.pid, "SIGTERM");
    } catch {
      /* 刚好退了 */
    }
  }
  clearGuard(root, cur.pid);
}

/**
 * 监视进程主体，常驻至监工消失并完成回收，或收到 SIGTERM。
 * 不改工作进程的 `visible` 模式，也不处理 pid 不匹配的记录；判定在 `reapOrphans`，本模块只决定时机。
 */
export function runGuard(root: string, supervisorPid: number): void {
  const logFile = guardLog(root);
  const log = (s: string): void => {
    try {
      appendFileSync(logFile, s.endsWith("\n") ? s : `${s}\n`);
    } catch {
      /* 日志写入失败不中断监视。 */
    }
  };

  let miss = 0;
  let done = false;

  const stop = (): void => {
    if (done) return;
    done = true;
    clearInterval(timer);
    clearGuard(root, process.pid);
  };

  /* 监工正常退出时自行回收工作进程；此处收到 SIGTERM 直接退出，避免重复。 */
  process.once("SIGTERM", () => {
    stop();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    stop();
    process.exit(0);
  });

  const timer = setInterval(() => {
    /*
     * 任务根被删就静默退出。
     *
     * 继续写日志会把目录重新建出来，用户删了又冒出来，会以为进程没停。
     */
    if (!existsSync(supervisorDir(root))) {
      stop();
      process.exit(0);
    }
    if (pidAlive(supervisorPid)) {
      miss = 0;
      return;
    }
    miss += 1;
    if (miss < MISS_LIMIT) return;

    done = true;
    clearInterval(timer);
    log(`[guard] ${new Date().toISOString()} 监工 pid ${supervisorPid} 连续 ${miss} 次不在，开始收它拉起的进程`);

    try {
      const reaped = reapOrphans(root, log, { onlySupervisorPid: supervisorPid });
      log(
        reaped.length > 0
          ? `[guard] 已收掉 ${reaped.length} 个 worker：${reaped.map((r) => r.id).join("、")}`
          : "[guard] 没有需要收的 worker",
      );
    } catch (err) {
      log(`[guard] 收进程失败：${err instanceof Error ? err.message : String(err)}`);
    }

    clearGuard(root, process.pid);
    process.exit(0);
  }, TICK_MS);
}
