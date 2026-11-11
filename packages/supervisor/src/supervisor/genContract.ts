/**
 * 按目标、工作空间内容与已加载技能动态生成契约。
 * 产物与 `contracts/*.contract.json` 同构，调度层无需改动；生成失败时回落内置契约。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { skillDirs } from "../agent/locations";
import { askModel } from "./llm";

/** 生成结果。`ok:false` 时调用方应退回内置契约。 */
export interface GenContractResult {
  ok: boolean;
  path: string;
  /** 生成不成功时的原因，成功时为空。 */
  why: string;
  stages: { id: string; name: string }[];
}

/** 工作空间摘要：供模型判断项目类型，不含全量文件树。 */
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
      lines.push(`${probe} 开头：${head}`);
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
      /* 目录读不了就跳过 */
    }
  }
  return names.slice(0, 40);
}

const SCHEMA_HINT = `只输出一个 JSON 对象，不要任何解释、不要代码块围栏。结构：
{
  "name": "契约名（英文短横线）",
  "domain": "简要说明这类任务",
  "stages": [
    {
      "id": "S0",
      "name": "阶段名（中文，4-8 字）",
      "goal": "阶段目标，简要说明",
      "next": "交给执行者的下一步动作，要具体到做什么、产出什么文件",
      "done": { "type": "file_exists", "path": "相对产出路径" }
    }
  ],
  "brief_redlines": ["不许碰凭据", "改既有文件前先备份"]
}

规则：
1. 阶段数按任务实际需要设定。零散杂活就 1 个阶段（id 用 T），有明确交付的长任务 3-6 个。
2. 阶段必须是这个任务真实要走的步骤，不许套用任何预置模板（不要出现“功能盘点”“视觉还原”这类与任务无关的名字）。
3. done 用这三种之一，别的不要用：
   - { "type": "file_exists", "path": "<该阶段的产出文件>" }
   - { "type": "glob_min", "pattern": "<通配>", "min": <数字> }
   - { "type": "jsonl_min", "file": "<记录文件>", "min": <数字> }
4. 单阶段（杂活）用 { "type": "file_exists", "path": ".capitalist/never-done.marker" }——让监工常驻待命，不自动收工。
5. 不要写 parallel 字段。`;

/**
 * 生成一份契约。
 * @param opts.root 任务根
 * @param opts.target 目标文本
 * @param opts.host 宿主 id
 * @param opts.out 输出路径，默认 `.capitalist/contracts/generated-<时间戳>.contract.json`
 */
export async function generateContract(opts: {
  root: string;
  target: string;
  /** 宿主 id，空则用 askModel 的默认。 */
  host?: string;
  out?: string;
  effort?: string;
}): Promise<GenContractResult> {
  const dir = join(opts.root, ".capitalist", "contracts");
  const path = opts.out ?? join(dir, `generated-${new Date().toISOString().replace(/[:.]/g, "-")}.contract.json`);
  const skills = loadedSkills(opts.root);
  const prompt = [
    "你在为一个任务型监工生成任务清单（契约）。监工会按这份清单派单给工作进程。",
    "",
    `目标内容：${opts.target || "（未提供，按工作空间内容判断）"}`,
    "",
    "工作空间摘要：",
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
  });
  if (!r.ok) return { ok: false, path, why: `模型通道不可用：${r.text}`, stages: [] };

  const raw = r.text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, path, why: "模型没有返回 JSON", stages: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    return { ok: false, path, why: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`, stages: [] };
  }

  const obj = parsed as { name?: unknown; stages?: unknown };
  const stagesRaw = Array.isArray(obj.stages) ? obj.stages : [];
  const stages = stagesRaw
    .map((s) => s as { id?: unknown; name?: unknown; goal?: unknown; next?: unknown; done?: unknown })
    .filter((s) => typeof s.id === "string" && typeof s.name === "string" && s.done && typeof s.done === "object")
    .map((s) => ({
      id: String(s.id),
      name: String(s.name),
      goal: String(s.goal ?? ""),
      next: String(s.next ?? ""),
      done: s.done,
    }));
  if (stages.length === 0) return { ok: false, path, why: "返回里没有可用的阶段（id/name/done 缺失）", stages: [] };

  const contract = {
    name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : `${basename(opts.root)}-generated`,
    domain: "动态生成",
    _note: `按用户目标生成于 ${new Date().toISOString()}；原始目标：${opts.target}`,
    pack_base: ".",
    memory_file: "memory.md",
    brief_redlines: [
      "不许删除任务根以外的本机内容",
      "不许碰凭据：.env / 密钥 / *.pem / ~/.ssh",
      "动手改既有文件之前先备份",
    ],
    stages,
  };

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  } catch (err) {
    return { ok: false, path, why: `写不进契约文件：${err instanceof Error ? err.message : String(err)}`, stages: [] };
  }
  return { ok: true, path, why: "", stages: stages.map((s) => ({ id: s.id, name: s.name })) };
}

/** 逐条列出阶段名，供核对契约与目标是否一致。 */
export function describeGenerated(r: GenContractResult): string {
  if (!r.ok) return `[契约] 未能生成，回落内置清单：${r.why}`;
  return (
    `[契约] 按目标生成了 ${r.stages.length} 个阶段：` +
    r.stages.map((s) => `${s.id} ${s.name}`).join(" / ") +
    `\n[契约] 文件：${r.path}`
  );
}
