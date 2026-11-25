/**
 * 把已终结的派单重新开出。
 *
 * 重开就是新派一次单：任务号不变，派单序 +1，旧单保持原终态（历史可查），新单继承内容与
 * 派生链。不再原地把旧单翻回 `open` 沿用旧号：那样“派单次数”就数不出来，也会让同一号
 * 对应两段执行。
 *
 * 终止字段须 `delete` 而非置空：`done_at`、`retry_verdict`、`review_until` 任一存在都会重新
 * 阻断该单。监工判定打回与用户按单号重派共用这一份，避免两处各自维护一套清字段的顺序。
 */

import { appendJsonl } from "../core/record/json";
import { NoLockTimeoutError } from "../core/record/noLock";
import { dispatchPath, readDispatches, type Dispatch } from "../core/record/supervisor";
import { ensureTaskForDispatch, resolveDispatchNo } from "../core/record/tasks";

/** 新单上必须不存在的字段：留着会让调度把它当成已结束。 */
const TERMINAL_FIELDS = [
  "done_at",
  "review_until",
  "review_note",
  "retry_verdict",
  "retry_why",
  "closed_at",
  "closed_by",
  "yielded_at",
  "yielded_by",
  "yield_rank",
  "rescued_at",
  "claimed_at",
  "worker",
  "session",
] as const;

/**
 * @param why 重开原因，写入新单的 `note`。
 * @returns 新开的派单；原单不存在、仍在途、或取号锁取不到时返回 `null`。
 */
export function reopenSettledDispatch(root: string, id: string, why: string): Dispatch | null {
  const rows = readDispatches(root);
  const src = rows.find((d) => d.id === id);
  if (!src) return null;
  /* 在途单不是“重开”的对象：那是另一条执行流，调用方应先停进程。 */
  if (src.status === "open" || src.status === "claimed") return null;

  let issued: { no: number; attempt: number; dispatchId: string };
  try {
    issued = resolveDispatchNo(root, src.id);
  } catch (e) {
    /* 取号失败按“没有重开”处理，由调用方下一轮再试，不猜号。 */
    if (e instanceof NoLockTimeoutError) return null;
    throw e;
  }

  const next = {
    ...src,
    id: issued.dispatchId,
    at: new Date().toISOString(),
    status: "open" as const,
    attempt: issued.attempt,
    source: "requeue" as const,
    lineage: String((src as Dispatch & { lineage?: string }).lineage ?? src.id),
    ...(why ? { note: why } : {}),
  } as Dispatch & Record<string, unknown>;
  for (const k of TERMINAL_FIELDS) delete next[k];

  /*
   * 追加而非整份重写：与其他写派单的路径一致，避免与并发写入互相覆盖。
   * 新单的 `id` 由取号临界区先行占位，这里只负责把记录补齐。
   */
  appendJsonl(dispatchPath(root), next);
  ensureTaskForDispatch(root, next as Dispatch);
  return next as Dispatch;
}
