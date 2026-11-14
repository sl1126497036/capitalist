/**
 * 文本截断与错误消息的共用实现。
 *
 * 拆分前 board / reload / workerLog / forestView / cli 各有一份 clip，名字相同但行为分两种：
 * 是否折叠空白、省略号是否计入长度上限。调用方按各自理解传参，改动一处不影响另一处，
 * 语义漂移无法察觉。这里按用途拆成两个函数，把差异写进名字。
 */

/**
 * 压成单行并限长。连续空白折叠为一个空格，去首尾空格，省略号计入上限。
 *
 * 用于表格单元格、标题、按钮等只能容纳一行的位置。
 */
export function clipLine(text: unknown, max: number): string {
  const s = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * 仅限长。保留原有换行与空白，超出上限时截断并补省略号。
 *
 * 用于日志片段、正文预览这类多行内容，折叠空白会损失可读性。
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * 取错误消息。非 Error 值按字符串处理，避免上层各写一份 instanceof 判断。
 */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 等待指定毫秒。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
