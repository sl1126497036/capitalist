/**
 * 面板发言的处置台账。命中要求特征只标记，不自动建单；动作由界面触发。
 * 只记录从当前开始处理的发言，不回填历史 `supervisor_chat_ask`。
 */

import { readJsonl } from "../core/json";
import { eventsPath, recordEvent } from "../core/ledger";

/** 一轮发言最终落到的分支。四个动作分支 + 只回答。 */
export type ChatVerdict = "dispatched" | "amended" | "queued" | "promoted" | "answered_only";

export const CHAT_VERDICTS: readonly ChatVerdict[] = [
  "dispatched",
  "amended",
  "queued",
  "promoted",
  "answered_only",
];

/**
 * 要求特征清单。命中顺序不影响判定；只用于标记未建单提示，不参与是否派单。
 */
export const REQUIREMENT_HINTS: readonly string[] = [
  "改成",
  "改为",
  "换成",
  "挪到",
  "延长",
  "缩短",
  "统一",
  "去掉",
  "删掉",
  "不要",
  "新增",
  "加一个",
  "修复",
  "实现",
  "应该",
];

/** 文本里命中的要求特征（去重、保持清单顺序）。 */
export function requirementHints(text: string): string[] {
  const s = String(text ?? "");
  if (!s) return [];
  return REQUIREMENT_HINTS.filter((h) => s.includes(h));
}

/** `DO:` 动作映射到 verdict；除 dispatch / amend / queue / promote 外统一记 `dispatched`。 */
export function chatVerdictOf(action: string, arg: string): ChatVerdict {
  switch (String(action ?? "").trim().toLowerCase()) {
    case "dispatch":
      /* `dispatch --now` 立即占用槽位执行，与 promote 同义。 */
      return /(^|\s)--now(\s|$)/.test(String(arg ?? "")) ? "promoted" : "dispatched";
    case "amend":
      return "amended";
    case "queue":
      return "queued";
    case "promote":
      return "promoted";
    default:
      return "dispatched";
  }
}

export interface ChatSettleInput {
  /** 这条发言的消息标识（`M-…`）。 */
  msg_id: string;
  verdict: ChatVerdict;
  /** 发言原文：要求特征按它判定，不采用模型复述。 */
  text: string;
  /** 发言所在会话（空串 = 监工会话）。 */
  thread?: string;
  /**
   * 动作记录 id：调度指令记 `SD-…`，追加到既有单记目标派单 id。
   * 没有产生动作时留空。
   */
  dispatch?: string;
  /** 一条发言落成多张单时的全部指令 id；首张同时写入 `dispatch`。 */
  dispatches?: string[];
  /** 动作名（dispatch / amend 等），便于追溯。 */
  action?: string;
  /** 未产生动作时的原因（通道失败、字数超限、白名单拒绝等）。 */
  error?: string;
}

/**
 * 写一条处置记录。
 *
 * @returns 是否同时落了一条 chat_unhandled（以及命中的特征）。
 */
export function settleChat(
  root: string,
  input: ChatSettleInput,
): { unhandled: boolean; hints: string[] } {
  const msgId = String(input.msg_id ?? "").trim();
  if (!msgId) return { unhandled: false, hints: [] };
  const verdict = CHAT_VERDICTS.includes(input.verdict) ? input.verdict : "answered_only";
  const text = String(input.text ?? "");

  const ids = Array.isArray(input.dispatches) ? input.dispatches.map((x) => String(x ?? "")).filter(Boolean) : [];
  recordEvent(root, "chat_settled", {
    msg_id: msgId,
    verdict,
    ...(input.dispatch ? { dispatch: String(input.dispatch) } : {}),
    ...(ids.length > 1 ? { dispatches: ids } : {}),
    ...(input.action ? { action: String(input.action) } : {}),
    ...(input.thread ? { thread: String(input.thread) } : {}),
    ...(input.error ? { error: String(input.error).slice(0, 300) } : {}),
  });

  if (verdict !== "answered_only") return { unhandled: false, hints: [] };

  const hints = requirementHints(text);
  if (hints.length === 0) return { unhandled: false, hints: [] };

  recordEvent(root, "chat_unhandled", {
    msg_id: msgId,
    text: text.slice(0, 4000),
    hints,
    ...(input.thread ? { thread: String(input.thread) } : {}),
  });
  return { unhandled: true, hints };
}

/** 标记“已答复，不需要动作”的发言，不再列入未建单列表。 */
export function dismissChat(root: string, input: { msg_id: string; reason?: string }): boolean {
  const msgId = String(input.msg_id ?? "").trim();
  if (!msgId) return false;
  recordEvent(root, "chat_dismissed", {
    msg_id: msgId,
    reason: String(input.reason ?? "已答复，不需要动作").slice(0, 120),
  });
  return true;
}

/** 一条待处理的发言。 */
export interface UnhandledChat {
  msg_id: string;
  text: string;
  at: string;
  thread: string;
  hints: string[];
}

/**
 * 按台账顺序还原待处理发言，后写入的记录覆盖先写入的。
 * `chat_unhandled` 入列，`chat_dismissed` 与非 `answered_only` 的 `chat_settled` 出列。
 */
export function unhandledFromEvents(rows: Array<Record<string, unknown>>): UnhandledChat[] {
  const pending = new Map<string, UnhandledChat>();
  for (const row of rows) {
    if (!row) continue;
    const name = String(row.event ?? row.kind ?? "");
    const msgId = String(row.msg_id ?? "").trim();
    if (!msgId) continue;
    if (name === "chat_unhandled") {
      pending.set(msgId, {
        msg_id: msgId,
        text: String(row.text ?? ""),
        at: String(row.at ?? ""),
        thread: String(row.thread ?? ""),
        hints: Array.isArray(row.hints) ? row.hints.map((x) => String(x)) : [],
      });
      continue;
    }
    if (name === "chat_dismissed") {
      pending.delete(msgId);
      continue;
    }
    if (name === "chat_settled") {
      const verdict = String(row.verdict ?? "");
      if (verdict && verdict !== "answered_only") pending.delete(msgId);
    }
  }
  return [...pending.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** 读整本事件台账，列出待处理的发言（时间倒序）。 */
export function listUnhandled(root: string): UnhandledChat[] {
  return unhandledFromEvents(readJsonl<Record<string, unknown>>(eventsPath(root)));
}
