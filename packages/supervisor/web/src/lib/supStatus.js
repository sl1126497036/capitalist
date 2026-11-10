/**
 * 监工状态徽章映射：顶栏徽章与右栏用量说明共用 `/api/supervisor`。
 * 只搬运字段为「键 / 值 / 色号」，不推断、不补值，缺失字段显示破折号。
 */

/**
 * @param {object} capitalist `/api/supervisor` 的返回
 * @returns {{k: string, v: string|number, tone?: string, dot?: boolean, tip?: string, na?: boolean}[]}
 *   状态 / 并行 / 运行 / 排队 / 待裁决 / 欠账，以及有心跳说明时多一条「异常」。
 */
export function supervisorStatusRows(capitalist) {
  const s = capitalist || {};
  const offline =
    s.status === "heartbeat-timeout" ? { v: "心跳超时", tone: "warn" } : { v: "已停止", tone: "bad" };
  return [
    s.online ? { k: "状态", v: "在线", tone: "run", dot: true } : { k: "状态", ...offline, dot: true },
    { k: "并行", v: s.parallel ?? "—" },
    { k: "运行", v: s.running ?? "—" },
    { k: "排队", v: s.queued ?? "—" },
    Number(s.pending_asks) > 0 ? { k: "待裁决", v: s.pending_asks, tone: "warn" } : { k: "待裁决", v: 0 },
    Number(s.debt_count) > 0 ? { k: "欠账", v: s.debt_count, tone: "warn" } : { k: "欠账", v: 0 },
    ...(String(s.heartbeat_note || "").trim()
      ? [{ k: "异常", v: String(s.heartbeat_note), tone: "warn", tip: String(s.heartbeat_note) }]
      : []),
  ];
}
