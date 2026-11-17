// 发布前把仓库根的 README 同步到包目录。
// npm 发布目录是 packages/supervisor，包页 README 取自本目录内的文件；
// 不同步时 npm 页会停留在旧版，与仓库根版本分叉。
import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(pkgDir, "..", "..");

let failed = false;
for (const name of ["README.md", "README.en.md"]) {
  const src = path.join(repoRoot, name);
  const dest = path.join(pkgDir, name);
  if (!existsSync(src)) {
    console.error(`[sync-readme] ${name}：仓库根缺失 ${src}，中止发布`);
    failed = true;
    continue;
  }
  copyFileSync(src, dest);
  console.log(`[sync-readme] ${name}：已同步仓库根版本`);
}
if (failed) process.exitCode = 1;
