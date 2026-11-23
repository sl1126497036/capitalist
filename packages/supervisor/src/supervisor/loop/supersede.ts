/**
 * 接替校验：补单声明 `SUPERSEDE:` 时，确认它能顶替某一件事。
 *
 * 写入口只有本模块：把原话换成台账 id，并拒绝不可能成立的组合。判定侧只读落盘字段
 * （`groupGraph` 的 `groupItemsOf`），不再解析原话，避免两处各算一遍编号。
 *
 * 只允许组内接替，理由与组的定义一致：组是“同一后继的多个输入”，补单必须与原成员同组同父，否则组的成员数与位置会不一致。
 */

import { dispatchNoLabel, groupNoLabel, normalizeGroupId } from "../../core/record/idMap";
import { isTerminal } from "../../core/record/dispatchState";
import type { Dispatch } from "../../core/record/supervisor";
import { resolveDispatchRef } from "./refs";

/** 校验结果。`id` 为空串表示未声明接替。 */
export type SupersedeResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * 把 `SUPERSEDE:` 换成台账 id。
 *
 * @param rows 全量台账，引用解析要用它查编号与 id。
 * @param groupId 本单要加入的组（`applyGroupDecl` 之后的归一值）。空串表示没有入组。
 */
export function resolveSupersede(
  root: string,
  ref: string,
  input: { rows: readonly Dispatch[]; groupId: string },
): SupersedeResult {
  const tok = String(ref ?? "").trim();
  if (!tok) return { ok: true, id: "" };

  const hit = resolveDispatchRef(root, [...input.rows], tok);
  if (!hit) {
    return {
      ok: false,
      error: `接替目标“${tok}”在台账里找不到：核对编号后重发；新增任务不写 SUPERSEDE。`,
    };
  }

  const label = dispatchNoLabel(String(hit.id));
  const status = String(hit.status ?? "");
  const gid = normalizeGroupId(input.groupId);
  const targetGroup = normalizeGroupId((hit as { group?: unknown }).group);

  if (!gid) {
    return {
      ok: false,
      error: `SUPERSEDE 只用于组内补单：本单没有加入任何组。先写 GROUP: #G<组号> 与 PARENT，再声明接替。`,
    };
  }
  if (targetGroup !== gid) {
    return {
      ok: false,
      error: targetGroup
        ? `接替目标 ${label} 属于 ${groupNoLabel(targetGroup)}，本单要进 ${groupNoLabel(gid)}：同一件事必须留在同一个组里。`
        : `接替目标 ${label} 不属任何组，无法组内接替：按新增任务派单，并自行挂父节点。`,
    };
  }
  if (!isTerminal(status)) {
    return {
      ok: false,
      error: `接替目标 ${label} 尚未结束：等它出结论；确实不再等待时先执行 DO: cancel ${label} 作废。`,
    };
  }
  if (status === "done") {
    return {
      ok: false,
      error: `接替目标 ${label} 已经完成，无需接替：新增任务直接派单即可。`,
    };
  }

  return { ok: true, id: String(hit.id) };
}
