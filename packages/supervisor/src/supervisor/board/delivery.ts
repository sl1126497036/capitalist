/**
 * 用户消息的送达档位。
 *
 * 气泡仅显示送达结果。判定须与台账字段同源：此前前端解析 `status` 文案中的主状态词，
 * 文案一旦变更（分隔符或措辞调整），整段插话即被误判为待送达。现按台账字段生成档位码，
 * 界面按档位码生成文案。
 */

import type { Delivery } from "./snapshot";

/**
 * 对话层的提问写入事件台账时，收件方/监工/工作进程已读取，档位恒为已送达。
 *
 * 用于 `supervisor_chat_ask`，监工面板与工作进程面板各有一处构造。
 */
export const DELIVERED: Delivery = "ok";

/**
 * 插话台账记录的送达档位。
 *
 * 未被领取为待送达；领取后按投递路径判定，目标单已终结而无法投递的记录无进程接收，判为未送达。
 */
export function directiveDelivery(r: { consumed?: unknown; consumed_via?: unknown }): Delivery {
  if (r.consumed !== true) return "pending";
  return String(r.consumed_via ?? "") === "dropped" ? "bad" : "ok";
}
