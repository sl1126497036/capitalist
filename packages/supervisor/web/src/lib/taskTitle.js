/**
 * 任务标题取值链：接口 `title` -> 分片映射 -> 正文摘要，不回落到分片 id。
 *
 * 分片映射直接取服务端 `usage/taskTitle.ts` 的那一份：前端构建会把该 `.ts` 一并编译
 * （`lib/fmt.js` 引 `context/terms.ts` 走的就是这条路径），无需在前端另存一张 90 项的表。
 * `shardTitle` 等函数仍留在本文件：服务端版本接收 `TitleInput` 对象，与这里的
 * `(thread, fallback)` 调用形状不同，强行共用会把差异推进参数里。
 */

import { SHARD_TITLES } from "../../../src/supervisor/usage/taskTitle.ts";

export { SHARD_TITLES };

/** 短标题上限：10 个汉字。 */
const MAX_TITLE_CHARS = 10;

const CJK = /[\u4e00-\u9fa5]/;

export function cjkCount(text) {
  let n = 0;
  for (const ch of String(text || "")) if (CJK.test(ch)) n += 1;
  return n;
}

/** 分片 id -> 中文短名；查不到返回空串。 */
export function shardTitle(shard) {
  const id = String(shard || "").trim();
  if (!id) return "";
  return SHARD_TITLES[id] || SHARD_TITLES[id.toLowerCase()] || "";
}

export function summarizeTitle(text, max = MAX_TITLE_CHARS) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const plain = raw
    .replace(/[（(][^）)]*[）)]/g, " ")
    .replace(/[`*#>|]/g, " ");
  for (const part of plain.split(/[。；;！!？?\n，,、：:]/)) {
    const seg = part.replace(/[\s\S]/gu, (ch) => (CJK.test(ch) ? ch : ""));
    if (cjkCount(seg) >= 2) return seg.slice(0, max);
  }
  return "";
}

/** `fallback` 仅在无标题来源时由调用方给定；取不到标题时留空，不使用占位文案。 */
export function taskTitle(t, fallback = "") {
  const stored = String(t?.title || "").trim();
  if (cjkCount(stored) > 0) return stored;
  const mapped = shardTitle(t?.shard);
  if (mapped) return mapped;
  const summarized = summarizeTitle(t?.action);
  if (summarized) return summarized;
  return fallback;
}
