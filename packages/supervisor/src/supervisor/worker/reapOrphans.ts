/**
 * 启动时回收上一轮监工遗留的工作进程。
 *
 * 只回收 `starting` / `running` 且 `supervisor_pid` 不属于本进程的记录，并要求 pid 存在且归属本任务根（命令行含根路径或父进程等于记录中的监工 pid）；pid 可能被复用，无法核实身份时不结束进程。
 *
 * 身份查询按平台分别走 Windows CIM、Linux `/proc` 与其它平台 `ps`，仅在启动时对候选记录执行一次。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { recordEvent } from "../../core/record/ledger";
import { listWorkers, pidAlive, saveWorker, type WorkerRecord } from "../../core/record/supervisor";
import { killTree } from "./terminate";

/** 一条被回收的工作进程记录，供调用方汇总输出。 */
export interface ReapedWorker {
  id: string;
  pid: number;
  dispatch: string;
  /** 判定依据说明，同时写入 `worker_reaped` 事件。 */
  reason: string;
  /** 证据来源：命令行命中 / 父进程命中。 */
  via: "cmdline" | "ppid";
}

/** 进程的外部身份。取不到时字段为空。 */
interface ProcIdentity {
  /** 完整命令行；取不到为空串。 */
  cmdline: string;
  /** 父进程号；取不到为 0。 */
  ppid: number;
}

/** 路径比较口径：Windows 不分大小写、不分斜杠方向。 */
function pathKey(s: string): string {
  const replaced = s.replace(/\\/g, "/");
  return process.platform === "win32" ? replaced.toLowerCase() : replaced;
}

/** Linux：`/proc/<pid>/cmdline` 是 NUL 分隔的 argv，ppid 在 stat 的第 4 段。 */
function identityFromProc(pid: number): ProcIdentity | null {
  const dir = `/proc/${pid}`;
  try {
    if (!existsSync(dir)) return null;
    const argv = readFileSync(`${dir}/cmdline`, "utf8").split("\0").filter(Boolean);
    let ppid = 0;
    try {
      const stat = readFileSync(`${dir}/stat`, "utf8");
      // comm 字段可能含空格与括号，从最后一个 ')' 之后开始切，避免错位。
      const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      ppid = Number(tail[1]) || 0;
    } catch {
      /* 读不到 stat 时只给命令行，不判定父进程。 */
    }
    return { cmdline: argv.join(" "), ppid };
  } catch {
    return null;
  }
}

/** Windows：一条 CIM 查询同时拿到 ParentProcessId 与 CommandLine，结果按 UTF-8 base64 返回。 */
function identityFromCim(pid: number): ProcIdentity | null {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
    "if ($p) {",
    "  $s = \"$($p.ParentProcessId)`t$($p.CommandLine)\"",
    "  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))",
    "}",
  ].join("\n");
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", timeout: 8000, windowsHide: true },
  );
  const out = (r.stdout ?? "").trim();
  if (!out) return null;
  try {
    const text = Buffer.from(out, "base64").toString("utf8");
    const tab = text.indexOf("\t");
    if (tab < 0) return { cmdline: text, ppid: 0 };
    return { cmdline: text.slice(tab + 1), ppid: Number(text.slice(0, tab)) || 0 };
  } catch {
    return null;
  }
}

/** 其它平台（macOS 等）：`ps` 一次给出父进程号与完整命令行。 */
function identityFromPs(pid: number): ProcIdentity | null {
  const r = spawnSync("ps", ["-p", String(pid), "-o", "ppid=", "-o", "command="], {
    encoding: "utf8",
    timeout: 8000,
  });
  const line = (r.stdout ?? "").trim();
  if (!line) return null;
  const m = /^(\d+)\s+([\s\S]*)$/.exec(line);
  if (!m) return null;
  return { cmdline: m[2] ?? "", ppid: Number(m[1]) || 0 };
}

/** 取进程身份；不支持查询的环境返回 null，调用方据此放弃判定。 */
export function describePid(pid: number): ProcIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") return identityFromProc(pid);
  if (process.platform === "win32") return identityFromCim(pid);
  return identityFromPs(pid);
}

/** 命令行不含任务根（派单正文走 stdin）时，改用父进程等于记录中监工 pid 判定归属。 */
function identityOf(
  w: WorkerRecord,
  ident: ProcIdentity,
  root: string,
): ReapedWorker["via"] | null {
  if (ident.cmdline && pathKey(ident.cmdline).includes(pathKey(root))) return "cmdline";
  if (w.supervisor_pid && ident.ppid === w.supervisor_pid) return "ppid";
  return null;
}

/**
 * 在 调度循环之前调用一次，先回收再派单；返回被回收的记录供启动日志汇总。
 *
 * 只处理后台模式。`opts.onlySupervisorPid` 限定只回收该监工 pid 拉起的记录，避免监工重启后误收新起的进程。
 */
export function reapOrphans(
  root: string,
  out: (s: string) => void,
  opts?: { onlySupervisorPid?: number },
): ReapedWorker[] {
  const reaped: ReapedWorker[] = [];
  const only = opts?.onlySupervisorPid;

  for (const w of listWorkers(root)) {
    if (w.status !== "running" && w.status !== "starting") continue;
    if (w.mode === "visible") continue;
    if (only != null && w.supervisor_pid !== only) continue;
    // 本进程拉起的记录不归这一层处理。
    if (w.supervisor_pid === process.pid) continue;
    if (!pidAlive(w.pid)) continue; // 进程已不在：交给调度轮次中的 reap 结单

    const ident = describePid(w.pid);
    if (!ident) {
      out(`[监工] 遗留 worker ${w.id}（pid ${w.pid}）无法核实身份，跳过（不确认归属就不结束进程）`);
      continue;
    }

    const via = identityOf(w, ident, root);
    if (!via) {
      out(`[监工] 遗留 worker ${w.id}（pid ${w.pid}）命令行与父进程都对不上本任务根，跳过`);
      continue;
    }

    const how = killTree(w.pid);
    const reason =
      via === "cmdline"
        ? "命令行命中任务根，判定为上一轮监工遗留"
        : `父进程 pid 与记录中的监工 pid（${w.supervisor_pid}）一致，判定为上一轮监工遗留`;

    recordEvent(root, "worker_reaped", {
      worker: w.id,
      dispatch: w.dispatch,
      pid: w.pid,
      reason,
      via,
      how,
      supervisor_pid: w.supervisor_pid ?? 0,
      prev_status: w.status,
    });
    saveWorker(root, { ...w, status: "exited", exit_code: 0 });
    reaped.push({ id: w.id, pid: w.pid, dispatch: w.dispatch, reason, via });

    out(
      `[监工] 收掉上一轮遗留 worker ${w.id}（pid ${w.pid}，派单 ${w.dispatch}）：${reason}` +
        `${how === "unconfirmed" ? "——终止后仍未确认退出，需人工核查" : ""}`,
    );
  }

  return reaped;
}
