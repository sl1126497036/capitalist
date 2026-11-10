/**
 * 结束进程的共用实现：判死、监工退场、启动时回收孤儿进程三处路径共用。
 *
 * 先 SIGTERM，窗口内未退出再 SIGKILL，并确认进程已不在。
 */

import { spawnSync } from "node:child_process";

import { pidAlive } from "../core/supervisor";

/** 主线程内的阻塞等待；判死与回收走同步路径，不使用 await。 */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 轮询等待进程退出；到期仍活着返回 false。 */
export function waitExit(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!pidAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(Math.min(200, Math.max(1, deadline - Date.now())));
  }
}

/**
 * 进程已不在时返回 `gone` 且不发信号；强杀后仍无法确认退出时返回 `unconfirmed`，由调用方决定后续。
 */
export function killProcess(pid: number): "gone" | "term" | "kill" | "unconfirmed" {
  if (!Number.isInteger(pid) || pid <= 0) return "gone";
  if (!pidAlive(pid)) return "gone";
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return waitExit(pid, 500) ? "gone" : "unconfirmed";
  }
  if (waitExit(pid, 3000)) return "term";
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 进程恰在两步之间退出，按已退出处理 */
  }
  return waitExit(pid, 2000) ? "kill" : "unconfirmed";
}

/**
 * 结束进程树：Windows 的 `.cmd` shim 使台账 pid 指向 cmd.exe，仅结束该 pid 会留下宿主 CLI 与其拉起的工具进程，需按进程树处理。
 *
 * 软阶段只对 pid 发信号；超时后 Windows 用 `taskkill /T /F` 递归整棵树，POSIX 先用 `pkill -P` 结束下级进程再结束自身。
 */
export function killTree(pid: number): "gone" | "term" | "kill" | "unconfirmed" {
  if (!Number.isInteger(pid) || pid <= 0) return "gone";
  if (!pidAlive(pid)) return "gone";

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* 信号发不出去时继续强杀，与 killProcess 同口径。 */
  }
  if (waitExit(pid, 3000)) return "term";

  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, timeout: 8000 });
    } catch {
      /* `taskkill` 不可用时回落为单进程强杀。 */
    }
  } else {
    try {
      spawnSync("pkill", ["-9", "-P", String(pid)], { timeout: 5000 });
    } catch {
      /* 没有 `pkill` 时只结束自身。 */
    }
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已在两步之间退出 */
  }
  return waitExit(pid, 2000) ? "kill" : "unconfirmed";
}
