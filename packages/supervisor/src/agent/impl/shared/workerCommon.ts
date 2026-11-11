/**
 * worker facet 里跨宿主一致的机制。
 *
 * 判定只与“Windows 上 npm 安装的 CLI 长什么样”有关，claude-code / codebuddy /
 * workbuddy 三家共用。文件内不出现产品名，产品名由调用方作为 `<name>` 传入。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { WorkerFacet } from "../../contract";

/**
 * 判断某个可执行文件是否必须经 shell 才能 spawn。
 *
 * Windows 上的 `.cmd` / `.bat` 包装脚本返回 true，其它情况返回 false。
 */
export const winShellForShim: NonNullable<WorkerFacet["needsShell"]> = (bin, platform) =>
  platform === "win32" && /\.(cmd|bat)$/i.test(bin);

/**
 * 候选可执行文件名。
 *
 * Windows 为 `<name>.cmd` / `<name>.exe` / `<name>`，其它平台只有裸名。平台分支收在这里，
 * 差异只在 `<name>`。
 */
export function winBinNames(platform: NodeJS.Platform, name: string): string[] {
  return platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name];
}

/**
 * Windows 上是否存在可用的 Git Bash。
 *
 * hook 命令是 node 绝对路径的直调，形如 `"<node>" "<entry>" <event> --agent <id> --from <标记>`，
 * 不含管道、重定向、变量与通配符，cmd.exe 与 PowerShell 都能执行。bash 不是本项目的前置依赖。
 *
 * 需要这个判断的是宿主侧：部分宿主以自己的 shell 执行 hook，若取的是 Git Bash，缺 bash 时
 * 条目照样写得进去却从不触发，表现为“配置在、注入行不出现”。三个默认安装位置之外也认
 * PATH 里的 bash.exe，便携版安装不写默认目录。非 Windows 恒为 true。
 */
export function gitBashAvailable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): boolean {
  if (platform !== "win32") return true;
  const dirs = [
    join(env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    join(env.ProgramW6432 ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    join(env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
  ].filter((p) => p.length > 16);
  if (dirs.some((p) => exists(p))) return true;
  const path = env.PATH ?? env.Path ?? "";
  return path
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .some((d) => exists(join(d, "bash.exe")));
}
