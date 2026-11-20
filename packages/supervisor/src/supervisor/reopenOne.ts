/**
 * 按单号或派单 id 重开一张单。
 *
 * 额度、凭证这类原因由人工确认恢复后，用户需要一个“把它放回队列”的入口；只按分片重派
 * 对没有分片的单无效，`retry #12` 因此只认单号。
 */

import { recordEvent } from "../core/record/ledger";
import { reopenSettledDispatch } from "./reopenDispatch";
import { dispatchOfThreadNo } from "./usage/threadNo";
import { readDispatches } from "../core/record/supervisor";

export type ReopenResult = { ok: true; id: string } | { ok: false; reason: string };

/**
 * @returns 命中单引用时返回结果；`arg` 不是单引用（分片名等）时返回 null，由调用方按分片处理。
 */
export function reopenOneByRef(root: string, arg: string, directiveId: string): ReopenResult | null {
  const text = String(arg ?? "").trim();
  const noM = /^#\s*(\d{1,4})$/.exec(text);
  const rows = readDispatches(root);
  const hit = noM
    ? dispatchOfThreadNo(root, Number(noM[1]), rows, { includeDone: true })
    : text.startsWith("D-")
      ? rows.find((x) => String(x.id) === text)
      : undefined;
  if (!hit) return null;

  const st = String(hit.status ?? "");
  if (st === "claimed" || st === "reported" || st === "review") {
    return { ok: false, reason: `这一单仍在执行或等待裁决（${st}），无需重派；修改做法用 amend` };
  }
  const next = reopenSettledDispatch(root, String(hit.id), "用户要求重派");
  if (!next) return { ok: false, reason: "重开失败：该单已在执行，或取号锁被占用，稍后重试即可" };
  recordEvent(root, "dispatch_reopened", {
    dispatch: next.id,
    source: String(hit.id),
    by: "supervisor-direct",
    directive: directiveId,
  });
  return { ok: true, id: String(next.id) };
}
