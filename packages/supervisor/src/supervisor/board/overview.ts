import { readQuotaState } from "../../core/quota";
import { loadState } from "../../core/state";
import { listWorkers, loadSupervisor, pidAlive, readDispatches } from "../../core/supervisor";
import { balanceView } from "../balance";
import { UsageFigures } from "../usage";
import { threadCostRows, tokenTotals } from "./stats";
import { workingSetBytes, humanBytes, resourceSample, ResourceSampleView } from "./sysmon";
import { TaskCounts, taskCounts } from "./threads";
import { TaskSummary, supervisorStateOf } from "./views";
import { resolve } from "node:path";
/**
 * 全局概览：把多个任务根汇总成一屏可见的总量视图。
 *
 * 依赖单根视图，不做单根之外的读盘。
 */
export interface BoardOverview {
  at: string;
  supervisors: { total: number; running: number; paused: number };
  processes: { total: number; alive: number; queued: number };
  tasks: TaskCounts;
  credit_used: number | null;
  credit_left: number | null;
  credit_unit: string;
  credit_at: string;
  credit_source: string;
  credit_stale: string;
  credit_unavailable_reason: string;
  usage: {
    total_input_tokens: number | null;
    total_output_tokens: number | null;
    total_tokens: number | null;
    total_cache_read_tokens: number | null;
    reported_runs: number;
    unreported_runs: number;
    billing_unit: string;
    total_credit: number | null;
    credit_unit: string;
  };
  /** WorkingSet 之和，一个进程都读不到时为 null。 */
  memory_bytes: number | null;
  memory_human: string;
  /** 整机内存压力百分比（0-100），与活动监视器同口径；采样不可用时为 null。 */
  memory_pressure_percent: number | null;
  resources: ResourceSampleView;
  unreclaimed_pids: number[];
  unreclaimed_detail: Array<{ pid: number; kind: string; id: string; at: string; why: string }>;
  /** 额度是账号级的，任一监工触发额度耗尽即为整个账号不可用。 */
  quota: { exhausted: boolean; at: string; text: string };
  roots: Array<{ root: string; target: string; status: TaskSummary["status"]; processes: number; alive: number; tasks: TaskCounts }>;
}

interface UnreclaimedProc {
  pid: number;
  kind: "监工" | "worker";
  id: string;
  at: string;
  why: string;
}

function unreclaimedOf(roots: string[]): UnreclaimedProc[] {
  const out: UnreclaimedProc[] = [];
  for (const root of roots) {
    try {
      const rec = loadSupervisor(root);
      const pid = Number(rec?.pid ?? 0);
      if (rec && rec.status !== "running" && pid > 0 && pidAlive(pid)) {
        out.push({
          pid,
          kind: "监工",
          id: String(rec.target ?? ""),
          at: String(rec.started_at ?? ""),
          why: `监工记录状态为 ${rec.status}，进程仍在`,
        });
      }
    } catch {
      /** 单个根读失败不影响别的根。 */
    }
    try {
      for (const w of listWorkers(root)) {
        if (w.status === "running" || w.status === "starting") continue;
        if (!(w.pid > 0) || !pidAlive(w.pid)) continue;
        out.push({
          pid: w.pid,
          kind: "worker",
          id: w.id,
          at: String(w.started_at ?? ""),
          why: `worker 已 ${w.status}，进程仍在${w.dispatch ? `（派单 ${w.dispatch}）` : ""}`,
        });
      }
    } catch {
    }
  }
  return out;
}

/** 汇总所有监工，单根读取失败只影响它自己那一行。 */
export function buildOverview(roots: string[]): BoardOverview {
  const pids: number[] = [];
  let running = 0;
  let paused = 0;
  let procTotal = 0;
  let procAlive = 0;
  let queued = 0;
  /** 跨根 token 合计只做加法。 */
  const figs: UsageFigures[] = [];
  const taskTotals: TaskCounts = {
    total: 0,
    running: 0,
    queued: 0,
    paused: 0,
    failed: 0,
    done: 0,
    canceled: 0,
    closed: 0,
    accepted: 0,
    ended: 0,
  };

  const rows: BoardOverview["roots"] = [];
  for (const root of roots) {
    let status: TaskSummary["status"] = "done";
    let procs = 0;
    let alive = 0;
    let counts: TaskCounts = {
      total: 0,
      running: 0,
      queued: 0,
      paused: 0,
      failed: 0,
      done: 0,
      canceled: 0,
      closed: 0,
      accepted: 0,
      ended: 0,
    };
    try {
      status = supervisorStateOf(root).status;
      if (status === "running") running++;
      if (status === "paused") paused++;
      const rec = loadSupervisor(root);
      if (rec && status !== "done" && pidAlive(rec.pid)) pids.push(rec.pid);
      for (const w of listWorkers(root)) {
        if (w.status === "running" || w.status === "starting") {
          procs++;
          if (pidAlive(w.pid)) {
            alive++;
            pids.push(w.pid);
          }
        }
      }
      queued += readDispatches(root).filter((d) => d.status === "open").length;
      for (const r of threadCostRows(root)) figs.push(r.usage);
      counts = taskCounts(root);
    } catch {
      status = "stale";
    }
    for (const k of Object.keys(taskTotals) as Array<keyof TaskCounts>) taskTotals[k] += counts[k];
    procTotal += procs;
    procAlive += alive;
    let target = "";
    try {
      target = String(loadState(root)?.target ?? "");
    } catch {
      target = "";
    }
    rows.push({ root, target, status, processes: procs, alive, tasks: counts });
  }

  const bytes0 = workingSetBytes(pids);
  const res = resourceSample();
  /** 内存口径：采样器成功时取全部 node 进程之和，采样不可用时退回台账 pid 的 WorkingSet 求和。 */
  const bytes = res.memory_bytes ?? bytes0;
  const unreclaimedList = unreclaimedOf(roots);
  /** 额度是账号级的，取当前根的记录去找账号，避免每个根各打一次计费接口。 */
  const balanceRaw = balanceView(roots[0] ?? "");
  /** 额度状态取各根里最近一次判定，只读磁盘 quota.json。 */
  let quota: BoardOverview["quota"] = { exhausted: false, at: "", text: "" };
  for (const root of roots) {
    const q = readQuotaState(root);
    if (!q.exhausted) continue;
    if (!quota.exhausted || q.at > quota.at) quota = q;
  }
  /** 余额照计费接口读数显示，不因模型通道 429 就作废。 */
  const balance = balanceRaw;
  const tokens = tokenTotals(figs);
  return {
    at: new Date().toISOString(),
    supervisors: { total: roots.length, running, paused },
    processes: { total: procTotal, alive: procAlive, queued },
    tasks: taskTotals,
    credit_used: balance.credit_used,
    credit_left: balance.credit,
    credit_unit: balance.credit_unit,
    credit_at: balance.at,
    credit_source: balance.source,
    credit_stale: balance.stale,
    credit_unavailable_reason: balance.reason,
    usage: {
      total_input_tokens: tokens.total_input_tokens,
      total_output_tokens: tokens.total_output_tokens,
      total_tokens: tokens.total_tokens,
      total_cache_read_tokens: tokens.total_cache_read_tokens,
      reported_runs: tokens.usage_reported,
      unreported_runs: tokens.usage_unreported,
      billing_unit: tokens.billing_unit,
      total_credit: tokens.total_credit,
      /* 同 `/api/supervisor`：无工作进程记录时使用账号额度单位，避免回退为 token。 */
      credit_unit: tokens.credit_unit || balance.credit_unit,
    },
    memory_bytes: bytes,
    memory_human: humanBytes(bytes),
    memory_pressure_percent: res.memory_pressure_percent,
    resources: res,
    unreclaimed_pids: unreclaimedList.slice(0, 50).map((x) => x.pid),
    unreclaimed_detail: unreclaimedList.slice(0, 20),
    quota,
    roots: rows,
  };
}

/** 总看板 JSON 带 2 秒缓存，缓存键为任务根集合排序后拼接。 */
const overviewCache = new Map<string, { at: number; body: string }>();
const OVERVIEW_TTL_MS = 2000;

export function overviewJson(roots: string[], fresh = false): string {
  const key = roots.map((r) => resolve(r)).sort().join("|");
  const now = Date.now();
  if (!fresh) {
    const hit = overviewCache.get(key);
    if (hit && now - hit.at < OVERVIEW_TTL_MS) return hit.body;
  }
  const body = JSON.stringify(buildOverview(roots));
  if (overviewCache.size > 16) overviewCache.clear();
  overviewCache.set(key, { at: now, body });
  return body;
}

/**
 * 线程页缓存。
 *
 * 一次页面刷新里，线程列表、监工状态、任务计数会各要一份，彼此只差个 limit；
 * 每份都重算一遍等于把同样的磁盘读取做三四次。这里按任务根缓存 1 秒，
 * 命中时返回浅拷贝。调用方会往线程对象上写展示字段，不能把缓存原件交出去。
 */
