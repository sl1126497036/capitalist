/**
 * 宿主派生路径：契约搜索目录、自动纳管配置位置。
 *
 * 这些路径从宿主配置目录派生，目录名一律来自 `registry.dirs()`，本文件不写宿主名。
 * 纯路径原语（`findRoot` / `isInside` / `expandHome`）在 `core/record/paths.ts`。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { normalizeForCompare } from "../core/record/paths";
import { existingDirs } from "./registry";

/**
 * 契约搜索目录，按优先级：`CAPITALIST_SKILLS_DIR` > 各宿主 `skills/` > 仓库根（开发态）。
 *
 * 不存在的目录会被过滤，重复目录只保留第一个。
 */
export function skillDirs(repoRootHint?: string): string[] {
  const env = process.env.CAPITALIST_SKILLS_DIR;
  if (env) return [env];

  const out: string[] = [];
  for (const h of existingDirs()) out.push(join(h.dir, "skills"));
  if (repoRootHint) out.push(repoRootHint);

  const seen = new Set<string>();
  return out.filter((d) => {
    const k = normalizeForCompare(d);
    if (seen.has(k) || !existsSync(d)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 用户级自动纳管配置的位置。
 *
 * 优先级：`CAPITALIST_WATCH_CFG`（测试与多实例隔离用）> 第一个存在 `capitalist-watch.json` 的宿主
 * 配置目录 > `~/.capitalist/capitalist-watch.json`。
 */
export function watchConfigPath(): string {
  const env = process.env.CAPITALIST_WATCH_CFG;
  if (env) return resolve(env);
  for (const h of existingDirs()) {
    const p = join(h.dir, "capitalist-watch.json");
    if (existsSync(p)) return p;
  }
  return join(homedir(), ".capitalist", "capitalist-watch.json");
}
