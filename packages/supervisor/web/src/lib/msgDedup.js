/**
 * 重复在展示层判定：前端增量追加，服务端合并不移除已上屏条目。
 * 判同按说话人、归一正文与时间窗；同台账 5 秒，跨 `S-` / `CH-` 台账 2 分钟。
 * 只对用户与监工消息去重；工作进程的重复输出可能是两次真实调用。
 */

export const DUP_WINDOW_MS = 5_000;

/**
 * 跨台账判同窗口。同一句发言由 `S-`（direct.jsonl 待办登记）与 `CH-`（events.jsonl
 * 对话记录）各记一次，两次落盘间隔一轮监工循环或一次模型往返，故放宽到 2 分钟。
 */
export const CROSS_SOURCE_WINDOW_MS = 120_000;

/** 台账来源：`S-` 为待办登记，`CH-` 为对话记录；其余返回空。 */
function sourceOf(m) {
  const id = String(m?.id || "");
  if (id.startsWith("S-")) return "S";
  if (id.startsWith("CH-")) return "CH";
  return "";
}

function windowOf(a, b) {
  const sa = sourceOf(a);
  const sb = sourceOf(b);
  return sa && sb && sa !== sb ? CROSS_SOURCE_WINDOW_MS : DUP_WINDOW_MS;
}

const SPEAKERS = new Set(["user", "supervisor"]);

/**
 * 归一时同时识别 `[附件]` 与 `[图N]` 两种前缀：服务端落账会把前者改写为后者，
 * 本地回显仍保留原写法。保留标点，避免不同句子被判同。
 */
export function normSaid(text) {
  return String(text || "")
    .replace(/^\[(?:附件|图\s*\d*)\][^\n]*$/gm, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** 时间戳（毫秒）；缺失或非法按 0，使都无时间的两条仍能判同。 */
function atOf(m) {
  const t = Date.parse(String(m?.at || ""));
  return Number.isFinite(t) ? t : 0;
}

function richer(a, b) {
  const score = (m) => (String(m?.status || "").trim() ? 2 : 0) + (Array.isArray(m?.atts) && m.atts.length ? 1 : 0);
  return score(b) > score(a) ? b : a;
}

/** 去重后保持首次出现的位置：替换重复条目时不改变其在列表中的下标。 */
export function dedupeMessages(list) {
  const rows = Array.isArray(list) ? list : [];
  const out = [];
  /** key -> 输出数组下标（最后一次出现位置，供跨批次比较）。 */
  const seen = new Map();
  for (const m of rows) {
    const role = String(m?.role || "");
    const key = `${role}|${normSaid(m?.text)}`;
    const text = normSaid(m?.text);
    if (!SPEAKERS.has(role) || !text) {
      out.push(m);
      continue;
    }
    const hit = seen.get(key);
    if (hit === undefined) {
      seen.set(key, out.length);
      out.push(m);
      continue;
    }
    const kept = out[hit];
    if (Math.abs(atOf(kept) - atOf(m)) >= windowOf(kept, m)) {
      /* 超出窗口视为新发言。 */
      out.push(m);
      seen.set(key, out.length - 1);
      continue;
    }
    out[hit] = richer(kept, m);
  }
  return out;
}

/** 空消息：正文为空，或正文只是回落标签。 */
export function isBlankMessage(m, fallbackLabel = "") {
  const text = String(m?.text || "").trim();
  if (!text) {
    /* 带缩略图附件的气泡不算空。 */
    return !(Array.isArray(m?.atts) && m.atts.length) && !(Array.isArray(m?.attachments) && m.attachments.length);
  }
  return Boolean(fallbackLabel) && text === fallbackLabel;
}
