/**
 * 队列编号：只用后端 `/api/threads` 下发的 `no`。
 *
 * 早先这里还有一套本地流水号：按线程 id 在 localStorage 里自增发号，用于“后端没给号时先显示
 * 一个”。那会造出第三套编号，与任务号、派单号都对不上，是界面编号错乱的来源之一，已删除。
 * 后端没有号就不显示号，不本地补。
 */
import { queueOrder } from "./queueOrder.js";
import { bareNoLabel } from "./no.js";

/**
 * 按队列顺序取号，返回 Map<线程 id, 两位号>。
 *
 * 号来自后端 `no`（任务号，已按派单号前缀归一）；为空时映射值为空串，模板据此不渲染编号。
 */
export function numberQueue(threads) {
  const map = new Map();
  for (const t of queueOrder(threads)) {
    const id = String(t?.id || "");
    if (!id) continue;
    const fromServer = String(t?.no || "").trim();
    map.set(id, fromServer ? bareNoLabel(fromServer) : "");
  }
  return map;
}
