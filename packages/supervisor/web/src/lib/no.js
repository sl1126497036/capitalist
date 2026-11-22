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

/**
 * 是否是消息编号形态：`任务号-方向-时间戳`，同毫秒冲突时尾部再加一段自增序。
 *
 * 与 `src/core/message/msgId.ts` 的 `isMsgNo` 同一判据。方向段是“发送方到接收方”：
 * `U2W` 用户发给工作进程、`U2S` 用户发给监工、`W2S` 申报、`S2W` 监工发给工作进程、
 * `S2U` 监工发给用户、`W2U` 工作进程发给用户。旧段 `W` / `S` / `SP` 只为读旧台账保留。
 *
 * 派单号（`19-1`）、进程号（`19-P1`）、视图块 id（含 `~`）、内容指纹（`n0fg0v`）都不是消息编号。
 */
export function isMsgNo(no) {
  return /^[^-\s]+-(?:U2W|U2S|W2S|S2W|S2U|W2U|W|S|SP)-\d+(?:-\d+)?$/.test(stripHash(no));
}

/**
 * 消息编号显示：合法形态才补 `#`，其余返回空串。
 *
 * 界面任何位置显示消息编号都走这里。调用方拿到空串就不显示编号；不得把哈希、视图块 id、
 * 派单号补个 `#` 当成消息号上屏。
 */
export function msgNo(no) {
  return isMsgNo(no) ? noLabel(stripHash(no)) : "";
}

/**
 * 引用目标的编号：只有消息编号才给号。
 *
 * 派单卡代表一张单、视图块代表一段日志，两者都不是消息，没有消息编号，也就不提供引用。
 * 老引用记录里存的派单号因此显示为空，界面只显示摘要，不再伪造一个编号。
 */
export function refNo(ref) {
  return msgNo(ref);
}

/**
 * 这条消息能否引用与复制。
 *
 * 判据只有“有没有合法消息编号”：引用条上的编号就是这条消息的编号，没有编号的卡片
 * 引用出去只能落一个内容指纹（如 `hhs87c`），体系外编号会随提示词回流到界面。
 *
 * 派单卡（身份是派单号）、本地回显（`L-` 前缀的临时身份）没有消息编号，自然为 false。
 * 工作进程的输出块与思考块按日志创建时刻取号，有编号，可以引用；`view` 只表示内容
 * 由日志派生，不再决定能否引用。
 */
export function refableOf(m) {
  if (!m) return false;
  return isMsgNo(m.id);
}
