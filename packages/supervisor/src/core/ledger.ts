/**
 * 台账：违规、事件、待复核、会话。
 *
 * 本仓库的 TS 实现与归档的 Python 实现读写同一个 `.capitalist/` 目录，同一任务可由任一套接手，
 * 因此字段名按 Python 侧定义对齐。两处历史分歧仍需兼容：
 *
 *   `level`   本仓库 TS 版曾写规则强度（BLOCK / NEED_USER），Python 版写重复次数（1 / 2 / 3）。
 *             同一个键两种含义，一方读另一方的台账时次数会全为 0。现在一律写次数。
 *   `event`   本仓库 TS 版早期只写 `kind`，Python 版读 `event`。
 *
 * 新记录同时写两种拼写；旧记录仍可读，各读取路径都容忍字段缺失。
 */

import { join } from "node:path";

import { appendJsonl, readJson, readJsonl, writeJson, writeJsonl } from "./json";
import { supervisorDir } from "./paths";

/** 事件台账的绝对路径：`<root>/.capitalist/events.jsonl`。 */
export function eventsPath(root: string): string {
  return join(supervisorDir(root), "events.jsonl");
}

/** 违规台账的绝对路径：`<root>/.capitalist/violations.jsonl`。 */
export function violationsPath(root: string): string {
  return join(supervisorDir(root), "violations.jsonl");
}

/** 待复核队列的绝对路径：`<root>/.capitalist/review.jsonl`。 */
export function reviewPath(root: string): string {
  return join(supervisorDir(root), "review.jsonl");
}

/** 会话台账的绝对路径：`<root>/.capitalist/sessions.json`。 */
export function sessionsPath(root: string): string {
  return join(supervisorDir(root), "sessions.json");
}

/**
 * 把命令或说明压成单行短串，用于同一动作去重。与归档的 Python 实现 `_norm_evidence` 一致。
 *
 * @param limit 截断长度，默认 120 字符。
 */
export function normEvidence(ev: unknown, limit = 120): string {
  return String(ev ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, limit);
}


/**
 * 记一条事件。
 *
 * `event` 与 `kind` 双写：前者是归档的 Python 引擎读取的键，后者是本仓库 TS 侧早期使用的键。
 * 同一份台账要让两边都能读，只写一个键时另一套实现读不到这段历史。
 *
 * `extra` 的键会覆盖同名的固定字段（`at` / `at_ts` / `event` / `kind`），调用方不应传这四个键。
 * 写入失败时不抛：事件是旁路记录，不阻断主流程，但也不会留下错误事件。
 */
export function recordEvent(root: string, event: string, extra: Record<string, unknown> = {}): void {
  appendJsonl(eventsPath(root), {
    at: new Date().toISOString(),
    at_ts: Date.now() / 1000,
    event,
    kind: event,
    ...extra,
  });
}

/** 节流状态：进程内，不落盘。监工重启后重新计一次，代价只是多一条记录。 */
const throttleState = new Map<string, { at: number; n: number }>();

/** 进程内节流记录：同一 `event|key` 在窗口内只落一条，重复的次数攒在 `repeat` 里。 */
export function recordEventThrottled(
  root: string,
  event: string,
  extra: Record<string, unknown>,
  opts: { key: string; windowMs: number },
): boolean {
  const k = `${event}|${opts.key}`;
  const now = Date.now();
  const cur = throttleState.get(k);
  if (cur && now - cur.at < opts.windowMs) {
    cur.n += 1;
    return false;
  }
  /*
   * 窗口到期后的第一条把攒下的次数一起写上：`repeat: 12` 读作「这件事又发生了 12 次」，
   * 而不是「这是第 12 条记录」。没有攒过就不写这个字段，老读侧不受影响。
   */
  const merged = cur && cur.n > 0 ? { ...extra, repeat: cur.n + 1 } : extra;
  throttleState.set(k, { at: now, n: 0 });
  recordEvent(root, event, merged);
  return true;
}


/** 一个会话的记录。 */
export interface SessionEntry {
  role: string;
  first_seen: string;
  last_seen: string;
  retired: boolean;
  tokens?: number;
  compacts?: number;
  note?: string;
}

type Sessions = Record<string, SessionEntry>;

/**
 * 读全部会话记录。
 *
 * @returns 会话 id → 记录。文件不存在或内容不是对象时返回空对象。
 */
export function loadSessions(root: string): Sessions {
  const d = readJson<Sessions>(sessionsPath(root), {});
  return d && typeof d === "object" && !Array.isArray(d) ? d : {};
}

/**
 * 写全部会话记录。整份覆盖写入。
 *
 * @throws 落盘失败时抛出。
 */
export function saveSessions(root: string, data: Sessions): void {
  writeJson(sessionsPath(root), data);
}

/**
 * 登记或更新一个会话。
 *
 * 多进程下这是判断「哪些会话仍在运行」的唯一依据：hook 每次运行都 touch 一次，
 * `capitalist sessions` 据此判断哪个会话还活着、哪个已经交接出去。
 *
 * @param patch 要更新的字段。`tokens` 只增不减；`compact` 为 true 时压缩计数加一。
 */
export function touchSession(
  root: string,
  id: string,
  patch: { role?: string; tokens?: number; compact?: boolean } = {},
): SessionEntry {
  const all = loadSessions(root);
  const now = new Date().toISOString();
  const cur: SessionEntry =
    all[id] ?? { role: "unknown", first_seen: now, last_seen: now, retired: false };

  if (patch.role && !cur.retired) cur.role = patch.role;
  if (typeof patch.tokens === "number" && patch.tokens > 0) {
    cur.tokens = Math.max(cur.tokens ?? 0, patch.tokens);
  }
  if (patch.compact) cur.compacts = (cur.compacts ?? 0) + 1;
  cur.last_seen = now;

  all[id] = cur;
  saveSessions(root, all);
  return cur;
}

/**
 * 取会话记录。
 *
 * @returns 记录；会话不存在时返回 null。
 */
export function currentSession(root: string, id: string): SessionEntry | null {
  return loadSessions(root)[id] ?? null;
}

/**
 * 标记会话已交接。
 *
 * @param note 交接说明，写进记录的 `note` 字段。
 * @returns 会话不存在时返回 false；已标记过时同样返回 false。
 */
export function retireSession(root: string, id: string, note = ""): boolean {
  const all = loadSessions(root);
  const cur = all[id];
  if (!cur) return false;
  cur.retired = true;
  cur.last_seen = new Date().toISOString();
  if (note) cur.note = note;
  saveSessions(root, all);
  return true;
}


/** 一条违规记录。写入 `.capitalist/violations.jsonl`。 */
export interface ViolationRecord {
  at?: string;
  at_ts?: number;
  session?: string;
  role?: string;
  stage?: string;
  kind?: string;
  rule?: string;
  label?: string;
  fix?: string;
  evidence?: string;
  decision?: string;
  /** 同一规则在本会话的第几次 */
  nth?: number;
  /** 1 / 2 / 3，与归档的 Python 实现一致 */
  level?: number | string;
  resolved?: boolean;
  resolved_at?: string;
}

/** 记一条违规所需的入参。 */
export interface ViolationInput {
  rule: string;
  label: string;
  fix?: string | undefined;
  evidence: string;
  /** 规则强度或流程判定：BLOCK / NEED_USER / REJECT / FORCED */
  decision?: string | undefined;
  kind?: string;
  session?: string;
  stage?: string;
  /**
   * 回复类内容每轮都会被重新扫描，同一句话因此会被反复命中；若按句子去重，计数会立刻
   * 升到第 3 次。这类调用传 true：同一内容只记一次，直到被 resolve。
   */
  forever?: boolean;
}

const DEDUPE_WINDOW_SEC = 60;

/**
 * 读全部违规记录，按文件中的先后顺序返回。
 *
 * 坏行跳过，不影响其余记录。
 */
export function loadViolations(root: string): ViolationRecord[] {
  return readJsonl<ViolationRecord>(violationsPath(root));
}

/**
 * 某规则在本会话的累计次数。已消解的记录也计入：次数用于判断「第几次犯」，与是否已清账无关。
 *
 * @returns 命中条数；未写 `session` 的历史记录不计入任何会话。
 */
export function violationCount(root: string, rule: string, session: string): number {
  return loadViolations(root).filter((v) => v.rule === rule && v.session === session).length;
}

/**
 * 同一会话、同一规则、同一内容是否刚刚记过。
 *
 * 与归档的 Python 实现 `_recent_duplicate` 逐条对齐：已消解的记录不参与去重，
 * 监工清账后再犯，那是一次新的违规，不该被旧账抵掉。
 */
function recentDuplicate(
  root: string,
  rule: string,
  evidence: string,
  session: string,
  forever: boolean,
): boolean {
  const ev = normEvidence(evidence);
  const rows = loadViolations(root);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const v = rows[i];
    if (!v || v.rule !== rule || (v.session ?? "") !== session) continue;
    if (normEvidence(v.evidence) !== ev) return false;
    if (v.resolved) return false;
    if (forever) return true;
    const at = Number(v.at_ts ?? 0);
    return at > 0 && Date.now() / 1000 - at <= DEDUPE_WINDOW_SEC;
  }
  return false;
}

/** 记一条违规。 */
export function recordViolation(
  root: string,
  v: ViolationInput,
): { nth: number; level: number; recorded: boolean } {
  const session = v.session ?? "";
  const evidence = normEvidence(v.evidence);

  if (recentDuplicate(root, v.rule, evidence, session, v.forever === true)) {
    const n = violationCount(root, v.rule, session);
    return { nth: n, level: n <= 1 ? 1 : n === 2 ? 2 : 3, recorded: false };
  }

  const nth = violationCount(root, v.rule, session) + 1;
  const level = nth === 1 ? 1 : nth === 2 ? 2 : 3;

  const written = appendJsonl(violationsPath(root), {
    at: new Date().toISOString(),
    at_ts: Date.now() / 1000,
    session,
    role: currentSession(root, session)?.role ?? "unknown",
    stage: v.stage ?? "",
    kind: v.kind ?? "",
    rule: v.rule,
    label: v.label,
    fix: v.fix ?? "",
    evidence,
    decision: v.decision ?? "",
    nth,
    level,
    resolved: false,
  });
  // appendJsonl 在写入失败时返回 false 且不抛：这里必须把真实结果透传出去，
  // 否则调用方会以为违规已入账，实际台账里什么都没有。
  return { nth, level, recorded: written };
}

/**
 * 某会话未消解的违规，按规则各取最新一条，次数降序。
 *
 * @returns 违规记录；无未消解项时返回空数组。
 */
export function openViolations(root: string, session?: string): ViolationRecord[] {
  const best = new Map<string, ViolationRecord>();
  for (const v of loadViolations(root)) {
    if (v.resolved) continue;
    // 会话未指定时不按会话过滤，与 resolveViolations 保持同一口径。
    if (session !== undefined && (v.session ?? "") !== session) continue;
    const rule = String(v.rule ?? "");
    const cur = best.get(rule);
    if (!cur || Number(v.nth ?? 0) >= Number(cur.nth ?? 0)) best.set(rule, v);
  }
  return [...best.values()].sort((a, b) => Number(b.nth ?? 0) - Number(a.nth ?? 0));
}

/**
 * 把违规标记为已纠正。
 *
 * @param opts.rule 指定规则。为空则清该会话全部。
 * @param opts.note 纠正说明，写进记录的 `fix` 字段。
 * @returns 改动条数。
 */
export function resolveViolations(
  root: string,
  opts: { rule?: string | undefined; session?: string | undefined; note?: string } = {},
): number {
  const rows = loadViolations(root);
  const now = new Date().toISOString();
  let n = 0;
  for (const v of rows) {
    if (v.resolved) continue;
    // 会话未指定时不做会话过滤。
    if (opts.session !== undefined && (v.session ?? "") !== opts.session) continue;
    if (opts.rule && v.rule !== opts.rule) continue;
    v.resolved = true;
    v.resolved_at = now;
    if (opts.note) v.fix = opts.note;
    n += 1;
  }
  if (n > 0) writeJsonl(violationsPath(root), rows);
  return n;
}


/** 一条待复核记录。 */
export interface ReviewRecord {
  at?: string;
  at_ts?: number;
  session?: string;
  role?: string;
  rule?: string;
  label?: string;
  why?: string;
  evidence?: string;
  decision?: string;
  resolved?: boolean;
}

const REVIEW_KEEP = 60;

/** 排队一个待复核动作。同一动作不重复排队。 */
export function recordReview(
  root: string,
  r: { rule: string; label: string; why?: string; evidence: string; decision?: string; session?: string },
): boolean {
  const ev = normEvidence(r.evidence);
  const rows = readJsonl<ReviewRecord>(reviewPath(root));
  if (rows.some((v) => normEvidence(v.evidence) === ev && !v.resolved)) return false;

  rows.push({
    at: new Date().toISOString(),
    at_ts: Date.now() / 1000,
    session: r.session ?? "",
    role: currentSession(root, r.session ?? "")?.role ?? "unknown",
    rule: r.rule,
    label: r.label,
    why: r.why ?? "",
    evidence: ev,
    decision: r.decision ?? "",
    resolved: false,
  });

  writeJsonl(reviewPath(root), rows.slice(-REVIEW_KEEP));
  return true;
}

/**
 * 待复核队列中未消解的记录。
 */
export function openReviews(root: string): ReviewRecord[] {
  return readJsonl<ReviewRecord>(reviewPath(root)).filter((r) => !r.resolved);
}

/**
 * 消解待复核项。下标或证据子串命中即消解。
 *
 * @param match 下标（纯数字）或证据子串。空匹配不做任何改动。
 * @returns 改动条数。
 */
export function resolveReviews(root: string, match: string): number {
  const rows = readJsonl<ReviewRecord>(reviewPath(root));
  const raw = String(match ?? "").trim();
  const idx = Number(raw);
  const byIndex = raw !== "" && Number.isInteger(idx) && idx >= 0;
  // 空匹配是任何字符串的子串：不挡住就会把整个队列一次消完，且看起来像「匹配成功」。
  const needle = normEvidence(raw);
  if (!byIndex && !needle) return 0;

  let n = 0;
  rows.forEach((r, i) => {
    if (r.resolved) return;
    const hit = byIndex && i === idx
      ? true
      : needle !== "" && normEvidence(r.evidence).includes(needle);
    if (!hit) return;
    r.resolved = true;
    n += 1;
  });
  if (n > 0) writeJsonl(reviewPath(root), rows);
  return n;
}
