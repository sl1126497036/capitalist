/**
 * 终端状态行：每轮输出一行，说明在做什么、卡在哪。
 *
 * 只写用户能据以行动的信息：阶段、进程数、队列，以及不派新单的原因。内部判据
 * （tick、槽位、闸门名）不进这一行，逐轮重复同一行会把真正发生的事挤掉。
 */

import { t } from "../cli/lang";
import { openInboxAsks } from "../core/dispatch/inbox";
import { ASK_BLOCK_MS } from "../core/guard/limits";
import { readPause } from "../core/record/pause";
import { loadState } from "../core/record/state";
import type { TaskState } from "../core/types";

/** 本轮状态摘要；读不到任务状态时返回空串。正常状态只报“运行中”，停派原因才跟在后面。 */
export function describeStatusLine(root: string, capacity: number): string {
  const state = loadState(root);
  if (!state) return "";
  const held = holdReason(root, state);
  return held ? t(`[supervisor] running · ${held}`, `[监工] 运行中 · ${held}`) : t("[supervisor] running", "[监工] 运行中");
}

/** 当前不派新单的原因；没有停派原因时返回空串。口径与看板提示一致。 */
export function holdReason(root: string, state: TaskState): string {
  const pause = readPause(root);
  if (pause) return t(`paused (${pause.reason || "no reason given"})`, `已暂停（${pause.reason || "未写原因"}）`);
  /*
   * 阻塞不进状态行：看板没有对应位置，终端单独说一句，用户会拿两份界面对不上。
   * 需要看阻塞时用 `capitalist status`，那里列出类型与时间。
   */
  const asks = openInboxAsks(root).filter((a) => {
    const at = Date.parse(String(a.at ?? ""));
    return Number.isFinite(at) && Date.now() - at < ASK_BLOCK_MS;
  });
  if (asks.length > 0)
    return t(
      `${asks.length} question(s) awaiting an answer (see capitalist inbox)`,
      `${asks.length} 个问题等回答（capitalist inbox 查看）`,
    );
  return "";
}
