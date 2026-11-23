/**
 * 台账记录自己的消息编号。
 *
 * `direct.jsonl` 的 `msg_id` 是“触发这条记录的用户消息”编号，用途是回查附件与供工作进程
 * 回报引用，不是记录自己的编号。监工下发的正文若直接沿用该字段，读侧会把监工消息认成
 * 用户消息：方向段停在 `U2S`，并与用户原话同号。
 *
 * 只给监工产生的记录发号：用户发言（`via` 缺省或 `user`）与对话台账里的
 * `supervisor_chat_ask` 是同一条消息的两次登记，必须共用身份才能合并。
 */

import { msgId } from "./msgId";
import { taskNoOfDispatchId } from "../record/tasks";

/**
 * 记录自己的消息编号；非监工来源返回空串，由调用方保持沿用 `msg_id`。
 *
 * 监工生成的内容写进 `direct.jsonl`，收件人是工作进程，方向记 `S2W`。
 *
 * @param via 指令来源，`capitalist` 表示监工对话层生成。
 * @param target 目标派单 id；任务号从中反解，取不到时用监工面板占位 `S0`。
 */
export function directiveOwnId(via: string | undefined, target: string | undefined, now = Date.now()): string {
  if (String(via ?? "") !== "capitalist") return "";
  const no = taskNoOfDispatchId(String(target ?? ""));
  return msgId(no > 0 ? no : "S0", "S2W", now);
}

/** 插话记录里由本模块负责的几个字段；不引 `Directive` 类型，避免 core 内互相依赖。 */
type StampableDirective = {
  id?: string;
  at?: string;
  at_ts?: number;
  msg_id?: string;
  quote?: string;
  quote_text?: string;
};

/**
 * 给一条插话盖章：身份、引用、时间戳顺延。
 *
 * 身份：监工来源发自己的号（`S`）；用户来源沿用触发它的用户消息号（`U2W` / `U2S`）。
 * 用户消息在对话台账里也有一条 `supervisor_chat_ask`，两处必须共用同一个编号才能合并成
 * 一条消息，所以用户来源不另发号。每条插话因此都带可引用的消息编号，无需在领用时再按台账行号补号。
 *
 * 时间戳：同一毫秒连发两条时 `directiveRef` 会指向同一行，结论落到相邻记录上；
 * 与前一条相同或更早（时钟回拨）则顺延 1ms。
 */
export function stampDirective(
  rec: StampableDirective,
  input: { via?: string; target?: string; msgId?: string; quote?: string; quoteText?: string },
  prevAt: string,
): void {
  const ownId = directiveOwnId(input.via, input.target) || String(input.msgId ?? "").trim();
  if (ownId) rec.id = ownId;
  if (input.msgId) rec.msg_id = String(input.msgId);
  const quoteRef = String(input.quote ?? "").trim();
  if (quoteRef) rec.quote = quoteRef;
  const quoteText = String(input.quoteText ?? "").trim();
  if (quoteRef && quoteText) rec.quote_text = quoteText;
  const at = String(rec.at ?? "");
  if (prevAt && at && prevAt >= at) {
    const next = new Date(new Date(prevAt).getTime() + 1);
    if (Number.isFinite(next.getTime())) {
      rec.at = next.toISOString();
      rec.at_ts = next.getTime() / 1000;
    }
  }
}
