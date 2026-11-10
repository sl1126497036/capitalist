/**
 * 安装器：把 hook 配置写进已安装的宿主。
 *
 * ## 职责边界
 *
 * 本文件只负责机制：幂等合并、只动 `hooks` 键、保留用户原有条目、卸载时识别自有条目。
 * 「写哪些事件、命令长什么样、装完还差哪一步」是各 impl 的 `InstallFacet`。
 *
 * 不同宿主的分发与生效方式不同，差异不在「怎么跑 hook」，而在「怎么让 hook 跑起来」。
 * 后置条件以 impl 的 `notice` / `preconditions` 数据表示，由安装器输出。
 *
 * ## 合并原则
 *
 * 只增改 `hooks` 下的自有条目：按标记移除旧条目再追加，重复执行结果相同；
 * 其余键（用户的 permissions、env、其他 hook）一律原样保留。安装器无权改动用户的其它配置。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { writeJson } from "../core/json";
import type { HostImpl, InstallContext, InstallEntry } from "../host/contract";
import { all, byId, normalize } from "../host/registry";
import { watchConfigPath } from "../host/locations";

/**
 * 自有条目的识别标记。安装器靠它做幂等，用户也靠它在配置里认出这段是谁写的。
 * 已写入宿主配置的条目按此值识别，取值与包名解耦，改包名不改此值。
 */
const MARKER = "capitalist-supervisor";

/**
 * 手册在宿主 skills 目录下的名字。
 *
 * 取包名而不取 `supervisor`：宿主以目录名作为 skill 名展示；列表显示「supervisor」时，
 * 与用户指令中的「监工」无法对应。
 */
const SKILL_NAME = "capitalist";

/** 旧版本目录名；安装与卸载时清理。 */
const LEGACY_SKILL_NAMES = ["supervisor"];

/** 安装入参。 */
export interface InstallOptions {
  hosts?: string[] | undefined;
  dryRun?: boolean;
  /** 输出每个宿主的落点、条目数与后置条件。缺省输出一行结论。 */
  verbose?: boolean;
  /**
   * hook 写进哪个任务根的项目级配置。
   *
   * 缺省取当前工作目录，`capitalist install` 的语义是「把本项目的监工接到宿主上」，
   * 站在项目里执行就装到这个项目。不再退到用户级：写宿主的用户级配置目录
   * 会让这台机器上所有项目、所有会话的每次工具调用都 spawn 一次 hook，
   * Windows 上就是一直闪窗。要装到别的项目就显式 `--root`。
   */
  root?: string | undefined;
}

/** 卸载入参。 */
export interface UninstallOptions {
  hosts?: string[] | undefined;
  /** 保留已投放的 skill 手册 */
  keepSkill?: boolean;
  /** 输出每个宿主的落点与摘除条数。缺省输出一行结论。 */
  verbose?: boolean;
  /** 项目级配置所在的任务根。缺省取当前工作目录。 */
  root?: string | undefined;
}

/**
 * 把用户给的 `--agent` 换成 impl。未知取值直接报错，不静默跳过。
 *
 * @param requested 宿主 id 列表。省略或为空时自动探测已安装的宿主。
 * @returns 命中的 impl 与未识别的原始取值。
 */
function resolveHosts(requested: string[] | undefined): { impls: HostImpl[]; unknown: string[] } {
  if (!requested?.length) {
    return {
      // fallback impl（通用回退）不参与自动安装：它不对应用户实际在用的宿主，
      // 自动写一份无人读取的配置只会增加噪音。
      impls: all().filter((impl) => !impl.fallback && isInstalled(impl)),
      unknown: [],
    };
  }
  const impls: HostImpl[] = [];
  const unknown: string[] = [];
  for (const raw of requested) {
    const id = normalize(raw);
    const impl = id ? byId(id) : null;
    if (impl) impls.push(impl);
    else unknown.push(raw);
  }
  return { impls, unknown };
}

/**
 * 该宿主是否已安装。配置目录存在即视为已安装。
 */
function isInstalled(impl: HostImpl): boolean {
  return existsSync(join(homedir(), impl.configDir));
}

/**
 * hook 入口脚本的绝对路径。安装器与被安装的脚本同在 dist/ 下，用相对关系推导。
 */
function hookEntryPath(): string {
  // 运行时 __dirname 为 <包根>/dist/install，入口脚本在同级的 host 目录下。
  return join(__dirname, "..", "host", "main.js");
}

/**
 * 构造传给 impl 的安装上下文。
 */
function installContext(): InstallContext {
  return {
    entry: hookEntryPath(),
    node: process.execPath,
    marker: MARKER,
    platform: process.platform,
  };
}

/** 判断一个既有条目是不是本安装器写入的。 */
function isOurs(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const hooks = (entry as InstallEntry).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h) => {
    const cmd = String(h?.command ?? "");
    const msg = String(h?.statusMessage ?? "");
    return (
      cmd.includes(MARKER) ||
      cmd.includes("capitalist-hook") ||
      msg.includes(MARKER)
    );
  });
}

/** 合并结果。`added` 是新增的自有条目数，`kept` 是保留的用户原有条目数。 */
interface MergeResult {
  added: number;
  kept: number;
  file: string;
}

/**
 * 读宿主配置文件为对象。
 *
 * 文件不存在按空对象处理（首次安装）；存在但不是 JSON 对象时抛出带修复指引的错误，
 * 由调用方转成面向使用者的失败信息。安装与卸载共用这一份读取：两处各写一份时，
 * 同一份坏文件会在安装时报「拒绝覆盖」、在卸载时被当成空配置，卸载于是报告成功而 hook
 * 仍留在配置里。
 *
 * @throws 文件存在但不是合法 JSON 时抛出。
 */
function readSettings(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} 不是合法 JSON，拒绝覆盖。请先手工修复或备份后重试。`);
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * 把计划合并进配置文件。只动 hooks，其余键原样保留。
 *
 * @param dryRun 为真时只计算结果，不落盘。
 */
function mergeSettings(file: string, plan: Record<string, InstallEntry[]>, dryRun: boolean): MergeResult {
  const data = readSettings(file);

  const hooks = (data.hooks && typeof data.hooks === "object" ? data.hooks : {}) as Record<
    string,
    unknown
  >;
  let added = 0;
  let kept = 0;

  for (const [event, entries] of Object.entries(plan)) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const foreign = existing.filter((e) => !isOurs(e));
    kept += foreign.length;
    hooks[event] = [...foreign, ...entries];
    added += entries.length;
  }

  data.hooks = hooks;
  if (!dryRun) {
    mkdirSync(dirname(file), { recursive: true });
    writeJson(file, data);
  }
  return { added, kept, file };
}

/**
 * 用户尚无纳管规则时写入模板。已存在则不覆盖。
 *
 * 写入引擎实际读取的路径（`watchConfigPath()`），不写到某个宿主下的固定目录：
 * 那样只有该宿主的用户会拿到模板，其余用户的自动纳管会静默失效。
 *
 * @param dryRun 为真时只返回路径，不落盘。
 * @returns 模板路径；文件已存在时返回 null。
 */
function ensureWatchConfig(dryRun: boolean): string | null {
  const file = watchConfigPath();
  if (existsSync(file)) return null;
  const template = {
    _说明:
      "自动纳管规则：cwd 的路径段连续匹配 match 时，把匹配段之后的第一级目录作为任务根。"
      + "在该目录（或它的子目录）里第一次发话就会建根，之后不需要 capitalist start。",
    _示例: { match: ["projects", "web"], contract: "generic", exclude: ["node_modules", "dist"] },
    rules: [],
  };
  if (!dryRun) {
    mkdirSync(dirname(file), { recursive: true });
    writeJson(file, template);
  }
  return file;
}

/** 移除已注册的 hook 与投放的 skill。 */
export function runUninstall(opts: UninstallOptions): number {
  const { impls, unknown } = resolveHosts(opts.hosts);
  if (unknown.length > 0) {
    process.stderr.write(
      `✗ 未知的 agent：${unknown.join(" / ")}\n  可用：${all().map((impl) => impl.id).join(" | ")}\n`,
    );
    return 1;
  }
  if (impls.length === 0) {
    process.stderr.write(
      "✗ 没有检测到可卸载的 agent\n" +
        `  用 --agent 指定：${all().map((impl) => impl.id).join(" | ")}\n`,
    );
    return 1;
  }

  const done: HostImpl[] = [];
  const failed: Array<{ label: string; reasons: string[] }> = [];
  const details: string[] = [];

  const root = opts.root ?? process.cwd();

  for (const impl of impls) {
    /* 同时清理项目级与用户级配置中的 hook 条目。 */
    const targets: string[] = [];
    const projectFile = hookSettingsFile(impl, root);
    if (projectFile) targets.push(projectFile);
    const userFile = join(homedir(), impl.configDir, impl.settingsFile);
    if (!targets.includes(userFile)) targets.push(userFile);

    let removedTotal = 0;
    const trouble: string[] = [];

    for (const file of targets) {
      if (!existsSync(file)) continue;
      try {
        const data = readSettings(file);
        const hooks = data.hooks as Record<string, unknown> | undefined;
        let touched = false;
        let removed = 0;

        if (hooks && typeof hooks === "object") {
          for (const [event, arr] of Object.entries(hooks)) {
            if (!Array.isArray(arr)) continue;
            const kept = arr.filter((e) => !isOurs(e));
            if (kept.length === arr.length) continue;
            removed += arr.length - kept.length;
            touched = true;
            if (kept.length > 0) hooks[event] = kept;
            else delete hooks[event];
          }
          if (touched && Object.keys(hooks).length === 0) delete data.hooks;
        }

        if (touched) {
          writeJson(file, data);
          removedTotal += removed;
          details.push(`${impl.label}：摘除 ${removed} 条（${file}）`);
        }
      } catch (err) {
        trouble.push(`${file}：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (trouble.length > 0) {
      failed.push({ label: impl.label, reasons: trouble.map((line) => `原因：${line}`) });
    } else {
      if (removedTotal === 0) details.push(`${impl.label}：没有自有条目`);
      done.push(impl);
    }

    if (!opts.keepSkill) {
      for (const name of [SKILL_NAME, ...LEGACY_SKILL_NAMES]) {
        const skillDir = join(homedir(), impl.configDir, "skills", name);
        if (!existsSync(skillDir)) continue;
        try {
          rmSync(skillDir, { recursive: true, force: true });
          details.push(`${impl.label}：已删除手册 ${skillDir}`);
        } catch (err) {
          failed.push({
            label: `${impl.label} 手册`,
            reasons: [`原因：${err instanceof Error ? err.message : String(err)}`],
          });
        }
      }
    }
  }

  if (done.length > 0) {
    process.stdout.write(`✓ 卸载成功 · ${done.map((impl) => impl.label).join("、")}\n`);
    process.stdout.write("  宿主重启后 hook 才停止加载\n");
    process.stdout.write("  任务数据已保留；移除包本体：npm uninstall -g capitalist\n");
  }
  for (const f of failed) {
    process.stderr.write(`✗ 卸载失败 · ${f.label}\n`);
    for (const line of f.reasons) process.stderr.write(`  ${line}\n`);
  }
  if (opts.verbose === true && details.length > 0) {
    process.stdout.write("\n");
    for (const line of details) process.stdout.write(`  · ${line}\n`);
  }
  return failed.length > 0 ? 1 : 0;
}

export interface HealResult {
  installed: string[];
  ok: string[];
  failed: { id: string; message: string }[];
}

/** 计划里的每个事件是否都已有本安装器的条目。 */
function hooksComplete(data: Record<string, unknown>, plan: Record<string, InstallEntry[]>): boolean {
  const hooks = (data.hooks && typeof data.hooks === "object" ? data.hooks : {}) as Record<string, unknown>;
  for (const event of Object.keys(plan)) {
    const rows = hooks[event];
    if (!Array.isArray(rows) || !rows.some((e) => isOurs(e))) return false;
  }
  return true;
}

/** 自检并补装 hook（幂等，只动 `hooks` 键）。 */
export function ensureHooks(hostIds: string[], root?: string): HealResult {
  const result: HealResult = { installed: [], ok: [], failed: [] };
  const ctx = installContext();

  for (const raw of hostIds) {
    const id = normalize(raw);
    const impl = id ? byId(id) : null;
    if (!impl?.install) continue;
    const file = hookSettingsFile(impl, root);
    if (!file) {
      // 没有项目级落点就别装：写用户级会让这台机器上每个会话都背上这个 hook。
      result.failed.push({
        id: impl.id,
        message: "该宿主只有用户级配置，已跳过（写用户级会污染所有会话的每次工具调用）",
      });
      continue;
    }
    try {
      const plan = impl.install.plan(ctx);
      if (hooksComplete(readSettings(file), plan)) {
        result.ok.push(impl.id);
        continue;
      }
      mergeSettings(file, plan, false);
      result.installed.push(`${impl.id}(${file})`);
    } catch (err) {
      result.failed.push({ id: impl.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

function hookSettingsFile(impl: HostImpl, root?: string): string | null {
  if (!root || !impl.settingsFile || impl.projectLocal !== true) return null;
  return join(root, impl.configDir, "settings.local.json");
}

/**
 * 该宿主在指定任务根下是否已装自有 hook。
 *
 * 判据：项目级配置中存在本安装器的 hook 条目。
 */
export function hostInstalled(impl: HostImpl, root: string): boolean {
  const file = hookSettingsFile(impl, root);
  if (!file || !existsSync(file)) return false;
  try {
    const data = readSettings(file);
    const hooks = data.hooks;
    if (!hooks || typeof hooks !== "object") return false;
    return Object.values(hooks as Record<string, unknown>).some(
      (rows) => Array.isArray(rows) && rows.some((entry) => isOurs(entry)),
    );
  } catch {
    return false;
  }
}

/**
 * 给宿主相关的说明加上宿主名。
 *
 * impl 提供的文案可能已包含宿主名，直接拼接会出现重复的宿主名。
 */
function withHost(impl: HostImpl, text: string): string {
  return text.startsWith(impl.label) ? text : `${impl.label}：${text}`;
}

/**
 * 安装 hook 到指定宿主：幂等合并配置、生成自动纳管规则模板、投放监工手册。
 *
 * 默认只输出一行结论；落点、条目数与后置条件在 `verbose` 或 `dryRun` 时列出。
 * 失败时输出原因与修复方式。
 *
 * @returns 退出码。全部成功时返回 0。
 */
export function runInstall(opts: InstallOptions): number {
  const { impls, unknown } = resolveHosts(opts.hosts);
  if (unknown.length > 0) {
    process.stderr.write(
      `✗ 未知的 agent：${unknown.join(" / ")}\n  可用：${all().map((impl) => impl.id).join(" | ")}\n`,
    );
    return 1;
  }

  const installable = impls.filter((impl) => impl.install);
  if (installable.length === 0) {
    process.stderr.write(
      "✗ 没有检测到可安装的 agent\n" +
        `  用 --agent 指定：${all().map((impl) => impl.id).join(" | ")}\n`,
    );
    return 1;
  }

  const entry = hookEntryPath();
  if (!existsSync(entry)) {
    process.stderr.write(
      "✗ 安装失败\n" +
        `  原因：入口脚本不存在（${entry}）\n` +
        "  修复：在包目录执行 npm run build 后重试\n",
    );
    return 1;
  }

  const ctx = installContext();
  const root = opts.root ?? process.cwd();
  const dryRun = opts.dryRun === true;
  const verbose = opts.verbose === true || dryRun;

  const done: HostImpl[] = [];
  const failed: Array<{ label: string; reasons: string[] }> = [];
  const details: string[] = [];
  const notes: string[] = [];

  for (const impl of installable) {
    const facet = impl.install;
    if (!facet) continue;
    /* 未安装该宿主时不预置配置：配置无对应读取方，且会在用户家目录创建空目录。 */
    if (!existsSync(join(homedir(), impl.configDir))) {
      notes.push(`${impl.label}：未检测到该宿主，已跳过`);
      continue;
    }
    const file = hookSettingsFile(impl, root);
    if (!file) {
      notes.push(`${impl.label}：该宿主没有项目级配置落点，已跳过`);
      continue;
    }
    try {
      const plan = facet.plan(ctx);
      const res = mergeSettings(file, plan, dryRun);
      done.push(impl);
      details.push(`${impl.label}：${res.file}（新增 ${res.added} 条，保留原有 ${res.kept} 条）`);
      /* 前置条件记录安装完成后的待办步骤：不阻断安装，可在 --verbose 输出中查询。 */
      for (const p of facet.preconditions?.(ctx) ?? []) notes.push(withHost(impl, p));
      const n = facet.notice?.() ?? null;
      if (n) notes.push(withHost(impl, n));
    } catch (err) {
      failed.push({
        label: impl.label,
        reasons: [`原因：${err instanceof Error ? err.message : String(err)}`],
      });
    }
  }

  /* 自动纳管规则模板对应自然语言启动这一主要用法；缺少该模板时只能使用显式 capitalist start。 */
  try {
    const created = ensureWatchConfig(dryRun);
    if (created) details.push(`自动纳管规则模板：${created}`);
  } catch (err) {
    const target = watchConfigPath();
    failed.push({
      label: "自动纳管规则",
      reasons: [
        `原因：${err instanceof Error ? err.message : String(err)}`,
        `目标：${target}`,
        `修复：确认 ${dirname(target)} 可写，或设 CAPITALIST_WATCH_CFG 指向可写路径后重试`,
      ],
    });
  }

  /* 手册随安装投放：`npm i -g` 之后宿主要从自己的 skills 目录读到它。 */
  try {
    const res = ensureSkillManual(installable, dryRun);
    /* 逐条输出落点：宿主未读到手册时，可据此查询写入路径。 */
    for (const p of res.placed) details.push(`手册：${p}`);
    if (res.cleaned.length > 0) details.push(`旧版手册目录：已清理 ${res.cleaned.length} 处`);
    for (const f of res.failed) failed.push({ label: "监工手册", reasons: [`原因：${f}`] });
  } catch (err) {
    failed.push({
      label: "监工手册",
      reasons: [`原因：${err instanceof Error ? err.message : String(err)}`],
    });
  }

  if (done.length > 0) {
    const label = done.map((impl) => impl.label).join("、");
    process.stdout.write(dryRun ? `（dry-run）将安装 · ${label}\n` : `✓ 安装成功 · ${label}\n`);
    if (!dryRun) process.stdout.write("  重启宿主后生效\n");
  } else if (failed.length === 0) {
    process.stderr.write("✗ 没有可安装的 agent\n");
    for (const line of notes) process.stderr.write(`  ${line}\n`);
    return 1;
  }
  for (const f of failed) {
    process.stderr.write(`✗ 安装失败 · ${f.label}\n`);
    for (const line of f.reasons) process.stderr.write(`  ${line}\n`);
  }
  if (verbose && (details.length > 0 || notes.length > 0)) {
    process.stdout.write("\n");
    for (const line of details) process.stdout.write(`  · ${line}\n`);
    for (const line of notes) process.stdout.write(`  · ${line}\n`);
  }
  if (dryRun) process.stdout.write("\n（dry-run：以上改动未落盘）\n");
  return failed.length > 0 ? 1 : 0;
}

/**
 * 手册下标：安装包里 vendor 的那份 → 仓库根的那份（开发态）→ 环境变量指定。
 *
 * 发布包里只有 `skill/SKILL.md`；从仓库直接跑时这个目录不在包内，源头在仓库根。
 * 两份同名但只有一份是源，构建时由 `scripts/vendor-skill.mjs` 从根同步进包。
 */
function skillManualSource(): string | null {
  const env = process.env.CAPITALIST_SKILL_SRC;
  if (env && existsSync(env)) return env;
  const candidates = [
    join(__dirname, "..", "..", "skill", "SKILL.md"),
    join(__dirname, "..", "..", "..", "skill", "SKILL.md"),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

/**
 * 将手册投放至各宿主的 skills 目录，并清理旧版本目录。
 *
 * 落点与 `capitalist uninstall` 删除的是同一个路径：`<configDir>/skills/capitalist/SKILL.md`。
 * 只投给已经装了的宿主，没装的宿主连 configDir 都没有，写进去只会留垃圾。
 *
 * @returns placed 为投放的路径，cleaned 为已清理的旧目录，failed 为失败项。
 */
export function ensureSkillManual(
  impls: HostImpl[],
  dryRun: boolean,
): { placed: string[]; failed: string[]; cleaned: string[] } {
  const placed: string[] = [];
  const failed: string[] = [];
  const cleaned: string[] = [];
  const src = skillManualSource();
  if (!src) {
    failed.push("找不到手册源文件（skill/SKILL.md）；包不完整，重装 capitalist");
    return { placed, failed, cleaned };
  }
  const body = readFileSync(src, "utf8");
  for (const impl of impls) {
    const target = join(homedir(), impl.configDir, "skills", SKILL_NAME, "SKILL.md");
    try {
      if (!dryRun) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, body, "utf8");
      }
      placed.push(target);
    } catch (err) {
      failed.push(`${target}：${err instanceof Error ? err.message : String(err)}`);
    }
    /* 旧目录只在它确实含本手册时清理：同名的用户自建目录不动。 */
    for (const legacy of LEGACY_SKILL_NAMES) {
      const dir = join(homedir(), impl.configDir, "skills", legacy);
      if (!existsSync(join(dir, "SKILL.md"))) continue;
      try {
        if (!dryRun) rmSync(dir, { recursive: true, force: true });
        cleaned.push(dir);
      } catch (err) {
        failed.push(`${dir}：旧目录清理失败（${err instanceof Error ? err.message : String(err)}）`);
      }
    }
  }
  return { placed, failed, cleaned };
}
