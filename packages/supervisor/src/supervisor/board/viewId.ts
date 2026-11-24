/**
 * 视图块身份：思考块、工具聚合、输出分块、引擎调试这些不是消息。
 *
 * 这些块不以消息编号拼接身份，否则前端会将其视为可引用的消息。
 *
 * 统一成 `归属~类型~序号`：`~` 不出现在任务号、派单号、进程号、消息号里，因此
 * {@link isViewId} 能一眼判定“这不是消息”，界面据此不显示编号、不提供引用。
 */

/** 视图块 id 的分隔符。 */
export const VIEW_SEP = "~";

/**
 * 造一个视图块身份。
 *
 * `base` 用派单 id，不用进程号：进程号不该出现在下发给界面的数据里。
 * 没有派单 id 时才退到进程号，此时该值只作列表 key，不上屏。
 */
export function viewId(base: string, kind: string, n?: number | string): string {
  const b = String(base ?? "").trim() || "view";
  const k = String(kind ?? "").trim() || "block";
  return n === undefined || n === "" ? `${b}${VIEW_SEP}${k}` : `${b}${VIEW_SEP}${k}${VIEW_SEP}${n}`;
}

/** 是否是视图块身份（不是消息编号）。 */
export function isViewId(id: string): boolean {
  return String(id ?? "").includes(VIEW_SEP);
}
