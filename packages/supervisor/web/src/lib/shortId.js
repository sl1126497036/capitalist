/**
 * 任务编号（`#01` 起）。后端 `/api/threads` 的 `no` 为权威；本模块仅在其缺失时提供回落编号，
 * 并维护「id → 号」查表供消息引用使用。
 * 映射用普通对象：在 computed 中写入 reactive 映射会触发递归更新，导致渲染失败。
 */
import { queueOrder } from "./queueOrder.js";

const KEY = "capitalist-thread-nos-v2";

const shortIds = (() => {
  try {
    if (typeof localStorage === "undefined") return {};
    return JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch {
    return {};
  }
})();
let shortNext = Math.max(0, ...Object.values(shortIds).map((n) => Number(n) || 0)) + 1;

/** 回落编号：同一 id 始终返回同一号。 */
export function shortOf(id) {
  const key = String(id || "");
  if (!key) return "";
  if (!shortIds[key]) {
    shortIds[key] = shortNext++;
    try {
      localStorage.setItem(KEY, JSON.stringify(shortIds));
    } catch {
      /* 写入失败只影响跨会话稳定，本会话内编号仍一致。 */
    }
  }
  return String(shortIds[key]).padStart(2, "0");
}

/**
 * 按队列顺序编号，返回 Map<线程 id, 两位号>；后端 `no` 优先，缺失时回落 shortOf。
 * 左栏与右栏共用同一 Map，显示的号保持一致。
 */
export function numberQueue(threads) {
  const map = new Map();
  for (const t of queueOrder(threads)) {
    const id = String(t?.id || "");
    if (!id) continue;
    const fromServer = String(t?.no || "").trim();
    map.set(id, fromServer || shortOf(id));
  }
  return map;
}
