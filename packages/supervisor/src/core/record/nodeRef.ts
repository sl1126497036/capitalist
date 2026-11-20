/**
 * 节点引用：树上一个节点的书写形式与显示形式。
 *
 * 树上的节点只有两种：派单与组。派单又可以用三种写法指认（编号、派单 id、进程号），
 * 组只有一种（组号）。这些形态曾散落在 `resolveDispatchRef`、`openDispatchOf`、
 * `cmd/tree.ts` 的 `noOf`、看板的 `forestNoOf` 中各自判定，组号加入后无法归类。
 *
 * 本模块只做两件事：
 *   1. {@link parseRef}：判断一段文本指的是哪一类节点，并把编号规范化（去 `#`、去前导零）；
 *   2. {@link label}：把落盘 id 显示成带 `#` 的形式。
 *
 * 不做“查台账”。编号到台账 id 的换算要看编号表与台账，属于带 IO 的解析，
 * 由调用方在本模块给出 `kind` 之后处理。这样 `core` 不必知道编号表存放在哪里。
 */

import {
  dispatchNoLabel,
  groupNoLabel,
  normalizeGroupId,
  padBareNo,
  stripHash,
  workerNoLabel,
} from "./idMap";

/** 引用指向哪一类节点。 */
export type RefKind =
  /** 组号：`#G1` / `G1`。 */
  | "group"
  /** 任务号：`#01` / `01`。一个任务可能对应多张派单，需查编号表。 */
  | "task-no"
  /** 派单 id：`2-3` / `02-3`。 */
  | "dispatch-id"
  /** 进程号：`2-P1`。指认该进程持有的派单。 */
  | "worker-no"
  /** 其它形态：历史 `D-` 号、分片名、线程 id。由调用方按台账精确匹配。 */
  | "other";

/** 一次解析的结果。`id` 已规范化（去 `#`、去前导零、组号大写），`raw` 保留原样供报错引用。 */
export interface NodeRef {
  kind: RefKind;
  id: string;
  raw: string;
}

/**
 * 去掉编号里的前导零：`02-3` -> `2-3`、`02` -> `2`、`002-P1` -> `2-P1`。
 *
 * 非编号形态原样返回：历史 `D-` 号与分片名里的数字不参与编号规则。
 */
export function normalizeNo(s: string): string {
  const t = stripHash(String(s ?? "")).trim();
  const m = /^(\d+)((?:-\d+|-P\d+)?)$/i.exec(t);
  if (!m) return t;
  return `${Number(m[1])}${m[2] ?? ""}`;
}

/**
 * 是否是组号形式。不校验组是否存在。
 *
 * 判据交给 `normalizeGroupId`：`#G01`、`G1`、`g001` 都算组号，且都归一到同一形态。
 * 这里不另写正则，否则“认得出 `#G01`”与“查得到 `G1`”会产生两套口径。
 */
export function isGroupRef(ref: string): boolean {
  return normalizeGroupId(ref) !== "";
}

/**
 * 解析一段引用文本。
 *
 * 顺序不可换：先认组号（`G` 开头不会与派单号冲突），再认进程号，再认派单号，
 * 最后才是纯数字（任务号）。纯数字不可能是派单 id，派单 id 恒为 `任务号-派单序`。
 */
export function parseRef(ref: string): NodeRef {
  const raw = String(ref ?? "").trim();
  const bare = stripHash(raw);
  if (!bare) return { kind: "other", id: "", raw };

  const gid = normalizeGroupId(bare);
  if (gid) return { kind: "group", id: gid, raw };
  if (/^\d+-P\d+$/i.test(bare)) {
    return { kind: "worker-no", id: normalizeNo(bare), raw };
  }
  if (/^\d+-\d+$/.test(bare)) {
    return { kind: "dispatch-id", id: normalizeNo(bare), raw };
  }
  if (/^\d+$/.test(bare)) {
    return { kind: "task-no", id: normalizeNo(bare), raw };
  }
  return { kind: "other", id: bare, raw };
}

/**
 * 把一个落盘 id 显示成带 `#` 的形式。
 *
 * 这是显示侧的唯一分派点：补零仍由 `idMap` 的四个 label 完成，本函数只负责判断
 * “这是哪一类号”。无法识别的形态原样返回，不作推测。
 */
export function label(id: unknown): string {
  const s = String(id ?? "").trim();
  if (!s) return "";
  if (normalizeGroupId(s)) return groupNoLabel(s);
  if (/^\d+-P\d+$/i.test(s)) return workerNoLabel(s);
  if (/^\d+(-\d+)?$/.test(s)) return dispatchNoLabel(s);
  return s;
}

/** 不带 `#` 的显示形式，供已经在 `#` 语义里的文案使用（如“等待 #02”的编号部分）。 */
export function bareLabel(id: unknown): string {
  return label(id).replace(/^#/, "");
}

/** 补零但保留原前缀，供需要自行拼 `#` 的旧调用点过渡使用。 */
export function paddedNo(id: unknown): string {
  return padBareNo(String(id ?? ""));
}
