/**
 * 用户消息的送达档位。
 *
 * 气泡只回答送到了没有。判定必须与台账字段同源：早先前端解析 `status` 文案里的主状态词，
 * 文案一改（分隔符换掉、措辞换掉），整片插话判成待送达。这里按台账字段出码，界面按码出词，
 * 文案怎么改都不影响判定。
 */

import type { Delivery } from "./snapshot";

/**
 * 对话层的问话：写进事件台账时收件方已经取走，恒为已送达。
 *
 * 用于 `supervisor_chat_ask`，监工面板与工作进程面板各有一处构造。
 */
export const DELIVERED: Delivery = "ok";

/**
 * 插话台账记录的送达档位。
 *
 * 未领走是待送达；领走后按投递路径分，随阶段推进作废的记录没有进程接收，算未送达。
 */
export function directiveDelivery(r: { consumed?: unknown; consumed_via?: unknown }): Delivery {
  if (r.consumed !== true) return "pending";
  return String(r.consumed_via ?? "") === "dropped" ? "bad" : "ok";
}
