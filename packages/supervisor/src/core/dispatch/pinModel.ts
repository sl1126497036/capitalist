/**
 * 用户显式切换过的模型：按阶段与分片记住，供补派与重派沿用。
 *
 * 只认带 `model_by: "user"` 的单。契约与启动参数下发的 `model` 每单都写，
 * 若不加标记，补派会把上一单的模型固定下来，越过后面的契约变更。
 *
 * 作用范围止于同一阶段同一分片：阶段推进后不再沿用，符合“其他单与新派单不受影响”。
 */

import { readDispatches } from "../record/supervisor";

/** 派单上与本模块相关的字段；基础 `Dispatch` 类型不含它们。 */
interface ModelFields {
  model?: string;
  model_by?: string;
}

/**
 * 取某阶段某分片最近一次由用户指定的模型。
 *
 * @returns 台账中最后一条 `model_by: "user"` 记录的模型；值是空串表示用户切回了默认，
 *          调用方据此回到契约与启动参数的既有取值。没有此类记录时同样返回空串。
 */
export function pinnedModelOf(root: string, stage: string, shard: string): string {
  const st = String(stage ?? "").trim().toLowerCase();
  const sh = String(shard ?? "").trim().toLowerCase();
  let found = "";
  for (const d of readDispatches(root)) {
    if (String(d.stage ?? "").trim().toLowerCase() !== st) continue;
    if (String(d.shard ?? "").trim().toLowerCase() !== sh) continue;
    const row = d as ModelFields;
    if (row.model_by !== "user") continue;
    found = String(row.model ?? "").trim();
  }
  return found;
}
