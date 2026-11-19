/**
 * 终端状态行：只报运行与暂停两种状态。
 *
 * 停派原因不进控制台：看板已有对应位置的，两边口径不一致用户就无法对照；需要细节
 * 时用 `capitalist status` 或看板。控制台一行一个状态，不追加来源、编号与计数。
 */

import { t } from "../cli/lang";
import { readPause } from "../core/record/pause";
import { loadState } from "../core/record/state";

/** 本轮状态；读不到任务状态时返回空串。 */
export function describeStatusLine(root: string, _capacity: number): string {
  if (!loadState(root)) return "";
  return readPause(root) !== null
    ? t("[supervisor] paused", "[监工] 已暂停")
    : t("[supervisor] running...", "[监工] 运行中…");
}
