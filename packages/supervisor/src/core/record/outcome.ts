/**
 * 上一轮结论的提取入口。
 *
 * 同一件事被派了多次时，新拉起的进程需要知道上一轮做到哪、定了什么口径。
 * 卡点段与换代后的交接摘要都从这一份取字段，避免两处各写一套截断规则与字段顺序。
 */

import { isTerminal } from "./dispatchState";
import { readDispatches, type Dispatch } from "./supervisor";

/**
 * 压成一行并截断。
 *
 * 台账里的换行与缩进进了提示词会变成新的段落，读者会以为那是新的要求。
 */
export function squashOutcome(text: unknown, max: number): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}

/** 派发序：`15-3` 取 3。用于在同一个任务内取最近一张。 */
function dispatchSeq(id: string): number {
  const m = /-(\d+)$/.exec(String(id ?? ""));
  return m ? Number(m[1]) : 0;
}

/**
 * 同一件事上一张已结束的单。
 *
 * `cur` 是即将拉起的单：排除它自己，只在它的派生链上找终态的派单。
 * 派生链接不上时退回同分片匹配，覆盖旧台账里没有 `lineage` 的记录。
 *
 * 只取终态，不取在途：在途单是另一条正在执行的流，拿它当上一轮结论会让新进程
 * 照着一半的进度重做。
 */
export function lastSettledOf(
  root: string,
  cur: { id?: string | undefined; shard?: string | undefined; lineage?: string | undefined },
): Dispatch | null {
  const chain = String(cur.lineage ?? cur.id ?? "").trim();
  const shard = String(cur.shard ?? "").trim();
  let hit: Dispatch | null = null;
  for (const d of readDispatches(root)) {
    if (cur.id && String(d.id) === String(cur.id)) continue;
    if (!isTerminal(String(d.status ?? ""))) continue;
    const sameChain = chain !== "" && String(d.lineage ?? d.id) === chain;
    const sameShard = shard !== "" && String(d.shard ?? "") === shard;
    if (!sameChain && !sameShard) continue;
    if (!hit || dispatchSeq(String(d.id)) > dispatchSeq(String(hit.id))) hit = d;
  }
  return hit;
}

/** 结束状态在交接摘要里的说法。 */
function stateWord(status: string): string {
  if (status === "done") return "完成";
  if (status === "closed") return "人工结束";
  if (status === "failed") return "失败";
  return status || "结束";
}

/**
 * 交接摘要：新会话起步时交给工作进程的上一轮结论。
 *
 * 只写能改变下一步动作的信息：上一轮是哪张单、怎么结束、定了什么口径、验收意见、
 * 以及核对工作树的办法。没有已结束的单时返回空数组，首次派单不出现这一段。
 */
export function handoffLines(prev: Dispatch | null): string[] {
  if (!prev) return [];
  const lines = [`上一轮派单 ${prev.id}（${stateWord(String(prev.status ?? ""))}）。`];
  const note = squashOutcome(prev.note, 300);
  const verdict = squashOutcome(prev.review_note, 300);
  const why = squashOutcome(prev.retry_why, 200);
  if (note) lines.push(`结论：${note}`);
  if (verdict) lines.push(`验收：${verdict}`);
  if (why) lines.push(`卡点：${why}`);
  lines.push(
    "上一代会话的上下文没有带过来：先看 git status 与 git diff --stat 核对工作树，已改过的文件不重做，缺的补齐；与正文冲突时以工作树现状为准。",
  );
  return lines;
}
