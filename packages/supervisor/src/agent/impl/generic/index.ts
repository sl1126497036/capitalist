/**
 * 通用（POSIX 约定）impl：任何遵循“stdin 收 JSON、退出码 2 阻断”的 CLI 都能用。
 *
 * 约定：退出码 2 表示阻断，stderr 内容回填给模型；退出码 0 表示放行。没有结构化 JSON
 * 输出，也没有上下文注入通道：能拦，不能注入。需要注入时写专用 impl。
 *
 * 写入位置：
 * - 安装器写 `~/.capitalist/hooks.json` 的 `hooks` 键，挂四个生命周期点；只在显式
 *   `--agent generic` 时安装。
 * - 不写用户级信任列表，不写项目级配置；`workspace` facet 缺省。
 *
 * 本 impl 是清单里唯一的回退项，不参与自动探测。
 */

import type { HookDecision, HostImpl, LifecyclePoint } from "../../contract";
import { ClaudeStyleHook } from "../shared/claudeStyle";
import { posixDeny, posixInject } from "../shared/posixExit";
import { settingsHookInstall } from "../shared/settingsHookPlan";

/**
 * 无结构化输出的 hook facet。
 *
 * 拒绝与注入都退化为 stderr 写入。
 */
class GenericHook extends ClaudeStyleHook {
  override readonly injects = false;
  override readonly structuredDeny = false;

  override deny(reason: string, _point: LifecyclePoint, _sessionId: string): HookDecision {
    return posixDeny(reason);
  }

  /** 无注入通道：把上下文写到 stderr 而不是 stdout，避免污染宿主的协议解析。 */
  override inject(context: string, _point: LifecyclePoint, _sessionId: string): HookDecision {
    return posixInject(context);
  }
}

/**
 * 通用 POSIX 约定的宿主实现。
 *
 * 写入位置与不写的配置见文件头。这是清单里唯一的回退项，只在显式 `--agent generic`
 * 时被选中，不参与自动探测。
 */
export const impl: HostImpl = {
  id: "generic",
  label: "Generic (POSIX)",
  aliases: ["posix", "plain"],
  configDir: ".capitalist",
  settingsFile: "hooks.json",
  fallback: true,

  hook: new GenericHook({ guessPriority: -1 }),

  // 显式 `--agent generic` 时可安装，供自建壳体接入。
  install: settingsHookInstall("generic"),
};

export default impl;
