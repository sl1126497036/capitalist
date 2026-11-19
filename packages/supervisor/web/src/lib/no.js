/**
 * 编号显示与解析的统一入口。
 *
 * 全系统编号只有一套：任务号 `#02`、派单号 `#02-2`、进程号 `#02-P1`。
 * `#` 前缀的加与剥统一在这里处理，任何地方不得各自拼 `#` 或自行去 `#`，
 * 否则有的地方带、有的地方不带，解析与查号会对不上。
 *
 * 服务端下发的 `no` 字段为不带 `#` 的裸编号（如 `"2"`、`"2-2"`、`"2-P1"`），
 * 显示时经 {@link noLabel} 补 `#`；解析输入时经 {@link stripHash} 剥 `#`。
 */

/** 裸编号补 `#`：`"2"` -> `#2`、`"2-2"` -> `#2-2`；已带 `#` 或空值原样返回。 */
export function noLabel(no) {
  const s = String(no ?? "").trim();
  if (!s) return "";
  return s.startsWith("#") ? s : `#${s}`;
}

/** 剥掉编号开头的 `#`，得裸编号；容忍用户带或不带 `#`。 */
export function stripHash(no) {
  return String(no ?? "").replace(/^#/, "").trim();
}

/** 任务号显示：`"2"` -> `#2`。 */
export function taskNo(no) {
  return noLabel(no);
}

/** 派单号显示：`"2-2"` -> `#2-2`。 */
export function dispatchNo(no) {
  return noLabel(no);
}

/** 进程号显示：`"2-P1"` -> `#2-P1`。 */
export function workerNo(no) {
  return noLabel(no);
}

/** 消息编号显示：`"2-U2W-…"` -> `#2-U2W-…`。 */
export function msgNo(no) {
  return noLabel(no);
}
