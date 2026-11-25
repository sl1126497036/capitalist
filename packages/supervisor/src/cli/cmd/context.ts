/**
 * 命令共用的前置条件：任务根与状态、守卫。
 *
 * 开工前的两步集中在这里，失败信息只有一套口径。
 */

import { loadPolicy, type Policy } from "../../core/policy/policy";
import { findRoot } from "../../core/record/paths";
import { loadState, saveState } from "../../core/record/state";
import type { TaskState } from "../../core/types";
import { skillDirs } from "../../agent/locations";
import { flagString, type Parsed } from "../args";
import { die } from "../output";

/**
 * 取任务根。
 *
 * 显式 `--root` 优先，否则从当前目录向上找。找不到直接报错退出。
 */
export function rootOrDie(p: Parsed): string {
  const root = flagString(p, "root") ?? findRoot();
  if (!root) die("当前不在任何受监督任务内。开工：capitalist start <目标> --policy <守卫名>");
  return root;
}

/**
 * 读状态与守卫。
 *
 * 守卫优先按记录里的绝对路径读；路径失效时按守卫名在 skill 目录里再找一次，并把找到的
 * 新路径写回状态。
 */
export function loadOrDie(root: string): { state: TaskState; policy: Policy } {
  const state = loadState(root);
  if (!state) die(`${root} 下没有可用的 .capitalist/runtime/state.json`);

  let policy = loadPolicy(state.policy_path) ?? loadPolicy(state.policy, skillDirs());
  if (!policy) die(`守卫文件丢失：${state.policy_path}`);

  if (policy.file !== state.policy_path) {
    state.policy_path = policy.file;
    saveState(root, state);
  }
  return { state, policy };
}
