/**
 * 宿主模型清单。
 *
 * 唯一可信来源是宿主 CLI 自身：`--help` 输出的 `--model` 可选值随宿主升级变化，
 * 静态常量会过期，因此派单轮换与看板下拉都按本清单取候选。常量仅在解析失败时兜底。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

import { byId } from "./registry";

/** 清单缓存时长。宿主升级后最迟一个周期内生效。 */
const TTL_MS = 5 * 60_000;

function hostCliBins(host: string): readonly string[] {
  return byId(host)?.cliBins ?? [];
}

/**
 * 在 PATH 中定位宿主 CLI。
 *
 * Windows 的包装脚本无扩展名时不可直接执行，需换用同目录的 `.cmd` / `.exe`。
 */
export function findHostCli(host: string): string | null {
  const names = hostCliBins(host);
  const win = process.platform === "win32";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      try {
        if (win && !extname(name)) {
          for (const suf of [".cmd", ".exe"]) {
            const p = join(dir, name + suf);
            if (existsSync(p)) return p;
          }
        }
        if (existsSync(join(dir, name))) return join(dir, name);
      } catch {
        /* 单个目录不可读时继续查找。 */
      }
    }
  }
  return null;
}

/**
 * 从 `--help` 正文解析模型 id。
 *
 * 只认 `--model` 后面括号内的取值列表，且要求至少三项：少于三项通常是说明文字而非清单。
 */
export function parseModelIdsFromHelp(text: string): string[] {
  const lines = String(text || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const head = lines[i] ?? "";
    if (!/(?<![\w-])--model\b/.test(head)) continue;
    let chunk = head;
    if (!chunk.includes("(")) {
      for (let j = i + 1; j < lines.length && j <= i + 12; j += 1) {
        const next = lines[j] ?? "";
        chunk += ` ${next}`;
        if (next.includes(")")) break;
      }
    }
    const body = chunk.match(/\(([^)]*)\)/)?.[1];
    if (!body) continue;
    const ids = body
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter((s) => /^[\w.:+-]{2,}$/.test(s));
    if (ids.length >= 3) return [...new Set(ids)];
  }
  return [];
}

let cache: { host: string; at: number; models: string[] } | null = null;

/** 清空缓存，供测试在改写 CLI 输出后立即重读。 */
export function resetHelpModelsCacheForTest(): void {
  cache = null;
}

/**
 * 读取宿主 CLI 声明的模型清单。
 *
 * @returns 模型 id 列表；CLI 不可执行或正文不含清单时返回空数组，由调用方决定兜底。
 */
export function helpModels(host: string): string[] {
  if (cache && cache.host === host && Date.now() - cache.at < TTL_MS) return cache.models;
  let models: string[] = [];
  const bin = findHostCli(host);
  if (bin) {
    try {
      const win = process.platform === "win32";
      const arg = win && /\s/.test(bin) ? `"${bin}"` : bin;
      const r = spawnSync(arg, ["--help"], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
        shell: win,
        maxBuffer: 4 * 1024 * 1024,
      });
      models = parseModelIdsFromHelp(`${r.stdout ?? ""}`);
    } catch {
      models = [];
    }
  }
  cache = models.length > 0 ? { host, at: Date.now(), models } : null;
  return models;
}

/**
 * 派单轮换候选：宿主实时清单中的快速档模型。
 *
 * 宿主升级后模型 id 会变，轮换必须跟着清单走。清单不可用时返回空数组，
 * 由调用方回落到常量或宿主默认，不在本层猜测 id。
 */
export function rotationCandidates(host: string): string[] {
  const live = helpModels(host);
  if (live.length === 0) return [];
  return live.filter((m) => /flash|fast/i.test(m));
}
