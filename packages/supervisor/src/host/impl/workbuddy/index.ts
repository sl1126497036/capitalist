/**
 * WorkBuddy impl。
 *
 * 写入位置：
 * - 安装器写 `~/.workbuddy/settings.json` 的 `hooks` 键，挂四个生命周期点，事件名与
 *   参照协议同名。
 * - `workspace` facet 写 `~/.codebuddy/settings.json` 的 `trustedDirectories` 与
 *   `<任务根>/.codebuddy/settings.json` 的 `permissions`。写入目标是同族宿主的目录，
 *   与本 impl 的 `configDir`（`.workbuddy`）不同。
 * - 不写 `~/.workbuddy/hooks/`：那不是加载路径。
 *
 * 自动纳管读 `~/.workbuddy/capitalist-watch.json`，读取方是 `core/autowatch`。
 *
 * 与参照协议的差异：
 *
 * 1. hook 经 POSIX shell 执行，命令里用 `$HOME` 与正斜杠。
 * 2. 自动纳管由 `~/.workbuddy/capitalist-watch.json` 驱动：cwd 命中路径规则时就地建根。
 * 3. 桌面端是 Electron 壳，没有可靠的 `-p` 入口，不参与工作进程自动探测。需要尝试时用
 *    `--worker-cmd` 给出真实入口。
 *
 * 目录信任沿用同族 CLI 的机制（同一个 `settings.json` 里的 `trustedDirectories`），
 * 因此 workspace facet 与 codebuddy 共用一份实现。
 */

import type { HostImpl } from "../../contract";
import { ClaudeStyleHook } from "../shared/claudeStyle";
import { TRUST_PRESET, createWorkspaceFacet } from "../shared/dirTrust";
import { settingsHookInstall } from "../shared/settingsHookPlan";
import { winBinNames, winShellForShim, gitBashAvailable } from "../shared/workerCommon";
import { TENCENT_MODEL_POLICY } from "../shared/modelPolicy";

const LABEL = "WorkBuddy";

const LOGIN_HINT =
  "本机未读取到宿主登录态。在 WorkBuddy 登录后可派单；工作进程沿用宿主登录态，不注入令牌。";

/**
 * WorkBuddy 的宿主实现。
 *
 * 写入位置与不写的配置见文件头。取用方按 `HostImpl` 字段读，缺失的 facet 表示该能力
 * 在这个宿主上不提供。
 */
export const impl: HostImpl = {
  id: "workbuddy",
  label: LABEL,
  aliases: ["wb", "work-buddy"],
  configDir: ".workbuddy",
  // 与 CodeBuddy 同族：共用客户端登录态与配置目录；桌面端不支持非交互执行时，由同族 CLI 承担工作进程。
  family: "tencent",
  // 同族共用 CodeBuddy 的注入变量，取值里带产品形态即说明是桌面端。
  hostEnv: [{ name: "CODEBUDDY_HOST", contains: "workbuddy" }],
  settingsFile: "settings.json",
  projectLocal: true,
  knownModels: ["fast-model", "deepseek-v4.1-flash", "glm-5.3-flash"],
  cliBins: ["workbuddy", "workbuddy.cmd"],
  /* 平台模型策略：默认档与禁用名单，阻止宿主自行回落（见 shared/modelPolicy.ts）。 */
  modelPolicy: TENCENT_MODEL_POLICY,

  hook: new ClaudeStyleHook({ guessPriority: 50 }),

  install: settingsHookInstall("workbuddy", {
    // hook 命令本身不经 shell 语法；宿主若以 Git Bash 为执行器，缺 bash 时条目写入但不触发。
    preconditions: (ctx) =>
      ctx.platform === "win32" && !gitBashAvailable(ctx.platform)
        ? ["本机未见 bash.exe：宿主若经 Git Bash 执行 hook，条目会写入但不触发；改用其它宿主，或装 Git for Windows"]
        : [],
  }),

  worker: {
    key: "workbuddy",
    envDropPrefixes: ["SERVER__"],
    envDropNames: [
      "WORKBUDDY_SESSION_ID",
      "CODEBUDDY_SESSION_ID",
      "CODEBUDDY_CONVERSATION_MESSAGE_ID",
      "CODEBUDDY_CONVERSATION_REQUEST_ID",
      "CODEBUDDY_TOOL_CALL_ID",
      "CODEBUDDY_MCP_CONFIG",
      "CODEBUDDY_DOCUMENT_IPC_ADDRESS",
    ],
    // 无 detectPriority：Electron 壳没有可靠的非交互入口，不能参与自动探测。
    binNames: (platform) => winBinNames(platform, "workbuddy"),
    argv: ({ prompt, model }) => ["-p", prompt, ...(model ? ["--model", model] : [])],
    argvStdin: ({ model }) => ["-p", "--permission-mode", "bypassPermissions", ...(model ? ["--model", model] : [])],
    needsShell: winShellForShim,
  },

  // 写入目标是 `.codebuddy`，与本 impl 的 `configDir`（`.workbuddy`）不同：同族宿主读
  // 同一份 `trustedDirectories`。移动写入位置会让已准备过的目录重新变回未信任，因此
  // 这里保持既有位置。
  workspace: createWorkspaceFacet({
    configDir: ".codebuddy",
    label: LABEL,
    ...TRUST_PRESET,
  }),
};

export default impl;
