/**
 * `ATT:` 行：随派单附带的截图编号。
 *
 * 只认编号，不认路径：模型写路径会指向不存在的文件，或引用上一轮的残留图片。
 * 编号由提示词里的【可用截图】给出，解析失败按未写处理，调用方回落到消息自带的图片。
 */

/**
 * 挑图行：`ATT: 1,3` / `ATT: none`。模型只写截图编号，不写路径，避免路径错误与历史残留。
 */
export const ATT_LINE = /^\s*ATT[:：]\s*(.*)$/i;

/** 解析 `ATT:` 行内容；无法识别时按未写处理，由调用方使用默认附件。 */
export function parseShots(raw: string): number[] | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  if (/^(?:none|no|无|不带|不需要|-|—)$/i.test(t)) return [];
  const nums = [...t.matchAll(/\d{1,2}/g)]
    .map((m) => Number(m[0]))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length === 0) return undefined;
  return [...new Set(nums)];
}
