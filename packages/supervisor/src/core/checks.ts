/** 声明式阶段门槛。 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { readJson, readJsonl } from "./json";
import { supervisorDir } from "./paths";

/** 一次检查的结果。`missing` 列出未满足的条件，供写入简报。 */
export interface CheckResult {
  ok: boolean;
  missing: string[];
}

type Spec = Record<string, unknown>;
type Checker = (spec: Spec, root: string) => CheckResult;

/** 清单文件：优先 `.capitalist/<file>`（record 的落点），回落任务根下同名文件（手工放置）。 */
function resolveListFile(root: string, rel: string): string {
  if (isAbsolute(rel)) return rel;
  const inSupervisor = join(supervisorDir(root), rel);
  return existsSync(inSupervisor) ? inSupervisor : join(root, rel);
}

/** 检查项里的清单路径：`file` 与 `path` 两种写法历史上都在用，缺省为空串。 */
function relOf(spec: Spec): string {
  return String(spec.file ?? spec.path ?? "");
}

/** 把检查结果套上契约里的 `msg` 模板，`{n}` 替换为数量。 */
function fail(spec: Spec, fallback: string, n?: number): CheckResult {
  const tpl = typeof spec.msg === "string" && spec.msg ? spec.msg : fallback;
  return { ok: false, missing: [tpl.replace("{n}", String(n ?? 0))] };
}

/** 数量阈值：写错（负数、非数字）时回落到默认值，避免 NaN 比较让检查恒不达标。 */
function threshold(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** 字符串数组字段：契约里写成标量或对象时按空数组处理，不让类型错误冒到判定路径上。 */
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

/**
 * 取字符串数组字段；字段存在但不是数组时 fail closed。
 *
 * “读不懂配置”与“没有这条要求”不能同义：按空数组放过去，等于把一条写错的检查变成
 * 永远达标，阶段会在没有证据的情况下被判完成。缺省（字段不存在）仍按空数组处理，
 * 那时语义确实是“没要求”。
 */
function strListOrFail(spec: Spec, key: string, label: string): { list: string[] } | { error: CheckResult } {
  const v = spec[key];
  if (v === undefined || v === null) return { list: [] };
  if (!Array.isArray(v)) {
    return { error: { ok: false, missing: [`${label} 必须是字符串数组，实际是 ${typeof v}`] } };
  }
  return { list: strList(v) };
}

/**
 * `all_of` / `any_of` 的子检查。
 *
 * `checks` 与 `of` 两种写法都在用；写成非数组时按“未配置”处理而不是抛出，
 * 判定路径上抛错会让整个 gate 变成异常，而上层只能记一条 error，等于把一条配置错误
 * 变成一次不明原因的不达标。元素不是对象的用空对象占位，交给 {@link runCheck} 判成
 * “没有配置 done 条件”，同样是 fail closed。
 */
function subChecks(spec: Spec): Spec[] {
  const raw = Array.isArray(spec.checks) ? spec.checks : Array.isArray(spec.of) ? spec.of : [];
  return raw.map((c) => (c && typeof c === "object" ? (c as Spec) : {}));
}

/** 归一化后的 errno 码，用于拼可操作的失败说明。 */
function errCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" && code ? code : String((err as Error).message ?? err);
}

function readText(p: string): { text: string } | { error: string } {
  try {
    return { text: readFileSync(p, "utf8") };
  } catch (err) {
    return { error: errCode(err) === "EISDIR" ? "是目录，不是文件" : `读取失败（${errCode(err)}）` };
  }
}

/**
 * 渲染一组缺失键的说明文案。模板含 `{k}` 时每个键一行。
 */
function failKeys(spec: Spec, rel: string, lack: string[]): CheckResult {
  const tpl = typeof spec.msg === "string" ? spec.msg : "";
  if (tpl.includes("{k}")) return { ok: false, missing: lack.map((k) => tpl.replace(/\{k\}/g, k)) };
  return fail(spec, `${rel} 缺键：${lack.join("、")}`, lack.length);
}

/** 秒级时间戳；接受数字与 ISO 字符串，取不到返回 0。 */
function tsOf(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t / 1000;
  }
  return 0;
}

/** 报告里的一条断言：`path` 点分取值，`op` 判定方式，`value` 期望值，`tol` 容差。 */
interface Assertion {
  path: string;
  op: string;
  value: unknown;
  tol: unknown;
}

/** 按点分路径取值。 */
function pickPath(data: unknown, path: string): { found: boolean; value: unknown } {
  if (!path) return { found: true, value: data };
  let cur: unknown = data;
  for (const seg of path.split(".").filter((s) => s !== "")) {
    if (cur === null || typeof cur !== "object") return { found: false, value: undefined };
    const obj = cur as Record<string, unknown>;
    if (!(seg in obj)) return { found: false, value: undefined };
    cur = obj[seg];
  }
  return cur === undefined ? { found: false, value: undefined } : { found: true, value: cur };
}

/** 断言里的期望值/实际值的可读形式：字符串加引号，避免 `"88"` 与 `88` 看起来一样。 */
function show(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === undefined) return "(缺失)";
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  return String(v);
}

/** 断言数组：`assert` 与 `assertions` 两种写法都在用；非数组时返回 null（fail closed）。 */
function assertionsOf(spec: Spec): Assertion[] | null {
  const raw = Array.isArray(spec.assert) ? spec.assert : spec.assertions;
  if (!Array.isArray(raw)) return null;
  return raw.map((a) => {
    const o = a && typeof a === "object" ? (a as Spec) : {};
    return {
      path: String(o.path ?? o.key ?? ""),
      op: String(o.op ?? o.assert ?? ""),
      value: o.value,
      tol: o.tol ?? o.tolerance,
    };
  });
}

/**
 * 单条断言的判定说明。满足返回 null，不满足返回一行“期望 / 实际”。
 *
 * 未知 `op` 与类型不匹配（要数的位置给了字符串）都判不满足：这类配置读成“通过”
 * 等于让门槛静默失效，方向性错误。
 */
function checkAssertion(data: unknown, a: Assertion, rel: string): string | null {
  const head = `${rel} ${a.path || "(空路径)"}`;
  const got = pickPath(data, a.path);
  if (!got.found) {
    return a.op === "truthy"
      ? `${head}：期望 truthy，实际 缺失`
      : a.op === "falsy"
        ? null // 缺字段按“没有这个元素”处理
        : `${head}：期望 ${a.op || "(空)"} ${show(a.value)}，实际 缺失`;
  }

  const actual = got.value;
  switch (a.op) {
    /** `eq` / `ne` / `gt` / `gte` / `lt` / `lte` 是常见写法的别名。 */
    case "equals":
    case "eq":
      return actual === a.value ? null : `${head}：期望 ${show(a.value)}，实际 ${show(actual)}`;
    case "ne":
    case "neq":
      return actual !== a.value ? null : `${head}：期望不等于 ${show(a.value)}，实际 ${show(actual)}`;
    case "min":
    case "gte":
    case "max":
    case "lte": {
      const isMin = a.op === "min" || a.op === "gte";
      if (typeof actual !== "number" || !Number.isFinite(actual)) {
        return `${head}：期望 ${a.op} ${show(a.value)}，实际 ${show(actual)}（不是数值，无法比较）`;
      }
      const ok = isMin ? actual >= Number(a.value) : actual <= Number(a.value);
      return ok ? null : `${head}：期望 ${a.op} ${show(a.value)}，实际 ${show(actual)}`;
    }
    case "gt":
    case "lt": {
      const isGt = a.op === "gt";
      if (typeof actual !== "number" || !Number.isFinite(actual)) {
        return `${head}：期望 ${a.op} ${show(a.value)}，实际 ${show(actual)}（不是数值，无法比较）`;
      }
      const ok = isGt ? actual > Number(a.value) : actual < Number(a.value);
      return ok ? null : `${head}：期望 ${a.op} ${show(a.value)}，实际 ${show(actual)}`;
    }
    case "near": {
      const want = Number(a.value);
      const tol = a.tol === undefined || a.tol === null ? 0 : Number(a.tol);
      if (typeof actual !== "number" || !Number.isFinite(actual) || !Number.isFinite(want) || !Number.isFinite(tol)) {
        return `${head}：期望 near ${show(a.value)} ± ${show(a.tol ?? 0)}，实际 ${show(actual)}（不是可比的数值）`;
      }
      return Math.abs(actual - want) <= tol
        ? null
        : `${head}：期望 near ${show(want)} ± ${show(tol)}，实际 ${show(actual)}`;
    }
    case "truthy":
      return actual ? null : `${head}：期望 truthy，实际 ${show(actual)}`;
    case "falsy":
      return actual ? `${head}：期望 falsy，实际 ${show(actual)}` : null;
    default:
      return `${head}：未知断言类型 ${a.op || "(空)"}（无法判定，不等于已满足）`;
  }
}

const CHECKS: Record<string, Checker> = {
  /*
   * 显式“无验收条件”。
   *
   * 与“没写 done”区分开：`runCheck` 对空 spec 是 fail closed（判不达标），因为漏配
   * 门槛通常是写错了。但有些阶段确实不需要验收条件，比如只按派单台账执行的任务根，
   * 阶段不代表一段有产出物的工序。这类阶段写 `{"type":"none"}`，明确表示“本阶段
   * 没有门槛”，而不是留空让人猜是漏配还是故意不配。
   */
  none: () => ({ ok: true, missing: [] }),
  file_exists: (spec, root) => {
    const rel = String(spec.path ?? "");
    const p = join(root, rel);
    if (!existsSync(p)) return fail(spec, `缺文件：${rel}`);
    // existsSync 与 statSync 之间存在竞态（并发删除），stat 一次拿不到就按不达标处理。
    let size: number;
    try {
      size = statSync(p).size;
    } catch (err) {
      return fail(spec, `读不到 ${rel} 的文件信息（${errCode(err)}）`);
    }
    if (size === 0) return fail(spec, `文件为空：${rel}`);
    return { ok: true, missing: [] };
  },

  glob_min: (spec, root) => {
    const rel = String(spec.path ?? spec.dir ?? "");
    const min = threshold(spec.min, 1);
    let count = 0;
    try {
      // withFileTypes 免去逐个 statSync：目录里的条目在枚举后被删也不会抛。
      count = readdirSync(join(root, rel), { withFileTypes: true }).filter((d) => d.isFile()).length;
    } catch {
      count = 0;
    }
    return count >= min ? { ok: true, missing: [] } : fail(spec, `${rel} 只有 ${count} 个，需 ≥ ${min}`, count);
  },

  jsonl_min: (spec, root) => {
    const rel = relOf(spec);
    const min = threshold(spec.min, 1);
    const n = readJsonl(resolveListFile(root, rel)).length;
    return n >= min ? { ok: true, missing: [] } : fail(spec, `${rel} 只有 ${n} 行，需 ≥ ${min}`, n);
  },

  jsonl_all_field: (spec, root) => {
    const rel = relOf(spec);
    const field = String(spec.field ?? "");
    const rows = readJsonl<Record<string, unknown>>(resolveListFile(root, rel));
    const lacking = rows.filter((r) => {
      const v = r[field];
      return v === undefined || v === null || String(v).trim() === "";
    }).length;
    if (lacking === 0) return { ok: true, missing: [] };
    if (rows.length === 0) return fail(spec, `${rel} 是空的（0 行）`, 0);
    return fail(spec, `${lacking} 行缺字段 ${field}`, lacking);
  },

  jsonl_status_min: (spec, root) => {
    const rel = relOf(spec);
    const field = String(spec.field ?? "status");
    const value = spec.value;
    const min = threshold(spec.min, 1);
    const rows = readJsonl<Record<string, unknown>>(resolveListFile(root, rel));
    const n = rows.filter((r) => r[field] === value).length;
    return n >= min
      ? { ok: true, missing: [] }
      : fail(spec, `${field}=${String(value)} 的只有 ${n} 条，需 ≥ ${min}`, n);
  },

  jsonl_status_none: (spec, root) => {
    const rel = relOf(spec);
    const field = String(spec.field ?? "status");
    const value = spec.value;
    const rows = readJsonl<Record<string, unknown>>(resolveListFile(root, rel));
    const n = rows.filter((r) => r[field] === value).length;
    return n === 0 ? { ok: true, missing: [] } : fail(spec, `还有 ${n} 条 ${field}=${String(value)} 未处理`, n);
  },

  json_keys: (spec, root) => {
    const rel = relOf(spec);
    const keysRes = strListOrFail(spec, "keys", "json_keys.keys");
    if ("error" in keysRes) return keysRes.error;
    const keys = keysRes.list;
    const data = readJson<Record<string, unknown> | null>(resolveListFile(root, rel), null);
    // 文件缺失按“所有键都缺”处理，不按“检查无法执行”处理。
    if (!data) return failKeys(spec, rel, keys);

    const lack = keys.filter((k) => !(k in data));
    if (lack.length === 0) return { ok: true, missing: [] };
    return failKeys(spec, rel, lack);
  },

  json_eq: (spec, root) => {
    const rel = relOf(spec);
    const data = readJson<Record<string, unknown> | null>(resolveListFile(root, rel), null);
    if (!data) return fail(spec, `${rel} 不存在或不是合法 JSON`);
    const key = String(spec.key ?? "");
    return data[key] === spec.value
      ? { ok: true, missing: [] }
      : fail(spec, `${rel} 的 ${key} ≠ ${String(spec.value)}`);
  },

  report_assert: (spec, root) => {
    const rel = relOf(spec);
    const list = assertionsOf(spec);
    if (list === null) {
      return { ok: false, missing: ["report_assert 的 assert 必须是断言数组（没有断言无从判定）"] };
    }
    if (list.length === 0) {
      return { ok: false, missing: ["report_assert 的 assert 是空数组（没有断言无从判定）"] };
    }

    // 报告本身读不到时整条不达标：一份没生成出来的量测结果不能当作“数值都对”。
    const data = readJson<unknown>(resolveListFile(root, rel), null);
    if (data === null || typeof data !== "object") {
      return fail(spec, `${rel} 不存在或不是合法 JSON（无从断言实测值）`);
    }

    const bad: string[] = [];
    for (const a of list) {
      const line = checkAssertion(data, a, rel);
      if (line) bad.push(line);
    }
    if (bad.length === 0) return { ok: true, missing: [] };

    const head = typeof spec.msg === "string" && spec.msg ? [spec.msg] : [];
    return { ok: false, missing: [...head, ...bad] };
  },

  file_contains_all: (spec, root) => {
    const rel = String(spec.path ?? "");
    const p = join(root, rel);
    if (!existsSync(p)) return fail(spec, `缺文件：${rel}`);
    const read = readText(p);
    if ("error" in read) return fail(spec, `${rel} ${read.error}`);
    const needRes = strListOrFail(spec, "contains", "file_contains_all.contains");
    if ("error" in needRes) return needRes.error;
    const lack = needRes.list.filter((w) => !read.text.includes(w));
    return lack.length === 0
      ? { ok: true, missing: [] }
      : fail(spec, `${rel} 缺要素：${lack.join("、")}`, lack.length);
  },

  glob_all_contains: (spec, root) => {
    const rel = String(spec.path ?? "");
    const kwRes = strListOrFail(spec, "keywords", "glob_all_contains.keywords");
    if ("error" in kwRes) return kwRes.error;
    const keywords = kwRes.list;
    const dir = join(root, rel);
    let files: string[] = [];
    try {
      files = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => d.name);
    } catch {
      return fail(spec, `目录不存在或为空：${rel}`);
    }
    if (files.length === 0) {
      const tpl = typeof spec.msg_empty === "string" && spec.msg_empty ? spec.msg_empty : "";
      return { ok: false, missing: [tpl || `${rel} 下没有文件`] };
    }
    const bad: string[] = [];
    for (const f of files) {
      const read = readText(join(dir, f));
      if ("error" in read) {
        bad.push(`${f}（${read.error}）`);
        continue;
      }
      if (keywords.some((k) => !read.text.includes(k))) bad.push(f);
    }
    return bad.length === 0
      ? { ok: true, missing: [] }
      : fail(spec, `${bad.length} 个文件缺要素：${bad.slice(0, 5).join("、")}`, bad.length);
  },

  mtime_after_stage: (spec, root) => {
    const rel = String(spec.path ?? "");
    const p = join(root, rel);
    if (!existsSync(p)) return fail(spec, `缺文件：${rel}`);
    const state = readJson<Record<string, unknown> | null>(join(supervisorDir(root), "state.json"), null);

    // 时间基准由具体到宽泛：优先本阶段进入时刻，其次 `created_at`。早于该字段出现的
    // 任务根（或手写的）没有前两者，退到 `created_at` 仍可判定；这种口径偏宽，但比让
    // 门槛因缺字段而永久不达标更接近事实。三者都没有时才报不达标。
    const entered =
      tsOf(state?.stage_entered_at_ts) || tsOf(state?.stage_entered_at) || tsOf(state?.created_at);
    if (!entered) {
      return {
        ok: false,
        missing: [
          `读不到阶段进入时间（state.json 无 stage_entered_at_ts / created_at），无法判定 ${rel} 是否更新过`,
        ],
      };
    }

    let mtime = 0;
    try {
      mtime = statSync(p).mtimeMs / 1000;
    } catch (err) {
      return fail(spec, `读不到 ${rel} 的修改时间（${errCode(err)}）`);
    }
    return mtime >= entered ? { ok: true, missing: [] } : fail(spec, `${rel} 本阶段没更新过`);
  },

  evidence_complete: (spec, root) => {
    const rel = relOf(spec);
    const fieldRes = strListOrFail(spec, "fields", "evidence_complete.fields");
    if ("error" in fieldRes) return fieldRes.error;
    const fields = fieldRes.list.length > 0 ? fieldRes.list : ["baseline", "probe", "diff", "repro"];
    const rows = readJsonl<Record<string, unknown>>(resolveListFile(root, rel));
    if (rows.length === 0) {
      const tpl = typeof spec.msg_empty === "string" && spec.msg_empty ? spec.msg_empty : "";
      return { ok: false, missing: [tpl || `${rel} 是空的，没有可核的证据`] };
    }
    const bad = rows.filter((r) => {
      const ev = (r.evidence ?? {}) as Record<string, unknown>;
      return fields.some((f) => {
        const v = ev[f];
        return v === undefined || v === null || String(v).trim() === "";
      });
    }).length;
    return bad === 0 ? { ok: true, missing: [] } : fail(spec, `${bad} 条结论证据不全`, bad);
  },

  all_of: (spec, root) => {
    const parts = subChecks(spec);
    if (parts.length === 0) return { ok: false, missing: ["all_of 未配置子检查"] };
    const missing: string[] = [];
    for (const part of parts) missing.push(...runCheck(part, root).missing);
    return { ok: missing.length === 0, missing };
  },

  any_of: (spec, root) => {
    const parts = subChecks(spec);
    if (parts.length === 0) return { ok: false, missing: ["any_of 未配置子检查"] };
    const failures: string[] = [];
    for (const part of parts) {
      const r = runCheck(part, root);
      if (r.ok) return { ok: true, missing: [] };
      failures.push(...r.missing);
    }
    return {
      ok: false,
      missing: [`以下条件至少要满足一条：`, ...failures.map((f) => `  · ${f}`)],
    };
  },

  script: (spec) => {
    // 不支持：在 hook 必经路径上执行任意命令会把一次判定变成又一次执行，并与红线判定
    // 判优先级。等价能力由内置检查类型的组合提供。
    const cmd = String(spec.cmd ?? "");
    return { ok: false, missing: [`script 检查未在 TS 版实现（${cmd.slice(0, 60)}），请改用内置检查类型`] };
  },
};

/**
 * 执行一项检查。
 *
 * @param spec 检查声明。空对象或未定义时判为不满足。
 * @param root 任务根路径。
 * @returns 检查结果。检查类型未知时判为不满足，并说明类型名。
 */
export function runCheck(spec: Spec | undefined, root: string): CheckResult {
  if (!spec || Object.keys(spec).length === 0) {
    return { ok: false, missing: ["该阶段没有配置 done 条件（无法判定是否完成）"] };
  }
  const type = String(spec.type ?? "");
  const checker = CHECKS[type];
  if (checker) return checker(spec, root);
  return { ok: false, missing: [`未知检查类型：${type || "(空)"}（无法判定，不等于已满足）`] };
}
