/**
 * 任务根状态。
 *
 * 只存事实：任务树进度、下一步动作、守卫指针、档位。理由与对话历史不入状态，
 * 它们无法校验，且长度无上限。
 */

import { join } from "node:path";

import type { Policy } from "../policy/policy";
import { readJson, writeJson } from "./json";
import { resolveMode } from "../guard/permission";
import { migrateRoot } from "./migrate";
import { recordEvent } from "./ledger";
import { runtime } from "./locations";
import { loadSupervisor, pidAlive, supervisorStaleSec } from "./supervisor";
import type { Mode, TaskState } from "../types";

/** 返回任务根下 `runtime/state.json` 的路径。 */
export function statePath(root: string): string {
  return runtime.state(root);
}

/** 本进程内已尝试过迁移的任务根。迁移失败（目录只读等）时不必每次读状态都重试。 */
const migrationTried = new Set<string>();

/**
 * 读任务根状态。
 *
 * 上一版把守卫名写在 `contract` 里。改名的升级路径上，磁盘上仍可能是旧结构：读到这里
 * 就把整个任务根的旧数据迁掉，再重读一次。迁移是幂等的，没有旧数据时只多做几次 stat，
 * 换来的好处是**没有"兼容读"分支长期留在每个调用方**。
 *
 * @returns 状态；文件缺失、内容损坏或缺守卫字段时返回 null，调用方需自行判空。
 */
export function loadState(root: string): TaskState | null {
  const st = readJson<TaskState | null>(statePath(root), null);
  if (!st || typeof st !== "object") return null;
  if (st.policy) return st;
  if (!(st as { contract?: unknown }).contract) return null;

  if (!migrationTried.has(root)) {
    migrationTried.add(root);
    const rep = migrateRoot(root);
    if (rep.errors.length > 0) {
      /*
       * 这里的迁移是静默的（没人传 `--check` 也没人在看启动输出），失败会在之后
       * 表现为"守卫读不到"。留一条台账，`capitalist feed` 与日志页能看到原因。
       */
      try {
        recordEvent(root, "migration_failed", { errors: rep.errors });
      } catch {
        /* 台账本身就写不进去时只能放弃：迁移失败不该让读状态变成抛异常。 */
      }
    }
  }
  const again = readJson<TaskState | null>(statePath(root), null);
  return again && typeof again === "object" && again.policy ? again : null;
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
 * 表现为已生效的设置被无声回退。
 *
 * 做法是乐观并发：读到 rev=n 就记下，写回前再读一次；磁盘上不是 n 说明中间有人写过，
 * 重读再改。重试三次仍冲突就放弃并返回 null，写入失败优于写入错误数据。
 *
 * 不用文件锁：hook 在用户操作的必经路径上，等锁的代价比偶发丢一次更新大。
 *
 * @param retries 冲突重试次数，默认 3。
 * @returns fn 的返回值；任务根不存在或连续冲突时返回 null。
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
 * 优先级：命令行 > 环境变量 > 会话状态 > 守卫默认 > 内置默认。
 * 会话状态放在守卫之前：一次会话的显式选择比领域惯例更具体。
 */
export function resolveModeFor(
  root: string | null,
  policy: Policy | null,
  cliMode?: string,
): Mode {
  const state = root ? loadState(root) : null;
  return resolveMode({
    cli: cliMode,
    env: process.env.CAPITALIST_MODE,
    session: state?.permission_mode,
    policy: policy?.data.permission,
  });
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
      detail: `进程已退出（进程号 ${rec.pid}），心跳 ${age}s 未更新`,
      heartbeat_age_sec: age,
    };
  }

  if (age <= supervisorStaleSec(rec)) {
    return { state: "online", pid: rec.pid, detail: `心跳 ${age}s 前更新`, heartbeat_age_sec: age };
  }

  // 运行中、进程仍在、但心跳已超时：归为“心跳超时”而非“已停”。进程还在，按已停处理会
  // 让使用者以为可以安全重启。
  return {
    state: "timeout",
    pid: rec.pid,
    detail: `进程仍在（进程号 ${rec.pid}），心跳 ${age}s 未更新`,
    heartbeat_age_sec: age,
  };
}

/** 三态的中文标签，集中一处避免各处各写一套。 */
export const SUPERVISOR_STATE_LABEL: Record<SupervisorDisplay, string> = {
  online: "在线",
  timeout: "心跳超时",
  stopped: "已停",
};
