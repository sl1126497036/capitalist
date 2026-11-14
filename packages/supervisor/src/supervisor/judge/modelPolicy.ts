/**
 * 模型决策：把调用方指定的模型规范化为传给宿主的 `--model`。
 *
 * 默认档与禁用名单声明在各平台 impl，可由 `.capitalist/supervisor.json` 的 `default_model` / `model_denylist` 覆盖；禁用名单取平台与配置的并集，配置只能追加。
 */

import { readJson } from "../../core/record/json";
import { supervisorPath } from "../../core/record/supervisor";
import { byId } from "../../agent/registry";

export interface ModelDecision {
  /** 实际传给 `--model` 的值；`undefined` 表示该宿主没有模型策略，按原样传递。 */
  model: string | undefined;
  /** 命中禁用名单被替换掉的原值，调用方据此记事件。 */
  denied?: string;
  /** 结果来源说明，写入日志与事件。 */
  why: string;
}

/** 模型名在不同来源写法不一致，比较前统一大小写、空格与连字符。 */
export function normalizeModelName(name: string): string {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
}

export function modelRulesOf(
  root: string | undefined,
  host: string | undefined,
): { def: string; deny: string[]; source: string } | null {
  const impl = host ? byId(host) : undefined;
  const policy = impl?.modelPolicy;
  if (!policy) return null;
  /* 不走 `loadSupervisor`：它要求 `heartbeat_ts` 为数字，配置缺少该运行字段时会整体失效。 */
  const cfg = root
    ? readJson<{ default_model?: unknown; model_denylist?: unknown } | null>(supervisorPath(root), null)
    : null;
  const def = String(cfg?.default_model ?? "").trim() || policy.default;
  const extra = Array.isArray(cfg?.model_denylist)
    ? cfg.model_denylist.map((x) => String(x ?? "")).filter(Boolean)
    : [];
  const deny = [...new Set([...policy.deny, ...extra].map(normalizeModelName))];
  return {
    def,
    deny,
    source: cfg?.default_model || cfg?.model_denylist ? "配置覆盖平台默认" : "平台默认",
  };
}

/**
 * @param opts.host 宿主 id；没有模型策略的宿主原样返回。
 * @param opts.wanted 调用方指定的模型，来自命令行、契约分片或看板换模型。
 * @param opts.root 任务根，用于读取 `.capitalist/supervisor.json` 覆盖配置；缺省时不读。
 */
export function resolveModel(opts: {
  root?: string | undefined;
  host?: string | undefined;
  wanted?: string | undefined;
}): ModelDecision {
  const rules = modelRulesOf(opts.root, opts.host);
  const wanted = String(opts.wanted ?? "").trim();
  if (!rules) {
    return { model: wanted || undefined, why: "该宿主没有模型策略，按调用方给的值" };
  }
  if (!wanted) {
    return { model: rules.def, why: `未指定模型，用默认档 ${rules.def}（${rules.source}）` };
  }
  if (rules.deny.includes(normalizeModelName(wanted))) {
    return {
      model: rules.def,
      denied: wanted,
      why: `${wanted} 在禁用名单里，改用默认档 ${rules.def}`,
    };
  }
  return { model: wanted, why: `按指定使用 ${wanted}` };
}

/** 宿主可能在模型不可用时改用其它模型，日志中的模型名才是实际使用值；此处不做判定，由调用方比对后记事件。 */
export function modelsInLog(text: string): string[] {
  const out: string[] = [];
  const re = /"model"\s*:\s*"([^"\\]{2,64})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text ?? ""))) !== null) {
    const name = m[1] ?? "";
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

export function deniedModelsUsed(root: string | undefined, host: string | undefined, logText: string): string[] {
  const rules = modelRulesOf(root, host);
  if (!rules) return [];
  return modelsInLog(logText).filter((m) => rules.deny.includes(normalizeModelName(m)));
}
