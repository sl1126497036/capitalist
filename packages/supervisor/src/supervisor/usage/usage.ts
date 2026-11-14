/**
 * 用量台账：从工作进程日志读取 token / 成本 / 耗时 / 模型，按进程、派单、阶段三个维度汇总。
 *
 * 无读数的字段为 null，前端显示“未上报”。`contextUsed` 缺失时按会话消息文本估算并标 `context_estimate`，不按日志体积或时长折算。
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

import { resolveContextWindow } from "../../core/guard/limits";
import { listWorkers, readDispatches, type Dispatch, type WorkerRecord } from "../../core/record/supervisor";
import { balanceView, type BalanceView } from "./balance";
import { creditOfSupervisor, creditOfWorker, creditUnit } from "./creditLedger";

/** 计费单位。`token` 表示该模型按 token 计费、宿主不报金额（`total_cost_usd` 为 0）。 */
export type BillingUnit = "token" | "usd" | "credit" | "";

/** 一次运行的用量读数；缺失字段一律为 null。 */
export interface UsageFigures {
  /** 输入 token（`usage.input_tokens`；无 result 时为各次请求之和） */
  input_tokens: number | null;
  /** 输出 token */
  output_tokens: number | null;
  /** 缓存命中读取的 token（`cache_read_input_tokens`） */
  cache_read_tokens: number | null;
  /** 写入缓存的 token（`cache_creation_input_tokens`） */
  cache_write_tokens: number | null;
  /** 输入 + 输出；缓存命中是输入的一部分，不重复加 */
  total_tokens: number | null;
  /** 宿主报的美元成本；`total_cost_usd` 为 0 表示该模型不走美元计价 */
  cost_usd: number | null;
  /** 该次运行的计费方式，前端据此决定显示 金额 / tokens / 积分 */
  billing_unit: BillingUnit;
  /** 积分消耗（积分台账按时间窗摊算；无摊算记录时为 null，界面回落按 token 显示） */
  credit: number | null;
  /** 积分单位；无来源时为空串 */
  credit_unit: string;
  /** 宿主是否按积分计费，属账号级事实；积分读数缺失时界面按“积分未上报”显示，不以 token 代替。 */
  credit_metered: boolean;
  /** 最后一次请求时上下文已用 token（`_meta` 里以 contextUsed 结尾的键） */
  context_used: number | null;
  /** 已用是否为估算值：宿主没有 `contextUsed` 时按本会话消息文本折算 */
  context_estimate: boolean;
  /** 已用是否超过生效上限；为 true 时 `context_used` 已夹到上限 */
  context_over: boolean;
  /** 该模型生效的上下文窗口（宿主读数经默认表校正，见 core/limits 的 resolveContextWindow）。 */
  context_window: number | null;
  /** 运行时长（优先 `result.duration_ms`，否则起止时间差） */
  duration_ms: number | null;
  /** 会话轮数（`result.num_turns`） */
  num_turns: number | null;
  /** 完整模型 id，例如 `deepseek-v4.1-flash` */
  model: string;
  /** 模型版本段（id 去掉厂商前缀），例如 `v4.1-flash`；CLI 只给 id，没有单独构建号 */
  model_version: string;
  /** 开始时刻（工作进程记录的 `started_at`） */
  started_at: string;
  /** 结束时刻（result 时间戳 > 最后一条带时间戳的行 > 派单结单时刻） */
  ended_at: string;
  /** 读数来源：官方汇总 / 日志逐条求和 / 没有 */
  source: "result" | "stream" | "mixed" | "none";
  /** 是否有真实读数 */
  reported: boolean;
  /** 无读数时的原因说明；有读数时为空串。 */
  unavailable_reason: string;
  /** 按模型拆分的 token（`modelUsage` 原样） */
  models: Record<string, ModelUsage>;
}

/** `modelUsage[model]` 的原样投影。字段名照宿主，不改写。 */
export interface ModelUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  /** 宿主原值；生效窗口在 {@link UsageFigures.context_window}，两者不混 */
  context_window: number | null;
  max_output_tokens: number | null;
}

/** 台账的一行：用量 + 身份 + 重派口径。 */
export interface UsageRow extends UsageFigures {
  /** 进程 id / 派单 id / 阶段 id，视维度而定 */
  id: string;
  /** 该行覆盖的运行次数（进程维度恒 1） */
  runs: number;
  /** 其中有真实读数的次数 */
  reported_runs: number;
  /** 其中没有读数的次数 */
  unreported_runs: number;
  /** 进程维度：所属派单；派单/阶段维度为空串 */
  dispatch: string;
  stage: string;
  shard: string;
  /** 派单维度：该单的工作进程 id 列表 */
  workers: string[];
  /** 阶段维度：该阶段的派单数 */
  dispatches: number;
}

export interface UsageLedger {
  at: string;
  /** 计费口径说明，前端与报告共用同一段话 */
  unit: { billing_unit: BillingUnit; credit_unit: string; note: string };
  /** 数据来源与解析规则，随台账一起下发供报告复现。 */
  source: { files: string[]; rules: string[] };
  totals: UsageRow;
  by_worker: UsageRow[];
  by_dispatch: UsageRow[];
  by_stage: UsageRow[];
  balance: BalanceView;
}

/** 宿主快速模型路由别名；日志出现具体模型后改显具体模型，否则按 {@link FAST_MODEL_TARGETS} 标注。 */
export const FAST_MODEL_ALIAS = "fast-model";
/** 别名实际对应的两个模型（宿主在两者之间路由，与监工默认模型的轮换档一致）。 */
export const FAST_MODEL_TARGETS: readonly string[] = ["deepseek-v4.1-flash", "glm-5.3-flash"];

/** 解析规则随 `/api/usage` 下发，供报告引用，与代码保持一致。 */
export const SCAN_RULES: readonly string[] = [
  "R1 assistant 行 = 一次模型请求；同一 message.id 重复出现（流式分片）只算第一次。",
  "R2 有 type=result 行时以它为唯一口径（source=result），usage 字段照抄，不再叠加 assistant 行，避免重复计数。",
  "R3 没有 result（运行中 / 被 kill）时用去重后的 assistant 行求和（source=stream），标为不完整。",
  "R4 日志里没有 usage（纯文本输出或进程在写 result 前死掉）-> source=none，数值全为 null，界面显示“未上报”。",
  "R5 模型取 message.model；版本取 id 的厂商后段（CLI 只给模型 id，没有单独构建号）。",
  "R6 上下文已用优先取 _meta 里以 /contextUsed 结尾的键；宿主没报时按本会话消息文本估算（含工具结果与 thinking，中文 3 字符/token、其余 4 字符/token），估算值标 context_estimate、界面加 ≈；已用一律夹到生效上限，超过时按上限显示并标 context_over。上限取 modelUsage[model].contextWindow，宿主没报或只报 300k 占位值时按模型默认表补（deepseek-v4.1-flash 为 600k），宿主报更大的值时以宿主为准。",
  "R7 时长优先 result.duration_ms；没有则用 started_at->结束时刻，结束时刻取 result 时间戳、最后一条带时间戳的行、派单 done_at 依次回落。",
  "R8 金额取 total_cost_usd；为 0 表示该模型不走美元计价，billing_unit=token，界面按 token 显示。",
  "R9 逐次运行的积分日志里没有：credit 取积分台账（.capitalist/credits.json，把计费接口账号级已用积分的增量按时间窗分摊给窗口内活跃的工作进程；账号级读数含同账号宿主侧对话与监工自身调用）；无活跃进程期间的增量记入 capitalist 独立行（不属于任何工作进程），台账没有该工作进程的摊算记录（面板没开、没拿到快照）时为 null，界面回落按 token 显示，不拿 0 冒充。",
  `R10 模型读数不露路由别名：${FAST_MODEL_ALIAS} 在日志里出现具体模型后改显具体模型，一次都没落时展示层标注它实际对应的两个模型（${FAST_MODEL_TARGETS.join(" / ")}）。`,
];

const CREDIT_UNIT = "积分";
const UNIT_NOTE =
  "token 按宿主 usage 原值显示；账号余额与已用积分来自计费接口，单位是积分；金额只在宿主报出非零 total_cost_usd 时显示。";

/** 一条 assistant 消息去重后的累加。 */
interface AssistAcc {
  /** 已计入的 message.id：流式分片会重复下发同一条消息，累加前必须去重 */
  seen: Set<string>;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  model: string;
  /** 日志里出现过的第一个非别名模型（`fast-model` 只是路由别名，具体模型以后续行为准）。 */
  concreteModel: string;
  contextUsed: number | null;
  contextAt: string;
  /** 本会话所有消息的字符统计，用于无 `contextUsed` 时折算上下文已用；增量扫描只累计新行。 */
  ctxChars: TextTally;
  lastTs: string;
}

/** `type=result` 的官方汇总。 */
interface ResultAcc {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  contextUsed: number | null;
  at: string;
  model: string;
  models: Record<string, ModelUsage>;
}

interface Scan {
  /** 已消费到的文件字节位置（rest 之前的整行都已解析） */
  offset: number;
  /** 末尾半行在下一次追加时接续，使整行可解析。 */
  rest: Buffer;
  size: number;
  assist: AssistAcc;
  result: ResultAcc | null;
  /** 任何一条带 `__timestamp` 的行，用于没有 result 时的结束时刻 */
  lastTs: string;
}

function newAssist(): AssistAcc {
  return {
    seen: new Set(),
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    turns: 0,
    model: "",
    concreteModel: "",
    contextUsed: null,
    contextAt: "",
    ctxChars: newTextTally(),
    lastTs: "",
  };
}

function newScan(): Scan {
  return { offset: 0, rest: Buffer.alloc(0), size: 0, assist: newAssist(), result: null, lastTs: "" };
}

const scans = new Map<string, Scan>();
const SCAN_CACHE_MAX = 512;

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * 会话消息文本的字符统计：无 `contextUsed` 时按中文 3 字符/token、其余 4 字符/token 折算，并标 `context_estimate`。
 *
 * 中文与其余字符分桶统计，不拼接整份日志。
 */
export interface TextTally {
  /** 中文（含中日韩汉字、CJK 标点与全角字符）字符数 */
  cjk: number;
  /** 其余字符数 */
  other: number;
}

export function newTextTally(): TextTally {
  return { cjk: 0, other: 0 };
}

/** 判定字符是否按中文口径计，覆盖汉字扩展区、兼容区、CJK 标点与全角字符。 */
function isCjkCode(c: number): boolean {
  return (
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0x3000 && c <= 0x303f) ||
    (c >= 0xff00 && c <= 0xffef)
  );
}

/** 把一段文本计入统计；非字符串忽略。 */
export function tallyText(acc: TextTally, text: unknown): void {
  if (typeof text !== "string" || !text) return;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (isCjkCode(c)) acc.cjk += 1;
    else acc.other += 1;
  }
}

/** 消息内容里不参与字符统计的元数据键。 */
const TALLY_SKIP_KEYS = new Set(["type", "id", "tool_use_id", "signature", "cache_control"]);

function tallyValue(acc: TextTally, v: unknown, depth: number): void {
  if (depth > 8) return;
  if (typeof v === "string") {
    tallyText(acc, v);
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) tallyValue(acc, item, depth + 1);
    return;
  }
  if (!v || typeof v !== "object") return;
  const rec = v as Record<string, unknown>;
  const type = typeof rec.type === "string" ? rec.type : "";
  /* 文本块只取正文，块类型名不计入。 */
  if (type === "text" || type === "input_text" || type === "output_text") {
    tallyText(acc, rec.text);
    return;
  }
  if (type === "thinking" || type === "reasoning" || type === "reasoning_text") {
    tallyText(acc, rec.thinking ?? rec.text ?? rec.reasoning);
    return;
  }
  for (const [k, item] of Object.entries(rec)) {
    if (TALLY_SKIP_KEYS.has(k)) continue;
    tallyValue(acc, item, depth + 1);
  }
}

/** 把一条消息的 `content` 计入统计；role / model / usage 等元数据不计。 */
export function tallyMessage(acc: TextTally, message: unknown): void {
  if (!message || typeof message !== "object") return;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string" || Array.isArray(content)) tallyValue(acc, content, 0);
}

/** 按统计折算 token：中文 3 字符/token、其余 4 字符/token，向上取整。 */
export function estimateContextTokens(acc: TextTally): number {
  const tokens = acc.cjk / 3 + acc.other / 4;
  return tokens > 0 ? Math.ceil(tokens) : 0;
}

/** 一段文本的估算 token（两段口径与 {@link estimateContextTokens} 相同）。 */
export function estimateTextTokens(text: unknown): number {
  const acc = newTextTally();
  tallyText(acc, text);
  return estimateContextTokens(acc);
}

/** 从模型 id 取版本段：`deepseek-v4.1-flash` -> `v4.1-flash`。 */
export function modelVersion(model: string): string {
  const s = model.trim();
  if (!s) return "";
  const cut = s.search(/[-_/ ]/);
  return cut > 0 ? s.slice(cut + 1) : "";
}

function modelsOf(raw: unknown): Record<string, ModelUsage> {
  const out: Record<string, ModelUsage> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    out[k] = {
      input_tokens: num(r.inputTokens),
      output_tokens: num(r.outputTokens),
      cache_read_tokens: num(r.cacheReadInputTokens),
      cache_write_tokens: num(r.cacheCreationInputTokens),
      context_window: num(r.contextWindow),
      max_output_tokens: num(r.maxOutputTokens),
    };
  }
  return out;
}

/** 按后缀 `/contextUsed` 匹配 `_meta` 中的上下文读数，不绑定厂商前缀。 */
function contextUsedOf(meta: unknown): number | null {
  if (!meta || typeof meta !== "object") return null;
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    if (k.endsWith("/contextUsed")) return num(v);
  }
  return null;
}

/** 解析一行 stream-json；先按子串筛选再 JSON.parse，跳过无关行。 */
function consumeLine(line: string, scan: Scan): void {
  if (line.length < 8 || line.charCodeAt(0) !== 0x7b) return;
  const interesting =
    line.includes('"usage"') ||
    line.includes('"modelUsage"') ||
    line.includes("/contextUsed") ||
    line.includes('"type":"assistant"') ||
    line.includes('"type":"user"') ||
    line.includes('"__timestamp"');
  if (!interesting) return;
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return;
    o = parsed as Record<string, unknown>;
  } catch {
    return;
  }

  const ts = str(o.__timestamp);
  if (ts) scan.lastTs = ts;

  const type = str(o.type);
  if (type === "assistant") {
    const msg = o.message;
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    /* 上下文估算按消息正文累计，与 usage 是否可读无关。 */
    tallyMessage(scan.assist.ctxChars, m);
    const id = str(m.id);
    const model = str(m.model);
    if (model) {
      scan.assist.model = model;
      if (model !== FAST_MODEL_ALIAS && !scan.assist.concreteModel) scan.assist.concreteModel = model;
    }
    const used = contextUsedOf(o._meta);
    if (used !== null && ts >= scan.assist.contextAt) {
      scan.assist.contextUsed = used;
      scan.assist.contextAt = ts;
    }
    const u = m.usage;
    if (!u || typeof u !== "object") return;
    // R1：同一条消息的流式分片只算一次。
    if (id) {
      if (scan.assist.seen.has(id)) return;
      scan.assist.seen.add(id);
    }
    const uu = u as Record<string, unknown>;
    scan.assist.input += num(uu.input_tokens) ?? 0;
    scan.assist.output += num(uu.output_tokens) ?? 0;
    scan.assist.cacheRead += num(uu.cache_read_input_tokens) ?? 0;
    const cw = num(uu.cache_creation_input_tokens) ?? 0;
    scan.assist.cacheWrite += cw;
    scan.assist.turns += 1;
    return;
  }

  /* `type=user` 的 `content` 含工具输出，计入上下文估算。 */
  if (type === "user") {
    const msg = o.message;
    if (msg && typeof msg === "object") tallyMessage(scan.assist.ctxChars, msg);
    return;
  }

  if (type !== "result") return;
  const u = o.usage;
  const uu = u && typeof u === "object" ? (u as Record<string, unknown>) : {};
  const models = modelsOf(o.modelUsage);
  const model = Object.keys(models)[0] ?? scan.assist.model;
  const meta = o._meta;
  const ctx = contextUsedOf(meta);
  // R2：出现 result 行时以它为唯一口径。
  scan.result = {
    input: num(uu.input_tokens) ?? 0,
    output: num(uu.output_tokens) ?? 0,
    cacheRead: num(uu.cache_read_input_tokens) ?? 0,
    cacheWrite: num(uu.cache_creation_input_tokens) ?? 0,
    costUsd: num(o.total_cost_usd),
    durationMs: num(o.duration_ms),
    numTurns: num(o.num_turns),
    contextUsed: ctx,
    at: ts || scan.assist.contextAt,
    model,
    models,
  };
}

/** 仅当末尾残行可完整解析时才消费；半行留待下一次追加，不遗漏数据、不重复计。 */
function consumeTail(scan: Scan): void {
  const tail = scan.rest.toString("utf8").trim();
  if (!tail.startsWith("{") || !tail.endsWith("}")) return;
  try {
    JSON.parse(tail);
  } catch {
    return;
  }
  consumeLine(tail, scan);
  scan.rest = Buffer.alloc(0);
}

/** 增量读日志：只解析新追加的整行，缓存按文件路径留存。 */function scanLog(file: string): Scan | null {
  /*
   * 这里直接 stat，不走缓存：日志由工作进程在另一个进程里追加，
   * 缓存住文件大小会让“刚写的行”读不到，表现为用量长时间不涨。
   * 单次 stat 的成本已经在扫描增量里摊掉了。
   */
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return null;
  }
  let scan = scans.get(file);
  // 文件被截断或路径变化时重新扫描，不沿用旧累加值。
  if (!scan || size < scan.offset) {
    scan = newScan();
    scans.set(file, scan);
    if (scans.size > SCAN_CACHE_MAX) scans.clear();
  }
  if (size === scan.offset && scan.rest.length === 0) return scan;

  let handle: number | null = null;
  try {
    handle = openSync(file, "r");
    const buf = Buffer.alloc(Math.max(0, size - scan.offset));
    let read = 0;
    try {
      read = buf.length > 0 ? readSync(handle, buf, 0, buf.length, scan.offset) : 0;
    } finally {
      closeSync(handle);
      handle = null;
    }
    scan.offset += read;
    const merged = scan.rest.length ? Buffer.concat([scan.rest, buf.subarray(0, read)]) : buf.subarray(0, read);
    const nl = merged.lastIndexOf(0x0a);
    if (nl < 0) {
      scan.rest = Buffer.from(merged);
      consumeTail(scan);
      return scan;
    }
    const text = merged.subarray(0, nl).toString("utf8");
    scan.rest = Buffer.from(merged.subarray(nl + 1));
    for (const line of text.split("\n")) consumeLine(line, scan);
    consumeTail(scan);
    return scan;
  } catch {
    if (handle !== null) {
      try {
        closeSync(handle);
      } catch {
        /* 已经关掉了 */
      }
    }
    return scan;
  }
}

/** 无读数时的固定说明，写明缺失来源。 */
export const NO_USAGE_REASON =
  "未上报：该进程日志里没有 stream-json 的 usage 行（宿主以纯文本输出，或进程在写 result 前被杀），不按日志体积或时长折算";

function emptyFigures(startedAt: string, endedAt: string, model: string, reason: string): UsageFigures {
  return {
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    total_tokens: null,
    cost_usd: null,
    billing_unit: "",
    credit: null,
    credit_unit: "",
    credit_metered: false,
    context_used: null,
    context_estimate: false,
    context_over: false,
    context_window: null,
    duration_ms: null,
    num_turns: null,
    model,
    model_version: modelVersion(model),
    started_at: startedAt,
    ended_at: endedAt,
    source: "none",
    reported: false,
    unavailable_reason: reason,
    models: {},
  };
}

/** 排队中的派单尚无读数，字段全为 null。 */
export function noUsage(startedAt = "", model = ""): UsageFigures {
  return emptyFigures(startedAt, "", model, NO_USAGE_REASON);
}

function atSec(s: string): number {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t / 1000 : 0;
}

/** 一个工作进程的用量读数；给 root 时一并带出积分摊算。 */
export function workerUsage(w: WorkerRecord, dispatches: readonly Dispatch[] = [], root = ""): UsageFigures {
  const scan = w.log ? scanLog(w.log) : null;
  const d = w.dispatch ? dispatches.find((x) => x.id === w.dispatch) : undefined;
  const doneAt = d?.done_at ? String(d.done_at) : "";
  const startedAt = str(w.started_at);
  const res = scan?.result ?? null;
  const assist = scan?.assist;
  const rawModel = res?.model || assist?.model || "";
  /* 日志里出现过具体模型时，不显示路由别名。 */
  const model =
    rawModel === FAST_MODEL_ALIAS && assist?.concreteModel ? assist.concreteModel : rawModel;
  const endedAt = res?.at || scan?.lastTs || doneAt || "";
  /* 积分取账号级台账，与日志是否可读无关：日志被清理后已有摊算记录仍要显示。 */
  const credit = root ? creditOfWorker(root, w.id) : null;
  const creditUnitStr = root ? creditUnit(root) : "";

  // R4：既没有 result，也没有任何 usage 行与可估算的消息文本。
  if (!res && (!assist || (assist.turns === 0 && estimateContextTokens(assist.ctxChars) === 0))) {
    const end = endedAt || str(w.heartbeat_at);
    const figs = emptyFigures(startedAt, end, model, NO_USAGE_REASON);
    figs.duration_ms = durationFrom(startedAt, end, null);
    if (credit !== null) {
      figs.credit = credit;
      figs.credit_unit = creditUnitStr || "积分";
      figs.billing_unit = "credit";
      figs.credit_metered = creditUnitStr !== "";
    }
    return figs;
  }

  const input = res ? res.input : (assist?.input ?? 0);
  const output = res ? res.output : (assist?.output ?? 0);
  const cacheRead = res ? res.cacheRead : (assist?.cacheRead ?? 0);
  const cacheWrite = res ? res.cacheWrite : (assist?.cacheWrite ?? 0);
  const costUsd = res?.costUsd ?? null;
  /* 无摊算读数时 `credit` 为 null，维持 token 口径。 */
  /* 上下文已用优先取 `_meta` 读数；`result` 的 usage 为整轮累计值，不作为占用。无读数时按会话文本估算并标 `context_estimate`。 */
  const hostCtx = res?.contextUsed ?? assist?.contextUsed ?? null;
  const estimated = hostCtx === null && assist ? estimateContextTokens(assist.ctxChars) : 0;
  const rawCtx = hostCtx ?? (estimated > 0 ? estimated : null);
  const models = res?.models ?? {};
  /* 窗口按展示模型校正；`modelUsage` 的别名键可能只有 300k 占位值，不按它压低真实窗口。 */
  const hostWin = model ? (models[model]?.context_window ?? firstWindow(models)) : firstWindow(models);
  const win = resolveContextWindow(model, hostWin);
  /* 已用一律夹到生效上限，超过时保留 `context_over` 标记。 */
  const over = rawCtx !== null && win !== null && win > 0 && rawCtx > win;
  const ctxUsed = rawCtx !== null && win !== null && win > 0 ? Math.min(rawCtx, win) : rawCtx;

  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    total_tokens: input + output,
    cost_usd: costUsd,
    // R8：金额为 0 / 缺失 -> 不走美元计价；有积分摊算读数 -> 按积分计费。
    billing_unit: credit !== null ? "credit" : costUsd !== null && costUsd > 0 ? "usd" : "token",
    credit,
    credit_unit: credit !== null ? creditUnitStr || "积分" : "",
    credit_metered: creditUnitStr !== "",
    context_used: ctxUsed,
    context_estimate: hostCtx === null && ctxUsed !== null,
    context_over: over,
    context_window: win,
    duration_ms: durationFrom(startedAt, endedAt, res?.durationMs ?? null),
    num_turns: res?.numTurns ?? assist?.turns ?? null,
    model,
    model_version: modelVersion(model),
    started_at: startedAt,
    ended_at: endedAt,
    source: res ? "result" : "stream",
    /* 有 assistant 行不等于有读数：usage 未落盘时按“未上报”处理，不记为 0。 */
    ...(input + output + cacheRead + cacheWrite > 0 || res
      ? { reported: true, unavailable_reason: "" }
      : {
          reported: false,
          unavailable_reason: "日志里还没有 token 读数（worker 刚启动，宿主还没写过 usage）",
        }),
    models,
  };
}

/** 取第一条带窗口的宿主读数，按条目自身的模型名校正后返回；别名键的占位值会压低具体模型窗口。 */
function firstWindow(models: Record<string, ModelUsage>): number | null {
  for (const [m, u] of Object.entries(models)) {
    if (u.context_window !== null) return resolveContextWindow(m, u.context_window);
  }
  return null;
}

/** 时长：官方毫秒优先；否则起止时间差；两者都拿不到为 null（不写 0）。 */
function durationFrom(startedAt: string, endedAt: string, fromResult: number | null): number | null {
  if (fromResult !== null && fromResult >= 0) return Math.round(fromResult);
  const a = atSec(startedAt);
  const b = atSec(endedAt);
  if (a > 0 && b > a) return Math.round((b - a) * 1000);
  return null;
}

function sumOrNull(values: Array<number | null>): number | null {
  let sum = 0;
  let hit = 0;
  for (const v of values) {
    if (v === null) continue;
    sum += v;
    hit++;
  }
  return hit > 0 ? sum : null;
}

/** 取出现次数最多的非空字符串；全空返回空串。 */
function dominant(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best = "";
  let n = 0;
  for (const [k, c] of counts) {
    if (c > n) {
      best = k;
      n = c;
    }
  }
  return best;
}

/** 把多行合成一行：数值求和，模型取出现次数最多者，来源取最弱一档。 */
function combine(id: string, rows: readonly UsageRow[]): UsageRow {
  const reported = rows.filter((r) => r.reported);
  const source: UsageFigures["source"] =
    reported.length === 0
      ? "none"
      : reported.every((r) => r.source === "result")
        ? "result"
        : reported.every((r) => r.source === "stream")
          ? "stream"
          : "mixed";
  const models: Record<string, ModelUsage> = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.models)) {
      const cur = models[k];
      if (!cur) {
        models[k] = { ...v };
        continue;
      }
      cur.input_tokens = sumOrNull([cur.input_tokens, v.input_tokens]);
      cur.output_tokens = sumOrNull([cur.output_tokens, v.output_tokens]);
      cur.cache_read_tokens = sumOrNull([cur.cache_read_tokens, v.cache_read_tokens]);
      cur.cache_write_tokens = sumOrNull([cur.cache_write_tokens, v.cache_write_tokens]);
      cur.context_window = cur.context_window ?? v.context_window;
      cur.max_output_tokens = cur.max_output_tokens ?? v.max_output_tokens;
    }
  }
  const model = dominant(rows.map((r) => r.model));
  const starts = rows.map((r) => r.started_at).filter(Boolean).sort();
  const ends = rows.map((r) => r.ended_at).filter(Boolean).sort();
  const input = sumOrNull(rows.map((r) => r.input_tokens));
  const output = sumOrNull(rows.map((r) => r.output_tokens));
  const cost = sumOrNull(rows.map((r) => r.cost_usd));
  const credit = sumOrNull(rows.map((r) => r.credit));
  const creditUnitStr = rows.map((r) => r.credit_unit).find(Boolean) ?? "";
  return {
    id,
    runs: rows.reduce((n, r) => n + r.runs, 0),
    reported_runs: rows.reduce((n, r) => n + r.reported_runs, 0),
    unreported_runs: rows.reduce((n, r) => n + r.unreported_runs, 0),
    dispatch: "",
    stage: dominant(rows.map((r) => r.stage)),
    shard: dominant(rows.map((r) => r.shard)),
    workers: rows.flatMap((r) => (r.workers.length ? r.workers : [r.id])),
    dispatches: new Set(rows.map((r) => r.dispatch).filter(Boolean)).size,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: sumOrNull(rows.map((r) => r.cache_read_tokens)),
    cache_write_tokens: sumOrNull(rows.map((r) => r.cache_write_tokens)),
    total_tokens: input !== null && output !== null ? input + output : null,
    cost_usd: cost,
    billing_unit: credit !== null ? "credit" : cost !== null && cost > 0 ? "usd" : input !== null ? "token" : "",
    credit,
    credit_unit: credit !== null ? creditUnitStr || "积分" : "",
    credit_metered: rows.some((r) => r.credit_metered),
    context_used: reported.length ? maxOrNull(reported.map((r) => r.context_used)) : null,
    /* 汇总行只要有一条估算或超限即标出，不因合并丢弃口径。 */
    context_estimate: reported.some((r) => r.context_estimate),
    context_over: reported.some((r) => r.context_over),
    context_window: maxOrNull(rows.map((r) => r.context_window)),
    duration_ms: sumOrNull(rows.map((r) => r.duration_ms)),
    num_turns: sumOrNull(rows.map((r) => r.num_turns)),
    model,
    model_version: modelVersion(model),
    started_at: starts[0] ?? "",
    ended_at: ends[ends.length - 1] ?? "",
    source,
    reported: reported.length > 0,
    unavailable_reason: reported.length > 0 ? "" : NO_USAGE_REASON,
    models,
  };
}

/** 上下文已用取最大值；同一任务根下并行线程取最满的一条。 */
function maxOrNull(values: Array<number | null>): number | null {
  let best: number | null = null;
  for (const v of values) {
    if (v === null) continue;
    if (best === null || v > best) best = v;
  }
  return best;
}

/** 进程维度的行。 */
export function workerUsageRow(w: WorkerRecord, dispatches: readonly Dispatch[] = [], root = ""): UsageRow {
  const figs = workerUsage(w, dispatches, root);
  return {
    ...figs,
    id: w.id,
    runs: 1,
    reported_runs: figs.reported ? 1 : 0,
    unreported_runs: figs.reported ? 0 : 1,
    dispatch: str(w.dispatch),
    stage: str(w.stage),
    shard: str(w.shard ?? ""),
    workers: [w.id],
    dispatches: 1,
  };
}

/** 全部进程的用量行；排队中的派单无用量可读，不生成零值行。 */
export function collectWorkerUsage(root: string): UsageRow[] {
  const dispatches = readDispatches(root);
  return listWorkers(root).map((w) => workerUsageRow(w, dispatches, root));
}

/** 非工作进程消耗（无活跃进程期间的账号增量）单列一行，计入合计。 */
function supervisorUsageRow(root: string): UsageRow | null {
  const credit = creditOfSupervisor(root);
  if (credit === null) return null;
  const unit = creditUnit(root) || "积分";
  return {
    ...emptyFigures("", "", "", ""),
    id: "capitalist",
    runs: 1,
    reported_runs: 1,
    unreported_runs: 0,
    dispatch: "",
    stage: "",
    shard: "",
    workers: ["capitalist"],
    dispatches: 1,
    /* 这一行只有积分读数，没有日志可解析 token；按有读数处理，避免界面判成“未上报”。 */
    reported: true,
    credit,
    credit_unit: unit,
    billing_unit: "credit",
    credit_metered: true,
  };
}

/** 构建用量台账：三个维度、合计与余额；各行按用量降序，读数为 null 的排最后。 */
export function buildUsageLedger(root: string): UsageLedger {
  const workers = collectWorkerUsage(root);
  /* 非工作进程消耗桶不进派单/阶段维度，只在进程维度列出并计入合计。 */
  const supervisorRow = supervisorUsageRow(root);
  const allRows = supervisorRow ? [...workers, supervisorRow] : workers;

  const byDispatch = new Map<string, UsageRow[]>();
  for (const r of workers) {
    const key = r.dispatch || `shard:${r.shard}`;
    const list = byDispatch.get(key);
    if (list) list.push(r);
    else byDispatch.set(key, [r]);
  }
  const dispatchRows = [...byDispatch.entries()].map(([id, rows]) => {
    const row = combine(id, rows);
    return { ...row, id, dispatch: id, stage: dominant(rows.map((r) => r.stage)), shard: dominant(rows.map((r) => r.shard)) };
  });

  const byStage = new Map<string, UsageRow[]>();
  for (const r of workers) {
    const key = r.stage || "(未知阶段)";
    const list = byStage.get(key);
    if (list) list.push(r);
    else byStage.set(key, [r]);
  }
  const stageRows = [...byStage.entries()].map(([id, rows]) => ({
    ...combine(id, rows),
    id,
    dispatch: "",
    stage: id,
    dispatches: new Set(rows.map((r) => r.dispatch).filter(Boolean)).size,
  }));

  const totals: UsageRow = {
    ...combine("total", allRows),
    id: "total",
    dispatch: "",
  };

  const sortRows = (rows: UsageRow[]): UsageRow[] =>
    rows.sort((a, b) => (b.total_tokens ?? -1) - (a.total_tokens ?? -1) || a.id.localeCompare(b.id));

  return {
    at: new Date().toISOString(),
    unit: { billing_unit: "token", credit_unit: CREDIT_UNIT, note: UNIT_NOTE },
    source: {
      files: [
        ".capitalist/workers/<id>.log（stream-json：type=assistant 的 message.usage、type=result 的汇总）",
        ".capitalist/workers/<id>.json（started_at / dispatch / stage / shard）",
        ".capitalist/inbox/dispatch.jsonl（派单 model 与 done_at）",
        "宿主登录态 + POST /v2/billing/meter/get-user-resource（余额与已用积分）",
      ],
      rules: [...SCAN_RULES],
    },
    totals,
    by_worker: sortRows(allRows),
    by_dispatch: sortRows(dispatchRows),
    by_stage: sortRows(stageRows),
    balance: balanceView(root),
  };
}

/**
 * 顶栏上下文取当前运行工作进程中最满的一条，无运行进程时回退到最近一次运行。
 *
 * 监工为 node 进程，不调用模型，无 token 上下文；该读数属于工作进程。
 */
export interface ContextView {
  used: number | null;
  window: number | null;
  /** 已用是否为估算值（界面加 `≈`） */
  estimate: boolean;
  /** 已用是否超过生效上限（`used` 已夹到 `window`） */
  over: boolean;
  model: string;
  model_version: string;
  worker: string;
  at: string;
  reason: string;
}

export function buildContextView(root: string): ContextView {
  const workers = listWorkers(root);
  const rowsOf = (pool: readonly WorkerRecord[]): UsageRow[] =>
    pool
      .map((w) => workerUsageRow(w))
      .filter((r) => r.context_used !== null)
      .sort((a, b) => (b.context_used ?? 0) - (a.context_used ?? 0));
  /* 优先取运行中进程；其尚无读数时回退到全部历史进程。 */
  const live = workers.filter((w) => w.status === "running" || w.status === "starting");
  const rows = rowsOf(live).length ? rowsOf(live) : rowsOf(workers);
  const top = rows[0];
  /* 运行中日志不含 `modelUsage.contextWindow` 时，从同模型的其它读数取窗口；取不到则留 null。 */
  const windowOf = (model: string): number | null => {
    if (!model) return null;
    for (const r of [...rows, ...rowsOf(workers)]) {
      if (r.model === model && r.context_window !== null) return r.context_window;
    }
    return null;
  };
  if (!top) {
    return {
      used: null,
      window: null,
      estimate: false,
      over: false,
      model: "",
      model_version: "",
      worker: "",
      at: "",
      reason: "未上报：日志里没有 contextUsed 读数，也没有可估算的会话消息",
    };
  }
  const win = top.context_window ?? windowOf(top.model);
  /* 窗口取自其它行时，按该分母重新夹取已用。 */
  const rawUsed = top.context_used;
  const over = top.context_over || (rawUsed !== null && win !== null && win > 0 && rawUsed > win);
  const used = rawUsed !== null && win !== null && win > 0 ? Math.min(rawUsed, win) : rawUsed;
  return {
    used,
    window: win,
    estimate: top.context_estimate,
    over,
    model: top.model,
    model_version: top.model_version,
    worker: top.id,
    at: top.ended_at || top.started_at,
    reason: "",
  };
}

/** 测试与诊断用：清空扫描缓存。 */
export function __resetUsageCache(): void {
  scans.clear();
}
