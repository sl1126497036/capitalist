/**
 * 消息编号：归属 + 方向 + 毫秒时间戳，天然携带顺序。
 *
 * 全系统消息只有这一套编号，落盘不带 `#`，展示才带 `#`（见 {@link msgNoLabel}）。
 * 毫秒时间戳保证同一毫秒内也能用自增序区分，消除消息面板错位。
 *
 *   用户发给 Worker       `2-U2W-<毫秒>`   显示 `#2-U2W-<毫秒>`
 *   用户发给监工（介入）   `2-U2S-<毫秒>`   显示 `#2-U2S-<毫秒>`
 *   Worker 回复           `2-W-<毫秒>`     显示 `#2-W-<毫秒>`
 *   监工回复              `2-S-<毫秒>`     显示 `#2-S-<毫秒>`
 *   监工面板·监工回复      `S0-S-<毫秒>`    显示 `#S0-S-<毫秒>`
 *   监工面板·派单类消息    `S0-SP-<毫秒>`   显示 `#S0-SP-<毫秒>`
 *
 * 方向段由 {@link MsgDirection} 决定；单号缺失（监工面板全局消息）用 `S0` 占位。
 */

import { padBareNo } from "../record/idMap";

/** 消息方向。 */
export type MsgDirection = "U2W" | "U2S" | "W" | "S" | "SP";

/** 监工面板全局消息的单号占位。 */
export const SUPERVISOR_NO = "S0";

/** 毫秒时间戳计数器，保证同一毫秒内仍有序。 */
let lastMs = 0;
let lastSeq = 0;

/**
 * 生成消息编号（落盘形式，不带 `#`）。
 *
 * @param taskNo 归属任务号；监工面板全局消息传 {@link SUPERVISOR_NO}。
 * @param dir 方向。
 * @param now 毫秒时间戳，默认系统时间；传入固定值可让编号可重现。
 */
export function msgId(taskNo: string | number, dir: MsgDirection, now = Date.now()): string {
  const ms = Math.max(0, Math.trunc(now));
  if (ms === lastMs) lastSeq += 1;
  else {
    lastMs = ms;
    lastSeq = 0;
  }
  const suffix = lastSeq > 0 ? `${ms}-${lastSeq}` : `${ms}`;
  return `${taskNo}-${dir}-${suffix}`;
}

/** 消息编号显示形式：裸编号补 `#` 并把任务号段补零到两位；与其它编号同一套补零入口。 */
export function msgNoLabel(no: string): string {
  const s = String(no ?? "").trim();
  if (!s) return "";
  return `#${padBareNo(s)}`;
}

/** 剥掉消息编号开头的 `#`，得落盘形式；容忍带或不带。 */
export function msgNoStrip(no: string): string {
  return String(no ?? "").replace(/^#/, "").trim();
}

/** 从消息编号解析归属任务号；监工面板全局消息返回 `S0`。 */
export function msgTaskNo(id: string): string {
  const s = msgNoStrip(id);
  const m = /^([^-\s]+)-/.exec(s);
  return m && m[1] ? m[1] : "";
}

/** 从消息编号解析方向段（`U2W` / `U2S` / `W` / `S` / `SP`）。 */
export function msgDirection(id: string): string {
  const s = msgNoStrip(id);
  const m = /^[^-]+-([^-]+)-/.exec(s);
  return m && m[1] ? m[1] : "";
}
