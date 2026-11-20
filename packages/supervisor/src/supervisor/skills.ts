/**
 * 宿主的技能清单。
 *
 * 技能不专属某一方：监工自己执行时可能用到（查资料、写契约、改文案），工作进程落地时
 * 也可能用到（改代码、跑测试）。因此本模块放在监工侧，由调用方决定怎么用。
 * 看板下拉、监工对话层、工作进程提示词都从这里取，口径唯一。
 *
 * 路径按宿主分别展开，取自 registry 的 `configDir`：各宿主的配置目录名不同
 * （`.claude` / `.codebuddy` / `.workbuddy`），硬编码一份清单会在新增宿主时漏掉。
 * 通用（fallback）条目不参与：`.capitalist` 不对应真实宿主的技能目录。
 *
 * 两个来源：
 *
 * - 技能目录：`<任务根|用户家目录>/<configDir>/skills/<名称>/SKILL.md`，用户自己放进去的。
 * - 插件缓存：`<用户家目录>/<configDir>/plugins/cache/<市场>/<插件>/<版本>/SKILL.md`，
 *   插件市场装下来的。同一插件会留多个版本目录，只取最近更新的那一份。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { all } from "../agent/registry";

export interface SkillEntry {
  /** 技能名，取自目录名，去掉插件包的 `skill-` 前缀。 */
  name: string;
  /** 技能所在目录。 */
  dir: string;
  /** SKILL.md 的绝对路径。 */
  path: string;
  /** frontmatter 的一行说明，缺失时为空串。 */
  desc: string;
}

/** 清单上限。看板下拉、监工提示词与工作进程提示词共用。 */
const SKILL_LIMIT = 200;

/** 说明取用长度：够判断相关性，又不会挤占清单。 */
const SKILL_DESC_LIMIT = 42;

/** 各宿主的技能目录与插件缓存目录，相对配置根。 */
export function hostRoots(): { skills: string; cache: string }[] {
  return all()
    .filter((impl) => !impl.fallback && Boolean(impl.configDir))
    .map((impl) => ({
      skills: join(impl.configDir, "skills"),
      cache: join(impl.configDir, "plugins", "cache"),
    }));
}

/** 只读白名单根。两类分开：技能目录下直接放行；插件缓存下还须确认在技能包内。 */
export interface SkillAllowRoots {
  /** 各宿主 `skills/` 目录，项目级与用户级。 */
  skills: string[];
  /** 各宿主插件缓存目录，用户级。其下属技能包才放行。 */
  cache: string[];
}

/**
 * 只读白名单根：各宿主技能目录与插件缓存，覆盖项目级与用户级。
 *
 * 口径取自 registry 的 `configDir`，新增宿主自动纳入，不另外硬编码目录名。
 * 项目级用任务根拼接，用户级用家目录；插件缓存只有用户级——插件市场装在家目录下。
 */
export function skillAllowRoots(root: string): SkillAllowRoots {
  const skills: string[] = [];
  const cache: string[] = [];
  for (const r of hostRoots()) {
    skills.push(join(root, r.skills));
    skills.push(join(homedir(), r.skills));
    cache.push(join(homedir(), r.cache));
  }
  const norm = (list: string[]): string[] =>
    [...new Set(list.map((p) => p.replace(/\\/g, "/")))];
  return { skills: norm(skills), cache: norm(cache) };
}

/**
 * 取技能的一行说明。
 *
 * 只读 frontmatter 的 `description`，不解析正文；缺失时返回空串。
 */
export function skillSummary(file: string): string {
  try {
    const head = readFileSync(file, "utf8").slice(0, 4000);
    const m = /^description:\s*(.+)$/m.exec(head);
    if (!m) return "";
    const d = String(m[1]).trim().replace(/^["']|["']$/g, "");
    /* 多行描述以 YAML 块标记起头，正文在后续缩进行，不在此处取。 */
    if (/^[>|][+-]?$/.test(d)) return "";
    return d.length > SKILL_DESC_LIMIT ? `${d.slice(0, SKILL_DESC_LIMIT)}…` : d;
  } catch {
    return "";
  }
}

/** 插件包目录名去掉 `skill-` 前缀：列表里按能力名展示，不按包名。 */
function bareName(dirName: string): string {
  return dirName.startsWith("skill-") ? dirName.slice("skill-".length) : dirName;
}

/**
 * 备份与历史目录不是可用技能。
 *
 * 安装升级与手工备份常就地留一份（`supervisor.bak-20261109`、`thesis-writer-backup-v1.0.0`），
 * 列进清单会让用户选到不再维护的旧副本。
 */
function isBackupName(name: string): boolean {
  return /(^|[._-])(bak|backup|old|stale)([._-]|$)/i.test(name);
}

/** 插件目录下最近更新的 SKILL.md；兼容 `SKILL.md` 直接位于插件目录的情形。 */
function latestSkillFile(dir: string): string | null {
  const direct = join(dir, "SKILL.md");
  if (existsSync(direct)) return direct;
  let subs: string[] = [];
  try {
    subs = readdirSync(dir);
  } catch {
    return null;
  }
  let best: string | null = null;
  let bestTime = -1;
  for (const s of subs) {
    const file = join(dir, s, "SKILL.md");
    if (!existsSync(file)) continue;
    let t = 0;
    try {
      t = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (t > bestTime) {
      bestTime = t;
      best = file;
    }
  }
  return best;
}

/** 插件缓存里的技能：每个插件一项，取最近更新的版本。 */
function cachedPluginSkills(roots: { cache: string }[]): SkillEntry[] {
  const out: SkillEntry[] = [];
  for (const root of roots) {
    const cache = join(homedir(), root.cache);
    let markets: string[] = [];
    try {
      markets = readdirSync(cache);
    } catch {
      continue;
    }
    for (const market of markets) {
      const marketDir = join(cache, market);
      let plugins: string[] = [];
      try {
        plugins = readdirSync(marketDir);
      } catch {
        continue;
      }
      for (const plugin of plugins) {
        const dir = join(marketDir, plugin);
        const file = latestSkillFile(dir);
        if (!file) continue;
        out.push({ name: bareName(plugin), dir, path: file, desc: skillSummary(file) });
      }
    }
  }
  return out;
}

/**
 * 列出可用技能。
 *
 * 只返回路径与一行说明，正文由调用方按需读取。监工自身的操作手册不下发：
 * 它是监工的运行说明，不是派单内容。
 * 同名技能按出现顺序取第一个：项目级先于用户级，技能目录先于插件缓存。
 */
export function listSkills(root: string): SkillEntry[] {
  const roots = hostRoots();
  const dirs = [...roots.map((r) => join(root, r.skills)), ...roots.map((r) => join(homedir(), r.skills))];
  const seen = new Set<string>();
  const seenName = new Set<string>();
  const out: SkillEntry[] = [];

  const take = (name: string, dir: string, path: string): void => {
    if (name === "capitalist" || !name) return;
    if (isBackupName(name)) return;
    if (seen.has(path) || seenName.has(name)) return;
    seen.add(path);
    seenName.add(name);
    out.push({ name, dir, path, desc: skillSummary(path) });
  };

  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const file = join(dir, n, "SKILL.md");
      if (!existsSync(file)) continue;
      take(n, dir, file);
    }
  }

  for (const s of cachedPluginSkills(roots)) take(s.name, s.dir, s.path);

  return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, SKILL_LIMIT);
}

/** 按名字取单个技能；名字不存在时返回空。 */
export function findSkill(root: string, name: string): SkillEntry | null {
  const want = String(name || "").trim();
  if (!want) return null;
  return listSkills(root).find((s) => s.name === want) ?? null;
}
