/**
 * 同协议宿主共用的 hook 配置条目生成。
 *
 * 六个宿主的挂载方式相同：在各自配置文件的 `hooks` 键下按原生事件名加条目。差异只有
 * 一组事件名与命令串的平台写法，全部由调用方以参数给出。
 *
 * 写入位置是 `<家目录>/<宿主配置目录>/<宿主配置文件名>` 的 `hooks` 键。合并与自有条目
 * 识别由安装器负责，本文件只产出条目本身；文件不存在时由安装器创建。
 *
 * 命令串的要求：
 * 1. Windows 上一律用正斜杠。有的宿主在 Windows 上经 Git Bash 执行 hook，
 *    `C:\x\y.js` 里的反斜杠会被当成转义符处理掉，hook 不运行且没有报错。
 * 2. 用当前 node 的绝对路径，不用裸 `node`。nvm / fnm / asdf 装多版本的环境里，宿主
 *    进程的 PATH 常常没有 node，hook 会被跳过。
 * 3. 末尾的 `--from <marker>` 是卸载用的识别标记。本地符号链接安装时入口路径是仓库
 *    路径，命令串里不含包名，只靠路径判断会让卸载认不出自己写的条目。
 */

import type { InstallContext, InstallEntry, InstallFacet } from "../../contract";

/** 工具类事件的 matcher；提交输入与结束事件不识别 matcher。 */
const TOOL_MATCHER = "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|Read|Glob|Grep";

/** 生成一条命令。`id` 是注册表键，写进 `--agent`，必须与 impl 的 id 一致。 */
function commandFor(id: string, event: string, ctx: InstallContext): string {
  const entry = ctx.entry.replace(/\\/g, "/");
  const node = ctx.node.replace(/\\/g, "/");
  return `"${node}" "${entry}" ${event} --agent ${id} --from ${ctx.marker}`;
}

function entryFor(id: string, event: string, ctx: InstallContext, withMatcher: boolean): InstallEntry {
  return {
    ...(withMatcher ? { matcher: TOOL_MATCHER } : {}),
    hooks: [
      {
        type: "command",
        command: commandFor(id, event, ctx),
        timeout: 20,
        statusMessage: `supervisor: ${ctx.marker}`,
      },
    ],
  };
}

/**
 * 按给定事件名生成 hooks 表。
 *
 * 只在 `PreToolUse` 上挂 matcher，其余事件的 matcher 由宿主忽略。
 */
function planFor(
  id: string,
  events: readonly string[],
  ctx: InstallContext,
): Record<string, InstallEntry[]> {
  const plan: Record<string, InstallEntry[]> = {};
  for (const event of events) {
    plan[event] = [entryFor(id, event, ctx, event === "PreToolUse")];
  }
  return plan;
}

/** 挂载到 `hooks` 键的四个生命周期点，六个宿主的形状一致。 */
export const SETTINGS_HOOK_EVENTS = ["PreToolUse", "UserPromptSubmit", "Stop", "PreCompact"] as const;

/**
 * 同协议宿主的 install facet。
 *
 * 挂载动作逐字相同：同一组生命周期点、同一条命令串、同一个幂等标记。差异只有 id 与
 * 「装完还要用户做哪一步」，后者由 `extra` 给出。
 */
export function settingsHookInstall(
  id: string,
  extra: Omit<InstallFacet, "plan"> = {},
): InstallFacet {
  return {
    plan: (ctx) => planFor(id, SETTINGS_HOOK_EVENTS, ctx),
    ...extra,
  };
}
