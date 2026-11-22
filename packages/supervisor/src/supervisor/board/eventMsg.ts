/**
 * 台账事件在界面上的身份。
 *
 * 两个读接口都要把 `events.jsonl` 的事件转成消息：线程消息流与监工事件流。两边早先各写
 * 一份判定，且都用 `msgId` 给缺号事件补号，补出来的号随进程级计数器漂移，同一事件每轮
 * 换号，前端按 id 合并就认不出是同一条。这里收成一处，取号走单次重建的发号器。
 *
 * 事件自带的 `msg_id`（部分事件把号写在 `id` 上）优先，它是写入时落的，重建不变。缺号且
 * 属于可引用事件时补一个；其余按视图块处理，界面不显示编号、不提供引用。
 */

import { isMsgNo, msgIdScope } from "../../core/message/msgId";
import { REFUNDABLE_EVENTS } from "./snapshot";
import { fingerprint } from "./render";
import { atTs } from "./sources";
import { viewId } from "./viewId";

/** 单次重建内的发号器，由构建函数在建消息前生成一个。 */
export type MsgIdScope = ReturnType<typeof msgIdScope>;

export interface EventRefOptions {
  /** 事件归属任务号，调用方按自己认得的来源算好。 */
  taskNo: string;
  /** 视图块身份前缀，用线程 id。 */
  base: string;
  /** 单次重建内的发号器。 */
  nextId: MsgIdScope;
}

export interface EventRef {
  id: string;
  /** 视图块为 true：不是消息，界面不显示编号、不提供引用。 */
  view: boolean;
}

/** 事件身份：自带消息号 → 可引用事件的补号 → 视图块。 */
export function eventRef(e: Record<string, unknown>, opts: EventRefOptions): EventRef {
  const own = String((e as { msg_id?: unknown }).msg_id ?? (e as { id?: unknown }).id ?? "").trim();
  if (isMsgNo(own)) return { id: own, view: false };
  const name = String(e.event ?? e.kind ?? "");
  if (REFUNDABLE_EVENTS.has(name)) {
    /* 事件落盘时必须带 at；缺失时按 0 取号，仍比取当前时间稳定。 */
    const born = Math.round(atTs(String(e.at ?? "")) * 1000);
    return { id: opts.nextId(opts.taskNo, name === "mq_triage" ? "S2W" : "S2U", born), view: false };
  }
  return { id: viewId(opts.base, "event", fingerprint(e)), view: true };
}
