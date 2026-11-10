/**
 * 监工对话层的上屏规则：实时推送与刷新重建共用同一份过滤，输出一致。
 *
 * 派单动作行不进气泡；落成指令时叙述整条不下发，只保留结构记录，补充说明由 board 并入指令卡。
 */

/** 派单动作行有行首与行内两种写法，此处只匹配行首。 */
const CONTROL_LINE_RE = /^\s*(?:DO|ACTION|ATT|PARENT_REASON|PARENT|AFTER)\s*[:：]/i;

/** 行内动作行须跟已知动作名，否则正文里普通的 `action:` 会被误截。 */
const INLINE_CONTROL_RE =
  /[ \t]*(?:DO|ACTION)\s*[:：]\s*(?:dispatch|amend|pause|resume|concurrency|retry|skip|set-next|ask|instruct|intervene)\b[^\n]*/gi;

/** 只复述派单动作的短句；「追加 / 改口」为 amend 的动作词。 */
const DISPATCH_ECHO_RE =
  /(调度指令|加入队列|已登记|登记为下一步|已执行|已派|已开|开一单|派发|发出|安排了|重派|已追加|追加到|追加给|改口|下一[轮次拍]生效|待执行|插队)/;

/** 归一化：去掉空白、标点与符号，只留文字与数字。 */
function norm(text: string): string {
  return String(text || "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
}

function lcsLen(a: string, b: string): number {
  if (!a || !b) return 0;
  const n = a.length;
  const m = b.length;
  let prev = new Uint16Array(m + 1);
  let cur = new Uint16Array(m + 1);
  let best = 0;
  for (let i = 1; i <= n; i += 1) {
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j += 1) {
      if (ca === b.charCodeAt(j - 1)) {
        const v = (prev[j - 1] ?? 0) + 1;
        cur[j] = v;
        if (v > best) best = v;
      } else {
        cur[j] = 0;
      }
    }
    const swap = prev;
    prev = cur;
    cur = swap;
    cur.fill(0);
  }
  return best;
}

function bigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < text.length; i += 1) out.add(text.slice(i, i + 2));
  return out;
}

function overlapRatio(sentence: string, body: string): number {
  const s = bigrams(sentence);
  if (s.size === 0) return 0;
  const b = bigrams(body);
  let hit = 0;
  for (const g of s) if (b.has(g)) hit += 1;
  return hit / s.size;
}

/** 短句仅按整句包含判定，不用公共子串与二元组比例，避免常用词重合误判。 */
export function isDispatchRestatement(sentence: string, body: string): boolean {
  const ns = norm(sentence);
  const nb = norm(body);
  if (!ns || !nb) return false;
  if (ns.length >= 6 && nb.includes(ns)) return true;
  if (ns.length < 10) return false;
  const lcs = lcsLen(ns, nb);
  if (lcs >= Math.max(10, Math.ceil(ns.length * 0.7))) return true;
  return overlapRatio(ns, nb) >= 0.45;
}

export function stripControlLines(text: string): string {
  const kept: string[] = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (CONTROL_LINE_RE.test(raw)) continue;
    const line = raw.replace(INLINE_CONTROL_RE, "").trimEnd();
    if (line.trim()) kept.push(line);
  }
  return kept.join("\n").trim();
}

/** `body` 为空时不做去重；返回空串表示整条都是复述，由调用方扣下。 */
export function stripDispatchEcho(reply: string, body: string): string {
  const text = stripControlLines(reply);
  if (!text) return "";
  const nb = norm(body);
  const parts = text.split(/(?<=[。！？!?；;\n])/).map((s) => s.trim()).filter(Boolean);
  const kept = parts.filter((s) => {
    const ns = norm(s);
    if (!ns) return false;
    if (nb && isDispatchRestatement(s, body)) return false;
    if (DISPATCH_ECHO_RE.test(s) && ns.length <= 30) return false;
    return true;
  });
  return kept.join("").trim();
}

export interface SupervisorReplyFields {
  reply?: unknown;
  want?: unknown;
  applied?: unknown;
  acted?: unknown;
  /** 落成的派单正文；老事件没有该字段。 */
  dispatch_text?: unknown;
  /** 落成的指令 id；有该字段时消息流中存在对应的结构记录。 */
  directive?: unknown;
}

/** `acted` 为真表示动作已落成，此时叙述条不下发。 */
export function supervisorReplyView(e: SupervisorReplyFields): string {
  if (e.acted === true) return "";
  const reply = stripControlLines(String(e.reply ?? ""));
  /* `applied` 中的 `但你没要求，已忽略` 为废弃话术，不上屏。 */
  const raw = String(e.applied ?? "");
  const applied = /但你没要求，已忽略$/.test(raw) ? "" : raw;
  return `${reply}${applied ? `（${applied}）` : ""}`.trim();
}
