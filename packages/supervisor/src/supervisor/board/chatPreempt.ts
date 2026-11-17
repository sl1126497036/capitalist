/**
 * 监工对话的抢占收尾。
 *
 * 用户追加新内容时，正在提交的回执或报告不该继续占着通道：新消息必须立刻被处理。
 * 这里把两件事放在一起：掐断正在跑的那一轮，以及把被打断的要求留给下一轮。
 * 只做前者，用户连发时先提出的那条就会静默消失。
 */

import { recordEvent } from "../../core/record/ledger";
import { settleChat } from "../view/chatSettle";
import type { BoardCtx } from "./types";

/**
 * 被打断且尚未执行的消息原文，按任务根分开存。
 *
 * 取用即清，避免陈旧要求被反复带进后续轮次。进程重启会清空——原文仍在消息流里，
 * 用户看得见，也可以重发。
 */
const preemptedAsks = new Map<string, string[]>();
const PREEMPTED_KEEP = 5;

/** 记下一条被新消息打断、尚未执行的要求。 */
export function rememberPreemptedAsk(root: string, text: string): void {
  const one = String(text ?? "").trim().slice(0, 2000);
  if (!one) return;
  const list = preemptedAsks.get(root) ?? [];
  list.push(one);
  preemptedAsks.set(root, list.slice(-PREEMPTED_KEEP));
}

/** 取走待提醒的打断消息：只提醒一轮。 */
export function takePreemptedAsks(root: string): string[] {
  const list = preemptedAsks.get(root) ?? [];
  preemptedAsks.delete(root);
  return list;
}

/**
 * 提示词里的一节：上一条被本消息打断、尚未执行的要求。
 *
 * 不提这一句，监工就会当它没发生过，用户却以为两条都收到了。
 */
export function preemptedPromptLines(root: string): string[] {
  const list = takePreemptedAsks(root);
  if (list.length === 0) return [];
  return [
    "",
    "【上一条消息被本消息打断，其要求尚未执行】",
    ...list.map((one) => `- ${one}`),
    "若本消息没有覆盖它，按原意处理或先向用户确认；不要声称已经做过。",
  ];
}

/**
 * 被新消息抢占时的统一收尾。
 *
 * 记为 `answered_only` 而不是 `amended`：本轮没有产出回复、也没有改派单，要求确实没被执行。
 * `answered_only` 在命中要求特征时会进入待处理清单，用户连发时先提出的那条才不会静默丢失。
 */
export function replyPreempted(
  ctx: BoardCtx,
  args: {
    msgId: string;
    text: string;
    thread: string;
    from: "worker" | "supervisor";
    sse: (obj: unknown) => void;
  },
): void {
  const reason = "被更新的用户消息打断，本条未执行";
  /* 监工对话被打断的消息留给下一轮提醒；工作进程会话里的插话已登记到派单，不会丢失。 */
  if (args.from === "supervisor" && !args.thread) rememberPreemptedAsk(ctx.opts.root, args.text);
  settleChat(ctx.opts.root, {
    msg_id: args.msgId,
    verdict: "answered_only",
    text: args.text,
    ...(args.thread ? { thread: args.thread } : {}),
    error: reason,
  });
  recordEvent(ctx.opts.root, "supervisor_reply", {
    ask: args.text,
    reply: "",
    want: "",
    applied: reason,
    thread: args.thread,
    from: args.from,
    preempted: true,
  });
  args.sse({ kind: "preempted", text: reason, applied: reason });
  ctx.res.end();
}
