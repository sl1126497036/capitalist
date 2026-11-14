/**
 * 宿主模型清单与看板侧模型视图。
 *
 * 清单来源与派单轮换共用 agent/modelCatalog，这里只做缓存与"为什么取到这份清单"的说明，
 * 两处口径因此不会分叉。
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import {
  findHostCli,
  helpModels as catalogHelpModels,
  parseModelIdsFromHelp,
  resetHelpModelsCacheForTest,
} from "../../agent/modelCatalog";
import { byId, detect } from "../../agent/registry";
import { loadSupervisor } from "../../core/supervisor";

export function knownModelsOf(host: string): readonly string[] {
  return byId(host)?.knownModels ?? [];
}
export function cliBinsOf(host: string): readonly string[] {
  return byId(host)?.cliBins ?? [];
}
export function configDirOf(host: string): string {
  return byId(host)?.configDir ?? "";
}

export interface ModelsView {
  host: string;
  source: string;
  models: string[];
  /** 宿主配置里的默认模型（`<configDir>/settings.json` 的 model 字段）；空值表示未配置。 */
  default_model: string;
  at: string;
  reason: string;
}

export const MODELS_TTL_MS = 5 * 60_000;
export let modelsCache: { host: string; at: number; view: ModelsView } | null = null;

/**
 * 通道失败时补一行处置。
 *
 * 授权只在启动监工时发生一次：拿到就是全树可用，拿不到则后续统一失败。因此这里的处置
 * 是“重启监工并允许授权”，而不是让用户在发消息时再点一次授权。
 */
export function chatAuthHint(root: string): string {
  try {
    if (String(loadSupervisor(root)?.host ?? "").trim() !== "workbuddy") return "";
    return "\n启动监工时没有取得宿主登录态。重启监工并在弹窗中选择允许；启动日志会写明是未登录、被拒还是格式不支持。";
  } catch {
    return "";
  }
}

export function hostConfigModel(host: string): string {
  const dir = configDirOf(host);
  if (!dir) return "";
  try {
    const raw = readFileSync(join(os.homedir(), dir, "settings.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const m = (parsed as { model?: unknown } | null)?.model;
    const s = typeof m === "string" ? m.trim() : "";
    return /^[\w.:-]+$/.test(s) ? s : "";
  } catch {
    return "";
  }
}

export { findHostCli, parseModelIdsFromHelp, resetHelpModelsCacheForTest };

/**
 * 宿主模型清单，供看板下拉使用。
 *
 * 清单来源与派单轮换同一份（见 `host/modelCatalog`），本处只负责在清单变化后
 * 让看板侧的模型视图缓存失效。
 */
export function helpModels(host: string): string[] {
  const models = catalogHelpModels(host);
  if (models.length > 0) modelsCache = null;
  return models;
}

export function readModels(host: string): ModelsView {
  const at = new Date().toISOString();
  const configured = hostConfigModel(host);
  const parsed = helpModels(host);
  const known = knownModelsOf(host);
  const rest = parsed.length > 0 ? parsed : known;
  const models = [...new Set([configured, ...rest].filter(Boolean))];
  if (models.length > 0) {
    const from = [
      configured ? "宿主配置 model 字段" : "",
      parsed.length ? "宿主 CLI --model 全量清单" : known.length ? "已知模型清单（CLI 解析失败回退）" : "",
    ].filter(Boolean).join(" + ");
    return {
      host,
      source: from,
      models,
      /* 宿主配置的默认模型，用于“宿主默认”一行。 */
      default_model: configured,
      at,
      reason: parsed.length ? "" : "未解析出宿主模型清单，以下为回退清单，可手填",
    };
  }
  return {
    host,
    source: configDirOf(host) ? `~/${configDirOf(host)}/settings.json` : "",
    models: [],
    default_model: configured,
    at,
    reason: "该宿主没有已知模型清单，可在输入框直接填写模型名",
  };
}

export function modelsView(root: string, fresh: boolean): ModelsView {
  const host = currentHostOf(root);
  if (!fresh && modelsCache && modelsCache.host === host && Date.now() - modelsCache.at < MODELS_TTL_MS) {
    return modelsCache.view;
  }
  const view = readModels(host);
  modelsCache = { host, at: Date.now(), view };
  return view;
}

export function currentHostOf(root: string): string {
  try {
    const h = String(loadSupervisor(root)?.worker_host ?? "").trim();
    if (h && h !== "none") return h;
  } catch {
  }
  return detect() ?? "generic";
}
