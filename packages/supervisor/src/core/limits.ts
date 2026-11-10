/** 跨模块共用的上限值（时间窗、文本长度）。 */

import { writeFileSync } from "node:fs";

import { readJson } from "./json";
import { join } from "node:path";

import { supervisorDir } from "./paths";

/** 一条待裁决问题（ask）最多能让阶段停多久。 */
export const ASK_BLOCK_MS = 15 * 60 * 1000;

/** 一条插话/指令挂了多久之后不再挡「报完成」。 */
export const DIRECTIVE_STALE_MS = 30 * 60 * 1000;

export const DIRECTIVE_OUTCOME_GUARD_MS = 45 * 60 * 1000;

/** 一次插话最多多少字。 */
export const MAX_SAY_CHARS = 8000;

/** 一张单「已上报、等监工裁决」期间，最多还能占住并发槽位多久。 */
export const VERDICT_HOLD_MS = 10 * 60 * 1000;

/** 被用户消息唤醒的派单，多久之内不因「阶段已推进」被作废。 */
export const WAKE_GRACE_MS = 30 * 60 * 1000;

/** 监工对话上下文的配置上限（token），缺省 600k；面板显式设置的值优先。 */
export const DEFAULT_SUPERVISOR_CONTEXT_LIMIT = 600_000;

/** 模型 → 上下文窗口默认表（token）。 */
export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "deepseek-v4.1-flash": 1_000_000,
};

/**
 * 宿主对未收录模型回落的占位窗口。
 *
 * 300000 不是任何模型的真实窗口，是宿主的默认值，遇到就当「没报」。用清单而不是
 * 单个常量。新增宿主时按宿主回落值增加一项。
 */
export const HOST_PLACEHOLDER_CONTEXT_WINDOWS: readonly number[] = [300_000];

/** 模型 id 的查表口径：去空白、转小写。表键按这个口径写。 */
export function modelKey(model: string): string {
  return String(model ?? "").trim().toLowerCase();
}

/** 默认表里登记的窗口；没有登记返回 0。 */
export function defaultContextWindow(model: string): number {
  const n = MODEL_CONTEXT_WINDOWS[modelKey(model)];
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}


export const CTX_WINDOW_PRESETS = [300_000, 600_000, 1_000_000] as const;

/** 未设置时的默认上下文窗口：监工与各工作进程各自独立取值，缺省都是这个数。 */
export const DEFAULT_CTX_WINDOW = 600_000;

export function isCtxWindowPreset(n: number): boolean {
  return (CTX_WINDOW_PRESETS as readonly number[]).includes(Math.round(n));
}

/**
 * 上下文窗口的作用域。
 *
 * - `default`：没单独设过的监工与工作进程都取这个值；
 * - `supervisor`：监工自己的；
 * - 其余字符串：一条工作进程线程的会话 id。
 *
 * 三个作用域的取值互不牵连：改监工的窗口不会改到任何工作进程，反之亦然。
 */
export type CtxScope = "default" | "supervisor" | (string & {});

/** `.capitalist/ctx-window.json` 的落盘结构。 */
export interface CtxWindowConfig {
  default: number | null;
  supervisor: number | null;
  threads: Record<string, number>;
}

function readConfigFile(root: string): CtxWindowConfig {
  const empty: CtxWindowConfig = { default: null, supervisor: null, threads: {} };
  try {
    /* 一轮构建里会被每行读数各查一次，走 readJson 的进程内缓存。 */
    const d = readJson<{ window?: number; default?: number; supervisor?: number; threads?: Record<string, number> }>(
      join(supervisorDir(root), "ctx-window.json"),
      {},
    );
    const pick = (v: unknown): number | null => {
      const n = Math.round(Number(v));
      return isCtxWindowPreset(n) ? n : null;
    };
    const threads: Record<string, number> = {};
    if (d.threads && typeof d.threads === "object") {
      for (const [k, v] of Object.entries(d.threads)) {
        const n = pick(v);
        if (k && n !== null) threads[k] = n;
      }
    }
    /* 旧格式只有一个 window 字段，是监工面板写下的：只认作监工的值，不当成全局限额。 */
    return { default: pick(d.default), supervisor: pick(d.supervisor) ?? pick(d.window), threads };
  } catch {
    return empty;
  }
}

function writeConfigFile(root: string, c: CtxWindowConfig): boolean {
  try {
    writeFileSync(join(supervisorDir(root), "ctx-window.json"), JSON.stringify(c, null, 1));
    return true;
  } catch {
    return false;
  }
}

/** 该作用域真的设过的值；没设过返回 null（不返回默认值，用于区分「未设置」）。 */
export function readCtxWindowChosen(root: string, scope: CtxScope = "default"): number | null {
  const c = readConfigFile(root);
  if (scope === "supervisor") return c.supervisor;
  if (scope !== "default") return c.threads[scope] ?? null;
  return c.default;
}

/** 该作用域生效的配置窗口：自己设过用自己的，否则退回默认档。 */
export function readCtxWindow(root: string, scope: CtxScope = "default"): number {
  return readCtxWindowChosen(root, scope) ?? readCtxWindowChosen(root, "default") ?? DEFAULT_CTX_WINDOW;
}

/**
 * 写某一作用域的窗口。只接受 300k / 600k / 1M 三档，别的值原样拒绝。
 *
 * `scope` 为 `default` 时不清掉监工与各线程的单设值。单设优先，改默认档只影响没单设过的。
 */
export function writeCtxWindow(root: string, w: number, scope: CtxScope = "default"): boolean {
  const n = Math.round(Number(w));
  if (!isCtxWindowPreset(n)) return false;
  const c = readConfigFile(root);
  if (scope === "supervisor") c.supervisor = n;
  else if (scope === "default") c.default = n;
  else c.threads = { ...c.threads, [scope]: n };
  return writeConfigFile(root, c);
}

/**
 * 模型真实窗口：宿主读数优先，没有读数才查默认表。
 *
 * 宿主报的是这次会话真正生效的额度，比表更可信；表只用来填补「宿主什么都没报」的情况。
 * 宿主对未收录模型常回一个占位值，那些值当「不知道」处理，不参与判断。
 */
export function modelRealWindow(model: string, reported?: number | null): number | null {
  const host = Number(reported);
  const hasHost = Number.isFinite(host) && host > 0 && !HOST_PLACEHOLDER_CONTEXT_WINDOWS.includes(Math.round(host));
  if (hasHost) return Math.round(host);
  return defaultContextWindow(model) || null;
}

/** 该模型的缺省窗口：600k，模型撑不住时降到模型的真实窗口。 */
export function defaultCtxWindowFor(model: string, reported?: number | null): number {
  const real = modelRealWindow(model, reported);
  return real !== null && real < DEFAULT_CTX_WINDOW ? real : DEFAULT_CTX_WINDOW;
}

/**
 * 生效上下文窗口：该作用域设过的值优先，没设过用模型缺省；两种情况都不超过模型真实窗口。
 */
export function effectiveCtxWindow(model: string, reported: number | null | undefined, chosen: number | null): number {
  const real = modelRealWindow(model, reported);
  const want = chosen ?? defaultCtxWindowFor(model, reported);
  return real !== null ? Math.min(want, real) : want;
}


/**
 * 这个模型撑不撑得住用户选的窗口。
 *
 * 判据：模型在默认表里登记过就用表；没登记看宿主报的读数（占位 300000 当「不知道」，
 * 按不支持处理）。返回 `supported` 与一句能直接给用户看的理由。
 */
export function ctxWindowSupported(
  model: string,
  reported: number | null | undefined,
  want: number,
): { supported: boolean; real: number | null } {
  const real = modelRealWindow(model, reported);
  if (real === null) return { supported: want <= 300_000, real: null };
  return { supported: want <= real, real };
}

/**
 * 生效上下文窗口（token）：宿主上报 + 默认表，唯一的换算入口。
 *
 * 规则：
 * 1. 宿主没报、或报的是占位值 → 用默认表；
 * 2. 宿主报了别的值 → 用它（比表大不压低，比表小也当作该模型的真实配额）；
 * 3. 两边都没有 → null：没有可依据的上限，界面只显示已用，不编一个。
 *
 * 看板读数、会话车道的换道闸门、监工上下文的超限判定都调这个函数。各算一套的后果是
 * 「界面说还有一半、闸门却已经换了道」，而这种事不会报错。
 */
export function resolveContextWindow(model: string, reported?: number | string | null): number | null {
  const host = Number(reported);
  const hasHost = Number.isFinite(host) && host > 0;
  const fallback = defaultContextWindow(model);
  if (!hasHost) return fallback > 0 ? fallback : null;
  const value = Math.round(host);
  if (HOST_PLACEHOLDER_CONTEXT_WINDOWS.includes(value)) {
    return fallback > 0 ? Math.max(fallback, value) : value;
  }
  return value;
}
