/** CodeBuddy impl。 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { HostImpl, WorkerSession } from "../../contract";
import { ClaudeStyleHook } from "../shared/claudeStyle";
import { TRUST_PRESET, createWorkspaceFacet } from "../shared/dirTrust";
import { settingsHookInstall } from "../shared/settingsHookPlan";
import { winBinNames, winShellForShim, gitBashAvailable } from "../shared/workerCommon";
import { TENCENT_MODEL_POLICY } from "../shared/modelPolicy";

const LABEL = "CodeBuddy";

const POST_INSTALL_NOTICE =
  "CodeBuddy 在 Windows 上强制用 Git Bash 执行 hook（cmd/PowerShell 不支持）。路径已按 POSIX 写法生成；若未生效，先确认 Git Bash 可用。";

const LOGIN_HINT =
  "本机未读取到宿主登录态。在 CodeBuddy 登录后可派单；工作进程沿用宿主登录态，不注入令牌。";

/** 调试参数：默认开启。 */
/**
 * 实时输出开关。
 *
 * 默认的 `--output-format text` 只在会话结束吐一段总结：跑 70 分钟的 worker，日志里只有宿主
 * 的运维行，看板因此「看不到它在做什么」，人也没法判断它是真在推进还是卡住了。
 * `stream-json` 把每个 assistant 消息、每次工具调用按行实时打出来，看板才有过程可看。
 *
 * 设 `CAPITALIST_WORKER_STREAM=0` 可关闭流式输出；解析侧无法识别格式时回到纯文本。
 */
/**
 * 会话续载参数。
 *
 * `--resume <id>` 续接上一次会话，会话已存在时接着上次的上下文跑。
 * `--session-id <id>` 用在要求变过的场合：同 id 新开会话，旧上下文不带过来。
 */
function sessionArgs(session?: WorkerSession): string[] {
  if (!session) return [];
  return session.resume
    ? ["--resume", session.id]
    : ["--session-id", session.id];
}

function streamArgs(): string[] {
  return process.env.CAPITALIST_WORKER_STREAM === "0" ? [] : ["--output-format", "stream-json"];
}

/** 推理强度参数。空值不传，交给 CLI 默认（而不是塞一个猜出来的档位）。 */
function effortFlags(effort?: string): string[] {
  const lv = String(effort ?? "").trim().toLowerCase();
  return lv ? ["--effort", lv] : [];
}

function debugArgs(): string[] {
  return process.env.CAPITALIST_WORKER_DEBUG === "0" ? [] : ["-d"];
}

/**
 * CodeBuddy 的宿主实现。
 *
 * 写入位置与不写的配置见文件头。取用方按 `HostImpl` 字段读，缺失的 facet 表示该能力
 * 在这个宿主上不提供。
 */
export const impl: HostImpl = {
  id: "codebuddy",
  label: LABEL,
  aliases: ["code-buddy", "tencent"],
  configDir: ".codebuddy",
  // 与 WorkBuddy 同族：共用客户端登录态与配置目录。
  family: "tencent",
  // 同族宿主共用该环境变量；桌面端取值包含产品形态，由另一条 contains 特征区分。
  hostEnv: [{ name: "CODEBUDDY_HOST" }],
  settingsFile: "settings.json",
  projectLocal: true,
  knownModels: ["fast-model", "deepseek-v4.1-flash", "glm-5.3-flash"],
  cliBins: ["codebuddy", "codebuddy.cmd"],
  /* 平台模型策略：默认档与禁用名单，阻止宿主自行回落（见 shared/modelPolicy.ts）。 */
  modelPolicy: TENCENT_MODEL_POLICY,

  hook: new ClaudeStyleHook({ guessPriority: 30 }),

  install: settingsHookInstall("codebuddy", {
    notice: () => POST_INSTALL_NOTICE,
    // hook 命令是 node 绝对路径的直调，cmd 与 PowerShell 都能执行。宿主若以 Git Bash
    // 为 hook 执行器，本机缺 bash 时条目仍在但不会触发，这种情形只有装完才能发现。
    preconditions: (ctx) =>
      ctx.platform === "win32" && !gitBashAvailable(ctx.platform)
        ? ["本机未见 bash.exe：宿主若经 Git Bash 执行 hook，条目会写入但不触发；改用其它宿主，或装 Git for Windows"]
        : [],
  }),

  worker: {
    key: "codebuddy",
    detectPriority: 30,
    // 只剔宿主 HTTP 服务的端口变量；整个前缀剔除会连 CLI 的启动配置一起削掉。
    //
    // 另剔 `ACC_PRODUCT_CONFIG*` 与 `CODEBUDDY_HOST`：宿主把产品配置注入成「桌面端身份」，
    // CLI 按该身份认证，与自身登录态不一致，非交互调用返回 `Authentication required`。
    // 剔除后 CLI 按自身 product.json 声明的身份认证，非交互调用恢复。该失败源于宿主注入的
    // 身份覆盖了 CLI 身份，与用户登录状态无关。
    envDropPrefixes: ["SERVER__", "ACC_PRODUCT_CONFIG"],
    envDropNames: [
      "CODEBUDDY_HOST",
      "CODEBUDDY_SESSION_ID",
      "CODEBUDDY_CONVERSATION_MESSAGE_ID",
      "CODEBUDDY_CONVERSATION_REQUEST_ID",
      "CODEBUDDY_TOOL_CALL_ID",
      "CODEBUDDY_MCP_CONFIG",
      "CODEBUDDY_DOCUMENT_IPC_ADDRESS",
    ],
    binNames: (platform) => winBinNames(platform, "codebuddy"),
    // prompt 走 argv，不走 stdin：`-p` 的 stdin 要承载首次进入目录的信任确认，两者共用
    // 一条管道时 prompt 会被当作确认读掉，进程随后读到 EOF 空转。
    // `--port 0` 让 CLI 自选端口。默认端口固定（51073），与桌面端宿主同机运行时得到
    // EADDRINUSE，而 CLI 在这种失败下仍以退出码 0 结束。
    argv: ({ prompt, model, session, effort }) => [
      "-p",
      prompt,
      "--permission-mode",
      "bypassPermissions",
      "--port",
      "0",
      ...(model ? ["--model", model] : []),
      ...effortFlags(effort),
      ...streamArgs(),
      ...sessionArgs(session),
      ...debugArgs(),
    ],
    // 管道写法可用，但 stdin 要留给信任确认，因此不设 preferStdin。
    argvStdin: ({ model, session, effort }) => [
      "-p",
      "--permission-mode",
      "bypassPermissions",
      "--port",
      "0",
      ...(model ? ["--model", model] : []),
      ...effortFlags(effort),
      ...streamArgs(),
      ...sessionArgs(session),
      ...debugArgs(),
    ],
    effortArgs: (level) => effortFlags(level),
    needsShell: winShellForShim,
    // npm 全局安装把 .cmd 与包目录放在同一个前缀下。直连真实入口可以避开 shim 里的
    // `2>NUL` 跳转：受限环境里那条重定向被拒时整行短路，CLI 无法启动。
    program: ({ bin, dir, platform }) => {
      if (platform !== "win32" || !/\.cmd$/i.test(bin)) return null;
      const entry = join(dir, "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy");
      if (!existsSync(entry)) return null;
      return { bin: process.execPath, args: [entry] };
    },
  },

  workspace: createWorkspaceFacet({
    configDir: ".codebuddy",
    label: LABEL,
    ...TRUST_PRESET,
  }),
};

export default impl;
