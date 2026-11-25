/**
 * 守卫加载与红线判定。
 *
 * `evaluate()` 与归档的 Python 实现 `Policy.gate()`
 * （`_archive/python-engine/supervisor/scripts/capitalist.py`）判定结果必须一致。两套实现读同一份
 * 守卫文件，判定分叉会使“换一套实现复现问题”失去意义。
 *
 * 对齐点：`requires: "url"` 前置条件、大小写不敏感的 `skip_if`、命中片段前后各取 30 字符、
 * 带 `defer` 的命中不参与严重度计算、严重度次序 BLOCK > NEED_USER > WARN。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { readJson, writeJson } from "../record/json";
import { recordEvent } from "../record/ledger";
import { config as configLoc, locks as locksLoc } from "../record/locations";
import { pidAlive } from "../record/supervisor";
import type { PolicyData, GateResult, LocalGuardConfig, Redline, RedlineHit } from "../types";

/**
 * 守卫文件的文件名约定：`<名>.policy.json`。上一版的后缀 `<名>.contract.json` 仍被识别，
 * 迁移会把已知文件改名；兼容留着是为了漏网的文件（外部脚本生成的、别处拷来的）
 * 不至于让任务根起不来。
 *
 * 恰名为 `policy.json` / `contract.json` 的文件也按守卫对待，由 {@link collectPolicies}
 * 单独判断：该名不带前缀，无法与上面的后缀规则共用一个正则。
 */
const POLICY_BASENAME = /\.(policy|contract)\.json$/i;
/** 恰好叫这两个名字的文件也是守卫（无前缀形态）。 */
const BARE_POLICY_NAMES = new Set(["policy.json", "contract.json"]);

/**
 * 解析后的守卫，判定层只依赖这个结构，不再回读原始 JSON。
 *
 * `localGuard` 缺省为空对象，此时本机边界不设限；`failedRedlines` 非空表示有红线未生效，
 * 调用方应把它报给用户，不能当作“规则齐备”。
 */
export interface Policy {
  data: PolicyData;
  file: string;
  name: string;
  domain: string;
  redlines: Redline[];
  localGuard: LocalGuardConfig;
  /** 编译好的正则，按红线 id 索引。 */
  compiled: Map<string, RegExp>;
  /**
   * 编译失败的红线 id。这些红线不生效，记录在此供调用方上报，
   * 避免规则缺失而无从察觉。
   */
  failedRedlines: string[];
}

/** 红线级别的严格度排序，用于“多条命中取最严”。 */
const LEVEL_RANK: Record<string, number> = { BLOCK: 3, NEED_USER: 2, WARN: 1 };

/** 本包自带的守卫目录：从 `dist/core/policy` 上跳三级到包根，再进 `policies/`。 */
function packagePoliciesDir(): string | undefined {
  const dir = resolve(__dirname, "..", "..", "..", "policies");
  return existsSync(dir) ? dir : undefined;
}

/**
 * 递归收集守卫文件。深度上限 3 层，跳过 `node_modules`、`.git` 与以 `.` 开头的目录。
 *
 * @returns 收集到的守卫文件绝对路径。目录不可读时返回空数组。
 */
function collectPolicies(dir: string, depth = 3): string[] {
  const out: string[] = [];
  if (depth <= 0 || !existsSync(dir)) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git" || name.startsWith(".")) continue;
    const full = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      out.push(...collectPolicies(full, depth - 1));
    } else if (POLICY_BASENAME.test(name) || BARE_POLICY_NAMES.has(basename(name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 按优先级产出守卫文件路径：本包自带的守卫在前，随后是调用方传入的目录
 * （宿主的 `skills/` 目录，由 `host/locations.ts` 解析）。用户安装的领域守卫因此不会
 * 因同名而遮蔽本包自带的守卫。
 *
 * 搜索目录由调用方传入，不在本模块内查找：宿主配置目录名属于宿主层的信息。
 *
 * @param searchDirs 额外的搜索目录。
 * @returns 守卫文件绝对路径，本包自带的在前，调用方目录按传入顺序在后；同一文件可能
 *   在两组目录里各出现一次，调用方需自行按需去重。
 */
export function* iterPolicies(searchDirs: readonly string[] = []): Generator<string> {
  const pkg = packagePoliciesDir();
  if (pkg) yield* collectPolicies(pkg);
  for (const base of searchDirs) {
    yield* collectPolicies(base);
  }
}

/**
 * 把守卫里的正则转成 JS RegExp。
 *
 * 守卫来自 Python 生态，可能带 `(?i)` 这类行内标志。JS 不接受该语法，直接
 * `new RegExp(pattern)` 会抛错；而静默忽略异常、跳过该条规则会让红线静默失效，
 * 调用方无从区分“规则没生效”与“没有规则”。因此失败一律返回 null，由上层计入
 * {@link Policy.failedRedlines} 并上报。
 *
 * 行内标志被剥离并翻译为 JS 标志。没有 JS 对应项的标志（`x`，详细模式）无法翻译，
 * 这类情况记为编译失败，由调用方上报。
 *
 * @returns 编译成功返回正则；行内标志无法翻译或正则本身非法时返回 null。
 */
function compilePattern(pattern: string, ignoreCase?: boolean): RegExp | null {
  let src = pattern;
  const flags = new Set<string>();
  if (ignoreCase) flags.add("i");

  const inline = /^\(\?([imsx]+)\)/.exec(src);
  if (inline) {
    const raw = inline[1] ?? "";
    if (raw.includes("i")) flags.add("i");
    if (raw.includes("m")) flags.add("m");
    if (raw.includes("s")) flags.add("s");
    if (raw.includes("x")) return null; // JS 无详细模式，无法等价翻译
    src = src.slice(inline[0].length);
  }

  try {
    return new RegExp(src, [...flags].join(""));
  } catch {
    return null;
  }
}

/**
 * 编译全部红线的正则。
 *
 * @returns 编译成功的 id -> 正则映射，以及编译失败的 id 列表。
 */
function compileRedlines(redlines: Redline[]): { map: Map<string, RegExp>; failed: string[] } {
  const map = new Map<string, RegExp>();
  const failed: string[] = [];
  for (const r of redlines) {
    if (!r.id || typeof r.pattern !== "string") continue;
    const rx = compilePattern(r.pattern, r.ignore_case);
    if (rx) map.set(r.id, rx);
    else failed.push(r.id);
  }
  return { map, failed };
}

/**
 * 守卫原始数据转成 {@link Policy}。
 *
 * 缺 `name` 时取文件所在目录名，`redlines` 不是数组时按空数组处理。
 */
function toPolicy(data: PolicyData, file: string): Policy {
  const redlines = Array.isArray(data.redlines) ? data.redlines : [];
  const { map, failed } = compileRedlines(redlines);
  return {
    data,
    file,
    name: typeof data.name === "string" && data.name ? data.name : basename(dirname(file)),
    domain: typeof data.domain === "string" ? data.domain : "",
    redlines,
    localGuard: (data.local_guard ?? {}) as LocalGuardConfig,
    compiled: map,
    failedRedlines: failed,
  };
}

/**
 * 可用守卫名清单，按字典序返回。供报错时列出可选项。
 *
 * @param searchDirs 额外的搜索目录，含义同 {@link iterPolicies}。
 */
export function policyNames(searchDirs: readonly string[] = []): string[] {
  const names = new Set<string>();
  for (const file of iterPolicies(searchDirs)) {
    const d = readJson<PolicyData | null>(file, null);
    if (!d) continue;
    names.add(d.name || basename(dirname(file)));
  }
  return [...names].sort();
}

/**
 * 该串是否按“文件路径”对待（而不是守卫名）：任意 `.json` 后缀。
 *
 * 路径形态的 spec 直接当文件读；其余按守卫名 / 末级目录名在搜索目录里找。
 */
function looksLikePath(spec: string): boolean {
  return /\.json$/i.test(spec);
}

/**
 * 按名字或路径定位守卫文件，不读内容。
 *
 * 路径形态原样返回（读不到由调用方给出针对性报错），名字形态遍历
 * {@link iterPolicies} 匹配 `name` 或所在目录名。`loadPolicy` 与
 * `readPolicyFile` 共用这一份解析，避免两处各自实现后在“同名守卫谁优先”
 * 上给出不同结论。
 */
function locatePolicy(spec: string, searchDirs: readonly string[]): string | null {
  const s = String(spec ?? "").trim();
  if (!s) return null;
  if (looksLikePath(s)) return s;

  const wanted = s.toLowerCase();
  for (const file of iterPolicies(searchDirs)) {
    const d = readJson<PolicyData | null>(file, null);
    if (!d) continue;
    const byName = String(d.name ?? "").toLowerCase();
    const byDir = basename(dirname(file)).toLowerCase();
    if (byName === wanted || byDir === wanted) return file;
  }
  return null;
}

/**
 * 按名字或路径加载守卫。
 *
 * @param spec 守卫名、文件路径，或 `minimal`（通用默认守卫）
 * @param searchDirs 额外的搜索目录（宿主 skills/ 等），由顶层传入
 * @returns 找不到或读不出（文件不存在、JSON 损坏）返回 null，由调用方决定是报错还是改用默认
 */
export function loadPolicy(spec: string, searchDirs: readonly string[] = []): Policy | null {
  const file = locatePolicy(spec, searchDirs);
  if (!file) return null;
  const d = readJson<PolicyData | null>(file, null);
  return d ? toPolicy(d, file) : null;
}


/** 守卫元信息：用于 policy_reload 事件的前后对比。 */
export interface PolicyMeta {
  redlineCount: number;
}

/** reloadPolicy 的返回：包含上一份（prev）与这一份（next）的元信息。 */
export interface HotPolicy {
  policy: Policy;
  file: string;
  mtimeMs: number;
  hash: string;
  /** 与 prev 相比是否发生变化（mtime 或内容哈希任一不同即算变）。 */
  changed: boolean;
  /** 解析失败时存在：说明沿用了上一份可用守卫。 */
  error?: string;
  prev?: PolicyMeta | undefined;
  next?: PolicyMeta | undefined;
}

/** FNV-1a 内容哈希：用于判重，比整段比对便宜，且对内容变化敏感。 */
function hashContent(raw: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < raw.length; i += 1) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${h.toString(16)}:${raw.length}`;
}

function metaOf(policy: Policy): PolicyMeta {
  return { redlineCount: policy.redlines.length };
}

/**
 * 守卫文件的读盘与解析结果。`ok` 为 false 时 `error` 给出可展示的原因。
 */
export type PolicySource =
  | { ok: true; file: string; raw: string; policy: Policy; mtimeMs: number }
  | { ok: false; error: string };

/**
 * 解析守卫文件。读盘与 JSON 解析分两步返回错误，使调用方能在热加载时保留上一份可用守卫，
 * 而不是抛错中断监工循环。
 *
 * @param spec 守卫名或文件路径。
 * @param searchDirs 额外的搜索目录，含义同 {@link iterPolicies}。
 * @returns 成功时给出守卫与原文；定位不到、读不出或 JSON 损坏时返回 `ok: false` 与原因。
 */
export function readPolicyFile(spec: string, searchDirs: readonly string[] = []): PolicySource {
  const file = locatePolicy(spec, searchDirs);
  if (!file) {
    return {
      ok: false,
      error: looksLikePath(String(spec ?? "").trim())
        ? `读不到守卫文件：${String(spec ?? "").trim()}`
        : `找不到守卫：${spec}`,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    return { ok: false, error: `读不到守卫文件：${file}${code ? `（${code}）` : ""}` };
  }

  let data: PolicyData;
  try {
    data = JSON.parse(raw) as PolicyData;
  } catch (e) {
    return { ok: false, error: `守卫 JSON 解析失败：${String((e as Error).message ?? e)}` };
  }

  let mtimeMs = 0;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  return { ok: true, file, raw, policy: toPolicy(data, file), mtimeMs };
}

/**
 * 每轮调度调用：重读守卫，按 mtime 与内容哈希判变化。
 *
 * 解析失败且 `prev` 存在时，沿用上一份守卫并回报 `error`，不中断调度；
 * 首读就失败（无 `prev`）则抛错，由调用方决定退出还是改用默认。
 *
 * @param prev 上一份守卫的定位信息与哈希，用于比对。
 * @param fallbackFile 按名定位失败时改读的文件（`capitalist adopt` 记下的绝对路径）。
 * @throws 首读即解析失败时抛出。
 */
export function reloadPolicy(
  spec: string,
  searchDirs: readonly string[] = [],
  prev?: { file: string; mtimeMs: number; hash: string; policy: Policy },
  fallbackFile?: string,
): HotPolicy {
  let res = readPolicyFile(spec, searchDirs);
  /* 守卫文件不一定在宿主 skills 目录下（比如 adopt 时给的是任务根外的路径），
     按名搜不到就退回 adopt 记下的绝对路径，避免每轮调度重复报解析失败。 */
  if (!res.ok && fallbackFile) {
    const byPath = readPolicyFile(fallbackFile, []);
    if (byPath.ok) res = byPath;
  }
  if (!res.ok) {
    if (prev) {
      return {
        policy: prev.policy,
        file: prev.file,
        mtimeMs: prev.mtimeMs,
        hash: prev.hash,
        changed: false,
        error: res.error,
        prev: undefined,
        next: undefined,
      };
    }
    throw new Error(res.error);
  }
  const hash = hashContent(res.raw);
  const changed =
    !prev || prev.file !== res.file || prev.mtimeMs !== res.mtimeMs || prev.hash !== hash;
  return {
    policy: res.policy,
    file: res.file,
    mtimeMs: res.mtimeMs,
    hash,
    changed,
    prev: prev ? metaOf(prev.policy) : undefined,
    next: metaOf(res.policy),
  };
}


/**
 * 列出被放宽的红线：被删除的，或级别下调的。
 *
 * 放宽边界属于操作者的显式决定，这里只报告，不阻断；工作进程自行改守卫文件时，
 * 这条记录是唯一的痕迹。
 */
export function weakenedRedlines(prev: PolicyData, next: PolicyData): string[] {
  const before = Array.isArray(prev.redlines) ? prev.redlines : [];
  const after = new Map((Array.isArray(next.redlines) ? next.redlines : []).map((r) => [r.id, r]));
  const out: string[] = [];
  for (const r of before) {
    const now = after.get(r.id);
    if (!now) {
      out.push(`${r.id} 已删除`);
      continue;
    }
    const was = LEVEL_RANK[String(r.level)] ?? 0;
    const is = LEVEL_RANK[String(now.level)] ?? 0;
    if (is < was) out.push(`${r.id} 由 ${r.level} 降为 ${now.level}`);
  }
  return out;
}

export function prevPolicyPath(root: string): string {
  return configLoc.policyPrev(root);
}

export function savePrevPolicy(root: string, data: PolicyData): void {
  writeJson(prevPolicyPath(root), data);
}

export function readPrevPolicy(root: string): PolicyData | null {
  return readJson<PolicyData | null>(prevPolicyPath(root), null);
}

/**
 * 把守卫数据原子写回文件（回滚与监工自行调整编排层时使用）。
 *
 * @throws 落盘失败时抛出。
 */
export function writePolicyFile(file: string, data: PolicyData): void {
  writeJson(file, data);
}

export function rollbackPolicy(root: string, file: string): PolicyData | null {
  const prev = readPrevPolicy(root);
  if (!prev) return null;
  try {
    writePolicyFile(file, prev);
    return prev;
  } catch (err) {
    recordEvent(root, "policy_rollback_failed", {
      file,
      error: String((err as Error).message ?? err),
    });
    return null;
  }
}


/**
 * 分片级模型优先级链：分片 model -> 守卫 default_model -> 命令行 --worker-model -> 宿主默认。
 *
 * 返回“去重后的非空候选 + 末尾一个 undefined（宿主默认）”。{@link resolveShardModel} 取首项，
 * {@link resolveShardModelFallback} 取次项（即上一档失败时的默认值）。前导 undefined 会被跳过，
 * 否则分片没写 model 时会错误地取 undefined 而非 default_model。
 *
 * @param cliModel 命令行指定的模型。为 undefined 时该档不参与。
 */
export function shardModelChain(
  shard: { model?: string | undefined },
  policy: Policy,
  cliModel?: string | undefined,
): (string | undefined)[] {
  const raw = [
    shard?.model,
    (policy.data as { default_model?: string }).default_model,
    cliModel,
  ];
  const chain: (string | undefined)[] = [];
  for (const m of raw) {
    if (m === undefined) continue;
    if (chain[chain.length - 1] !== m) chain.push(m);
  }
  chain.push(undefined); // 末尾 undefined = 宿主默认，作为最终默认值
  return chain;
}

/**
 * 实际选用的模型：优先级链的第一档。
 *
 * @returns 模型名；链上无候选时返回 undefined，表示用宿主默认。
 */
export function resolveShardModel(
  shard: { model?: string | undefined },
  policy: Policy,
  cliModel?: string | undefined,
): string | undefined {
  return shardModelChain(shard, policy, cliModel)[0];
}

/**
 * 启动即失败时的回退模型：优先级链的下一档。
 *
 * @returns 模型名；无下一档时返回 undefined，表示用宿主默认。
 */
export function resolveShardModelFallback(
  shard: { model?: string | undefined },
  policy: Policy,
  cliModel?: string | undefined,
): string | undefined {
  const c = shardModelChain(shard, policy, cliModel);
  return c.length > 1 ? c[1] : undefined;
}

/**
 * 该红线的“正确做法”。
 *
 * @returns 红线 `fix` 字段的文本；该红线不存在或未写 `fix` 时返回中性说明，不臆造领域表述。
 */
export function redlineFix(policy: Policy, id: string): string {
  const r = policy.redlines.find((x) => x.id === id);
  return r?.fix || "换一条不越界的做法；不确定时用 capitalist ask 由监工裁决。";
}


/**
 * 监工实例租约：`.capitalist/locks/<task>.lock`。
 *
 * 监工单实例不能只靠 supervisor.json：它记录的是“最近一次写心跳的监工”，两个监工
 * 先后启动、先后写心跳时，文件只剩后写者，先写者毫无察觉。租约把“谁占着这个任务根”
 * 落成独立文件：启动时写入（实例 id、pid、启动时间、心跳），每轮调度刷新心跳，退出时
 * 标记 released。后来者读到存活租约就拒绝启动，错误信息给出持有者 pid 与启动时间。
 *
 * 租约状态三种：`running`（在位）、`superseded`（被接管者标记下线）、`released`（正常退出）。
 */
export interface InstanceLease {
  /** 实例 id：每次启动生成一份，用于区分“同一文件的前后写者”。 */
  instance_id: string;
  /** 持有者进程号。 */
  pid: number;
  /** 启动时间（ISO），拒绝信息与接管事件都要引用它。 */
  started_at: string;
  /** 最近一次心跳（ISO），供展示。 */
  heartbeat_at: string;
  /** 最近一次心跳（epoch 秒），判活用它。 */
  heartbeat_ts: number;
  /** 判活窗口（秒）。租约自带窗口，读取方不必再依赖调度周期配置。 */
  stale_sec: number;
  status: "running" | "superseded" | "released";
  /** 被接管时间（ISO），仅 superseded 时存在。 */
  superseded_at?: string;
  /** 接管者的实例 id，仅 superseded 时存在。 */
  superseded_by?: string;
}

/** 锁目录：`<root>/.capitalist/locks`。 */
export function locksDir(root: string): string {
  return locksLoc.dir(root);
}

/** 文件名安全段：只留字母数字与 `-` `_` `.`，其余压成 `-`。 */
function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "task";
}

/** FNV-1a 短哈希：区分同名目录，避免两处同名任务根共用一把锁。 */
function shortHash(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

/**
 * 任务根对应的锁名 `<task>`。
 *
 * 取任务根目录名，拼上绝对路径的短哈希：不同位置的同名目录各有一把锁，互不误伤。
 */
export function leaseTaskName(root: string): string {
  const abs = resolve(root);
  return `${safeName(basename(abs))}-${shortHash(abs.toLowerCase()).slice(0, 8)}`;
}

/** 租约文件绝对路径：`<root>/.capitalist/locks/<task>.lock`。 */
export function leasePath(root: string, task: string): string {
  return join(locksDir(root), `${safeName(task)}.lock`);
}

/**
 * 造一条本进程的租约。
 *
 * @param pid 持有者进程号。
 * @param staleSec 判活窗口（秒），下限 30，容忍调度抖动，避免把存活实例误判为失效。
 * @param instanceId 实例 id；省略时按时间与随机数生成。
 */
export function newInstanceLease(
  pid: number,
  staleSec: number,
  instanceId = `I-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
): InstanceLease {
  const now = new Date().toISOString();
  return {
    instance_id: instanceId,
    pid,
    started_at: now,
    heartbeat_at: now,
    heartbeat_ts: Date.now() / 1000,
    stale_sec: Math.max(Math.floor(staleSec), 30),
    status: "running",
  };
}

/**
 * 读租约。
 *
 * @returns 文件缺失、JSON 损坏或字段不完整时返回 null，调用方按“无租约”处理。
 */
export function readLease(root: string, task: string): InstanceLease | null {
  const rec = readJson<InstanceLease | null>(leasePath(root, task), null);
  if (!rec || typeof rec !== "object") return null;
  if (typeof rec.instance_id !== "string" || typeof rec.pid !== "number") return null;
  if (typeof rec.heartbeat_ts !== "number") return null;
  return rec;
}

/**
 * 写租约。锁目录不存在时先建。
 *
 * @throws 目录或文件写不进去时抛出，调用方需自行处理。
 */
export function writeLease(root: string, task: string, lease: InstanceLease): void {
  mkdirSync(locksDir(root), { recursive: true });
  writeJson(leasePath(root, task), lease);
}

/**
 * 刷新租约心跳。只有仍是自己的租约才刷新：接管后旧实例的心跳写入会被拒绝，
 * 不会把接管者的租约改回去。
 */
export function touchLease(root: string, task: string, instanceId: string): void {
  const cur = readLease(root, task);
  if (!cur || cur.instance_id !== instanceId) return;
  writeLease(root, task, {
    ...cur,
    heartbeat_at: new Date().toISOString(),
    heartbeat_ts: Date.now() / 1000,
  });
}

/**
 * 租约是否存活：状态 `running`、持有者进程仍在、心跳在窗口内。
 *
 * 进程还在但心跳超窗不算存活（卡死实例应可被接管），但接管前必须把它标成
 * `superseded` 并留事件，见监工启动流程。
 */
export function leaseAlive(lease: InstanceLease, nowSec = Date.now() / 1000): boolean {
  if (lease.status !== "running") return false;
  if (!pidAlive(lease.pid)) return false;
  return nowSec - lease.heartbeat_ts <= (lease.stale_sec > 0 ? lease.stale_sec : 90);
}

/** 租约的展示与告警信息，供 `capitalist status` 消费。 */
export interface LeaseStatus {
  /** 当前持有者（心跳在窗口内的存活实例）；无则 null。 */
  holder: InstanceLease | null;
  /** 仍占着进程的实例列表（状态 running 且 pid 存活，含心跳已超时的卡死实例）。 */
  instances: InstanceLease[];
  /** 实例数。 */
  instance_count: number;
  /** 持有者心跳年龄（秒）；无租约时为 -1。 */
  heartbeat_age_sec: number;
  /** 实例数大于 1 时的告警文案；正常为 null。 */
  warn: string | null;
}

/**
 * 汇总本任务的实例租约状态。
 *
 * 扫锁目录里属于本任务的全部租约文件（`<task>.lock` 与 `<task>.*.lock` 残留都算），实例数按“状态 running 且进程存活”计。多于一个说明多个监工实例同时持有该任务根，会造成重复派单和重复启动进程，必须告警。
 */
export function instanceLeaseStatus(root: string, task: string): LeaseStatus {
  const dir = locksDir(root);
  const prefix = `${safeName(task)}.`;
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((n) => n.endsWith(".lock") && (n === `${safeName(task)}.lock` || n.startsWith(prefix)));
  } catch {
    files = [];
  }

  const nowSec = Date.now() / 1000;
  const leases: InstanceLease[] = [];
  for (const name of files) {
    const rec = readJson<InstanceLease | null>(join(dir, name), null);
    if (!rec || typeof rec.instance_id !== "string" || typeof rec.pid !== "number") continue;
    if (rec.status !== "running" || !pidAlive(rec.pid)) continue;
    leases.push(rec);
  }
  leases.sort((a, b) => b.heartbeat_ts - a.heartbeat_ts);

  const holder = leases.find((l) => nowSec - l.heartbeat_ts <= (l.stale_sec > 0 ? l.stale_sec : 90)) ?? null;
  const age = holder ? Math.max(0, Math.round(nowSec - holder.heartbeat_ts)) : -1;
  const warn =
    leases.length > 1
      ? `发现 ${leases.length} 个存活实例（${leases.map((l) => `pid ${l.pid}`).join("、")}），同根多监工会重复派单，请保留一个并停掉其余`
      : null;
  return {
    holder,
    instances: leases,
    instance_count: leases.length,
    heartbeat_age_sec: age,
    warn,
  };
}

/**
 * 红线预检。
 *
 * 带 `defer` 的红线只识别动作类型，是否放行交给更专门的判定（例如本机删除需判断路径是否在任务根内）。这类红线不参与最严级别计算，否则识别到删除就会直接拦截，使路径判定失效。
 *
 * @param text 被检查的命令文本。
 * @returns 判定结果与命中的红线列表。`skip_if` 正则非法时按“不跳过”处理。
 */
export function evaluate(policy: Policy, text: string): GateResult {
  const src = String(text ?? "");
  const hits: RedlineHit[] = [];
  const hasUrl = /[A-Za-z][A-Za-z0-9+.\-]*:\/\//.test(src);

  for (const r of policy.redlines) {
    if (!r.id) continue;

    // 只作用于对外请求的红线：同一个词出现在本机命令里不构成证据
    if ((r as { requires?: string }).requires === "url" && !hasUrl) continue;

    // 只读类检查（如 grep 一个文件）不应触发内容类规则
    const skipIf = (r as { skip_if?: string }).skip_if;
    if (skipIf) {
      try {
        if (new RegExp(skipIf, "i").test(src)) continue;
      } catch {
        /* skip_if 写错时按“不跳过”处理，允许重复判定。 */
      }
    }

    const rx = policy.compiled.get(r.id);
    if (!rx) continue;
    const m = rx.exec(src);
    if (!m) continue;

    const start = Math.max(0, m.index - 30);
    const end = Math.min(src.length, m.index + m[0].length + 30);
    const hit: RedlineHit = {
      id: r.id,
      level: r.level || "WARN",
      label: r.label || r.id,
      snippet: src.slice(start, end).replace(/\n/g, " "),
    };
    const defer = (r as { defer?: string }).defer;
    if (defer) hit.defer = defer;
    hits.push(hit);
  }

  let worst = 0;
  for (const h of hits) {
    if (h.defer) continue;
    worst = Math.max(worst, LEVEL_RANK[h.level] ?? 1);
  }
  const decision: GateResult["decision"] =
    worst >= 3 ? "BLOCK" : worst === 2 ? "NEED_USER" : worst === 1 ? "PASS_WITH_WARN" : "PASS";

  return { decision, hits };
}
