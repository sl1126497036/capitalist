/**
 * 任务根创建，供 CLI 与自动纳管共用。
 *
 * 未指定领域契约时回落到 `minimal`，并在状态里记 `contract_fallback`。
 * 调用方需要把该字段展示出来：跑的是通用红线而没有领域判据是一种合法状态，
 * 但必须显式可见，不能被当成“已有领域判据”。
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { type Contract, contractNames, loadContract } from "./contract";
import { supervisorDir } from "./paths";
import { saveState, statePath } from "./state";
import type { Stage, TaskState } from "./types";

/** 创建任务根的入参。 */
export interface CreateRootOptions {
  target: string;
  /** 契约名、文件路径，或省略以使用通用回落契约。 */
  contractSpec?: string | undefined;
  root: string;
  /** 额外的契约搜索目录（宿主 `skills/`）；由调用方解析，不在此处查找。 */
  contractDirs?: readonly string[];
}

/** 创建任务根的结果。`fallback` 为真表示用的是通用回落契约。 */
export interface CreateRootResult {
  root: string;
  contract: Contract;
  fallback: boolean;
}

/** 任务根已存在。 */
export class RootExistsError extends Error {
  constructor(readonly root: string) {
    super(`already supervised: ${root}`);
  }
}

/** 契约不存在。`available` 列出可选的契约名。 */
export class ContractNotFoundError extends Error {
  constructor(
    readonly spec: string,
    readonly available: string[],
  ) {
    super(`contract not found: ${spec}`);
  }
}

/**
 * 构造任务根的初始状态。
 *
 * CLI 与自动纳管共用这一份构造逻辑：两处各自构造时，给一处新增的字段会被另一处漏写，
 * 而漏写不报错（`stage_entered_at_ts` 就被读过、被比对过，却从未写入）。
 *
 * `stage_entered_at_ts` 为 epoch 秒，与归档的 Python 实现一致，也是
 * `mtime_after_stage` 的比对基准。
 *
 * @throws 契约没有定义任何阶段时抛出：监工无法确定起点。
 */
export function newState(target: string, contract: Contract, fallback: boolean): TaskState {
  const stage = contract.stages[0];
  if (!stage) {
    throw new Error(
      `任务列表 ${contract.name}（${contract.file}）没有定义任何阶段：监工无法确定起点。` +
        "请在任务列表里补 stages，或改用 capitalist start --contract minimal 先跑通用流程。",
    );
  }

  const now = new Date().toISOString();
  return {
    version: 2,
    target,
    contract: contract.name,
    contract_path: contract.file,
    contract_fallback: fallback,
    stage: stage.id,
    stage_entered_at: now,
    stage_entered_at_ts: Date.now() / 1000,
    next_action: stage.next ?? "",
    blockers: [],
    counters: { rounds_in_stage: 0 },
    created_at: now,
    updated_at: now,
  };
}

/**
 * 切换阶段：阶段、进入时间、下一步与新阶段的轮次计数一起重置，避免只改一半。
 *
 * 只改传入的 `state` 对象，不落盘；调用方负责写回。
 */
export function enterStage(state: TaskState, stage: Stage): void {
  state.stage = stage.id;
  state.stage_entered_at = new Date().toISOString();
  state.stage_entered_at_ts = Date.now() / 1000;
  state.next_action = stage.next ?? "";
  state.counters = { rounds_in_stage: 0 };
}

/**
 * 创建任务根：解析契约、写 `state.json` 与 `inbox/` 目录。
 *
 * @throws 契约无法解析时抛 `ContractNotFoundError`；已存在 `state.json` 时抛
 *   `RootExistsError`；契约没有定义阶段时抛 `Error`。
 */
export function createTaskRoot(opts: CreateRootOptions): CreateRootResult {
  const fallback = !opts.contractSpec;
  const spec = opts.contractSpec ?? "generic";
  const contract = loadContract(spec, opts.contractDirs ?? []);
  if (!contract) throw new ContractNotFoundError(spec, contractNames(opts.contractDirs ?? []));

  if (existsSync(statePath(opts.root))) throw new RootExistsError(opts.root);

  const state = newState(opts.target, contract, fallback);

  mkdirSync(join(supervisorDir(opts.root), "inbox"), { recursive: true });
  saveState(opts.root, state);

  return { root: opts.root, contract, fallback };
}
