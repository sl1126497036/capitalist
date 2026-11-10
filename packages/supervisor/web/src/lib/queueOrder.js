/**
 * 任务队列排序口径，左栏列表与消息编号共用同一顺序。
 * 同状态下按 (启动时刻, id) 收敛，轮询之间不乱序。
 */

const ALIVE = new Set(["running", "starting", "claimed"]);

export function isAlive(t) {
  return ALIVE.has(String(t?.status || ""));
}

function startedMs(t) {
  return Date.parse(t?.started_at || "") || 0;
}

/** 比较器为纯函数，不读取入参以外的状态。 */
export function queueCompare(a, b) {
  const ga = isAlive(a) ? 0 : 1;
  const gb = isAlive(b) ? 0 : 1;
  if (ga !== gb) return ga - gb;
  const pa = Date.parse(String(a?.promoted_at || "")) || 0;
  const pb = Date.parse(String(b?.promoted_at || "")) || 0;
  if (pa !== pb) return pb - pa;
  const d = startedMs(b) - startedMs(a);
  if (d) return d;
  return String(a?.id || "") < String(b?.id || "") ? -1 : 1;
}

/** 返回按队列顺序排列的新数组，不改入参。 */
export function queueOrder(threads) {
  return (Array.isArray(threads) ? [...threads] : []).sort(queueCompare);
}
