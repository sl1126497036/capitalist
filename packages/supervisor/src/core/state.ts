/**
 * 任务根状态。
 *
 * 只存事实：当前阶段、下一步动作、契约指针、档位。理由与对话历史不入状态，
 * 它们无法校验，且长度无上限。
 */

import { join } from "node:path";

import type { Contract } from "./contract";
import { readJson, writeJson } from "./json";
import { resolveMode } from "./permission";
import { supervisorDir } from "./paths";
import { loadSupervisor, pidAlive, supervisorStaleSec } from "./supervisor";
import type { Mode, TaskState } from "./types";

/** 返回任务根下 `state.json` 的路径。 */
export function statePath(root: string): string {
  return join(supervisorDir(root), "state.json");
}

/**
 * 读任务根状态。
 *
 * @returns 状态；文件缺失、内容损坏或缺 `contract` 字段时返回 null，调用方需自行判空。
 */
export function loadState(root: string): TaskState | null {
  const st = readJson<TaskState | null>(statePath(root), null);
  return st && typeof st === "object" && st.contract ? st : null;
}

/**
 * 写回状态：先递增 `rev` 再落盘 `state.json`。
 *
 * @throws 落盘失败时抛出（目录不可写、磁盘满等），调用方需自行处理。
 */
export function saveState(root: string, state: TaskState): void {
  state.rev = Number(state.rev ?? 0) + 1;
  state.updated_at = new Date().toISOString();
  writeJson(statePath(root), state);
}

/**
 * 带冲突检测的状态更新。
 *
 * 场景：hook 每个工具调用起一个进程，CLI 与它并行改同一份 state。无条件覆盖时，
 * 后写的进程会把先写的字段整块抹掉，文件仍是合法 JSON，丢掉的更新不留痕迹，
 * 表现为「刚才明明切了只读档，怎么又回去了」。
 *
 * 做法是乐观并发：读到 rev=n 就记下，写回前再读一次；磁盘上不是 n 说明中间有人写过，
 * 重读再改。重试三次仍冲突就放弃并返回 null，写不进去好过写错。
 *
 * 不用文件锁：hook 在用户操作的必经路径上，等锁的代价比偶发丢一次更新大。
 *
 * @param retries 冲突重试次数，默认 3。
 * @returns fn 的返回值；任务根不存在或连续冲突则为 null
 */
export function updateState<T>(root: string, fn: (state: TaskState) => T, retries = 3): T | null {
  for (let i = 0; i < retries; i += 1) {
    const st = loadState(root);
    if (!st) return null;

    const seen = Number(st.rev ?? 0);
    const out = fn(st);

    const disk = loadState(root);
    if (disk && Number(disk.rev ?? 0) !== seen) continue;

    saveState(root, st);
    return out;
  }
  return null;
}

/**
 * 解析当前生效档位。
 *
 * 优先级：命令行 > 环境变量 > 会话状态 > 契约默认 > 内置默认。
 * 会话状态放在契约之前：一次会话的显式选择比领域惯例更具体。
 */
export function resolveModeFor(
  root: string | null,
  contract: Contract | null,
  cliMode?: string,
): Mode {
  const state = root ? loadState(root) : null;
  return resolveMode({
    cli: cliMode,
    env: process.env.CAPITALIST_MODE,
    session: state?.permission_mode,
    contract: contract?.data.permission,
  });
}

/** 当前阶段；状态缺失时回落到契约首段，避免调用方到处判空。 */
export function currentStageId(state: TaskState | null, contract: Contract | null): string {
  if (state?.stage) return state.stage;
  return contract?.stages[0]?.id ?? "S0";
}

/** 监工显示三态。 */
export type SupervisorDisplay = "online" | "timeout" | "stopped";

/** 监工显示信息。 */
export interface SupervisorDisplayInfo {
  state: SupervisorDisplay;
  pid: number;
  /** 人读的原因，直接进 `capitalist status` / `capitalist workers` 的输出 */
  detail: string;
  /** 距上次心跳的秒数；无记录时为 -1 */
  heartbeat_age_sec: number;
}

/**
 * 判定监工的显示状态。
 *
 * @returns 显示状态与依据。无监工记录时 `state` 为 `stopped`、`pid` 为 0、
 *   `heartbeat_age_sec` 为 -1。
 */
export function supervisorDisplayState(root: string): SupervisorDisplayInfo {
  const rec = loadSupervisor(root);
  if (!rec) {
    return { state: "stopped", pid: 0, detail: "无监工记录（从未启动或已被归档）", heartbeat_age_sec: -1 };
  }

  const now = Date.now() / 1000;
  const age = Math.max(0, Math.round(now - rec.heartbeat_ts));

  if (rec.status !== "running") {
    return {
      state: "stopped",
      pid: rec.pid,
      detail: `status=${rec.status}${rec.note ? `（${rec.note}）` : ""}`,
      heartbeat_age_sec: age,
    };
  }

  if (!pidAlive(rec.pid)) {
    return {
      state: "stopped",
      pid: rec.pid,
      detail: `进程已消失（pid ${rec.pid}），心跳 ${age}s 未更新`,
      heartbeat_age_sec: age,
    };
  }

  if (age <= supervisorStaleSec(rec)) {
    return { state: "online", pid: rec.pid, detail: `心跳 ${age}s 前更新`, heartbeat_age_sec: age };
  }

  // 运行中、进程仍在、但心跳已超时：归为「心跳超时」而非「已停」。进程还在，按已停处理会
  // 让使用者以为可以安全重启。
  return {
    state: "timeout",
    pid: rec.pid,
    detail: `进程还在（pid ${rec.pid}）但心跳已 ${age}s 未更新——可能卡死或失联`,
    heartbeat_age_sec: age,
  };
}

/** 三态的中文标签，集中一处避免各处各写一套。 */
export const SUPERVISOR_STATE_LABEL: Record<SupervisorDisplay, string> = {
  online: "在线",
  timeout: "心跳超时",
  stopped: "已停",
};
