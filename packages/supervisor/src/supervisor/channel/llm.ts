/**
 * 监工对话通道：把 prompt 交给模型，返回纯文本。复用工作进程链路发现可执行文件并固定 `--session-id`。
 * 每次调用起一个短命进程（`-p` 模式，执行结束即退出），不占工作进程槽位，不写 `.capitalist/workers`。
 */

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_SUPERVISOR_CHAT_HOST } from "../../agent/impl/shared/hostHints";
import { byId, currentHost, siblings } from "../../agent/registry";
import { recordEvent } from "../../core/record/ledger";
import { resolveModel } from "../judge/modelPolicy";
import { findBin, needsShell, quoteShellArg, workerEnv, workerImpl, type WorkerHost } from "../worker/worker";
/* 故障判定收口在 `./fault`：本文件只提供文本来源，不另写正则与阈值。 */
import { faultText, judgeFault, judgeResultFault, type FaultKind } from "./fault";
/* 回复解析在 `./parseReply`：本文件只负责与模型通信，不解析标记行。 */
import { officialAccessToken, tokenInjectionEnabled } from "./officialToken";

/* 兼容既有调用点：判定与文案的唯一实现在 `./fault`。 */
export {
  AUTH_HINT_TEXT,
  AUTH_REQUIRED_TEXT,
  QUOTA_EXHAUSTED_TEXT,
  RATE_BUSY_TEXT,
  faultText,
  isQuotaText,
  judgeFault,
  judgeResultFault,
} from "./fault";
export type { FaultKind } from "./fault";

/**
 * 将宿主令牌写入子进程环境。
 *
 * 优先级：调用方传入的令牌 > 宿主登录态。宿主 CLI 见到该变量即以令牌认证，不再读取客户端
 * 自身的登录态文件，桌面端启动的监工因此可以在受限环境中完成对话。
 *
 * 传入令牌为首选路径：监工进程读取登录态文件时通常被文件访问授权拦截，失败无报错，
 * 仅表现为认证失败。宿主未声明变量名时两者均不写入，行为与改动前一致。
 * 令牌仅进入本次子进程环境，不写日志、不落盘。
 */
function injectOfficialToken(env: NodeJS.ProcessEnv, host: WorkerHost, explicit?: string): void {
  if (!tokenInjectionEnabled()) return;
  const authVar = byId(host)?.worker?.authEnvVar;
  if (!authVar) return;
  const token = (explicit ?? "").trim() || officialAccessToken();
  if (token) env[authVar] = token;
}

/**
 * 对话通道用哪个 CLI。
 *
 * 候选顺序：声明的宿主（`supervise --agent` 落盘值或 `--agent` 覆盖）-> 同族宿主 -> 常量默认值。
 * 逐个验证本机存在可执行文件：桌面端没有非交互入口时，由同族 CLI 承担工作进程。
 * 显式声明找不到可执行文件时原样返回，由调用方报错，不跨族借用别家的登录态。
 *
 * 候选只取声明了 `worker.detectPriority` 的宿主：未声明表示该宿主没有可靠的非交互入口
 * （桌面端），与工作进程的探测口径一致。把它排进候选会让对话通道选中一个无法以 `-p`
 * 运行的入口，表现为进程启动后无正文输出。
 */
export function resolveChatHost(explicit?: WorkerHost): WorkerHost {
  const cur = currentHost();
  const start = explicit ?? ((cur ? (byId(cur)?.worker?.key ?? cur) : "") as WorkerHost | "");
  const chain: WorkerHost[] = [];
  if (start) {
    if (workerImpl(start)?.worker?.detectPriority !== undefined) chain.push(start);
    for (const s of siblings(String(start))) {
      if (s.worker?.key && s.worker.detectPriority !== undefined) chain.push(s.worker.key as WorkerHost);
    }
  }
  for (const key of chain) {
    if (findBin(key)) return key;
  }
  /* 同族没有可用入口时回到常量默认值：由 askModel 按“找不到可执行文件”报错，不使用桌面端入口。 */
  return chain[0] ?? (DEFAULT_SUPERVISOR_CHAT_HOST as WorkerHost);
}

/**
 * 把宿主 CLI 解析成可直接启动的入口，并在必要时转义参数。
 *
 * Windows 上经 npm 安装的 CLI 是 `.cmd` 包装脚本。经 shell 启动时，命令行会把整段提示词
 * 重新分词：空格、换行与中文在 `cmd.exe` 与 PowerShell 下都会改变参数边界与字节编码；
 * 包装脚本本身在受限环境里还会因重定向被拒而短路。宿主 impl 声明了 `program` 时改用它
 * 给出的直连入口，与工作进程同一套装配。
 *
 * 脚本入口（自建包装、测试替身）交给当前 node 执行：Windows 上带 shebang 的 `.js` 不是
 * 可执行格式，直接启动会报 EFTYPE。
 *
 * @returns `bin` 为实际可执行文件，`preArgs` 为其前置参数，`shell` 表示是否必须经 shell 启动。
 */
function entryOf(host: WorkerHost, located: string): { bin: string; preArgs: string[]; shell: boolean } {
  const program =
    workerImpl(host)?.worker?.program?.({
      bin: located,
      dir: dirname(located),
      platform: process.platform,
    }) ?? null;
  let bin = program?.bin ?? located;
  let preArgs = program?.args ?? [];
  if (/\.(?:js|cjs|mjs)$/i.test(bin)) {
    preArgs = [bin, ...preArgs];
    bin = process.execPath;
  }
  return { bin, preArgs, shell: needsShell(bin, host) };
}

/**
 * 把参数整理成可直接传给子进程的数组。
 *
 * 经 shell 启动时逐项转义；提示词含换行时返回 null：`cmd.exe` 与 PowerShell 都以换行作为
 * 命令分隔，换行无法在命令行内表达，转义也不能恢复。这类情形在启动前拦下并给出具体原因，
 * 不把“参数被截断”报告成“模型没有返回内容”。
 */
function argvOf(entry: { preArgs: string[]; shell: boolean }, args: string[]): string[] | null {
  const raw = [...entry.preArgs, ...args];
  if (!entry.shell) return raw;
  if (raw.some((a) => /[\r\n]/.test(a))) return null;
  return raw.map(quoteShellArg);
}

/**
 * 解码诊断通道的输出。
 *
 * 协议通道（stdout）恒按 UTF-8 解析。诊断通道在 Windows 上可能来自 `cmd.exe` 或宿主 CLI
 * 的本地化报错，按 OEM 代码页输出；按 UTF-8 解码会得到替换字符。出现替换字符时改用 GBK
 * 重解，仅用于错误判定与诊断日志，不参与协议解析。
 */
function decodeDiag(buf: Buffer): string {
  const utf8 = buf.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("gbk").decode(buf);
  } catch {
    return utf8;
  }
}

/**
 * 写入对话诊断日志，返回该文件路径。
 *
 * 界面文案不携带 CLI 的原始 stderr：其中含账号链接、请求号与会话号。原始输出只写入本机
 * 临时目录，界面上给出路径供排查时取用。写入失败不影响主流程，此时返回空串。
 */
function writeChatDiag(rec: Record<string, unknown>): string {
  const file = join(tmpdir(), "capitalist-chat-diag.log");
  try {
    appendFileSync(file, `${JSON.stringify(rec)}\n`, "utf8");
  } catch {
    return "";
  }
  return file;
}

/** 失败说明拼接诊断路径；没有诊断文件时原样返回。 */
function withDiag(text: string, file: string): string {
  return file ? `${text}；诊断信息见 ${file}` : text;
}

/**
 * 模型由 `resolveModel` 决定：未指定用平台默认档，指定禁用模型时回落默认并记 `model_denied` 事件。
 * 与工作进程侧共用 `supervisor/modelPolicy.ts`，两端口径一致。
 */
function modelFor(host: WorkerHost, opts: AskModelOptions): string | undefined {
  const pick = resolveModel({ root: opts.cwd, host, wanted: opts.model });
  if (pick.denied && opts.cwd) {
    recordEvent(opts.cwd, "model_denied", {
      scope: "capitalist",
      wanted: pick.denied,
      used: pick.model ?? "",
      why: pick.why,
    });
  }
  return pick.model;
}

/** 默认空闲超时（5 分钟）。CLI 冷启动与长思考期间可能长时间无输出，不宜按秒级判定卡死。 */
const DEFAULT_TIMEOUT_MS = 300_000;
/** 总时长上限（20 分钟）：防止进程持续输出但永不结束。 */
const DEFAULT_MAX_MS = 20 * 60_000;

/**
 * CLI 每次占用一个本地端口。端口被占用时它既不报错也不退出，无输出地挂到空闲超时，
 * 端口需经试绑定确认可用。
 */
let portCursor = 52_000;

/** 试绑定 127.0.0.1:<port>，能绑上即视为可用；随即释放，交给 CLI 去绑。 */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function nextPort(): Promise<number> {
  for (let i = 0; i < 64; i += 1) {
    portCursor += 1;
    if (portCursor > 59_000) portCursor = 52_000;
    if (await portFree(portCursor)) return portCursor;
  }
  /* 异常分支：极少发生。返回当前游标值，由 CLI 决定后续结果，不再无限等待。 */
  return portCursor;
}

export interface AskModelOptions {
  /** 要发给模型的话（含上下文）。 */
  prompt: string;
  /** 会话 id：同一 id 的多轮共享上下文。 */
  sessionId?: string;
  /** 工作目录，缺省取进程当前目录。 */
  cwd?: string;
  /** 宿主，缺省取 impl 层声明的缺省值。 */
  host?: WorkerHost;
  /** 空闲超时：连续无 stdout/stderr 输出即判定失败，有输出则重置计时；总时长由 `maxMs` 约束。 */
  timeoutMs?: number;
  /** 总时长上限（毫秒），缺省 {@link DEFAULT_MAX_MS}。 */
  maxMs?: number;
  /** 推理强度；监工判定为语义判断，低档位会退化为关键词匹配。 */
  effort?: string;
  /** 监工对话模型（`supervise --capitalist-model` 写入 supervisor.json）；空表示宿主默认。 */
  model?: string | undefined;
  /**
   * 宿主令牌，由监工启动时一次性传入并常驻内存。
   *
   * 有值时直接写入子进程环境，不再读取登录态文件。监工进程通常无法获取该文件的读取权限，
   * 回退到文件读取会静默返回空值，表现为“登录状态失效”。
   */
  token?: string | undefined;
  /**
   * 中止信号：上层收到新的用户消息时用它终止正在提交的回执或报告，
   * 让用户要求优先得到处理。中止后子进程被结束，本轮按 `aborted` 返回。
   */
  signal?: AbortSignal;
}

/**
 * 推理强度参数由 impl 的 `effortArgs` 生成；宿主未声明该能力时返回空数组，不传未识别的参数。
 */
function effortArgsOf(host: WorkerHost, effort?: string): string[] {
  const level = String(effort ?? "").trim().toLowerCase();
  if (!level) return [];
  return workerImpl(host)?.worker?.effortArgs?.(level) ?? [];
}

export interface AskModelResult {
  ok: boolean;
  /** 模型回的话（ok 为 false 时是错误说明）。 */
  text: string;
  /**
   * 调用结束时的上下文已用 token。优先取 result 行 `_meta`，其次取末条 assistant 行的
   * `message.usage.input_tokens`（见 {@link contextUsedOfAssistantMessage}）；两者都无时由调用方估算。
   */
  context_used?: number;
  /** 该模型的上下文窗口 token（stream-json 的 modelUsage 里有读数才有）。 */
  context_window?: number;
  /** 这条读数对应的模型名（modelUsage 的键）；宿主没报时缺省。 */
  context_model?: string;
  /**
   * 本轮被调用方的中止信号终止。
   *
   * 与“通道故障”分开：中止是预期内的结果，调用方据此收尾（提示用户本轮被打断），
   * 不按错误上报，也不重试。
   */
  aborted?: boolean;
}

/** 从 assistant 行取 `message.model`；宿主没给时返回空串。 */
function assistantModelOf(o: unknown): string {
  const msg = (o as Record<string, unknown>)?.message;
  if (!msg || typeof msg !== "object") return "";
  return String((msg as Record<string, unknown>).model ?? "").trim();
}

/**
 * 从 stream-json 的 `result` 行取上下文读数，口径与 usage.ts 一致。
 * `_meta` 中以 `/contextUsed` 结尾的键为已用，`modelUsage[模型].contextWindow` 为窗口；按后缀匹配以兼容厂商前缀。
 */
export function contextUsageOfResult(o: unknown): { used: number | null; window: number | null } {
  if (!o || typeof o !== "object") return { used: null, window: null };
  const rec = o as Record<string, unknown>;
  let used: number | null = null;
  let window: number | null = null;
  const meta = rec._meta;
  if (meta && typeof meta === "object") {
    for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
      if (k.endsWith("/contextUsed")) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) used = n;
        break;
      }
    }
  }
  const mu = rec.modelUsage;
  if (mu && typeof mu === "object") {
    const first = Object.values(mu as Record<string, unknown>)[0];
    if (first && typeof first === "object") {
      const w = Number((first as Record<string, unknown>).contextWindow);
      if (Number.isFinite(w) && w > 0) window = w;
    }
  }
  return { used, window };
}

/** result 行 `modelUsage` 的模型名，取第一个键，与 {@link contextUsageOfResult} 口径一致；窗口属模型属性，换模型后失效。 */
export function contextModelOfResult(o: unknown): string {
  if (!o || typeof o !== "object") return "";
  const mu = (o as Record<string, unknown>).modelUsage;
  if (!mu || typeof mu !== "object") return "";
  const key = Object.keys(mu as Record<string, unknown>)[0];
  return String(key ?? "").trim();
}

/**
 * 从 stream-json 的 `assistant` 行取本次请求的上下文占用。`result.usage` 为会话累计值，不能当占用；
 * `message.usage.input_tokens` 只记本次请求且含缓存命中。`_meta.contextUsed` 仅在 ACP 通道上报，headless 模式取末条有读数的 assistant 行；result 行在其后解析，有真读数时覆盖。
 */
export function contextUsedOfAssistantMessage(o: unknown): number | null {
  if (!o || typeof o !== "object") return null;
  const msg = (o as Record<string, unknown>).message;
  if (!msg || typeof msg !== "object") return null;
  const usage = (msg as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  const n = Number((usage as Record<string, unknown>).input_tokens);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 进程静默退出时的说明。
 *
 * 与 {@link QUOTA_EXHAUSTED_TEXT} 分开：静默退出只是“没有任何诊断信息”，不等于额度耗尽。
 * 两者混用会让一次误判被写进 quota.json，而该状态不按时间过期，后续调用会直接短路。
 */
export const NO_OUTPUT_TEXT = "模型没有返回内容：请重试；若持续失败，请检查登录状态";

/** stderr 过长时取尾部：失败原因通常出现在末尾。 */
function tailOf(s: string, n = 600): string {
  const t = String(s ?? "").trim();
  return t.length > n ? t.slice(-n) : t;
}

/**
 * 进程正常退出却无输出时给出可读原因，区分额度耗尽、登录失效与限流，否则返回退出码描述。
 * 不携带上游原文：账号链接、request-id 与会话 id 属于账号信息，只留在工作进程日志。
 * 判定本身在 `./fault` 的 `judgeFault("diag", …)`，这里只做文案映射。
 */
export function emptyExitReason(err: string, code: number | null, signal: NodeJS.Signals | null): string {
  const kind = judgeFault("diag", err);
  if (kind) return faultText(kind);
  const tail = tailOf(err);
  /*
   * stderr 为空且 code 0 退出，只能说明进程没留下任何诊断信息，不能据此断言额度耗尽：
   * 登录失效、通道中断、上游拒绝都可能表现为该形态。若经 isQuotaText 写入 quota.json，
   * 该状态不按时间过期，一次误判会使后续调用长期直接返回“额度已耗尽”，
   * 不再请求模型。额度判定只认含额度字样或 429 的情形（见 judgeFault）。
   */
  if (!tail && (code === 0 || (code === null && signal === null))) return NO_OUTPUT_TEXT;
  if (tail) return "模型已退出，没有返回内容：请重试或查看诊断信息";
  return "模型已退出，没有返回内容";
}

/**
 * 从会话原始输出里取上游错误原因。
 *
 * 会话以上游拒绝结束时，`result` 行携带 `errors` 而正文为空；只按解析后的正文判断，
 * 会把“登录失效”退化成“无输出”。这里交给 `judgeFault("stream", …)`：它只认带
 * errors / is_error 的协议行，不扫正文与历史行，返回文案不含上游原文。
 */
export function upstreamErrorOf(raw: string): string {
  return faultText(judgeFault("stream", raw));
}

/**
 * 向模型提交 prompt 并返回自然语言文本，不解析动作；动作由调用方按 `parseReply` 处理。
 * @returns `ok:false` 表示通道不可用（找不到 CLI / 无凭证 / 超时），由调用方回落处理。
 */
export async function askModel(opts: AskModelOptions): Promise<AskModelResult> {
  const host = resolveChatHost(opts.host);
  const bin = findBin(host);
  if (!bin) return { ok: false, text: `找不到 ${host} 可执行文件，对话通道不可用` };

  /*
   * 与工作进程共用同一套环境构造：宿主注入的 `ACC_PRODUCT_CONFIG*` 会把 CLI 的身份标识设为桌面端产品形态，CLI 据此读取加密凭据信封并判定“未登录”。
   */
  const env: NodeJS.ProcessEnv = workerEnv();
  injectOfficialToken(env, host, opts.token);

  /* 模型决策与工作进程侧共用同一策略：未指定用平台默认档，禁用模型回落默认档。 */
  const model = modelFor(host, opts);
  /*
   * prompt 走 argv，不走 stdin：CodeBuddy CLI 的 `-p` 只认紧随其后的位置参数，
   * stdin 留给首次进入目录的信任确认。走 stdin 时进程既不读 prompt 也不报错，
   * 无输出持续到超时且退出码为 0 时，下游会误判为“登录状态失效”。
   */
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "text",
    "--permission-mode",
    "bypassPermissions",
    "--port",
    String(await nextPort()),
    ...effortArgsOf(host, opts.effort),
    ...(model ? ["--model", model] : []),
  ];
  if (opts.sessionId) args.push("--session-id", opts.sessionId);

  /*
   * 入口装配与工作进程一致：Windows 上 PATH 给出的是 `.cmd` 包装脚本，经 shell 启动时
   * 命令行会把提示词重新分词，空格、换行与中文都会改变参数边界；宿主声明直连入口时改用它。
   */
  const entry = entryOf(host, bin);
  const argv = argvOf(entry, args);
  if (!argv) {
    return {
      ok: false,
      text: "无法传递带换行的提示词，本次调用已中止：请将内容放在单行内",
    };
  }

  return await new Promise<AskModelResult>((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    let stopTimers = (): void => {};
    const done = (r: AskModelResult): void => {
      if (settled) return;
      settled = true;
      stopTimers();
      resolve(r);
    };

    const child = spawn(entry.bin, argv, {
      cwd: opts.cwd ?? process.cwd(),
      env,
      windowsHide: true,
      shell: entry.shell,
      /* prompt 走 argv；stdin 置空。 */
      stdio: ["ignore", "pipe", "pipe"],
    });

    /* 空闲超时：进程有输出即重置计时；总时长由 hardTimer 约束。 */
    const idleMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
    let idleTimer: NodeJS.Timeout | null = null;
    let hardTimer: NodeJS.Timeout | null = null;
    stopTimers = (): void => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (hardTimer) {
        clearTimeout(hardTimer);
        hardTimer = null;
      }
    };
    const heartbeat = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 已经退了 */
        }
        done({
          ok: false,
          text:
            `模型连续 ${Math.round(idleMs / 1000)}s 没有响应，已中止：请重试`,
        });
      }, idleMs);
    };
    heartbeat();
    hardTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已经退了 */
      }
      done({ ok: false, text: `模型整体耗时超过 ${Math.round(maxMs / 1000)}s 仍未结束` });
    }, maxMs);

    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      /* 收到内容即重置空闲计时。 */
      heartbeat();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += decodeDiag(d);
      heartbeat();
    });
    child.on("error", (e) => done({ ok: false, text: `启动模型失败：${e.message}` }));
    child.on("exit", (code, signal) => {
      const raw = out.trim();
      /* 正文只在整段像宿主转述的拒绝说明时才作废，见 `judgeFault("reply", …)`。 */
      const kind = judgeFault("reply", raw);
      if (kind) return done({ ok: false, text: faultText(kind) });
      if (raw) return done({ ok: true, text: raw });
      const reason = emptyExitReason(err, code, signal);
      /* 失败时保留原始诊断：界面只给路径，stderr 原文含账号信息，不进消息流。 */
      const diag = err.trim()
        ? writeChatDiag({
            at: new Date().toISOString(),
            caller: "askModel",
            host,
            bin: entry.bin,
            shell: entry.shell,
            code,
            signal,
            err: tailOf(err, 4000),
          })
        : "";
      done({ ok: false, text: withDiag(reason, diag) });
    });
  });
}

/** 模型回复末尾的可选 `ACTION:` 行给出要执行的动作，认不出的动作一律丢弃。 */
/** 流式增量：正文、思考过程、工具调用。 */
export type StreamDelta =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string };

/**
 * 流式版：按行解析 stream-json 事件，边生成边回调增量；`thinking_delta` 为思考过程，`text_delta` 为正文，`tool_use` 为工具调用。
 * @returns 结束时返回由增量拼成的完整文本，供调用方解析动作。
 */
export async function askModelStream(
  opts: AskModelOptions & { onDelta: (d: StreamDelta) => void },
): Promise<AskModelResult> {
  const host = resolveChatHost(opts.host);
  /* 进程尚未启动就已被抢占：直接返回，不产生一次模型调用，也不必关心通道是否可用。 */
  if (opts.signal?.aborted) return { ok: false, aborted: true, text: "" };
  const bin = findBin(host);
  if (!bin) return { ok: false, text: `找不到 ${host} 可执行文件，对话通道不可用` };

  /*
   * 与工作进程共用同一套环境构造：宿主注入的 `ACC_PRODUCT_CONFIG*` 会把 CLI 的身份指向
   * 桌面端的产品形态，它据此去读加密凭据信封、判定“未登录”。对话通道
   * 与工作进程共用同一套环境构造。
   */
  const env: NodeJS.ProcessEnv = workerEnv();
  injectOfficialToken(env, host, opts.token);

  /* 模型决策与工作进程侧共用同一策略：未指定用平台默认档，禁用模型回落默认档。 */
  const model = modelFor(host, opts);
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-mode",
    "bypassPermissions",
    "--port",
    String(await nextPort()),
    ...effortArgsOf(host, opts.effort),
    ...(model ? ["--model", model] : []),
  ];
  if (opts.sessionId) args.push("--session-id", opts.sessionId);

  /* 入口装配与 {@link askModel} 一致，两处共用同一份实现，避免口径分叉。 */
  const entry = entryOf(host, bin);
  const argv = argvOf(entry, args);
  if (!argv) {
    return {
      ok: false,
      text: "无法传递带换行的提示词，本次调用已中止：请将内容放在单行内",
    };
  }

  return await new Promise<AskModelResult>((resolve) => {
    let text = "";
    let err = "";
    let pending = "";
    /** 诊断用：原始 stdout 累积，仅在 CAPITALIST_CHAT_DEBUG 置位时填充。 */
    let rawAll = "";
    let settled = false;
    /* result 行携带的上下文读数，有值时随结果返回。 */
    let ctxUsed: number | undefined;
    let ctxWindow: number | undefined;
    let ctxModel: string | undefined;
    /* result 行的上游拒绝分类；非空表示本次调用被上游拒绝。 */
    let resultFault: FaultKind = "";
    let stopTimers = (): void => {};
    /** 移除中止监听；本轮已结束时必须移除，否则上层复用的信号会留下一条失效引用。 */
    let detachAbort = (): void => {};
    const done = (r: AskModelResult): void => {
      if (settled) return;
      settled = true;
      stopTimers();
      detachAbort();
      resolve({
        ...r,
        ...(ctxUsed !== undefined ? { context_used: ctxUsed } : {}),
        ...(ctxWindow !== undefined ? { context_window: ctxWindow } : {}),
        ...(ctxModel ? { context_model: ctxModel } : {}),
      });
    };

    const child = spawn(entry.bin, argv, {
      cwd: opts.cwd ?? process.cwd(),
      env,
      windowsHide: true,
      shell: entry.shell,
      /* 同上：prompt 走 argv，stdin 留空。 */
      stdio: ["ignore", "pipe", "pipe"],
    });

    /*
     * 抢占：上层收到新的用户消息时中止本轮。
     *
     * 先发 SIGTERM 让宿主自己收尾；2 秒后仍未退出则 SIGKILL，避免一个已经没人等的
     * 模型进程继续占用端口与额度。返回 `aborted` 而不返回错误，调用方据此把本轮
     * 收成“被新消息打断”，不按通道故障上报。
     */
    const onAbort = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* 已退出 */
      }
      const hard = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* 已退出 */
        }
      }, 2_000);
      /* 不阻止进程退出：本轮已经结束，不需要为强杀计时器保活。 */
      hard.unref?.();
      done({ ok: false, aborted: true, text: "" });
    };
    if (opts.signal) {
      /* 启动进程期间被抢占的，信号已经处于 aborted，监听不会再回调，需补充判断一次。 */
      if (opts.signal.aborted) onAbort();
      else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => opts.signal?.removeEventListener("abort", onAbort);
      }
    }

    /* 空闲超时语义与 {@link askModel} 一致：有输出即重置计时。流式版逐段输出，整体耗时长于一次性返回。 */
    const idleMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
    let idleTimer: NodeJS.Timeout | null = null;
    let hardTimer: NodeJS.Timeout | null = null;
    stopTimers = (): void => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (hardTimer) {
        clearTimeout(hardTimer);
        hardTimer = null;
      }
    };
    const heartbeat = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 已退 */
        }
        done({
          ok: false,
          text:
            text ||
            `模型连续 ${Math.round(idleMs / 1000)}s 没有响应，已中止：请重试`,
        });
      }, idleMs);
    };
    heartbeat();
    hardTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退 */
      }
      done({ ok: false, text: text || `模型整体耗时超过 ${Math.round(maxMs / 1000)}s 仍未结束` });
    }, maxMs);

    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      /* assistant 行的 usage 为本次请求占用；result 行的 usage 为会话累计值，不能当占用。 */
      if (j.type === "assistant") {
        const n = contextUsedOfAssistantMessage(j);
        if (n !== null) ctxUsed = n;
        /* assistant 行带本次实际使用的模型名；result 行缺 modelUsage 时用它补上。 */
        const am = assistantModelOf(j);
        if (am) ctxModel = am;
        return;
      }
      /* result 行给出上下文已用与窗口的真实读数，供 reload.ts 的 `shouldAutoReload` 判定。 */
      if (j.type === "result") {
        const u = contextUsageOfResult(j);
        if (u.used !== null) ctxUsed = u.used;
        if (u.window !== null) ctxWindow = u.window;
        const m = contextModelOfResult(j);
        if (m) ctxModel = m;
        /* 上游拒绝时记下分类，避免正文被当作模型回答。 */
        const q = judgeResultFault(j);
        if (q.kind) resultFault = q.kind;
        return;
      }
      if (j.type !== "stream_event") return;
      const ev = (j.event ?? {}) as Record<string, unknown>;
      const evType = String(ev.type ?? "");
      if (evType === "content_block_start") {
        const block = (ev.content_block ?? {}) as Record<string, unknown>;
        if (String(block.type ?? "") === "tool_use") {
          opts.onDelta({ kind: "tool", name: String(block.name ?? "工具") });
        }
        return;
      }
      if (evType !== "content_block_delta") return;
      const delta = (ev.delta ?? {}) as Record<string, unknown>;
      const dt = String(delta.type ?? "");
      if (dt === "thinking_delta") {
        const t = String(delta.thinking ?? "");
        if (t) opts.onDelta({ kind: "thinking", text: t });
        return;
      }
      if (dt === "text_delta") {
        const t = String(delta.text ?? "");
        if (!t) return;
        text += t;
        opts.onDelta({ kind: "text", text: t });
      }
    };

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      /*
       * 累积原始输出：会话以上游拒绝结束时正文为空，错误只出现在 `result` 行的 `errors` 里；
       * 累积原始输出以识别认证失败；限长避免长会话占用过多内存。
       */
      if (rawAll.length < 200_000) rawAll += s;
      pending += s;
      /* 有字节到达即重置空闲计时。 */
      heartbeat();
      let i = pending.indexOf("\n");
      while (i >= 0) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 1);
        handleLine(line);
        i = pending.indexOf("\n");
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      err += decodeDiag(d);
      /* stderr 输出同样重置空闲计时。 */
      heartbeat();
    });
    child.on("error", (e) => done({ ok: false, text: `启动模型失败：${e.message}` }));
    child.on("exit", (code, signal) => {
      if (pending) handleLine(pending);
      if (process.env.CAPITALIST_CHAT_DEBUG) {
        try {
          appendFileSync(
            join(tmpdir(), "capitalist-chat-debug.log"),
            `${JSON.stringify({
              at: new Date().toISOString(),
              code,
              signal,
              args,
              text_len: text.length,
              err,
              raw_len: rawAll.length,
              raw_tail: rawAll.slice(-2000),
            })}\n`,
            "utf8",
          );
        } catch {
          /* 诊断写盘失败不影响主流程 */
        }
      }
      const raw = text.trim();
      /*
       * 协议行给出分类时以协议为准；只有正文时才看正文。正文作用域的判据要求整段像宿主
       * 转述的拒绝说明（长度、无动作行、带协议特征），模型正常回答里提到额度不计。
       */
      const kind: FaultKind = resultFault || judgeFault("reply", raw);
      if (kind) return done({ ok: false, text: faultText(kind) });
      if (raw) return done({ ok: true, text: raw });
      /* 正文为空但原始输出含上游错误时，按原始行判读。 */
      const upstream = upstreamErrorOf(rawAll);
      if (upstream) return done({ ok: false, text: upstream });
      const reason = emptyExitReason(err, code, signal);
      /* 失败时保留原始诊断：界面只给路径，stderr 原文含账号信息，不进消息流。 */
      const diag = err.trim() || rawAll
        ? writeChatDiag({
            at: new Date().toISOString(),
            caller: "askModelStream",
            host,
            bin: entry.bin,
            shell: entry.shell,
            code,
            signal,
            err: tailOf(err, 4000),
            raw_tail: rawAll.slice(-2000),
          })
        : "";
      done({ ok: false, text: withDiag(reason, diag) });
    });
  });
}
