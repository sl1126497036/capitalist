
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadWorker, workerLogPath } from "../core/supervisor";

/** 连续多少次检测不到监工才判定为孤儿。 */
export const MISS_LIMIT = 2;

/** 漏检记账文件的扩展名，落在 `.capitalist/workers/` 里，与 worker 记录同目录。 */
const GUARD_SUFFIX = ".guard.json";

/**
 * pid 是否还活着。
 *
 * 与 `core/supervisor.pidAlive` 的差别只在 `EPERM`：那表示进程在、只是没权限发信号
 * （Linux 上跨用户、Windows 上受保护进程）。对自检来说「在」就是「别自杀」。
 */
export function supervisorPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function workerEnv(): { root: string; id: string } | null {
  const root = process.env.CAPITALIST_ROOT ?? "";
  const id = process.env.CAPITALIST_WORKER_ID ?? "";
  return root && id ? { root, id } : null;
}

/**
 * 漏检记账文件路径。
 *
 * 计数必须跨 hook 进程保留：每次 hook 都是新的短命进程，内存计数永远是 1，永远不会
 * 触发。worker 环境齐全时记在 `.capitalist/workers/<id>.guard.json`（同目录，随任务根一起清）；
 * 环境不全时退到系统临时目录，按监工 pid 命名，使同一监工下的钩子共用一份计数。
 */
function guardStatePath(supervisorPid: number): string {
  const w = workerEnv();
  if (w) return join(w.root, ".capitalist", "workers", `${w.id}${GUARD_SUFFIX}`);
  return join(tmpdir(), `capitalist-guard-${supervisorPid}.json`);
}

/** 读已累计的漏检次数；文件缺失或损坏都按 0 处理。 */
function readMisses(file: string): number {
  try {
    if (!existsSync(file)) return 0;
    const raw = JSON.parse(readFileSync(file, "utf8")) as { misses?: unknown };
    const n = Number(raw?.misses);
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** worker 自己的日志文件；环境不全时返回 null（不猜路径）。 */
function ownLogPath(): string | null {
  const w = workerEnv();
  if (!w) return null;
  try {
    return workerLogPath(w.root, w.id);
  } catch {
    return null;
  }
}

/** 结束 worker 自己。 */
function exitWorker(supervisorPid: number): never {
  const w = workerEnv();
  const rec = w ? loadWorker(w.root, w.id) : null;
  const target = rec?.pid ?? 0;

  if (
    rec &&
    (rec.status === "running" || rec.status === "starting") &&
    target > 0 &&
    target !== process.pid &&
    target !== supervisorPid &&
    supervisorPidAlive(target)
  ) {
    try {
      process.kill(target, "SIGTERM");
    } catch {
    }
  }
  process.exit(1);
}

/**
 * hook 入口每次被调用时执行一次。
 *
 * 没有 `CAPITALIST_SUPERVISOR_PID`（不是监工拉起的 worker）时直接返回，一次系统调用都不做。
 * 本函数不抛：hook 抛异常在多数宿主体内表现为 hook 失败，会把正常会话拦下来。
 */
export function guardSupervisor(): void {
  const raw = process.env.CAPITALIST_SUPERVISOR_PID;
  if (!raw) return;
  const supervisorPid = Number(raw);
  if (!Number.isInteger(supervisorPid) || supervisorPid <= 0) return;

  const state = guardStatePath(supervisorPid);

  if (supervisorPidAlive(supervisorPid)) {
    // 监工回来了（重启或换实例）：清零，下一次从 0 数。
    if (existsSync(state)) {
      try {
        unlinkSync(state);
      } catch {
        /* 清不掉不影响放行 */
      }
    }
    return;
  }

  const misses = readMisses(state) + 1;
  try {
    writeFileSync(
      state,
      JSON.stringify({ misses, supervisor_pid: supervisorPid, at: new Date().toISOString() }),
    );
  } catch {
    /* 记账失败：仍然放行，下一次大概率能写成功；不在读不到账时误杀会话 */
  }

  if (misses < MISS_LIMIT) return;

  const log = ownLogPath();
  if (log) {
    try {
      appendFileSync(
        log,
        `[capitalist-guard] ${new Date().toISOString()} 监工 pid ${supervisorPid} 连续 ${misses} 次检测不到，` +
          "判定父进程已被强杀，worker 自行退出\n",
      );
    } catch {
      /* 日志写不进去也要退出，否则孤儿照样挂着 */
    }
  }
  exitWorker(supervisorPid);
}
