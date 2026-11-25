/**
 * 用户显式切换过的模型：按分片记住，供补派与重派沿用。
 *
 * 只认带 `model_by: "user"` 的单。启动参数下发的 `model` 每单都写，
 * 若不加标记，补派会把上一单的模型固定下来，越过后面的启动参数变更。
 */

import { readDispatches } from "../record/supervisor";

/** 派单上与本模块相关的字段；基础 `Dispatch` 类型不含它们。 */
interface ModelFields {
  model?: string;
  model_by?: string;
}

/**
 * 取某分片最近一次由用户指定的模型。
 *
 * @returns 台账中最后一条 `model_by: "user"` 记录的模型；值是空串表示用户切回了默认，
 *          调用方据此回到启动参数的既有取值。没有此类记录时同样返回空串。
 */
export function pinnedModelOf(root: string, shard: string): string {
  const sh = String(shard ?? "").trim().toLowerCase();
  let found = "";
  for (const d of readDispatches(root)) {
    if (String(d.shard ?? "").trim().toLowerCase() !== sh) continue;
    const row = d as ModelFields;
    if (row.model_by !== "user") continue;
    found = String(row.model ?? "").trim();
  }
  return found;
}
