/**
 * 文本截断与错误消息的共用实现。
 *
 * clipLine 折叠空白并把省略号计入长度上限，clipText 保留换行与空白。两者行为不同，分别实现。
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

/**
 * 行首列表序号：`1. ` / `2、` / `3)` / `4：`。
 *
 * 只认 1-2 位数字，且序号后的点号不能紧跟数字：`2026. 年度盘点`、
 * `3.5 倍的阈值` 是正文，不是列表编号，剥掉数字会丢掉语义。
 */
const LEAD_ORDINAL = /^[ \t]*\d{1,2}[ \t]*[.)）:：、](?![ \t]*\d)[ \t]*/;

/**
 * 去掉**首个非空行**的行首列表序号，其余行原样保留。
 *
 * 序号是书写格式，不是内容。只处理行首：正文里“第 1 张单”的数字是语义，去掉后变成“第张单”，指代随之丢失。
 */
export function stripListMark(text: string): string {
  const s = String(text ?? "");
  const lines = s.split(/\r?\n/);
  const i = lines.findIndex((l) => l.trim());
  if (i < 0) return s;
  const hit = LEAD_ORDINAL.exec(lines[i] ?? "");
  if (!hit) return s;
  lines[i] = (lines[i] ?? "").slice(hit[0].length);
  return lines.join("\n");
}

/**
 * 去掉派单正文开头的列表序号；整段每行都带序号时视为分步清单，不动。
 *
 * 一条消息派多单时，模型常把“第几条”写进每单正文（`2. 盘点 web/src 下所有含中文的文件`）。派单按单分发，各进程上下文隔离，仅拿到 `2.` 的进程无法确认其余派单是否已下发。
 *
 * 整段每行都带序号的是这张单自己的分步清单，属于内容，保留。
 */
export function stripLeadOrdinal(text: string): string {
  const s = String(text ?? "");
  const lines = s.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length >= 2 && lines.every((l) => LEAD_ORDINAL.test(l))) return s;
  return stripListMark(s);
}
