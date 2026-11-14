/** 裁决收件箱（`.capitalist/inbox/qa.jsonl`）的读写口径。 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { supervisorDir } from "../record/paths";

/** 裁决台账的文件名。只认这一个，别的一律不是台账。 */
export const INBOX_LEDGER = "qa.jsonl";

/** 收件箱目录：`<root>/.capitalist/inbox`。 */
export function inboxDir(root: string): string {
  return join(supervisorDir(root), "inbox");
}

/** 裁决台账的绝对路径：`<root>/.capitalist/inbox/qa.jsonl`。 */
export function inboxLedgerPath(root: string): string {
  return join(inboxDir(root), INBOX_LEDGER);
}

/** 一条通过校验的裁决记录。字段保持原样，只用类型收窄。 */
export interface InboxRecord extends Record<string, unknown> {
  id: string;
  type: "ask" | "answer";
  status: "open" | "answered";
  text: string;
}

/** 一条被忽略的畸形记录：行号、原因、原始文本（截断）。 */
export interface IgnoredInboxRow {
  /** 在文件里的行号，从 1 起。 */
  line: number;
  /** 人或日志可读的原因。 */
  reason: string;
  /** 原始行截断到 200 字符，仅用于定位，避免整份台账写入事件。 */
  raw: string;
}

/** 一次读取的结果。 */
export interface InboxRead {
  /** 通过校验的记录，保持文件顺序。 */
  rows: InboxRecord[];
  /** 畸形记录。条数即“已忽略 N 条”。 */
  ignored: IgnoredInboxRow[];
  /** 因为不是 `qa.jsonl` 而被跳过的同目录文件（`.tmp` 之类）。 */
  skipped: string[];
}

/** 允许的 `type` / `status` 取值。校验与提示共用这两处定义。 */
const TYPES = new Set(["ask", "answer"]);
const STATUSES = new Set(["open", "answered"]);

/** 校验一条记录。 */
export function validateInboxRecord(row: unknown): string | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return "不是对象";
  const r = row as Record<string, unknown>;

  if (r.type === "answer") {
    if (typeof r.qid !== "string" || r.qid.trim() === "") return "回答缺 qid";
    if (String(r.text ?? "").trim() === "") return "回答 text 为空";
    r.id = r.qid;
    if (typeof r.status !== "string") r.status = "new";
    return null;
  }

  if (typeof r.id !== "string" || r.id.trim() === "") {
    return r.id === undefined ? "缺 id" : `id 非法（${typeof r.id}）`;
  }
  if (typeof r.type !== "string" || !TYPES.has(r.type)) return `type 非法（${String(r.type)}）`;
  if (typeof r.status !== "string" || !STATUSES.has(r.status)) {
    return `status 非法（${String(r.status)}）`;
  }
  // text 兼容历史写法：早期监工写 `question`。两种都没有才是空。
  const text = String(r.text ?? r.question ?? "").trim();
  if (text === "") return "text 为空";
  return null;
}

/**
 * 同目录下哪些文件不是台账。
 *
 * 显式枚举而不是“只拼路径读一次”：并发写遗留的临时文件必须以可观测的方式被跳过。
 * 读不到目录（inbox 还没建）时返回空数组，调用方按“没有台账”处理。
 */
export function skippedInboxFiles(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(inboxDir(root));
  } catch {
    return [];
  }
  return names.filter((n) => n !== INBOX_LEDGER).sort();
}

/**
 * 读裁决台账。
 *
 * 只读 `qa.jsonl`：同目录的 `.tmp`（原子写的临时文件）、`.bak`、`dispatch.jsonl` 等一律
 * 不参与解析，名字记进 `skipped` 供调用方提示。
 *
 * 坏行不抛：单行脏数据不该让整份台账不可用，也不能让监工因为一行解析不了就停摆，
 * 但必须被计数，让“忽略了多少”可被看见。
 */
export function readInbox(root: string): InboxRead {
  const rows: InboxRecord[] = [];
  const ignored: IgnoredInboxRow[] = [];
  const skipped = skippedInboxFiles(root);

  let text: string;
  try {
    text = readFileSync(inboxLedgerPath(root), "utf8");
  } catch {
    // 文件不存在或读不了：没有台账，也没有畸形行。
    return { rows, ignored, skipped };
  }

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const s = (lines[i] ?? "").trim();
    if (!s) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(s);
    } catch {
      ignored.push({ line: i + 1, reason: "不是合法 JSON", raw: s.slice(0, 200) });
      continue;
    }
    const bad = validateInboxRecord(parsed);
    if (bad) {
      ignored.push({ line: i + 1, reason: bad, raw: s.slice(0, 200) });
      continue;
    }
    rows.push(parsed as InboxRecord);
  }

  return { rows, ignored, skipped };
}

/**
 * 未裁决的问题。
 *
 * 这是监工“要不要暂停派单”的唯一依据，因此必须走 {@link readInbox} 的校验：
 * 一条 id 缺失的记录不该让整条流水线停下来。
 */
export function openInboxAsks(root: string): InboxRecord[] {
  return readInbox(root).rows.filter((q) => q.type === "ask" && q.status === "open");
}

/**
 * 畸形记录的稳定签名，用于“同一批坏行只报一次”。
 *
 * 每轮调度 都写一条 warn 会把真正的派单事件挤出窗口；签名变化（新坏行、坏行被清理）
 * 才值得再记一条。
 */
export function ignoredSignature(ignored: readonly IgnoredInboxRow[]): string {
  if (ignored.length === 0) return "";
  return ignored.map((i) => `${i.line}:${i.reason}`).join("|");
}
