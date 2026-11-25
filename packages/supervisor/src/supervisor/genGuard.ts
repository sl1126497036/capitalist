/**
 * 按目标、项目内容与已加载技能生成守卫。
 *
 * 产物与 `policies/*.policy.json` 同构，只含边界与判据（领域名、完成口径、红线、本机边界、
 * 环境前提），不含流程：编排由监工按目标拆成任务树承担。生成失败时调用方回落内置守卫。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { skillDirs } from "../agent/locations";
import { supervisorDir } from "../core/record/paths";
import { askModel } from "./channel/llm";

/** 生成结果。`ok:false` 时调用方应退回内置守卫。 */
export interface GuardGenResult {
  ok: boolean;
  path: string;
  /** 生成不成功时的原因，成功时为空。 */
  why: string;
  /** 生成出的红线条数，供命令行回执。 */
  redlines: number;
}

/** 项目摘要：供模型判断项目类型，不含全量文件树。 */
function workspaceDigest(root: string): string {
  const lines: string[] = [`目录：${root}`];
  try {
    const top = readdirSync(root)
      .filter((n) => !n.startsWith(".") || n === ".git")
      .slice(0, 40)
      .map((n) => {
        try {
          return statSync(join(root, n)).isDirectory() ? `${n}/` : n;
        } catch {
          return n;
        }
      });
    lines.push(`顶层条目：${top.join("、")}`);
  } catch {
    lines.push("顶层条目：读取失败");
  }
  for (const probe of ["package.json", "README.md", "pyproject.toml", "go.mod", "Cargo.toml", "scope.txt"]) {
    if (!existsSync(join(root, probe))) continue;
    try {
      const head = readFileSync(join(root, probe), "utf8").slice(0, 400).replace(/\s+/g, " ").trim();
      lines.push(`${probe} 首部：${head}`);
    } catch {
      /* 单个探测文件读取失败时跳过，摘要仍可生成。 */
    }
  }
  return lines.join("\n");
}

/** 已加载技能名，仅取目录名。 */
function loadedSkills(root: string): string[] {
  const names: string[] = [];
  for (const dir of skillDirs(root)) {
    try {
      if (!existsSync(dir)) continue;
      for (const n of readdirSync(dir)) {
        if (n.startsWith(".")) continue;
        if (!names.includes(n)) names.push(n);
      }
    } catch {
      /* 目录读取失败时跳过 */
    }
  }
  return names.slice(0, 40);
}

const SCHEMA_HINT = `只输出一个 JSON 对象，不要解释，不要代码块围栏。结构：
{
  "name": "守卫名，英文短横线",
  "domain": "该任务所属领域名，简短",
  "context": "判据口径：完成判定、不合格判定及判据来源。分句表述，不写步骤",
  "redlines": [
    {
      "id": "大写短横线标识",
      "level": "BLOCK 或 NEED_USER 或 WARN",
      "label": "以一句话描述所禁止的行为",
      "pattern": "匹配命令或操作的正则",
      "fix": "命中该红线时的处置说明：应执行的修正动作"
    }
  ],
  "env_notes": { "summary": "本任务成立所依赖的环境与前提" }
}

规则：
1. 只声明边界与判据，不声明流程：不写步骤顺序、不写并行度。编排由监工按目标分解为任务树决定。
2. redlines 仅列在该目标下确有风险的三类：破坏性操作、不可逆操作、越界访问敏感数据；不存在时留空，不为满足条数而填充。
3. pattern 是正则，需要忽略大小写时用 (?i) 前缀；匹配面控制在“真会执行这件事”的写法上，避免把讨论、查看、文档提到也算命中。
4. level 取 BLOCK（直接拒绝，用于不可逆与越界）、NEED_USER（需当次授权）、WARN（只提示）。
5. context 填写判据来源，例如：以用户原话为准，验收以产出物本身为准。不要写成鼓励性说明。
6. name 使用英文短横线，依目标语义命名，不使用 generated、task 等无实义的泛词。`;

/**
 * 生成一份守卫。
 *
 * @param opts.root 任务根
 * @param opts.target 目标文本
 * @param opts.host 宿主 id
 * @param opts.out 输出路径，默认 `.capitalist/policies/generated-<时间戳>.policy.json`
 */
export async function generateGuard(opts: {
  root: string;
  target: string;
  /** 宿主 id，空则用 askModel 的默认。 */
  host?: string;
  out?: string;
  effort?: string;
  /** 监工模型（`--capitalist-model`）：守卫措辞与后续判定用同一个模型，口径才一致。 */
  model?: string;
}): Promise<GuardGenResult> {
  const dir = join(supervisorDir(opts.root), "policies");
  const path = opts.out ?? join(dir, `generated-${new Date().toISOString().replace(/[:.]/g, "-")}.policy.json`);
  const skills = loadedSkills(opts.root);
  const prompt = [
    "本提示词用于为通用任务监工起草守卫。守卫仅声明边界与判据：所禁止的操作、不可修改的位置以及完成判定标准，不安排流程。",
    "",
    `目标内容：${opts.target || "（未提供，按项目内容判断）"}`,
    "",
    "项目摘要：",
    workspaceDigest(opts.root),
    "",
    `已加载技能：${skills.length ? skills.join("、") : "（无）"}`,
    "",
    SCHEMA_HINT,
  ].join("\n");

  const r = await askModel({
    prompt,
    cwd: opts.root,
    ...(opts.host ? { host: opts.host } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(String(opts.model ?? "").trim() ? { model: String(opts.model).trim() } : {}),
  });
  if (!r.ok) return { ok: false, path, why: `模型调用失败：${r.text}`, redlines: 0 };

  const raw = r.text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, path, why: "模型没有返回 JSON", redlines: 0 };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    return { ok: false, path, why: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`, redlines: 0 };
  }

  const obj = parsed as { name?: unknown; domain?: unknown; context?: unknown; redlines?: unknown; env_notes?: unknown };
  const redlines = (Array.isArray(obj.redlines) ? obj.redlines : [])
    .map((x) => x as Record<string, unknown>)
    /* 缺 id、label 或 pattern 的红线无法生效，也不该写进文件假装存在。 */
    .filter((x) => typeof x.id === "string" && typeof x.label === "string" && typeof x.pattern === "string")
    .map((x) => ({
      id: String(x.id),
      level: String(x.level ?? "WARN"),
      label: String(x.label),
      pattern: String(x.pattern),
      ...(typeof x.fix === "string" && x.fix.trim() ? { fix: String(x.fix) } : {}),
    }));

  const guard = {
    name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : `${basename(opts.root)}-generated`,
    domain: typeof obj.domain === "string" && obj.domain.trim() ? obj.domain.trim() : "动态生成",
    description: `按用户目标起草于 ${new Date().toISOString()}。原始目标：${opts.target}`,
    ...(typeof obj.context === "string" && obj.context.trim() ? { context: obj.context.trim() } : {}),
    redlines,
    ...(obj.env_notes && typeof obj.env_notes === "object"
      ? { env_notes: obj.env_notes as Record<string, unknown> }
      : {}),
  };

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(guard, null, 2)}\n`, "utf8");
  } catch (err) {
    return { ok: false, path, why: `守卫文件写入失败：${err instanceof Error ? err.message : String(err)}`, redlines: 0 };
  }
  return { ok: true, path, why: "", redlines: redlines.length };
}

/** 生成结果的一句话回执，供命令行输出。 */
export function describeGenerated(r: GuardGenResult): string {
  if (!r.ok) return `[监工] 未能生成守卫，改用内置默认档：${r.why}`;
  /* 文件路径不进终端：用户要看的是生成了哪几条边界，路径属于内部位置。 */
  return `[监工] 已按目标生成守卫：红线 ${r.redlines} 条`;
}
