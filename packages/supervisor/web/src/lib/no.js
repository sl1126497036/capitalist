/**
 * 编号显示与解析的统一入口。
 *
 * 系统里有两类号：任务号 / 派单号 / 进程号（`#02`、`#02-2`、`#02-P1`），
 * 以及树上的组号（`#G01`）。组号不发行任务号、不占派单序，显示时同样在这里补零并补 `#`。
 * 任何地方不得各自拼 `#` 或自行去 `#`，否则各处格式不一致，解析与查号会失配。
 *
 * 服务端下发的 `no` 字段为不带 `#` 的裸编号（如 `"2"`、`"2-2"`、`"2-P1"`、`"G1"`），
 * 显示时经 {@link noLabel} 补 `#`；解析输入时经 {@link stripHash} 剥 `#`。
 */

/** 任务号段补零到两位；超过 99 原样（不截断）。 */
function padTaskNo(n) {
  return /^\d+$/.test(n) ? n.padStart(2, "0") : n;
}

/** 裸编号里第一段任务号补零到两位：`2-2` -> `02-2`、`2-P1` -> `02-P1`、`2` -> `02`；非数字开头原样。 */
function padNo(s) {
  const m = /^(\d+)(.*)$/.exec(s);
  return m ? `${padTaskNo(m[1])}${m[2]}` : s;
}

/** 组号补零：`G1` -> `G01`。组号的补零规则与任务号不同，但共用同一出口。 */
function padGroupNo(s) {
  const m = /^G(\d+)$/i.exec(s);
  return m ? `G${String(Number(m[1])).padStart(2, "0")}` : s;
}

/** 裸编号（补零、不带 `#`）：`"2-2"` -> `"02-2"`、`"G1"` -> `"G01"`；空值返回空串。 */
export function bareNoLabel(no) {
  const s = String(no ?? "").trim();
  if (!s) return "";
  const bare = s.replace(/^#/, "");
  return /^G\d+$/i.test(bare) ? padGroupNo(bare) : padNo(bare);
}

/** 裸编号补 `#` 并补零：`"2"` -> `#02`、`"2-2"` -> `#02-2`、`"G1"` -> `#G01`；空值返回空串。 */
export function noLabel(no) {
  const bare = bareNoLabel(no);
  return bare ? `#${bare}` : "";
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

/**
 * 进程号降级为其所属任务号：`"6-P1"` -> `"#06"`。
 *
 * 进程号是调度内部标识，界面不展示。文件锁持有者与待回收进程原先直接显示进程号，
 * 改为只显示所属任务。非进程号（如 `user`、空值）原样返回，不生成编号。
 */
export function workerOwnerNo(id) {
  const raw = String(id ?? "").trim();
  const m = /^(\d+)-P\d+$/.exec(stripHash(raw));
  return m ? noLabel(m[1]) : raw;
}

/** 消息编号显示：`"2-U2W-…"` -> `#2-U2W-…`。 */
export function msgNo(no) {
  return noLabel(no);
}
