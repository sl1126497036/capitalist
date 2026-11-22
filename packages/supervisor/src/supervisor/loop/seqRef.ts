/**
 * 同一条消息内的相对引用：`PARENT: @1` 指「本条消息第 1 个派单」。
 *
 * 为什么需要它：一条消息可以写多个 `DO: dispatch`（用户一次贴两段任务、模型一次拆两步）。
 * 这些单的编号在建单前并不存在，`PARENT: #03` 无法指向「刚刚同一批里的第一单」。
 * 早先的做法是：多动作消息的树字段整体丢弃，于是两张单都成了根，并行跑起来。
 *
 * `@N` 只查「同一 `msg_id` 下第 N 个 `dispatch` 指令建出的单」，不猜语义、不做推断：
 * 那条单没建成（被拒、还在排队）就返回 undefined，由调用方给出明确拒绝，
 * 而不是在无提示的情况下降级成根节点。
 */

import { readDispatches, type Dispatch } from "../../core/record/supervisor";
import { listSupervisorDirectives } from "../channel/direct";

/** 是否形如 `@1` / `@2`。 */
export function isSeqRef(tok: string): boolean {
  return /^@\d+$/.test(String(tok ?? "").trim());
}

/**
 * 取本条消息第 `seq` 个派单建出的单（1 起）。
 *
 * 只数 `dispatch`：用户说的「第 1 张单」指的是第 1 个派单动作，中间的 `ask` / `skip`
 * 不占这个序号。指令台账按写入顺序保存，同一 `msg_id` 的多条相邻，顺序即动作顺序。
 */
export function dispatchOfSeq(root: string, msgId: string, seq: number): Dispatch | undefined {
  const want = Math.trunc(Number(seq));
  const msg = String(msgId ?? "").trim();
  if (!msg || !Number.isFinite(want) || want <= 0) return undefined;

  const picks = listSupervisorDirectives(root).filter(
    (r) => String(r.msg_id ?? "") === msg && String(r.action ?? "") === "dispatch",
  );
  const id = String(picks[want - 1]?.result?.dispatch ?? "");
  if (!id) return undefined;
  return readDispatches(root).find((d) => String(d.id) === id);
}
