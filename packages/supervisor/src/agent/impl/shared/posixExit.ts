/**
 * POSIX 退出码决策：退出码 2 阻断，stderr 回填给模型。
 *
 * 只依赖“非零退出码即拒绝”这一条，不需要结构化 JSON。用于只确认了退出码通路的宿主
 * 与 generic 协议。
 *
 * 注入无退出码语义，使用本模块的 impl 声明 `injects: false`：stderr 只在终端可见，
 * 不保证模型可见。
 */

import type { HookDecision } from "../../contract";

/** 阻断用的退出码。 */
export const POSIX_BLOCK_CODE = 2;

/**
 * 拒绝：写 stderr，返回退出码 2。
 *
 * stderr 写入失败不影响返回码。
 */
export function posixDeny(reason: string): HookDecision {
  process.stderr.write(`${reason}\n`);
  return { code: POSIX_BLOCK_CODE };
}

/**
 * 无注入通道时的退化实现：写 stderr，不阻断。
 *
 * stderr 写入失败不影响返回码。
 */
export function posixInject(context: string): HookDecision {
  process.stderr.write(`${context}\n`);
  return { code: 0 };
}
