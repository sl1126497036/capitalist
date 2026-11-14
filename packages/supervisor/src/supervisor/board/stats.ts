/**
 * 工作进程的用量与成本核算。
 *
 * 输入只有工作进程记录、派单记录与日志文件大小，不读界面状态，
 * 因此同一份数据在面板、指标接口与告警里给出相同读数。
 */

import { closeSync, openSync, readSync } from "node:fs";

import { statCached } from "../../core/fsCache";
import { effectiveCtxWindow, readCtxWindowChosen } from "../../core/limits";
import type { Dispatch, WorkerRecord } from "../../core/supervisor";
import { creditOfWorker } from "../creditLedger";
import { noUsage, workerUsageRow, type UsageFigures } from "../usage";
import { atTs, dispatchModel, listWorkersBoard, readDispatchesBoard } from "./sources";

export interface ThreadCost {
  output_bytes: number;
  duration_sec: number;
  spawn_count: number;
}

export interface ThreadCostRow extends ThreadCost {
  id: string;
  shard: string;
  stage: string;
  usage: UsageFigures;
}

export const LAUNCH_PROBE_BYTES = 4096;

export function launchBannerBytes(file: string): number {
  try {
    if (!statCached(file)) return 0;
    const buf = Buffer.alloc(LAUNCH_PROBE_BYTES);
    const handle = openSync(file, "r");
    let read = 0;
    try {
      read = readSync(handle, buf, 0, buf.length, 0);
    } finally {
      closeSync(handle);
    }
    let bytes = 0;
    for (const line of buf.subarray(0, read).toString("utf8").split("\n")) {
      if (!line.startsWith("[launch")) break;
      bytes += Buffer.byteLength(line, "utf8") + 1;
    }
    return bytes;
  } catch {
    return 0;
  }
}

export function spawnCountFor(stage: string, shard: string, dispatches: readonly Dispatch[]): number {
  return shard
    ? dispatches.filter((d) => (d.shard ?? "") === shard).length
    : dispatches.filter((d) => d.stage === stage && !d.shard).length;
}

export const logStatsCache = new Map<string, { key: string; size: number; banner: number }>();
export const LOG_STATS_CACHE_MAX = 512;

export function logStats(file: string): { size: number; banner: number } {
  try {
    /* 一轮请求里每条日志会被预览、成本、头像各查一次，stat 走缓存。 */
    const st = statCached(file);
    if (!st) return { size: 0, banner: 0 };
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = logStatsCache.get(file);
    if (hit && hit.key === key) return hit;
    const v = { key, size: st.size, banner: launchBannerBytes(file) };
    if (logStatsCache.size >= LOG_STATS_CACHE_MAX) logStatsCache.clear();
    logStatsCache.set(file, v);
    return v;
  } catch {
    return { size: 0, banner: 0 };
  }
}

export function workerCost(w: WorkerRecord, dispatches: Dispatch[], nowSec = Date.now() / 1000): ThreadCost {
  const start = atTs(w.started_at);
  const d = w.dispatch ? dispatches.find((x) => x.id === w.dispatch) : undefined;
  const doneTs = d?.done_at ? atTs(d.done_at) : 0;
  const live = w.status === "running" || w.status === "starting";
  const end = doneTs > 0 ? doneTs : live ? nowSec : Math.max(w.heartbeat_ts, 0);
  const stats = logStats(w.log);
  return {
    output_bytes: Math.max(0, stats.size - stats.banner),
    duration_sec: start > 0 && end > start ? Math.round(end - start) : 0,
    spawn_count: spawnCountFor(w.stage, w.shard ?? "", dispatches),
  };
}

export function threadCostRows(root: string): ThreadCostRow[] {
  return costRowsWith(listWorkersBoard(root), readDispatchesBoard(root), root);
}

export const costRowCache = new Map<string, { fp: string; row: ThreadCostRow }>();
export const COST_ROW_CACHE_MAX = 1024;

export function costRowOf(w: WorkerRecord, dispatches: Dispatch[], nowSec = Date.now() / 1000, root = ""): ThreadCostRow {
  const live = w.status === "running" || w.status === "starting";
  const d = w.dispatch ? dispatches.find((x) => x.id === w.dispatch) : undefined;
  const fp = [
    w.status,
    String(w.started_at ?? ""),
    String(w.heartbeat_ts ?? 0),
    String(d?.done_at ?? ""),
    String(d?.attempt ?? 0),
    dispatches.length,
    logStats(w.log).size,
    // 积分摊算可能晚于收工落账，结构指纹包含积分值。
    String(root ? creditOfWorker(root, w.id) ?? "" : ""),
  ].join("|");
  if (!live) {
    const hit = costRowCache.get(w.id);
    if (hit && hit.fp === fp) return hit.row;
  }
  const row: ThreadCostRow = {
    id: w.id,
    shard: w.shard ?? "",
    stage: w.stage,
    ...workerCost(w, dispatches, nowSec),
    usage: workerUsageRow(w, dispatches, root),
  };
  if (!live) {
    if (costRowCache.size >= COST_ROW_CACHE_MAX) costRowCache.clear();
    costRowCache.set(w.id, { fp, row });
  }
  return row;
}

export function costRowsWith(workers: readonly WorkerRecord[], dispatches: readonly Dispatch[], root = ""): ThreadCostRow[] {
  const nowSec = Date.now() / 1000;
  const rows: ThreadCostRow[] = workers.map((w) => costRowOf(w, dispatches as Dispatch[], nowSec, root));
  const served = new Set(workers.map((w) => w.dispatch));
  const keys = new Set(rows.map((r) => r.id));
  for (const d of dispatches) {
    if (d.status !== "open" && d.status !== "claimed") continue;
    if (d.id && served.has(d.id)) continue;
    const key = d.shard ? `shard:${d.shard}` : d.id;
    if (keys.has(key)) continue;
    keys.add(key);
    rows.push({
      id: key,
      shard: d.shard ?? "",
      stage: d.stage,
      output_bytes: 0,
      duration_sec: 0,
      spawn_count: spawnCountFor(d.stage, d.shard ?? "", dispatches),
      usage: noUsage(d.at, dispatchModel(d)),
    });
  }
  return fillContextWindow(rows, root, (r) => r.id);
}

/**
 * 补齐每行读数的上下文分母。
 *
 * 分母按作用域分别取：监工的窗口由 {@link buildSupervisorContextView} 单独算，这里只处理工作进程。
 * 每个工作进程自己设过的值优先（`scopeOf` 给出该行的作用域键），没设过用默认档，
 * 两种情况都不超过该行模型的真实窗口。
 */
export function fillContextWindow<T extends { usage: { model: string; context_window: number | null } }>(
  rows: T[],
  root = "",
  scopeOf?: (row: T) => string,
): T[] {
  for (const r of rows) {
    const u = r.usage;
    if (!u.model) continue;
    const scope = scopeOf ? scopeOf(r) : "default";
    const chosen = root && scope ? readCtxWindowChosen(root, scope) : null;
    const w = effectiveCtxWindow(u.model, u.context_window, chosen);
    if (w !== u.context_window) r.usage = { ...u, context_window: w };
  }
  return rows;
}

export const METRICS_COST_ROWS_MAX = 20;

export function pickCurrentCostRows(
  rows: readonly ThreadCostRow[],
  workers: readonly WorkerRecord[],
  dispatches: readonly Dispatch[],
): ThreadCostRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const picked: ThreadCostRow[] = [];
  const liveIds = new Set<string>();
  for (const w of workers) {
    if (w.status !== "running" && w.status !== "starting") continue;
    liveIds.add(w.id);
    const r = byId.get(w.id);
    if (r) picked.push(r);
  }
  const rest = workers
    .filter((w) => !liveIds.has(w.id))
    .sort((a, b) => String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")))
    .slice(0, Math.max(0, METRICS_COST_ROWS_MAX - picked.length));
  for (const w of rest) {
    const r = byId.get(w.id);
    if (r) picked.push(r);
  }
  for (const d of dispatches) {
    if (d.status !== "open" && d.status !== "claimed") continue;
    for (const key of [d.shard ? `shard:${d.shard}` : "", d.id]) {
      const r = key ? byId.get(key) : undefined;
      if (r && !picked.includes(r)) picked.push(r);
    }
  }
  return picked;
}

export function costTotals(rows: readonly ThreadCost[]): {
  total_duration_sec: number;
  total_output_bytes: number;
  total_spawn_count: number;
} {
  let duration = 0;
  let output = 0;
  let spawns = 0;
  for (const r of rows) {
    duration += r.duration_sec;
    output += r.output_bytes;
    spawns += r.spawn_count;
  }
  return { total_duration_sec: duration, total_output_bytes: output, total_spawn_count: spawns };
}

export function tokenTotals(figs: readonly UsageFigures[]): {
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_tokens: number | null;
  total_cache_read_tokens: number | null;
  usage_reported: number;
  usage_unreported: number;
  billing_unit: string;
  total_credit: number | null;
  credit_unit: string;
} {
  const sum = (pick: (f: UsageFigures) => number | null): number | null => {
    let total = 0;
    let hit = 0;
    for (const f of figs) {
      const v = pick(f);
      if (v === null) continue;
      total += v;
      hit++;
    }
    return hit > 0 ? total : null;
  };
  const cost = sum((f) => f.cost_usd);
  const input = sum((f) => f.input_tokens);
  const reported = figs.filter((f) => f.reported).length;
  const credit = sum((f) => f.credit);
  return {
    total_input_tokens: input,
    total_output_tokens: sum((f) => f.output_tokens),
    total_tokens: sum((f) => f.total_tokens),
    total_cache_read_tokens: sum((f) => f.cache_read_tokens),
    usage_reported: reported,
    usage_unreported: figs.length - reported,
    billing_unit: credit !== null ? "credit" : cost !== null && cost > 0 ? "usd" : input !== null ? "token" : "",
    total_credit: credit,
    credit_unit: credit !== null ? (figs.map((f) => f.credit_unit).find(Boolean) || "积分") : "",
  };
}
