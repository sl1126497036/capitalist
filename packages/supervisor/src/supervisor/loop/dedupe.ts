/**
 * 建单前的重复判定：同一件事已有在途单时不再新建。
 *
 * 重复判定与调度无关，只回答“这一单是否已在途”。独立成模块后，建单流程只调用这一处，不再各自拼比较逻辑。
 *
 * 两条判据：
 *   1. 正文归一后完全相同（去掉附件行、空白、标点）；
 *   2. 同一分类标签且正文相似度不低于 0.8。阈值高于合并用的 0.45：
 *      相似到这一程度，追加进原单会污染正文。
 * 标签不同的两单不算重复：作用对象不同的两件事，文字常常相似。
 */

import { readDispatches } from "../../core/record/supervisor";
import { titleSimilarity } from "../../core/record/tasks";

/** 正文归一：去掉附件行、空白、标点与符号，用于“同一件事”的精确比较。 */
function dedupeKey(text: string): string {
  return String(text ?? "")
    .replace(/^\s*\[附件\].*$/gm, "")
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
}

/** 命中的在途单。`status` 只在正文完全相同时给出，供回执说明它处于哪一档。 */
export interface BusyDuplicate {
  kind: "dup" | "twin";
  id: string;
  status?: string;
}

/**
 * 找出覆盖同一件事的在途单。
 *
 * 只比较在途状态：已结束的单不阻止重新派单。
 * @returns 未命中返回 `null`。
 */
export function findBusyDuplicate(root: string, body: string, tag: string): BusyDuplicate | null {
  const rows = readDispatches(root);
  const bodyKey = dedupeKey(body);

  /* 空正文不参与判重：归一化后都是空串，会把互不相干的单判成同一件。 */
  if (bodyKey) {
    const dup = rows.find(
      (x) =>
        (x.status === "open" || x.status === "claimed" || x.status === "review") &&
        dedupeKey(String(x.action ?? "")) === bodyKey,
    );
    if (dup) return { kind: "dup", id: String(dup.id), status: String(dup.status) };
  }

  if (!tag) return null;
  const twin = rows.find((x) => {
    const st = String(x.status ?? "");
    if (st !== "open" && st !== "claimed" && st !== "reported" && st !== "review") return false;
    const tags = (x as { tags?: unknown }).tags;
    if (!Array.isArray(tags) || !tags.includes(tag)) return false;
    return titleSimilarity(String(x.action ?? ""), body) >= 0.8;
  });
  return twin ? { kind: "twin", id: String(twin.id) } : null;
}
