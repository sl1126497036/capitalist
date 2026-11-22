/**
 * 消息编号：发送方 + 接收方 + 毫秒时间戳，天然携带顺序。
 *
 * 全系统消息只有这一套编号，落盘不带 `#`，展示才带 `#`（见 {@link msgNoLabel}）。
 * 方向段一律写成「谁发给谁」，不用单字母：只写发送方无法区分收件人，
 * 监工回复用户、监工派单给工作进程、监工裁决申报会挤在同一个段里。
 *
 *   用户发给工作进程      `2-U2W-<毫秒>`   显示 `#2-U2W-<毫秒>`
 *   用户发给监工          `2-U2S-<毫秒>`   显示 `#2-U2S-<毫秒>`
 *   工作进程申报给监工    `2-W2S-<毫秒>`   显示 `#2-W2S-<毫秒>`
 *   监工发给工作进程      `2-S2W-<毫秒>`   显示 `#2-S2W-<毫秒>`
 *   监工发给用户          `2-S2U-<毫秒>`   显示 `#2-S2U-<毫秒>`
 *   工作进程发给用户      `2-W2U-<毫秒>`   显示 `#2-W2U-<毫秒>`
 *   监工面板全局          `S0-S2U-<毫秒>`  显示 `#S0-S2U-<毫秒>`
 *
 * 旧段 `W`（工作进程申报）、`S`（监工产出）、`SP`（旧监工面板派单）不再生成，
 * 只保留解析：旧台账照常显示，不做数据迁移。
 *
 * 时间戳取**这条消息创建的时刻**，不取完成时刻。追加写入的消息有落盘时间 `at`；
 * 工作进程的输出块与思考块由日志切分而来，取块首行日志自带的事件时间（`__timestamp`），
 * 直接作为 {@link msgId} 的 `now` 传入。历史行的时间不会变，重建得到同一个编号。
 */

import { padBareNo } from "../record/idMap";

/** 消息方向。前六段是「发送方到接收方」，后三段只为兼容旧台账保留。 */
export type MsgDirection = "U2W" | "U2S" | "W2S" | "S2W" | "S2U" | "W2U" | "W" | "S" | "SP";

/**
 * 用户消息的承接方。
 *
 * 方向由承接方决定，不由请求里带了哪个参数决定。早先按「是否监工介入」判定方向，
 * 监工面板直发因不带介入标记，全部落成 `U2W`，与「用户发给 Worker」无法区分。
 */
export type UserMsgCarrier = "supervisor" | "worker";

/** 承接方到方向段：监工承接记 `U2S`，工作进程承接记 `U2W`。 */
export function userMsgDirectionOf(carrier: UserMsgCarrier): MsgDirection {
  return carrier === "supervisor" ? "U2S" : "U2W";
}

/** 用户消息可用的方向段；工作进程与监工的方向由各自模块生成，不接受调用方指定。 */
export const USER_MSG_DIRECTIONS: readonly MsgDirection[] = ["U2W", "U2S"];

/** 判断一个串是否为用户消息方向段。 */
export function isUserMsgDirection(value: string): value is MsgDirection {
  return (USER_MSG_DIRECTIONS as readonly string[]).includes(value);
}

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

/**
 * 消息编号显示形式：合法形态才补 `#`，并把任务号段补零到两位。
 *
 * 非消息形态（派单号、进程号、视图块 id、内容指纹）返回空串：调用方拿到空串就不显示编号，
 * 不得把这些串补个 `#` 当成消息号上屏。与前端 `web/src/lib/no.js` 的 `msgNo` 同一判据。
 */
export function msgNoLabel(no: string): string {
  const s = String(no ?? "").trim();
  if (!s || !isMsgNo(s)) return "";
  return `#${padBareNo(msgNoStrip(s))}`;
}

/** 剥掉消息编号开头的 `#`，得落盘形式；容忍带或不带。 */
export function msgNoStrip(no: string): string {
  return String(no ?? "").replace(/^#/, "").trim();
}

/**
 * 是否是消息编号形态：`任务号-方向-时间戳`，同毫秒冲突时尾部再加一段自增序。
 *
 * 界面与引用只认这个形态。派单号（`19-1`）、进程号（`19-P1`）、视图块 id（含 `~`）、
 * 内容指纹（`n0fg0v`）都不是消息编号，不得补 `#` 显示成消息，也不得进了引用。
 */
export function isMsgNo(no: string): boolean {
  const bare = msgNoStrip(no);
  return /^[^-\s]+-(?:U2W|U2S|W2S|S2W|S2U|W2U|W|S|SP)-\d+(?:-\d+)?$/.test(bare);
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
