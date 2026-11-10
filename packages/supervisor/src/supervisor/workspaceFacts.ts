/**
 * 采集工作区的版本控制变动，供判定层核对；非版本控制仓库返回空数组。
 *
 * 只报告变动本身，不判定变动归属；采集失败返回空数组，不使判定失败。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 单条 git 命令的超时；采集不阻塞判定。 */
const GIT_TIMEOUT_MS = 3000;
/** `status` 输出最多列出的行数，超出只报总数。 */
const STATUS_MAX_LINES = 30;
/** 单个命令的输出上限（字节）。 */
const MAX_BUFFER = 1024 * 1024;

function run(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(String(stdout ?? ""));
      },
    );
  });
}

/** 采集工作区的版本控制变动，返回可直接写入提示词的事实行；非版本控制仓库或 git 不可用时返回空数组。 */
export async function workspaceFacts(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  /* 任务根可能是仓库子目录；`--show-toplevel` 同时确认仓库身份并取得仓库根，使路径为仓库相对路径。 */
  const top = (await run(root, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!top) return [];

  const status = await run(top, ["status", "--porcelain=v1", "-uall"]);
  if (status === null) return [];
  const rows = status.split("\n").map((s) => s.replace(/\s+$/, "")).filter(Boolean);

  const out: string[] = [];
  if (rows.length) {
    const shown = rows.slice(0, STATUS_MAX_LINES);
    out.push(`- 未提交变动 ${rows.length} 处：`);
    for (const r of shown) out.push(`    ${r.slice(0, 160)}`);
    if (rows.length > shown.length) out.push(`    （另有 ${rows.length - shown.length} 处未列出）`);
    /* 未跟踪文件不进入 `diff --shortstat`，其数量由 `status` 表达。 */
    const stat = (await run(top, ["diff", "--shortstat", "HEAD"]))?.trim();
    if (stat) out.push(`- 改动规模（相对最近一次提交）：${stat}`);
  } else {
    /* 工作区干净不代表未做改动（可能已提交），附最近提交供核对，不区分提交者。 */
    const last = (await run(top, ["log", "-1", "--format=%h %ad %s", "--date=short"]))?.trim();
    out.push(`- 工作区干净（无未提交变动）${last ? `；最近一次提交：${last.slice(0, 140)}（不区分是谁提交的）` : ""}`);
  }
  return out;
}
