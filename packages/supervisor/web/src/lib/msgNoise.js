/**
 * 监工流分层：服务端按事件类型写入 `tier`（main / log），前端按该字段折叠过程日志，不重复判定。
 */

import { evtTag, evtText, msgRef } from "./fmt.js";

export function isLog(m) {
  return String(m?.tier || "") === "log";
}

/**
 * 过程日志行模型。同类事件由服务端按 10 分钟窗口合并，前端不二次合并。
 * `at` 取窗口首条固定位置，`last_at` 取末条用于时间范围，轮询之间不跳位。
 */
export function logRowsOf(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter(isLog)
    .map((m) => {
      const count = Math.max(1, Number(m?.count || 1) || 1);
      const at = String(m?.at || "");
      return {
        ref: msgRef(m),
        label: evtTag(m),
        count,
        text: evtText(m),
        at,
        first_at: String(m?.first_at || at),
        last_at: String(m?.last_at || at),
      };
    });
}

export function logSummaryOf(rows, max = 4) {
  const by = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    by.set(r.label, (by.get(r.label) || 0) + r.count);
  }
  const list = [...by.entries()].sort((a, b) => b[1] - a[1]);
  const head = list.slice(0, max).map(([k, v]) => `${k} ${v}`);
  return list.length > max ? `${head.join(" ")} 等` : head.join(" ");
}
