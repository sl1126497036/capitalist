/**
 * 构建时把仓库根的监工手册同步进包内。
 *
 * 手册的源只有一份：仓库根 `skill/SKILL.md`。发布包要自带它（`npm i -g` 之后
 * 由 `capitalist install` 投放到各宿主的 skills 目录），但 npm 只能打包包目录内的文件，
 * 所以构建时复制一份到 `packages/supervisor/skill/SKILL.md`。
 *
 * 内容一致时不写：从公开仓库安装时两份文件同源，重复写入既无效果，也会在
 * 文件被其它进程占用时中断构建。
 *
 * 不要直接改包内那份：下次构建会被覆盖。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "..", "skill", "SKILL.md");
const dst = join(here, "..", "skill", "SKILL.md");

if (!existsSync(src)) {
  console.error(`找不到手册源文件：${src}`);
  process.exit(1);
}

if (existsSync(dst) && readFileSync(src).equals(readFileSync(dst))) {
  process.exit(0);
}

mkdirSync(dirname(dst), { recursive: true });
copyFileSync(src, dst);
