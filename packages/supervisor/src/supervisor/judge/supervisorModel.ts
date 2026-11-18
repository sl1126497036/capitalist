/**
 * 监工模型：监工自己的活共用一个模型的唯一取值入口。
 *
 * 监工有两类调用：对话层（看板回复、线程回复）与派单执行层（派单判定、守卫判定、摘要与自检），
 * 两者都必须跑在同一个模型上，且与看板顶部显示的模型是同一个。
 *
 * 取值顺序：`supervisor.json` 的 `supervisor_model`（用户在看板选定）→ 平台默认档。
 * 空串表示“跟随宿主默认”，此处解析成具体档名，使显示值与实际调用值不再分叉。
 */

import { readJson } from "../../core/record/json";
import { supervisorPath } from "../../core/record/supervisor";
import { resolveModel } from "./modelPolicy";

/** 监工实际调用的模型；没有模型策略的宿主返回 undefined，由宿主决定。 */
export function supervisorModelOf(root: string): string | undefined {
  /*
   * 不走 `loadSupervisor`：它要求心跳等运行字段齐全，监工未运行时整体读不回来，
   * 配置里的模型会被误判成“没配”。这里只读配置文件本身。
   */
  const cfg = readJson<{ supervisor_model?: unknown; host?: unknown } | null>(
    supervisorPath(root),
    null,
  );
  const explicit = String(cfg?.supervisor_model ?? "").trim();
  if (explicit) return explicit;
  return resolveModel({ root, host: String(cfg?.host ?? "").trim(), wanted: "" }).model;
}

/** 监工模型的显示值：解析结果，取不到时为空串（表示该宿主没有模型策略）。 */
export function supervisorModelEffective(root: string): string {
  return String(supervisorModelOf(root) ?? "").trim();
}
