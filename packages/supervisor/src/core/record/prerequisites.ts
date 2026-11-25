/**
 * 前置判定与“同一件事”的身份口径。
 *
 * 从 `supervisor.ts` 拆出：前置判定、任务内容指纹、派生链身份三者互相依赖，且只服务于
 * “下游能不能放行”这一个问题。留在台账模块里既撑大文件，也让调用方误以为它们与读写落盘
 * 同属一层。
 *
 * 判定分两段：
 *   1. 派单前置（`parent` / `after` 里的派单 id）：同一件事的后续尝试完成即视为满足，
 *      同分片已有完成单也视为满足；
 *   2. 组前置（`G` 号）不在这里判定，由 `core/dispatch/deps.ts` 交给 `groupSettled`：
 *      组要整组了结才放行，不能沿用单张单的宽容规则。
 *
 * 两条宽容规则都以“最后一次尝试”为准：用户重派一张已验收的单之后，旧单的完成不能让
 * 下游提前放行。
 */

import type { Dispatch } from "./supervisor";
import { isSettled } from "./dispatchState";
import { isGroupRef } from "./nodeRef";

/** 一张派单的父节点 id：`parent` 优先；老台账里只有一个 `after` 的记录按父节点处理。 */
export function parentOf(d: { id?: string; parent?: string; after?: string[] }): string {
  const p = String(d.parent ?? "").trim();
  if (p) return p;
  const after = Array.isArray(d.after) ? d.after.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
  if (after.length === 1 && after[0] !== "*") return after[0] as string;
  return "";
}

/** 前置集合：父节点 + 遗留 `after` 里的多前置。`barrier` 表示带 `"*"`（等所有其它单到终态）。 */
export function prerequisitesOf(d: {
  id?: string;
  parent?: string;
  after?: string[];
}): { ids: string[]; barrier: boolean } {
  const after = Array.isArray(d.after) ? d.after.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
  const ids = [...new Set([parentOf(d), ...after.filter((x) => x !== "*")].filter(Boolean))];
  return { ids, barrier: after.includes("*") };
}

/**
 * 这张单挂的前置里，哪些编号在台账里根本找不到（孤儿前置）。
 *
 * {@link dependenciesSettled} 对孤儿前置按“已满足”放行（等一个不存在的编号就是永久
 * 等待），但放行必须留痕：调度层每拍拿这个函数核对，有孤儿就记
 * `dispatch_parent_missing` 事件，否则台账被归档/重写之后，依赖静默失效，
 * 顺序错了却没人知道是哪张单、缺了哪个编号。
 */
export function missingPrerequisites(
  d: { id: string; parent?: string; after?: string[] },
  rows: Dispatch[],
): string[] {
  const { ids } = prerequisitesOf(d);
  if (ids.length === 0) return [];
  const byId = new Set(rows.map((x) => String(x.id)));
  /*
   * 组号不是派单，不按“派单孤儿”计：组的缺失由组索引的 `dangling` 单独上报
   * （`group_missing`）。若合并统计，每张挂组的派单都会记一条误报的孤儿事件。
   */
  return ids.filter((id) => !isGroupRef(id) && !byId.has(id));
}

/**
 * 一条派生链的身份：同一件事的多次派单共用它。
 *
 * `lineage` 为空串时视同自身，不把空串当成一条公共链：否则所有缺字段的老单会被并成
 * 一件事，完成数、前置判定与重派识别全部错位。
 */
export function lineageOf(d: Dispatch): string {
  return String(d.lineage || d.id);
}

/**
 * 一张单的任务内容指纹：剥掉附件行、压平空白后的正文。
 *
 * 台账里同一件事会有多条记录（每次重派一条），它们只有 `action` 尾部可能被追加
 * 插话/验收清单。做归组（重建树）和认亲（派生链匹配）都靠这个指纹，口径必须同一份。
 *
 * 正文为空时退回分片，再为空退回标题。
 */
export function workKeyOf(d: { action?: string; title?: unknown; shard?: string }): string {
  const body = String(d.action ?? "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[附件]/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  if (body) return body;
  const shard = String(d.shard ?? "").trim();
  if (shard) return `shard:${shard}`;
  return `title:${String(d.title ?? "").trim()}`;
}

/** 两张单是否同一份工作：正文指纹相同，或标题整条继承（重派路径会带过来）。 */
function sameWork(a: Dispatch, b: Dispatch): boolean {
  if (workKeyOf(a) === workKeyOf(b)) return true;
  const ta = String((a as { title?: unknown }).title ?? "").trim();
  const tb = String((b as { title?: unknown }).title ?? "").trim();
  return Boolean(ta) && ta === tb;
}

/**
 * 还差哪些前置没满足（只看派单前置，组前置交给调用方）。
 *
 * 宽容规则落在“最后一次尝试”上：派生链与分片各取台账里最后一张单，只有它了结才算满足。
 * 用户重派一张已验收的单后，旧单的 `done` 不能再让下游放行。
 *
 * @returns 未满足的前置 id；孤儿前置不计入，由 {@link missingPrerequisites} 单独上报。
 */
export function pendingPrerequisites(
  d: { id: string; parent?: string; after?: string[] },
  rows: Dispatch[],
): string[] {
  const { ids, barrier } = prerequisitesOf(d);
  const pending: string[] = [];

  if (barrier) {
    /* 除自己以外，还有没有活着的单：有就等，没有才轮到我。 */
    const alive = rows.some(
      (x) => x.id !== d.id && x.status !== "done" && x.status !== "closed" && x.status !== "failed",
    );
    if (alive) pending.push("*");
  }
  if (ids.length === 0) return pending;

  const settled = rows.filter((x) => isSettled(String(x.status)));
  /* 派生链 -> 已完成的那些记录。判据是“同一件事的后续尝试”，不是“同一条链上任一张”。 */
  const settledByLineage = new Map<string, Dispatch[]>();
  for (const x of settled) {
    const k = lineageOf(x);
    const list = settledByLineage.get(k);
    if (list) list.push(x);
    else settledByLineage.set(k, [x]);
  }
  const settledShards = new Set(
    settled.filter((x) => String(x.shard ?? "").trim()).map((x) => String(x.shard)),
  );
  const byId = new Map(rows.map((x) => [String(x.id), x] as const));
  /*
   * 每件事、每个分片各自最后一次尝试。台账按追加顺序，后出现的那张就是最近一次派单。
   * 宽容规则（同链后续尝试完成、同分片已有完成单）必须落在这一次上：用户重派一张已验收的
   * 单之后，旧单的完成不能让下游提前放行。
   */
  const latestByLineage = new Map<string, Dispatch>();
  const latestByShard = new Map<string, Dispatch>();
  for (const x of rows) {
    latestByLineage.set(lineageOf(x), x);
    const shard = String(x.shard ?? "").trim();
    if (shard) latestByShard.set(shard, x);
  }
  /** 最后一次尝试是否了结；查不到记录时按已了结算（沿用孤儿放行口径）。 */
  const headSettled = (row: Dispatch | undefined): boolean => !row || isSettled(String(row.status ?? ""));

  for (const id of ids) {
    const ref = byId.get(id);
    if (!ref) continue; // 孤儿前置：放行并留痕，见上面的说明
    const refLineage = lineageOf(ref);
    if (isSettled(String(ref.status)) && headSettled(latestByLineage.get(refLineage))) continue;
    const refShard = String(ref.shard ?? "").trim();
    if (refShard !== "" && settledShards.has(refShard) && headSettled(latestByShard.get(refShard))) {
      continue;
    }
    if (
      settledByLineage.get(refLineage)?.some((x) => sameWork(x, ref)) &&
      headSettled(latestByLineage.get(refLineage))
    ) {
      continue;
    }
    pending.push(id);
  }
  return pending;
}

/**
 * 依赖判定：派单的前置是否都到终态。
 *
 * 判定逻辑在 {@link pendingPrerequisites}，此处为“无剩余前置”的简写；
 * 调度层与森林视图共用该判定。
 */
export function dependenciesSettled(
  d: { id: string; parent?: string; after?: string[] },
  rows: Dispatch[],
): boolean {
  return pendingPrerequisites(d, rows).length === 0;
}
