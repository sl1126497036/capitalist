/**
 * Claude Code impl。参照实现，其余几家的事件契约与它一致。
 *
 * 写入位置：
 * - 安装器写 `~/.claude/settings.json` 的 `hooks` 键，挂四个生命周期点。
 * - `workspace` facet 缺省：不写项目级配置，也不改 `trustedDirectories`。
 * - 无 credential facet：工作进程沿用 Claude Code 自己的登录态。
 *
 * 写入后立即生效，不需要用户在宿主里再确认。
 *
 * 工作进程入口是 `claude -p`。宿主取值与工作进程宿主取值同为 `claude-code`，
 * 两者都写进配置与 `.capitalist/workers/*.json`，只增不改。
 */

import type { HostImpl } from "../../contract";
import { ClaudeStyleHook } from "../shared/claudeStyle";
import { settingsHookInstall } from "../shared/settingsHookPlan";
import { winBinNames, winShellForShim } from "../shared/workerCommon";

/**
 * Claude Code 的宿主实现。
 *
 * 写入位置与不写的配置见文件头。取用方按 `HostImpl` 字段读，缺失的 facet 表示该能力
 * 在这个宿主上不提供。
 */
export const impl: HostImpl = {
  id: "claude-code",
  label: "Claude Code",
  aliases: ["claude", "claudecode", "anthropic"],
  configDir: ".claude",
  settingsFile: "settings.json",
  projectLocal: true,
  // 该宿主与腾讯系宿主不共用登录态，工作进程不可互相替代。
  family: "anthropic",
  hostEnv: [{ name: "CLAUDE_PROJECT_DIR" }, { name: "CLAUDE_SESSION_ID" }],
  cliBins: ["claude", "claude.cmd"],

  hook: new ClaudeStyleHook({ guessPriority: 40 }),

  install: settingsHookInstall("claude-code"),

  worker: {
    /* 宿主对外名称与 impl id 一致，均为 claude-code。 */
    key: "claude-code",
    envDropPrefixes: ["CLAUDE"],
    detectPriority: 20,
    binNames: (platform) => winBinNames(platform, "claude"),
    argv: ({ prompt, model }) => [
      "-p",
      prompt,
      "--permission-mode",
      "acceptEdits",
      "--output-format",
      "text",
      ...(model ? ["--model", model] : []),
    ],
    argvStdin: ({ model }) => ["-p", "--output-format", "text", ...(model ? ["--model", model] : [])],
    // `-p` 不与目录信任确认共用 stdin，管道写法可用。
    preferStdin: true,
    needsShell: winShellForShim,
  },
};

export default impl;
