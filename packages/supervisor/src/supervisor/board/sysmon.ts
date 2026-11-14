/**
 * 进程与整机的资源采样。
 *
 * 采样在后台定时进行，读接口只取最近一次结果；采样失败时把原因带到界面上，
 * 不让空值看起来像"没有占用"。
 */

import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import { readdirSync, readFileSync } from "node:fs";

/** 内存读数按 2 秒缓存。 */
export let memCache: { key: string; at: number; bytes: number | null } = { key: "", at: 0, bytes: null };

/** Windows 分支直接返回 null：Node 没有读取其它进程 WorkingSet 的 API。 */
export function workingSetBytes(pids: number[]): number | null {
  const want = [...new Set(pids.filter((p) => Number.isFinite(p) && p > 0))].sort((a, b) => a - b);
  if (want.length === 0) return 0;
  const key = want.join(",");
  const now = Date.now();
  if (memCache.key === key && now - memCache.at < 2000) return memCache.bytes;

  let bytes: number | null = null;
  try {
    if (process.platform === "linux") {
      let sum = 0;
      let hit = 0;
      for (const pid of want) {
        try {
          const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)\s+kB/);
          if (!m) continue;
          sum += Number(m[1]) * 1024;
          hit++;
        } catch {
          /** 进程刚退出时跳过，不把整次求和判成失败。 */
        }
      }
      bytes = hit > 0 ? sum : null;
    } else if (process.platform !== "win32") {
      // macOS 与其它 POSIX 读 ps 的 rss 列。
      const r = spawnSync("ps", ["-o", "rss=", "-p", want.join(",")], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (r.status === 0 && r.stdout) {
        let sum = 0;
        let hit = 0;
        for (const line of r.stdout.split(/\r?\n/)) {
          const kb = Number(line.trim());
          if (!Number.isFinite(kb) || kb <= 0) continue;
          sum += kb * 1024;
          hit++;
        }
        bytes = hit > 0 ? sum : null;
      }
    }
  } catch {
    bytes = null;
  }
  memCache = { key, at: now, bytes };
  return bytes;
}

export function humanBytes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}G`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return `${Math.round(n)}B`;
}


export interface NodeProcSample {
  pid: number;
  /** 瞬时 CPU：Windows 为格式化计数器读数（单核口径，可超过 100%），macOS 为 ps 的 %CPU，Linux 为 /proc stat 差分折算。 */
  cpu: number | null;
  mem: number | null;
}

/** 一轮采样结果按模块级缓存，5 秒新鲜期。 */
export interface ProcSnapshot {
  at: number;
  procs: NodeProcSample[];
  source: string;
  reason: string;
}

export let procSnap: ProcSnapshot = { at: 0, procs: [], source: "", reason: "首次采样尚未完成" };
export let samplerTimer: ReturnType<typeof setInterval> | 0 = 0;
/** Linux CPU 差分用上一轮每个 pid 的 utime+stime（时钟滴答）。 */
export const lastCpuTicks = new Map<number, number>();
export let lastTicksAt = 0;


/** 整机读数：CPU 用 os.cpus() 时间片差分；内存压力按各平台系统口径取值。 */
export interface SysSample {
  at: number;
  cpu: number | null;
  memUsed: number | null;
  memPressure: number | null;
  memTotal: number;
}
export let sysSnap: SysSample = { at: 0, cpu: null, memUsed: null, memPressure: null, memTotal: 0 };
export let lastCpuTimes: { idle: number; total: number } | null = null;

/**
 * 整机内存压力百分比（0-100，越高越紧张），与活动监视器同一口径：
 * macOS 取 memory_pressure 的“System-wide memory free percentage”取反；
 * Linux 用 /proc/meminfo 的 MemAvailable 折算；Windows 用 (总量 − 空闲) / 总量。
 * 读不到时返回 null，不以其它值代入。
 */
/**
 * 异步执行命令并收集 stdout，超时即杀。
 *
 * 采样在子进程中异步执行，与 HTTP 处理互不阻塞。同步采样会阻塞事件循环，
 * 使同时到达的看板请求一并等待。
 */
export function runCapture(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; code: number | null; error: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (r: { stdout: string; code: number | null; error: string }): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      finish({ stdout: "", code: null, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      finish({ stdout, code: null, error: `超时（${timeoutMs}ms）` });
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      finish({ stdout, code: null, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ stdout, code, error: "" });
    });
  });
}

async function sampleMemPressure(total: number, free: number): Promise<number | null> {
  try {
    if (process.platform === "darwin") {
      const r = await runCapture("memory_pressure", [], 3000);
      const m = r.code === 0 && r.stdout
        ? r.stdout.match(/System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/)
        : null;
      return m ? Math.max(0, Math.min(100, Math.round(100 - Number(m[1])))) : null;
    }
    if (process.platform === "linux") {
      const text = readFileSync("/proc/meminfo", "utf8");
      const avail = Number((text.match(/^MemAvailable:\s+(\d+)\s+kB/m) ?? [])[1]);
      const all = Number((text.match(/^MemTotal:\s+(\d+)\s+kB/m) ?? [])[1]);
      if (Number.isFinite(avail) && Number.isFinite(all) && all > 0) {
        return Math.max(0, Math.min(100, Math.round((1 - avail / all) * 100)));
      }
      return null;
    }
    if (total > 0 && Number.isFinite(free)) {
      return Math.max(0, Math.min(100, Math.round((1 - free / total) * 100)));
    }
    return null;
  } catch {
    return null;
  }
}

async function sampleSys(): Promise<void> {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  let cpu: number | null = null;
  if (lastCpuTimes && total > lastCpuTimes.total) {
    const dTotal = total - lastCpuTimes.total;
    const dIdle = idle - lastCpuTimes.idle;
    cpu = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
  }
  lastCpuTimes = { idle, total };
  const memFree = os.freemem();
  const memTotal = os.totalmem();
  sysSnap = {
    at: Date.now(),
    cpu: cpu === null ? null : Math.round(cpu * 10) / 10,
    memUsed: Math.max(0, memTotal - memFree),
    memPressure: await sampleMemPressure(memTotal, memFree),
    memTotal,
  };
}

export const SAMPLER_INTERVAL_MS = 5000;
export const PS_TIMEOUT_MS = 9000;

export function runPowerShell(cmd: string): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      rej(new Error(`powershell 超时（${PS_TIMEOUT_MS}ms）`));
    }, PS_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", (e) => {
      clearTimeout(timer);
      rej(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) res(out);
      else rej(new Error(`powershell 退出码 ${code}${err.trim() ? `：${err.trim().slice(0, 200)}` : ""}`));
    });
  });
}

/** Windows 用一条 CIM 查询取全部 node 进程的 CPU% 与 WorkingSet。 */
async function sampleWindows(): Promise<ProcSnapshot> {
  const source = "Win32_PerfFormattedData_PerfProc_Process（PowerShell CIM，Filter Name LIKE 'node%'）";
  /*
   * 默认不采样进程级指标。
   *
   * CIM 查询要起一个 powershell 进程，看板每 5 秒跑一次，宿主的命令通道会跟着
   * 每隔几秒闪一次控制台窗口。整机 CPU 与内存由 os.cpus / os.freemem 直接算，不受影响；
   * 只有“每个 node 进程占多少”这一项缺失。需要时设 CAPITALIST_BOARD_PROC_SAMPLE=1。
   */
  if (String(process.env.CAPITALIST_BOARD_PROC_SAMPLE ?? "").trim() !== "1") {
    return {
      at: Date.now(),
      procs: [],
      source,
      reason: "进程级采样默认关闭；需要时设 CAPITALIST_BOARD_PROC_SAMPLE=1",
    };
  }
  try {
    const out = await runPowerShell(
      `Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "Name LIKE 'node%'" ` +
        `| Select-Object IDProcess,PercentProcessorTime,WorkingSet | ConvertTo-Json -Compress`,
    );
    const raw = JSON.parse(out.trim() || "[]");
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const procs: NodeProcSample[] = [];
    for (const it of arr) {
      const pid = Number(it?.IDProcess);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      procs.push({
        pid,
        cpu: Number.isFinite(Number(it?.PercentProcessorTime)) ? Number(it.PercentProcessorTime) : null,
        mem: Number.isFinite(Number(it?.WorkingSet)) ? Number(it.WorkingSet) : null,
      });
    }
    return { at: Date.now(), procs, source, reason: procs.length ? "" : "本机没有运行中的 node 进程" };
  } catch (e) {
    return {
      at: Date.now(),
      procs: [],
      source,
      reason: `CIM 采样失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Linux 扫 /proc，comm 以 node 开头的进程，CPU% 用 stat 差分折算。 */
export function sampleLinux(): ProcSnapshot {
  const source = "/proc（comm + stat + statm 差分）";
  try {
    const hz = 100; // Linux USER_HZ 几乎恒为 100
    const now = Date.now();
    const dt = lastTicksAt ? (now - lastTicksAt) / 1000 : 0;
    const procs: NodeProcSample[] = [];
    const curTicks = new Map<number, number>();
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      let comm = "";
      let ticks = 0;
      let mem: number | null = null;
      try {
        comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
        if (!/^node(\.|$)/.test(comm)) continue;
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        // 第 14、15 列是 utime/stime，取最后一个右括号之后的部分再偏移。
        const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        ticks = Number(rest[11]) + Number(rest[12]); // utime(14)-1=11, stime(15)-1=12（含 0 位）
        const m = readFileSync(`/proc/${pid}/statm`, "utf8").trim().split(/\s+/);
        mem = Number(m[1]) * 4096; // resident 列 × 页大小
      } catch {
        continue; // 进程刚退出：跳过
      }
      const prev = lastCpuTicks.get(pid);
      const cpu = prev !== undefined && dt > 0 ? ((ticks - prev) / hz / dt) * 100 : null;
      curTicks.set(pid, ticks);
      procs.push({ pid, cpu: cpu === null ? null : Math.round(cpu * 10) / 10, mem });
    }
    lastCpuTicks.clear();
    for (const [k, v] of curTicks) lastCpuTicks.set(k, v);
    lastTicksAt = now;
    return { at: now, procs, source, reason: procs.length ? "" : "本机没有运行中的 node 进程" };
  } catch (e) {
    return {
      at: Date.now(),
      procs: [],
      source,
      reason: `/proc 采样失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function sampleMac(): Promise<ProcSnapshot> {
  const source = "ps -axo pid,%cpu,rss,comm（comm 过滤 node）";
  /**
   * 经 /bin/sh -c 中转，不直接 exec ps；macOS 26 起 /bin/ps 是 setuid root，带 hardened runtime 的进程直接 exec 会被内核拒（EPERM）。
   * 用异步采集而非 `spawnSync`：`ps -axo` 是全系统扫描，同步调用会阻塞事件循环。
   */
  const r = await runCapture("/bin/sh", ["-c", "ps -axo pid=,%cpu=,rss=,comm="], 9000);
  if (r.error || r.code !== 0 || !r.stdout) {
    return {
      at: Date.now(),
      procs: [],
      source,
      reason: `ps 采样失败：${r.error || `ps 退出码 ${r.code}`}`,
    };
  }
  const procs: NodeProcSample[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!m || m.length < 5) continue;
    if (!/\/node(\.|$)|^node(\.|$)/.test(m[4] ?? "")) continue;
    procs.push({ pid: Number(m[1]), cpu: Number(m[2]), mem: Number(m[3]) * 1024 });
  }
  return { at: Date.now(), procs, source, reason: procs.length ? "" : "本机没有运行中的 node 进程" };
}

async function sampleOnce(): Promise<void> {
  if (process.platform === "win32") procSnap = await sampleWindows();
  else if (process.platform === "darwin") procSnap = await sampleMac();
  else procSnap = sampleLinux();
}

/** 懒启动后台采样器，首次有人看 /api/overview 才开始，unref 不拦进程退出。 */
export function ensureProcSampler(): void {
  if (samplerTimer) return;
  void sampleOnce();
  void sampleSys();
  /** 首轮没有差分、CPU 为 null；400ms 后补一轮。 */
  setTimeout(() => void sampleSys(), 400).unref?.();
  samplerTimer = setInterval(() => {
    void sampleOnce().catch(() => {
      /** sampleOnce 返回带 reason 的快照，不会 reject。 */
    });
    void sampleSys();
  }, SAMPLER_INTERVAL_MS);
  samplerTimer.unref?.();
}

export interface ResourceSampleView {
  sampled_at: string;
  process_count: number;
  cpu_percent: number | null;
  memory_bytes: number | null;
  memory_human: string;
  /** 整机内存压力百分比（0-100），与活动监视器同口径；采样不可用时为 null。 */
  memory_pressure_percent: number | null;
  source: string;
  unavailable_reason: string;
}

export const SYS_SOURCE = "os.cpus() 差分 + 系统内存压力（整机口径）";

export function resourceSample(): ResourceSampleView {
  ensureProcSampler();
  /** CPU 与内存都在 sysSnap 这一份整机采样里；per-pid 清单只在拿得到时补充。 */
  const sysFresh = Date.now() - sysSnap.at < SAMPLER_INTERVAL_MS * 4;
  const procFresh = Date.now() - procSnap.at < SAMPLER_INTERVAL_MS * 4;
  const at = Math.max(sysSnap.at, procSnap.at);
  const reason = !sysFresh
    ? sysSnap.at
      ? "整机采样读数已过期（后台采样器超过 20 秒未产生数据）"
      : "首次采样尚未完成"
    : "";
  return {
    sampled_at: at ? new Date(at).toISOString() : "",
    process_count: procFresh ? procSnap.procs.length : 0,
    cpu_percent: sysFresh ? sysSnap.cpu : null,
    memory_bytes: sysFresh ? sysSnap.memUsed : null,
    memory_human: sysFresh && sysSnap.memUsed !== null ? humanBytes(sysSnap.memUsed) : "—",
    memory_pressure_percent: sysFresh ? sysSnap.memPressure : null,
    source: SYS_SOURCE,
    unavailable_reason: reason,
  };
}
