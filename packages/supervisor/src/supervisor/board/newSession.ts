/**
 * 新建监工会话。
 *
 * 只换会话，不动任务卡与台账：监工换到下一代会话，本任务根下已登记的派单会话同步换代，
 * 并写一条 `chat_session_new` 作为监工流的下界。清空任务卡与新建会话是两件事，互不触发。
 */
import { existsSync, writeFileSync } from "node:fs";

import { recordEvent } from "../../core/record/ledger";
import { contextPath, rotateChatSession } from "../context/reload";
import { rotateAllLanes } from "../judge/sessionLane";

/**
 * 换代并返回回执文案。
 *
 * 换监工会话失败时抛出：静默保留旧会话会让用户以为上下文已经清空。
 * 派单会话换代失败只影响条数，不回滚监工侧已完成的换代。
 */
export function startNewSession(root: string): { session: string; lanes: number; effective: string } {
  const session = rotateChatSession(root, "gen", 0).session_id;
  /*
   * 上一代的压缩简报不再注入：它属于上一代会话的摘要，留着会让新会话首轮提示继续带
   * “重载后继承的上下文”。台账仍在，监工每轮按台账重建状态，不依赖这份摘要。
   */
  try {
    if (existsSync(contextPath(root))) writeFileSync(contextPath(root), "", "utf8");
  } catch {
    /* 写不进去时保留旧简报：新会话会多带一段上一代摘要，不影响调度。 */
  }
  /* 会话边界：监工流只返回这条之后的消息，界面清空后刷新不会把旧消息读回来。 */
  recordEvent(root, "chat_session_new", { session });
  let lanes = 0;
  try {
    lanes = rotateAllLanes(root);
  } catch {
    lanes = 0;
  }
  const bits = [`监工对话已换新会话（${session}）`];
  if (lanes) bits.push(`${lanes} 条派单会话同步换代`);
  return { session, lanes, effective: bits.join("，") };
}
