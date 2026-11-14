/**
 * 自动纳管：工作目录命中用户级路径规则时创建任务根。
 *
 * 匹配按路径段进行，不区分分隔符：规则 `["cases","targets"]` 匹配
 * `<任意路径>/cases/targets/<项目名>`，匹配段之后的下一段成为任务根。
 * 规则后面没有下一段时不匹配任何目录，分类层本身不是一个项目。
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { readJson } from "../record/json";
import { createTaskRoot, RootExistsError } from "../contract/init";
import { normalizeForCompare, toNativePath } from "../record/paths";

/** 一条纳管规则。`match` 与 `exclude` 的段名一律转小写。 */
export interface WatchRule {
  match: string[];
  contract: string;
  exclude?: string[];
}

interface WatchFile {
  rules?: Array<{ match?: unknown; contract?: unknown; exclude?: unknown }>;
}

/**
 * 规则文件的中性回退路径。
 *
 * 与宿主相关的路径（第一个含 `capitalist-watch.json` 的宿主配置目录）由
 * `host/locations.ts` 解析，由持有该信息的调用方传入。此处的回退路径使 `core`
 * 不含宿主信息，同时在未安装任何宿主时仍能工作。
 *
 * @returns `CAPITALIST_WATCH_CFG` 环境变量指定的路径，或 `~/.capitalist/capitalist-watch.json`。
 */
export function defaultWatchConfigPath(): string {
  const env = process.env.CAPITALIST_WATCH_CFG;
  if (env) return env;
  return join(homedir(), ".capitalist", "capitalist-watch.json");
}

/**
 * 读用户级规则。
 *
 * @param file 规则文件路径，默认取 {@link defaultWatchConfigPath}。
 * @returns 规则列表。文件缺失或内容损坏时返回空列表；`match` 为空或 `contract`
 *   不是字符串的条目被跳过。
 */
export function loadWatchRules(file = defaultWatchConfigPath()): WatchRule[] {
  const data = readJson<WatchFile>(file, {});
  const out: WatchRule[] = [];
  for (const raw of data.rules ?? []) {
    const match = Array.isArray(raw.match) ? raw.match.map((m) => String(m).toLowerCase()) : [];
    if (match.length === 0 || typeof raw.contract !== "string") continue;
    out.push({
      match,
      contract: raw.contract,
      exclude: Array.isArray(raw.exclude) ? raw.exclude.map((e) => String(e).toLowerCase()) : [],
    });
  }
  return out;
}

/** 一次规则命中的结果。 */
export interface WatchMatch {
  /** 任务根的原生路径。 */
  root: string;
  contract: string;
}

/**
 * 判断一个目录属于哪个任务根，不改动文件系统。
 *
 * 返回第一条命中的规则。段下标在归一化后的副本上计算，再应用到原始路径，
 * 以保留原始大小写，Windows 的比较不区分大小写，路径本身区分。
 *
 * @returns 命中的任务根与契约名；没有规则命中时返回 null。
 */
export function matchWatchDir(cwd: string, rules = loadWatchRules()): WatchMatch | null {
  if (!cwd) return null;
  const native = toNativePath(cwd).replace(/\\/g, "/");
  const segments = normalizeForCompare(native).split("/");
  const original = native.split("/");

  for (const rule of rules) {
    const n = rule.match.length;
    for (let i = 0; i + n <= segments.length; i += 1) {
      if (!rule.match.every((m, k) => segments[i + k] === m)) continue;
      const j = i + n;
      const next = segments[j];
      if (!next) break; // 规则后没有下一段：分类层本身不构成项目，不匹配任何目录
      if (rule.exclude?.includes(next)) continue;
      return { root: original.slice(0, j + 1).join("/"), contract: rule.contract };
    }
  }
  return null;
}

/** 自动纳管失败的可诊断落点：用户级日志（失败时任务根可能仍不存在，写不进 `.capitalist/`）。 */
function noteAdoptFailure(root: string, err: unknown): void {
  const file = join(homedir(), ".capitalist", "adopt-errors.log");
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()}\t${root}\t${String((err as Error).message ?? err)}\n`, "utf8");
  } catch {
    /* 诊断写不进去不能反过来阻断纳管流程 */
  }
}

/** 为一个目录创建任务根，前提是规则命中且该目录尚无任务根。 */
export function autoAdopt(
  cwd: string,
  rules = loadWatchRules(),
  contractDirs: readonly string[] = [],
): string | null {
  const hit = matchWatchDir(cwd, rules);
  if (!hit) return null;
  if (!existsSync(hit.root)) return null;

  try {
    const target = hit.root.replace(/\\/g, "/").split("/").pop() ?? "task";
    createTaskRoot({ target, contractSpec: hit.contract, root: hit.root, contractDirs });
    return hit.root;
  } catch (err) {
    if (err instanceof RootExistsError) return hit.root;
    noteAdoptFailure(hit.root, err);
    return null;
  }
}
