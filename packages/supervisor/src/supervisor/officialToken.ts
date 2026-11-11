/**
 * 子进程使用的访问令牌。
 *
 * ## 下发是可选的
 *
 * 两个判据同时成立才启用：`CAPITALIST_TOKEN_INJECT=1`（意图），并且注入组件存在（能力）。
 * 缺任一个都不启用，令牌为空，工作进程与对话通道改用宿主 CLI 自身的登录态。
 *
 * ## 组件独立
 *
 * 注入实现不纳入版本库，也不参与编译。主流程不静态引用它，只在运行时按编译产物是否
 * 存在决定加载；产物缺失时该能力整体不存在，主流程不需要改动。
 *
 * ## 不落盘
 *
 * 令牌只留在进程内存与子进程环境：不写日志、不复制、不落盘，也不提供导出口令。
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/** 令牌来源。`host` 为宿主登录态，`env` 为启动时已取得的令牌。 */
export type TokenSource = "env" | "host" | "none";

/** 读取失败原因。`denied` 需用户重新执行并允许，`missing` 需先登录。 */
export type TokenFailure = "denied" | "missing" | "encrypted" | "empty" | "";

/** 注入组件的形状。实现由外部提供，主流程只按形状取用。 */
export interface TokenInjector {
  read(): { token: string; expiresAt: number; domain: string; failure: TokenFailure };
  diag(): Record<string, unknown>;
}

/** 缓存时长。被动解析只读环境，缓存只用来免掉重复解析。 */
const TTL_MS = 30_000;

let cache: { at: number; token: string; source: TokenSource } | null = null;

/** 启动时那次读取的失败原因，供诊断输出。被动解析不覆盖它。 */
let lastFailure: TokenFailure = "";

/** 已加载的组件实例；`undefined` 表示还没查过，`null` 表示不存在。 */
let injector: TokenInjector | null | undefined;

const req = createRequire(__filename);

/**
 * 是否下发令牌。
 *
 * 缺省关闭。宿主对自身登录态设有访问询问，读取会打断启动；需要沿用启动时读到的那份
 * 令牌时，置 `CAPITALIST_TOKEN_INJECT=1`。
 */
export function tokenInjectionEnabled(): boolean {
  return String(process.env.CAPITALIST_TOKEN_INJECT ?? "").trim() === "1";
}

/**
 * 加载注入组件。
 *
 * 判据是编译产物是否存在：产物缺失时返回 `null`，此后一律不注入，调用方无需改动。
 */
export function loadInjector(): TokenInjector | null {
  if (injector !== undefined) return injector;
  injector = null;
  const entry = join(__dirname, "..", "token-inject", "index.js");
  if (!existsSync(entry)) return injector;
  try {
    const mod = req(entry) as { createInjector?: () => TokenInjector };
    if (typeof mod?.createInjector === "function") injector = mod.createInjector();
  } catch {
    injector = null;
  }
  return injector;
}

/** 读取组件是否可用。供诊断命令与启动提示使用。 */
export function tokenInjectorPresent(): boolean {
  return loadInjector() !== null;
}

/**
 * 取宿主登录态。
 *
 * 只在启动命令里调用：读取会触发宿主的一次访问询问，必须发生在用户可见的调用路径上。
 * 组件不存在时按缺失处理，不尝试其它读取方式。
 */
export function readHostCredential(): {
  token: string;
  expiresAt: number;
  domain: string;
  failure: TokenFailure;
} {
  const inj = loadInjector();
  if (!inj) {
    lastFailure = "missing";
    return { token: "", expiresAt: 0, domain: "", failure: "missing" };
  }
  const r = inj.read();
  lastFailure = r.failure;
  return r;
}

/** 读取诊断。开关关闭只报关闭；开启时才检查组件，不触碰读取路径。 */
export function hostTokenDiag(): Record<string, unknown> {
  if (!tokenInjectionEnabled()) return { injection: "off" };
  const inj = loadInjector();
  if (!inj) return { injection: "absent", reason: "注入组件不存在" };
  return { injection: "on", ...inj.diag() };
}

/**
 * 被动解析：只取已经在环境里的令牌。
 *
 * 这里不读任何文件。令牌只有一个来源：启动命令读到后写进环境，
 * 由整棵进程树继承。
 */
function resolvePassive(): { token: string; source: TokenSource } {
  const fromEnv = String(process.env.CAPITALIST_HOST_TOKEN ?? "").trim();
  if (fromEnv) return { token: fromEnv, source: "env" };

  return { token: "", source: "none" };
}

function refresh(): { token: string; source: TokenSource } {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache;
  cache = { at: now, ...resolvePassive() };
  return cache;
}

/** 当前可用的令牌；取不到返回空串。 */
export function officialAccessToken(): string {
  return refresh().token;
}

/** 令牌来源：`env` 启动时取到，`host` 宿主登录态，`none` 不可用。 */
export function officialTokenSource(): TokenSource {
  return refresh().source;
}

/** 启动时那次读取的失败原因，供启动日志给出对应的下一步。 */
export function officialTokenFailure(): TokenFailure {
  return lastFailure;
}

/**
 * 启动命令调用：在开关打开且组件存在时读一次宿主登录态。
 *
 * 读到的令牌写进本进程环境，由监工与它拉起的所有进程继承；此后对话、派单、工作进程
 * 都只读环境，不会再询问第二次。读不到时不反复重试，由调用方输出一次明确提示。
 *
 * @returns 取到时的来源；未取到返回 `none`。
 */
export function warmHostToken(): TokenSource {
  const fromEnv = String(process.env.CAPITALIST_HOST_TOKEN ?? "").trim();
  if (fromEnv) {
    cache = null;
    return "env";
  }

  if (!tokenInjectionEnabled()) {
    lastFailure = "";
    return "none";
  }

  const host = readHostCredential();
  if (host.token) {
    process.env.CAPITALIST_HOST_TOKEN = host.token;
    cache = null;
    return "host";
  }
  return "none";
}

/** 测试用：清空缓存，避免上一条用例的结果影响下一条。 */
export function resetOfficialTokenCacheForTest(): void {
  cache = null;
  injector = undefined;
}
