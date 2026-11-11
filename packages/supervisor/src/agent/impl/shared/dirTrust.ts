/**
 * 同族宿主的目录准备共用实现：目录信任与项目级权限。
 *
 * 这类宿主首次在某个目录里启动会停在交互式确认
 *
 *   Do you trust the files in this folder?  > 1. Trust folder only
 *
 * 该确认只能由人按键，非交互模式下表现为无输出挂死。非交互模式也没有 TUI 可以点
 * “允许”，未授权时工具调用被直接拒绝，因此同时补齐项目级权限。
 *
 * 写入位置与条件：
 * - `<家目录>/<configDir>/settings.json` 的 `trustedDirectories`：追加当前任务根。
 *   文件不存在、不是合法 JSON、写入失败时不改该文件。
 * - `<任务根>/<configDir>/settings.json` 的 `permissions`：已存在 `defaultMode` 时不写。
 *   写入时补 `defaultMode` 与 `allow`，已有的 `allow` 保留。
 *
 * 用户已有的信任条目与其它键不改动。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { WorkspaceFacet } from "../../contract";

/** 统一成宿主 settings.json 里既有的写法：正斜杠、无尾斜杠、Windows 盘符大写。 */
export function normalizeDir(p: string): string {
  const abs = resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return abs.replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`);
}

function sameDir(a: string, b: string): boolean {
  return normalizeDir(a).toLowerCase() === normalizeDir(b).toLowerCase();
}

/** 开工前准备目录的输入：一个宿主写哪个文件、放行哪些工具。 */
export interface WorkspaceOptions {
  /** 家目录下的配置目录名，例如某宿主的 `.xxx` */
  configDir: string;
  /** 面向用户的宿主名，只出现在提示文案里 */
  label: string;
  /** 项目级配置里的默认权限档位；宿主不识别该键时置空，跳过权限补齐。 */
  defaultMode: string;
  /** 默认放行的工具列表 */
  allow: string[];
  /**
   * 家目录解析，仅供测试注入。
   *
   * 省略时写真实家目录。测试需要把写入重定向到临时目录时通过本字段注入。
   */
  home?: () => string;
  /**
   * 项目级权限写到哪个目录，相对任务根。
   *
   * 省略时与 `configDir` 相同；置 `null` 表示不写项目级配置。需要置空的场合是
   * 该目录出现在项目里会改变宿主自身行为：WorkBuddy 见到 `.codebuddy` 即转受限模式，
   * 不执行终端命令，写进去等于把工作区弄坏。
   */
  projectConfigDir?: string | null;
}

/**
 * 同族宿主共用的项目级权限档位与放行清单。
 *
 * `defaultMode` 是宿主的权限档位名，`allow` 是它认的工具名，两者都属宿主协议，
 * 因此放在 shared 而不是顶层。
 */
export const TRUST_PRESET: Pick<WorkspaceOptions, "defaultMode" | "allow"> = {
  defaultMode: "acceptEdits",
  allow: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
};

function homeOf(opts: WorkspaceOptions): string {
  return opts.home?.() ?? homedir();
}

function settingsPath(opts: WorkspaceOptions): string {
  return join(homeOf(opts), opts.configDir, "settings.json");
}

/**
 * 把 root 写入信任列表。
 *
 * 不抛异常，失败时返回原因。
 *
 * 写入路径是 `<家目录>/<configDir>/settings.json` 的 `trustedDirectories` 数组，只追加
 * 任务根一项。文件不存在、不是合法 JSON、写入失败这三种情况都不改动该文件。写入前先在
 * 同目录留一份 `.supervisor.bak` 备份。
 */
function ensureTrustedDir(root: string, opts: WorkspaceOptions): { ok: boolean; added: boolean; message: string } {
  const file = settingsPath(opts);
  const dir = normalizeDir(root);

  if (!existsSync(file)) {
    return {
      ok: false,
      added: false,
      message: `没找到 ${file}（${opts.label} 尚未初始化）。先手动跑一次 ${opts.label} 完成登录与初始配置。`,
    };
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      added: false,
      message: `${file} 不是合法 JSON，未改动：${String((err as Error).message ?? err)}`,
    };
  }

  const current = Array.isArray(raw.trustedDirectories)
    ? (raw.trustedDirectories.filter((x): x is string => typeof x === "string") as string[])
    : [];

  if (current.some((d) => sameDir(d, dir))) {
    return { ok: true, added: false, message: `任务根已在 ${opts.label} 信任列表：${dir}` };
  }

  raw.trustedDirectories = [...current, dir];
  try {
    // 改用户配置前留一份 .supervisor.bak 备份。
    copyFileSync(file, `${file}.supervisor.bak`);
    // 不用 tmp + rename：Windows 上宿主常驻进程会持有该文件的句柄，
    // rename 覆盖会得到 EPERM。原地截断写可以避开这一点。
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  } catch (err) {
    return {
      ok: false,
      added: false,
      message: `写入 ${file} 失败：${String((err as Error).message ?? err)}`,
    };
  }

  return { ok: true, added: true, message: `已把任务根加入 ${opts.label} 信任列表：${dir}` };
}

/**
 * 在任务根写入项目级权限。
 *
 * 写入路径是 `<任务根>/<configDir>/settings.json` 的 `permissions` 键。已存在
 * `permissions.defaultMode` 时不写；否则写入 `defaultMode` 与 `allow`，`allow` 只在缺失
 * 时补齐，不覆盖已有列表。文件不是合法 JSON 或写入失败时都不改动该文件。
 */
function ensureProjectPermissions(root: string, opts: WorkspaceOptions): { ok: boolean; added: boolean; message: string } {
  const projConfigDir = opts.projectConfigDir === undefined ? opts.configDir : opts.projectConfigDir;
  if (!projConfigDir) {
    /* 该项目目录会改变宿主行为（例如 WorkBuddy 见到 `.codebuddy` 即转受限模式），不写。 */
    return { ok: true, added: false, message: `按配置跳过项目级权限：${opts.label} 不在任务根下建配置目录` };
  }
  const dir = join(root, projConfigDir);
  const file = join(dir, "settings.json");
  let raw: Record<string, unknown> = {};
  let existed = false;

  if (existsSync(file)) {
    existed = true;
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      return { ok: false, added: false, message: `${file} 不是合法 JSON，未改动` };
    }
  }

  const perms = (raw.permissions && typeof raw.permissions === "object")
    ? (raw.permissions as Record<string, unknown>)
    : {};
  if (typeof perms.defaultMode === "string" && perms.defaultMode) {
    return { ok: true, added: false, message: `项目权限已配置（defaultMode=${perms.defaultMode}）` };
  }

  perms.defaultMode = opts.defaultMode;
  perms.allow = Array.isArray(perms.allow) ? perms.allow : [...opts.allow];
  raw.permissions = perms;

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  } catch (err) {
    return {
      ok: false,
      added: false,
      message: `写入 ${file} 失败：${String((err as Error).message ?? err)}`,
    };
  }

  return {
    ok: true,
    added: true,
    message: existed ? `已补齐项目权限：${file}` : `已写入项目权限：${file}`,
  };
}

/**
 * 组合成 workspace facet。
 *
 * 顺序固定：先信任目录，再补权限。权限写进项目配置，宿主还没信任这个目录时不会读取。
 */
export function createWorkspaceFacet(opts: WorkspaceOptions): WorkspaceFacet {
  return {
    prepare(root: string) {
      const trust = ensureTrustedDir(root, opts);
      const perm = ensureProjectPermissions(root, opts);
      return {
        ok: trust.ok && perm.ok,
        added: trust.added || perm.added,
        message: [trust.message, perm.ok ? perm.message : `项目权限未写入：${perm.message}`].join("；"),
      };
    },
  };
}
