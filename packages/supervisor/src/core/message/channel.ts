/**
 * 通道状态：宿主登录态是否可用。
 *
 * ## 用途
 *
 * 工作进程因登录态失败时写 `down`，调度层据此停止派单与阶段推进。没有这个状态时，每一轮
 * 都会重新派单、重新失败，而门槛判定与阶段推进照常执行，表现为“通道不可用却在推进阶段”。
 *
 * ## 为什么带有效期
 *
 * `down` 只保留一段时间：恢复登录态后没有工作进程能成功，也就没有机会把它写回 `up`。
 * 过期后允许重试，用户修复登录态即可自动恢复，不必重启监工。重启监工时文件一并清除。
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CAPITALIST_DIR } from "../record/paths";

/** down 记录的有效期。超过后按未知处理，允许再次尝试。 */
const DOWN_TTL_MS = 5 * 60_000;

/** 通道状态文件。 */
export function channelFile(root: string): string {
  return join(root, CAPITALIST_DIR, "channel.json");
}

export interface ChannelDown {
  reason: string;
  at: string;
}

/** 当前是否处于不可用状态。过期记录按可用处理。 */
export function readChannelDown(root: string): ChannelDown | null {
  const file = channelFile(root);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (raw.ok !== false) return null;
    const at = String(raw.at ?? "");
    const ts = Date.parse(at);
    if (Number.isFinite(ts) && Date.now() - ts > DOWN_TTL_MS) return null;
    return { reason: String(raw.reason ?? ""), at };
  } catch {
    return null;
  }
}

/** 标记不可用。同一原因重复写入时保持原时间，避免无限续期。 */
export function markChannelDown(root: string, reason: string): void {
  const file = channelFile(root);
  const prev = existsSync(file) ? readChannelDown(root) : null;
  const body = {
    ok: false,
    reason,
    at: prev?.reason === reason ? prev.at : new Date().toISOString(),
  };
  try {
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  } catch {
    /* 写不进去时闸失效，按无记录处理：宁可多派一次，也不能因为写不成而停住任务。 */
  }
}

/** 标记可用。成功后删除状态文件。 */
export function markChannelUp(root: string): void {
  const file = channelFile(root);
  if (!existsSync(file)) return;
  try {
    rmSync(file, { force: true });
  } catch {
    /* 删除失败时留下过期记录，五分钟后自动失效。 */
  }
}
