/**
 * 把已终结的派单重新置为 open 供重新领取。
 *
 * 终止字段须 delete 而非置空：done_at、retry_verdict、review_until 任一存在都会重新挡住该单。
 * 监工的判定打回与用户按单号重派共用这一份，避免两处各写一套清字段的顺序。
 */

import { writeJsonl } from "../core/record/json";
import { dispatchPath, readDispatches, type Dispatch } from "../core/record/supervisor";

export function reopenSettledDispatch(root: string, id: string, why: string): Dispatch | null {
  const rows = readDispatches(root);
  const idx = rows.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  const next: Dispatch = { ...(rows[idx] as Dispatch), status: "open", ...(why ? { note: why } : {}) };
  delete next.done_at;
  delete next.review_until;
  delete next.review_note;
  delete next.retry_verdict;
  delete next.retry_why;
  rows[idx] = next;
  writeJsonl(dispatchPath(root), rows);
  return next;
}
