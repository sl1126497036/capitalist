/**
 * npm 上的版本检查。
 *
 * 只读：不发安装命令、不改本机配置。检查结果缓存 24 小时，`capitalist --version`
 * 借缓存补一行提示，因此日常命令不联网、不等待。
 *
 * 升级动作始终交给用户显式执行 `npm i -g capitalist`：CLI 自身在运行时替换自己的
 * 文件，在 Windows 上会因文件被占用而失败，失败后还可能留下半个包。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { get } from "node:https";

/** 包名与注册表地址。名字改动时两处一起改。 */
const PACKAGE_NAME = "capitalist";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

/** 缓存有效期。一天一次足够，nvm 与环境迁移都不受影响。 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 单次请求的超时。离线环境按这个上限等待后放弃。 */
const DEFAULT_TIMEOUT_MS = 3000;

/** 一次检查的结论。 */
export interface UpdateStatus {
  local: string;
  latest: string;
  outdated: boolean;
  /** ISO 时间串，说明这条结论是什么时候拿到的 */
  checkedAt: string;
}

export type CheckOutcome =
  | { ok: true; status: UpdateStatus; cached: boolean }
  | { ok: false; message: string };

/** 缓存位置。`CAPITALIST_UPDATE_CACHE` 用于测试与多实例隔离，避免写进真实家目录。 */
function cacheFile(): string {
  const env = process.env.CAPITALIST_UPDATE_CACHE;
  if (env) return env;
  return join(homedir(), ".capitalist", "update-check.json");
}

/**
 * 比较两个 `x.y.z` 版本号。
 *
 * 只处理数字段：本项目不使用预发布标签，遇到多余段按前列比较，避免在没发布过的
 * 形态上做出错误判断。
 *
 * @returns 负数表示 a 旧于 b，0 表示相同，正数表示 a 新于 b。
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10));
  const pb = b.split(".").map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function readCache(local: string): UpdateStatus | null {
  try {
    const f = cacheFile();
    if (!existsSync(f)) return null;
    const d = JSON.parse(readFileSync(f, "utf8")) as Partial<UpdateStatus>;
    if (typeof d.latest !== "string" || typeof d.checkedAt !== "string") return null;
    // 缓存里的判断只对同一下载版本有效：升级之后旧的“有新版本”可能已经不成立。
    if (d.local !== local) return null;
    return {
      local,
      latest: d.latest,
      outdated: d.outdated === true,
      checkedAt: d.checkedAt,
    };
  } catch {
    return null;
  }
}

function writeCache(status: UpdateStatus): void {
  try {
    const f = cacheFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(status, null, 2), "utf8");
  } catch {
    /* 写不进去只影响下次仍要联网，不影响本次结论。 */
  }
}

/**
 * 向注册表问一次最新版本。
 *
 * @returns 版本号；包尚未发布（404）返回空串；网络或解析失败返回 `null`，由调用方
 *   区分“没有这个包”与“问不到”。
 */
function fetchLatestVersion(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const req = get(REGISTRY_URL, { timeout: timeoutMs }, (res) => {
      const code = res.statusCode ?? 0;
      if (code === 404) {
        res.resume();
        resolve("");
        return;
      }
      if (code !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        // 响应体只读取 version 字段；超过 64 KB 按异常响应处理。
        if (body.length < 64 * 1024) body += chunk;
      });
      res.on("end", () => {
        try {
          const v = (JSON.parse(body) as { version?: unknown }).version;
          resolve(typeof v === "string" ? v : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

/**
 * 查一次是否有新版本。
 *
 * @param local 当前运行版本的版本号，由调用方给出，避免本模块依赖 CLI 层。
 * @param opts.force 忽略缓存，强制联网。
 */
export async function checkUpdate(
  local: string,
  opts: { force?: boolean; timeoutMs?: number } = {},
): Promise<CheckOutcome> {
  if (!opts.force) {
    const cached = readCache(local);
    if (cached) {
      const age = Date.now() - Date.parse(cached.checkedAt);
      if (Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS) {
        return { ok: true, status: cached, cached: true };
      }
    }
  }

  const latest = await fetchLatestVersion(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (latest === null) {
    return { ok: false, message: `连不上 npm 注册表（超时 ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms 或网络不可用），本次不判断版本` };
  }
  if (latest === "") {
    return { ok: false, message: `npm 上还没有 ${PACKAGE_NAME} 这个包，无法比较版本` };
  }

  const status: UpdateStatus = {
    local,
    latest,
    outdated: compareVersions(local, latest) < 0,
    checkedAt: new Date().toISOString(),
  };
  writeCache(status);
  return { ok: true, status, cached: false };
}

/**
 * 读缓存里的版本提示，供 `capitalist --version` 追加一行。
 *
 * 不联网：缓存过期或没有缓存时返回 null，日常命令因此没有额外等待。
 */
export function cachedUpdateNotice(local: string): string | null {
  const cached = readCache(local);
  if (!cached || !cached.outdated) return null;
  return `npm 上已有 ${cached.latest}，升级：npm i -g ${PACKAGE_NAME}`;
}
