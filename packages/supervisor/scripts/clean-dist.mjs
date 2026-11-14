/**
 * 删掉 dist 里没有对应源文件的产物。
 *
 * tsc 只写不删，两类残留会出错：
 *
 * 1. `x.ts` 拆成 `x/index.ts` 后，`dist/x.js` 还在，`require("./x")` 会优先命中它；
 * 2. 源文件删除后，`dist/x.js` 还在，会被打进发布包。
 *
 * 只比对源文件是否存在，不整目录清空：`dist/board-web` 是 vite 产物，没有对应源文件。
 */
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = "src";
const DIST = "dist";
/** 非 tsc 产物，按目录整体跳过。 */
const SKIP_DIRS = new Set(["board-web"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(full, out);
    } else if (name.endsWith(".js") || name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

if (existsSync(DIST)) {
  const stale = [];
  for (const file of walk(DIST)) {
    const rel = relative(DIST, file);
    const source = join(SRC, rel.replace(/\.d\.ts$/, ".ts").replace(/\.js$/, ".ts"));
    if (!existsSync(source)) stale.push(file);
  }
  let removed = 0;
  let failed = 0;
  for (const file of stale) {
    try {
      unlinkSync(file);
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  if (removed > 0) console.log(`[clean] 删掉 ${removed} 个没有对应源文件的产物`);
  if (failed > 0) {
    console.error(
      `[clean] ${failed} 个旧产物没删掉。构建会加载到旧模块，请在不受删除策略限制的终端重跑构建。`,
    );
    process.exit(1);
  }
}
