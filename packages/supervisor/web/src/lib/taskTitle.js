/**
 * 任务标题取值链：接口 `title` -> 分片映射 -> 正文摘要，不回落到分片 id。
 *
 * 取数、去噪、摘要算法全部取服务端 `usage/taskTitle.ts` 的那一份：前端构建会把该 `.ts`
 * 一并编译（`lib/fmt.js` 引 `context/terms.ts` 走的就是这条路径）。本文件只保留
 * `taskTitle` 这一层“按 thread 对象取值”的包装，以及显示用的字数上限。
 *
 * 曾在此另存一份 `summarizeTitle`，与本文件其它函数一起复制自服务端；服务端后来修掉
 * “删数字”的缺陷（`校验第 1 张单` 被删成 `校验第张单`，指代消失），这里的副本没有跟上，
 * 于是同一个任务在左栏与看板显示成两个标题。摘要口径只此一份，不要在前端复写。
 */

import {
  SHARD_TITLES,
  cjkCount,
  shardTitle,
  summarizeTitle as summarizeFull,
} from "../../../src/supervisor/usage/taskTitle.ts";

/* 同源再导出：前端需要分片映射与汉字计数时，取的是服务端那份，不另存表。 */
export { SHARD_TITLES, cjkCount, shardTitle };

/** 短标题上限：10 个汉字。服务端保留完整标题，显示宽度由前端截断。 */
const MAX_TITLE_CHARS = 10;

export function summarizeTitle(text, max = MAX_TITLE_CHARS) {
  return summarizeFull(String(text || "")).slice(0, max);
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
