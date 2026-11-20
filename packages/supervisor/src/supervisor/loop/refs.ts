/**
 * 引用解析：把指令里的 `PARENT:` / 锚点写法换成台账上的派单。
 *
 * 从 `loop.ts` 搬出，两个原因：一是 `loop.ts` 已到规模上限，二是这段与调度循环无关——
 * 它只回答「这个记号指哪张单」。搬出后 `loop.ts` 只调用、不再各自拼解析。
 *
 * 三种写法：
 *   - `#01` / `#02-3` / 裸派单 id：编号与 id，查台账；
 *   - `@1`：本条消息第 1 个派单建出的单（编号在建单前不存在，只能用它）；
 *   - `#G1`：组号，不在这里换成派单，由调用方查组台账。
 */

import { checkTreeEdge, type Dispatch } from "../../core/record/supervisor";
import { parseRef } from "../../core/record/nodeRef";
import { resolveParentNode } from "../../core/dispatch/groupOps";
import { dispatchOfRef } from "../usage/threadNo";
import { dispatchOfSeq, isSeqRef } from "./seqRef";

/**
 * 把一个引用解析成台账行。组号返回 undefined（组不是派单行）。
 *
 * 不按状态过滤：前置单已经结束是正常情形（依赖已满足），指向它才不会重复等待。
 * 落库一律写派单 id；找不到时返回 undefined。
 */
export function resolveDispatchRef(root: string, rows: Dispatch[], tok: string): Dispatch | undefined {
  const ref = parseRef(tok);
  if (ref.kind === "group") return undefined;
  /* 历史 `D-` 号、线程键不是编号形态，按台账原文精确匹配。 */
  if (ref.kind === "other") return rows.find((x) => String(x.id) === ref.id);
  return dispatchOfRef(root, tok, { rows, anyStatus: true });
}

export interface ParentTokenInput {
  /** 本条指令来自哪条消息，`@N` 靠它定位同批动作。 */
  msgId: string;
  /** `PARENT:` 的值，调用方已把 `none` 这类否定值清成空串。 */
  tok: string;
  /** `PARENT_REASON:` 的值。 */
  why: string;
  /** 全量台账：成环检测要看父子链，只传父单会漏判。 */
  rows: readonly Dispatch[];
}

/**
 * 解析 `PARENT:` 指向的节点，返回派单 id 或组号。
 *
 * 三种语义的拒绝文案不同，这里统一产出，调用方只负责 `reject`：
 * `@N` 是「同批第 N 单没建成」，组号是「组不存在或已解散」，派单编号是「父派单找不到」。
 * 混成一句会让调用方补错东西。
 */
export function resolveParentTokens(
  root: string,
  input: ParentTokenInput,
): { ok: true; id: string; asGroup: boolean } | { ok: false; error: string } {
  const tok = String(input.tok ?? "").trim();
  if (!tok) return { ok: true, id: "", asGroup: false };

  if (isSeqRef(tok)) {
    const seq = Number(tok.slice(1));
    const hit = dispatchOfSeq(root, input.msgId, seq);
    if (!hit) {
      return {
        ok: false,
        error:
          `PARENT: ${tok} 指本条消息的第 ${seq} 个派单，但那一单没有建成（可能被拒或尚未建单）。` +
          `先确认那一单，再重发本条；或改用它的编号重发。`,
      };
    }
    const chk = checkTreeEdge(input.rows as Dispatch[], String(hit.id), input.why);
    if (!chk.ok) return { ok: false, error: chk.reason };
    return { ok: true, id: String(hit.id), asGroup: false };
  }

  const pn = resolveParentNode(root, tok, input.why, input.rows, (t) =>
    resolveDispatchRef(root, input.rows as Dispatch[], t),
  );
  if (!pn.ok) return { ok: false, error: pn.error };
  return { ok: true, id: pn.id, asGroup: pn.asGroup };
}
