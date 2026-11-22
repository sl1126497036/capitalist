/**
 * 任务标题取值链：接口 `title` -> 分片映射 -> 正文摘要，不回落到分片 id。
 *
 * 取数、去噪、摘要算法全部取服务端 `usage/taskTitle.ts` 的那一份：前端构建会把该 `.ts`
 * 一并编译（`lib/fmt.js` 引用 `context/terms.ts` 正是经由这条路径）。本文件只保留
 * `taskTitle` 这一层“按 thread 对象取值”的包装，不再自带字数上限。
 *
 * 曾在此另存一份 `summarizeTitle`，服务端后来修掉“删数字”的缺陷，这里的副本没有跟上，
 * 同一个任务在左栏与看板显示成两个标题。摘要口径只此一份，不要在前端复写。
 *
 * 也不再按字数截断：服务端落库的标题由派单方给出，长度已在写入时定过；前端再切一刀，
 * 会把“校验 cli 文案”切成“校验 cli 文”，同一批单又出现同名。显示宽度交给 CSS 省略。
 */

import {
  SHARD_TITLES,
  cjkCount,
  shardTitle,
  summarizeTitle,
} from "../../../src/supervisor/usage/taskTitle.ts";

/* 同源再导出：前端需要分片映射、汉字计数与摘要时，取的是服务端那份，不另存表。 */
export { SHARD_TITLES, cjkCount, shardTitle, summarizeTitle };

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
