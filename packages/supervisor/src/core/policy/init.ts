/**
 * 任务根创建，供 CLI 与自动纳管共用。
 *
 * 未指定领域守卫时回落到 `minimal`，并在状态里记 `policy_fallback`。
 * 调用方需要把该字段展示出来：跑的是通用红线而没有领域判据是一种合法状态，
 * 但必须显式可见，不能被当成“已有领域判据”。
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { type Policy, policyNames, loadPolicy } from "./policy";
import { supervisorDir } from "../record/paths";
import { saveState, statePath } from "../record/state";
import type { TaskState } from "../types";

/** 创建任务根的入参。 */
export interface CreateRootOptions {
  target: string;
  /** 守卫名、文件路径，或省略以使用通用回落守卫。 */
  policySpec?: string | undefined;
  root: string;
  /** 额外的守卫搜索目录（宿主 `skills/`）；由调用方解析，不在此处查找。 */
  policyDirs?: readonly string[];
}

/** 创建任务根的结果。`fallback` 为真表示用的是通用回落守卫。 */
export interface CreateRootResult {
  root: string;
  policy: Policy;
  fallback: boolean;
}

/** 任务根已存在。 */
export class RootExistsError extends Error {
  constructor(readonly root: string) {
    super(`already supervised: ${root}`);
  }
}

/** 守卫不存在。`available` 列出可选的守卫名。 */
export class PolicyNotFoundError extends Error {
  constructor(
    readonly spec: string,
    readonly available: string[],
  ) {
    super(`policy not found: ${spec}`);
  }
}

/**
 * 构造任务根的初始状态。
 *
 * CLI 与自动纳管共用这一份构造逻辑，避免两处各自构造时新增字段被另一处漏写。
 */
export function newState(target: string, policy: Policy, fallback: boolean): TaskState {
  const now = new Date().toISOString();
  return {
    version: 2,
    target,
    policy: policy.name,
    policy_path: policy.file,
    policy_fallback: fallback,
    next_action: "",
    blockers: [],
    created_at: now,
    updated_at: now,
  };
}

/**
 * 创建任务根：解析守卫、写 `state.json` 与 `inbox/` 目录。
 *
 * @throws 守卫无法解析时抛 `PolicyNotFoundError`；已存在 `state.json` 时抛 `RootExistsError`。
 */
export function createTaskRoot(opts: CreateRootOptions): CreateRootResult {
  const fallback = !opts.policySpec;
  const spec = opts.policySpec ?? "minimal";
  const policy = loadPolicy(spec, opts.policyDirs ?? []);
  if (!policy) throw new PolicyNotFoundError(spec, policyNames(opts.policyDirs ?? []));

  if (existsSync(statePath(opts.root))) throw new RootExistsError(opts.root);

  const state = newState(opts.target, policy, fallback);

  mkdirSync(join(supervisorDir(opts.root), "inbox"), { recursive: true });
  saveState(opts.root, state);

  return { root: opts.root, policy, fallback };
}
