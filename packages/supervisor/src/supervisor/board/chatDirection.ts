/**
 * 用户消息承接方的唯一判定入口。
 *
 * 方向段曾在四处各自判定：对话路由的线程分支写死 `U2W`、监工分支按 `via` 字符串判、
 * 插话写死 `U2W`、消息模块以 `U2W` 作缺省。判据用错维度时（把“是否监工介入”当成
 * “谁承接这条消息”），监工面板直发的消息全部落成 `U2W`，与“用户发给 Worker”无法区分。
 *
 * 现只在 {@link chatCarrierOf} 判定：会话归属监工，或请求声明由监工承接，即为监工承接；
 * 其余登记给工作进程。对话路由的分支条件与消息编号必须读同一个结果，避免
 * “进入工作进程分支、编号却标成监工承接”这类漂移。
 */

import { userMsgDirectionOf, type MsgDirection } from "../../core/message/msgId";

/** 监工会话在前端的选择值；线程会话不会取该值。 */
export const SUPERVISOR_THREAD = "capitalist";

/** 请求声明的承接方：工作进程会话内按“监工介入”发送时取该值。 */
export const SUPERVISOR_VIA = "capitalist";

/** 用户消息的承接方。 */
export type ChatCarrier = "supervisor" | "worker";

/**
 * 判定一条对话请求由谁承接。
 *
 * @param input.thread 会话归属；监工会话为空串或 {@link SUPERVISOR_THREAD}。
 * @param input.via 请求声明的承接方；工作进程会话内发起监工介入时为 {@link SUPERVISOR_VIA}。
 */
export function chatCarrierOf(input: { thread?: string; via?: string }): ChatCarrier {
  const thread = String(input.thread ?? "").trim();
  const via = String(input.via ?? "").trim();
  if (via === SUPERVISOR_VIA) return "supervisor";
  if (!thread || thread === SUPERVISOR_THREAD) return "supervisor";
  return "worker";
}

/** 一条对话请求的用户消息方向段：由 {@link chatCarrierOf} 的承接方映射。 */
export function chatDirectionOf(input: { thread?: string; via?: string }): MsgDirection {
  return userMsgDirectionOf(chatCarrierOf(input));
}
