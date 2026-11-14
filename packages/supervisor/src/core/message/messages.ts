/** 用户消息的标识与附件归属。 */

import { adoptAttachmentsForMessage, attachmentsIn, numberAttachmentLines } from "./attachments";
import { readJsonl } from "../record/json";
import { eventsPath, recordEvent } from "../record/ledger";

/** 一条用户消息的身份与它自己的附件。 */
export interface UserMessage {
  /** 消息标识（`M-…`），随事件与指令一路带到派单上。 */
  id: string;
  /** 这条消息自己带的附件路径（去重，保持出现顺序）。 */
  atts: string[];
}

export function newMessageId(now = Date.now()): string {
  return `M-${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/**
 * 记一条用户消息，返回它的标识与附件。
 *
 * 事件本身就是消息的权威记录（`supervisor_chat_ask`），标识写在事件上；后续的调度指令、
 * 派单都只带标识，附件按标识回查。
 *
 * 引用（被引消息的界面标识 + 原文摘要）随事件一并持久化：不带它，消息只剩正文，
 * 界面刷新后引用块就没了，实时路径上前端自己带着引用，权威记录里没有，重建
 * （轮询 / 刷新后从台账投影）时就拿不到。带引用时两个字段一起写，重建路径按
 * 同一字段渲染，与实时路径一致。
 */
export function recordUserMessage(
  root: string,
  input: { text: string; thread?: string; atts?: string[]; quote?: string; quoteText?: string },
): UserMessage {
  /** 图在这里编一次号（`[附件] x.png` -> `[图1] x.png`），之后所有环节照抄这一套。 */
  let text = numberAttachmentLines(String(input.text ?? ""));
  const id = newMessageId();
  /*
   * 附件按“消息 id + 序号”另存一份（`<msgId>-1.png`）：这张图属于哪条消息、是第几张，
   * 写进文件名，往下任何环节想拿错都能当场看出来。原文里的路径同步换成新路径。
   */
  const own = input.atts?.length
    ? [...new Set(input.atts.map((p) => String(p ?? "").trim()).filter(Boolean))]
    : attachmentsIn(text);
  const atts = adoptAttachmentsForMessage(root, own, id);
  for (let i = 0; i < own.length; i += 1) {
    const from = own[i]!;
    const to = atts[i]!;
    if (from && to && from !== to) text = text.split(from).join(to);
  }
  const quote = String(input.quote ?? "").trim();
  const quoteText = String(input.quoteText ?? "").trim();
  recordEvent(root, "supervisor_chat_ask", {
    msg_id: id,
    text,
    thread: input.thread ?? "",
    from: "user",
    atts,
    ...(quote ? { quote } : {}),
    ...(quote ? { quote_text: quoteText } : {}),
  });
  return { id, atts };
}

/**
 * 按消息标识取这条消息自己的附件。
 *
 * @returns 找到时为该消息的附件数组（没有附件就是空数组）；找不到（老记录没有标识、
 *          标识写错）返回 null，调用方据此决定是否退回到指令上固化的 `atts`。
 */
export function attachmentsOfMessage(root: string, msgId: string): string[] | null {
  const id = String(msgId ?? "").trim();
  if (!id) return null;
  const rows = readJsonl<{ msg_id?: unknown; atts?: unknown }>(eventsPath(root));
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row || String(row.msg_id ?? "") !== id) continue;
    const atts = row.atts;
    return Array.isArray(atts) ? atts.map((p) => String(p)).filter(Boolean) : [];
  }
  return null;
}

export interface ShotRef {
  /** 从 1 起的编号，提示词里的 `ATT:` 行用它指代。 */
  index: number;
  path: string;
  /** 来源消息标识（`M-…`）。 */
  msg_id: string;
  /** 它属于哪个会话（空串 = 监工会话）。 */
  thread: string;
  /** 什么时候发的（ISO，提示词里只取时分秒）。 */
  at: string;
}

/** 最近这段时间里，这个会话贴过的图，按时间正序编号。 */
export function recentShots(
  root: string,
  opts: { thread?: string | undefined; limit?: number } = {},
): ShotRef[] {
  const limit = Math.max(1, Math.min(40, opts.limit ?? 12));
  const rows = readJsonl<{ event?: unknown; kind?: unknown; at?: unknown; thread?: unknown; msg_id?: unknown; atts?: unknown }>(
    eventsPath(root),
  );
  const out: ShotRef[] = [];
  for (const row of rows) {
    const ev = String(row.event ?? row.kind ?? "");
    if (ev !== "supervisor_chat_ask" && ev !== "supervisor_reply") continue;
    const atts = Array.isArray(row.atts) ? row.atts.map((p) => String(p ?? "")).filter(Boolean) : [];
    if (atts.length === 0) continue;
    const threadOf = String(row.thread ?? "");
    if (opts.thread !== undefined && threadOf !== String(opts.thread ?? "")) continue;
    for (const p of atts) {
      out.push({
        index: 0,
        path: p,
        msg_id: String(row.msg_id ?? ""),
        thread: threadOf,
        at: String(row.at ?? ""),
      });
    }
  }
  const seen = new Set<string>();
  const uniq: ShotRef[] = [];
  for (const s of out) {
    if (seen.has(s.path)) continue;
    seen.add(s.path);
    uniq.push(s);
  }
  const tail = uniq.slice(-limit);
  return tail.map((s, i) => ({ ...s, index: i + 1 }));
}
