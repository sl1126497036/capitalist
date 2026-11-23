/**
 * 终端状态行：报已启动、运行、暂停三种状态。
 *
 * 停派原因不进控制台：看板已展示对应信息，两边口径不一致用户就无法对照；需要细节时用 `capitalist status` 或看板。控制台一行一个状态，不追加来源、编号与计数。
 */

import { t } from "../cli/lang";
import { readPause } from "../core/record/pause";
import { loadState } from "../core/record/state";

/** 本轮状态；读不到任务状态时返回空串。 */
export function describeStatusLine(root: string, _capacity: number): string {
  if (!loadState(root)) return "";
  return readPause(root) !== null
    ? t("[supervisor] paused", "[监工] 调度暂停中")
    : t("[supervisor] running...", "[监工] 运行中…");
}

/**
 * 状态行报告器：内容变化才打印，启动首行固定报“已启动”。
 *
 * 启动即暂停时直接报“暂停中”，用户看不出进程是否已经起来，所以首行改报“已启动”，
 * 并把当轮状态记为已播报；之后恢复调度、再次暂停仍各打一行，状态变化不会漏。
 */
export function createStatusReporter(
  root: string,
  out: (line: string) => void,
): (capacity: number) => void {
  let sig = "";
  let first = true;
  return (capacity: number): void => {
    const line = describeStatusLine(root, capacity);
    if (!line) return;
    if (first) {
      first = false;
      sig = line;
      out(t("[supervisor] started", "[监工] 已启动"));
      return;
    }
    if (line === sig) return;
    out(line);
    sig = line;
  };
}
