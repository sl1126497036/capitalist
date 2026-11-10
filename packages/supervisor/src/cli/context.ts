/**
 * 命令共用的前置条件：任务根与状态、契约。
 *
 * 开工前的两步集中在这里，失败信息只有一套口径。
 */

import { loadContract, type Contract } from "../core/contract";
import { findRoot } from "../core/paths";
import { loadState, saveState } from "../core/state";
import type { TaskState } from "../core/types";
import { skillDirs } from "../host/locations";
import { flagString, type Parsed } from "./args";
import { die } from "./output";

/**
 * 取任务根。
 *
 * 显式 `--root` 优先，否则从当前目录向上找。找不到直接报错退出。
 */
export function rootOrDie(p: Parsed): string {
  const root = flagString(p, "root") ?? findRoot();
  if (!root) die("当前不在任何受监督任务内。开工：capitalist start <目标> --contract <任务列表名>");
  return root;
}

/**
 * 读状态与契约。
 *
 * 契约优先按记录里的绝对路径读；路径失效时按契约名在 skill 目录里再找一次，并把找到的
 * 新路径写回状态。
 */
export function loadOrDie(root: string): { state: TaskState; contract: Contract } {
  const state = loadState(root);
  if (!state) die(`${root} 下没有可用的 .capitalist/state.json`);

  let contract = loadContract(state.contract_path) ?? loadContract(state.contract, skillDirs());
  if (!contract) die(`任务列表文件丢失：${state.contract_path}`);

  if (contract.file !== state.contract_path) {
    state.contract_path = contract.file;
    saveState(root, state);
  }
  return { state, contract };
}
