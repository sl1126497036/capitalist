/**
 * 监工上下文重载（capitalist reload）：压缩监工对话与事件流水，只保留未完成项、决策结论与需求原文，产物落在 `.capitalist/reload/`。
 *
 * 快照 `snapshot.json` 中 `done_verified` 的条目不重派，`done_unverified` 的条目由 {@link applyResumePlan} 补 `source=reverify` 复验单；另有 `context.md` 简报、`resume.json` 恢复计划、`session.json` 会话代次与历史副本。
 * 看板侧：重载开始写 `active.json`、结束删除，`/api/supervisor` 转成 `reload: { active, phase }`；残留 active 超过 {@link RELOAD_STALE_MS} 视为失效。
 *
 * 自动重载：board 把 result 行的 contextUsed / contextWindow 经 {@link recordSupervisorContext} 落到 `capitalist-ctx.json`，主循环用 {@link shouldAutoReload} 判定超限后走同一条 `beginReload` 链路。
 * 恢复计划按 {@link ReloadSnapshot.dispatch_order}（台账行序）与 `resume_order` 排序，不按任务编号排序；编号仅作身份标识，与下发顺序无关。
 *
 * 边界：只写 `.capitalist/reload/` 与复验单，不改 state、不推进阶段、不动契约；阶段推进与门槛判定只在 loop.ts 的 step 里发生。
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { dirs } from "../agent/registry";
import { hhmmOf } from "../core/clock";
import { runCheck, type CheckResult } from "../core/checks";
import { listDirectives } from "../core/commands";
import { stageById, type Contract } from "../core/contract";
import { openInboxAsks } from "../core/inbox";
import { readJson, readJsonl, writeJson } from "../core/json";
import { DEFAULT_SUPERVISOR_CONTEXT_LIMIT, readCtxWindow, readCtxWindowChosen, resolveContextWindow } from "../core/limits";
import { recordEvent } from "../core/ledger";
import { supervisorDir } from "../core/paths";
import { loadState } from "../core/state";
import { EVENT_ZH } from "./terms";
import {
  appendDispatch,
  listWorkers,
  loadSupervisor,
  newDispatchId,
  readDispatches,
  type Dispatch,
} from "../core/supervisor";
import {
  estimateContextTokens,
  newTextTally,
  tallyMessage,
  workerUsageRow,
} from "./usage";
import type { Stage, TaskState } from "../core/types";

/** 重载目录：`.capitalist/reload`。所有产物都在这里，归档时不与业务台账混在一起。 */
function reloadDir(root: string): string {
  return join(supervisorDir(root), "reload");
}

function activePath(root: string): string {
  return join(reloadDir(root), "active.json");
}

/** 最近一次的进度快照。 */
export function snapshotPath(root: string): string {
  return join(reloadDir(root), "snapshot.json");
}

/** 压缩后的上下文简报（纯文本，进模型提示词）。 */
export function contextPath(root: string): string {
  return join(reloadDir(root), "context.md");
}

/** 重载后的恢复计划：哪些跳过、哪些复验。 */
export function resumePath(root: string): string {
  return join(reloadDir(root), "resume.json");
}

/** 当前重载代次与监工对话会话 id。 */
export function sessionPath(root: string): string {
  return join(reloadDir(root), "session.json");
}

function historyDir(root: string): string {
  return join(reloadDir(root), "history");
}

/** “重载进行中”标记的失效时间；重载是秒级动作，残留 active 说明写它的进程已退出。 */
export const RELOAD_STALE_MS = 3 * 60_000;

/** 一张单在快照里的状态。 */
export type ReloadItemState =
  /** 契约里有这一片，但没有任何派单记录 */
  | "not_started"
  /** open / claimed：排队或执行中 */
  | "in_progress"
  /** 最后一单失败，等重派 */
  | "failed"
  /** 报过完成，但没有可核对的确认（review，或 done 而证据台账里没有） */
  | "done_unverified"
  /** 完成且有证据确认；重载后不得重派 */
  | "done_verified";

/** 快照里一条派单的摘要。只留判断所需，不留 action 全文（详情在 item.action 里）。 */
export interface ReloadDispatchRef {
  id: string;
  status: string;
  attempt: number;
  at: string;
  note: string;
  /** 复验单标记：这类单本身不是业务产出，不参与“业务是否完成”的判定 */
  reverify: boolean;
}

/** 一片（或整阶段的空分片）在快照里的记录。 */
export interface ReloadItem {
  /** `${stage}/${shard}` 或 `${stage}/-`；跨阶段唯一 */
  key: string;
  stage: string;
  shard: string;
  title: string;
  state: ReloadItemState;
  /** 判定依据。重载后据此核对状态判定。 */
  why: string;
  /**
   * 这一片是否仍在当前阶段的契约里。
   *
   * false 来自已删分片或上一阶段遗留的 review 单，只作记录、不进复验清单：阶段推进后 `supersedeStaleDispatches` 会把旧阶段的在途单作废，派复验单只会每轮调度 被作废一次。
   */
  in_contract: boolean;
  /** 需求原文，不压缩。 */
  action: string;
  /** 重派计数：同一片出现过的派单次数 - 1（累计口径，不受裁决重置影响） */
  retries: number;
  /** 当前连续失败次数（口径同 loop.shardRetry，受 retry_resets 影响） */
  failures: number;
  dispatches: ReloadDispatchRef[];
  /** 复验单 id（恢复计划写入；快照里只做记录） */
  verify_dispatch?: string;
  verified_by?: string;
  verified_at?: string;
}

/** 需求原文条目：来源 + 原文。 */
export interface ReloadRequirement {
  source: string;
  text: string;
}

/** 一个验收项（契约 done 里的单条检查）。 */
export interface ReloadGateItem {
  stage: string;
  label: string;
  ok: boolean;
  missing: string[];
}

/** 用户插话（`.capitalist/direct.jsonl` 里未消费的那些）。 */
export interface ReloadDirective {
  at: string;
  text: string;
  shard: string;
  stage: string;
}

/** 未裁决提问。 */
export interface ReloadAsk {
  id: string;
  at: string;
  text: string;
  stage: string;
  shard: string;
}

/** 决策结论：一行一条，来自已回填的裁决与阶段推进记录。 */
export interface ReloadDecision {
  at: string;
  kind: string;
  text: string;
}

/** 快照的统计，报告里的“前后对比”直接用这份数。 */
export interface ReloadMetrics {
  /** 重载前，几份台账的原始字符数合计 */
  before_chars: number;
  /** 压缩后简报的字符数 */
  after_chars: number;
  events_total: number;
  events_dropped: number;
  events_kept: number;
  items: number;
  done_verified: number;
  done_unverified: number;
  unfinished: number;
  directives: number;
  asks: number;
}

/** 契约超过该时长未更新即视为可能过期；新鲜度写入简报前部。 */
const CONTRACT_STALE_HOURS = 12;

/** 契约文件的新鲜度。 */
export interface ContractFreshness {
  /** 契约文件绝对路径；state 里没记或读不到时为空串。 */
  path: string;
  /** 文件最后修改时间（ISO）；读不到时为空串。 */
  mtime: string;
  /** 距现在多少小时；读不到时为 null。 */
  age_hours: number | null;
  /** 超过 {@link CONTRACT_STALE_HOURS} 未更新。 */
  stale: boolean;
}

/** 以契约文件的 mtime 判断新鲜度；`state.json` 的 `rev` 只记监工写状态次数，不反映外部改动。 */
export function contractFreshness(root: string): ContractFreshness {
  const st = loadState(root);
  const p = String(st?.contract_path ?? "").trim();
  if (!p) return { path: "", mtime: "", age_hours: null, stale: false };
  try {
    const mt = statSync(p).mtime;
    const age = (Date.now() - mt.getTime()) / 3_600_000;
    return {
      path: p,
      mtime: mt.toISOString(),
      age_hours: Math.round(age * 10) / 10,
      stale: age > CONTRACT_STALE_HOURS,
    };
  } catch {
    return { path: p, mtime: "", age_hours: null, stale: false };
  }
}

/**
 * 比对契约文件 mtime，变化即登记并提示重读。
 * 记录落在 `.capitalist/reload/contract-seen.json`，进程重启后仍可判定。
 */
export interface ContractChange {
  /** 变更前的 mtime；首次见到时为空串。 */
  from: string;
  /** 变更后的 mtime。 */
  to: string;
  /** 距上次见到的间隔小时数；首次见到为 null。 */
  gap_hours: number | null;
}

export function noteContractChange(root: string): ContractChange | null {
  const fresh = contractFreshness(root);
  if (!fresh.path || !fresh.mtime) return null;
  const seenPath = join(reloadDir(root), "contract-seen.json");
  const prev = readJson<{ path?: string; mtime?: string; at?: string } | null>(seenPath, null);
  const sameFile = String(prev?.path ?? "") === fresh.path;
  if (sameFile && String(prev?.mtime ?? "") === fresh.mtime) return null;

  /* 首次登记不算变更，否则每个新任务根都会报一次契约变化。 */
  const from = sameFile ? String(prev?.mtime ?? "") : "";
  const prevAt = Date.parse(String(prev?.at ?? ""));
  const change: ContractChange = {
    from,
    to: fresh.mtime,
    gap_hours: Number.isFinite(prevAt) ? Math.round(((Date.now() - prevAt) / 3_600_000) * 10) / 10 : null,
  };
  try {
    writeJson(seenPath, { path: fresh.path, mtime: fresh.mtime, at: new Date().toISOString() });
  } catch {
    /* 写入失败不阻断主流程：下一次比对仍会重试。 */
  }
  return from ? change : null;
}

export interface ReloadSnapshot {
  version: 1;
  gen: number;
  at: string;
  at_ts: number;
  target: string;
  contract: string;
  stage: string;
  stage_name: string;
  stage_index: number;
  next_action: string;
  requirements: ReloadRequirement[];
  gates: ReloadGateItem[];
  items: ReloadItem[];
  directives: ReloadDirective[];
  asks: ReloadAsk[];
  decisions: ReloadDecision[];
  /** 文件边界与禁止事项，原文行 */
  boundaries: string[];
  /** 契约文件新鲜度。 */
  contract_freshness?: ContractFreshness;
  retries: Record<string, number>;
  /**
   * 在途单按派单台账行序记录，恢复时依此顺序，不按任务编号排序。
   * 任务编号是身份标识，与下发顺序无关。
   */
  dispatch_order: ReloadOrderEntry[];
  /**
   * 未完成条目的恢复顺序（item key）。
   *
   * 按“这片第一张派单在台账里的行序”排；从没派过的片按契约顺序排在后面。
   * 恢复计划（buildResumePlan）的 reverify / pending 数组按它排序。
   */
  resume_order: string[];
  metrics: ReloadMetrics;
}

/** 恢复计划里的一条待复验项。 */
export interface ResumeReverifyItem {
  key: string;
  stage: string;
  shard: string;
  title: string;
  action: string;
  /** 判成“已做但未验证”的依据。 */
  why: string;
}

/** 每条的恢复状态：由 {@link applyResumePlan} 推进。 */
export interface ResumeItemState {
  state: "pending" | "verifying" | "verified";
  verify_dispatch?: string;
  verified_by?: string;
  verified_at?: string;
}

/** 重载恢复计划。 */
export interface ResumePlan {
  gen: number;
  at: string;
  /** done_verified：不重派 */
  skip: Array<{ key: string; stage: string; shard: string; title: string; why: string }>;
  /** done_unverified：必须派复验 */
  reverify: ResumeReverifyItem[];
  /**
   * 已做但未验证、且不能在本阶段派复验的条目：分片已不在契约，或属于已推进阶段。
   * `supersedeStaleDispatches` 会逐轮作废这类在途单，保留记录供最终清算。
   */
  deferred: Array<{ key: string; stage: string; shard: string; title: string; why: string; reason: string }>;
  /** 其余（未开始 / 执行中 / 失败）：交给监工原有补派，不在此重复派 */
  pending: Array<{ key: string; stage: string; shard: string; state: string }>;
  state: Record<string, ResumeItemState>;
  applied_at?: string;
}

/** 快照里一条在途单的原始下发顺序记录。 */
export interface ReloadOrderEntry {
  id: string;
  stage: string;
  shard: string;
  status: string;
  at: string;
}

/** `/api/supervisor` 下发的重载状态。 */
export interface ReloadStatus {
  active: boolean;
  /** snapshot | compress | resume | done */
  phase: string;
  gen: number;
  started_at: string;
  age_sec: number;
  /** 触发来源：manual（capitalist reload / 监工动作）| context_overflow（上下文超限自动重载） */
  trigger: string;
}

/** `.capitalist/reload/active.json` 的结构。 */
interface ActiveMarker {
  gen: number;
  phase: string;
  pid: number;
  started_at: string;
  at_ts: number;
  /** 触发来源；老标记没有这个字段，读作 manual。 */
  trigger?: string;
}

interface SessionRecord {
  gen: number;
  session_id: string;
  at: string;
  brief_chars: number;
}

interface LedgerEntry {
  id?: string;
  claim?: string;
  verdict?: string;
  evidence?: Record<string, string>;
  at?: string;
}

/** 台账文件的大小（字符数）；不存在按 0。 */
function fileChars(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** 截断到 n 字符，超出以省略号收尾。 */
function clip(text: string, n: number): string {
  const s = String(text ?? "");
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 单行化：快照里的 title / why 要能进表格，不携带换行。 */
function oneLine(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** 噪音事件：只表明进程存活、不反映进度，压缩时丢弃，避免挤掉派单与裁决记录。 */
const NOISE_EVENT =
  /^(supervisor_tick|heartbeat|heartbeat_.*|worker_heartbeat.*|board_.*|.*_debug|.*_probe|probe.*|tool|tool_result|stream.*|message_.*|usage|token_.*)$/i;

/** 明细事件：仅在单未了结时保留，重载后可据此还原这一单原本要做的事。 */
const DETAIL_EVENT = /^dispatch_(open|claim|start)$/i;

/** 证据四项。与 `capitalist ledger add` 的 confirmed 门槛一致（见 cli/records.ts）。 */
const EVIDENCE_FIELDS = ["baseline", "probe", "diff", "repro"] as const;

function readEvents(root: string): Array<Record<string, unknown>> {
  return readJsonl<Record<string, unknown>>(join(supervisorDir(root), "events.jsonl"));
}

function readLedger(root: string): LedgerEntry[] {
  return readJsonl<LedgerEntry>(join(supervisorDir(root), "ledger.jsonl"));
}

/** 证据是否齐全；缺项不算确认，与台账降级口径一致。 */
function evidenceComplete(e: LedgerEntry): boolean {
  const ev = (e.evidence ?? {}) as Record<string, unknown>;
  return EVIDENCE_FIELDS.every((k) => Boolean(ev[k]));
}

/**
 * 台账里有没有“这一片已确认”的记录。
 * 台账结论不绑分片，按 claim 中是否出现分片 id 或派单 id 匹配；阶段 id 是短串，易误匹配，不用于匹配。
 */
function confirmedFor(ledger: readonly LedgerEntry[], shard: string, dispatchIds: readonly string[]): LedgerEntry | null {
  for (const e of ledger) {
    if (String(e.verdict ?? "") !== "confirmed") continue;
    if (!evidenceComplete(e)) continue;
    const claim = String(e.claim ?? "");
    if (shard && claim.includes(shard)) return e;
    if (dispatchIds.some((id) => id && claim.includes(id))) return e;
  }
  return null;
}

/**
 * 该片重派计数的起算点。
 *
 * 口径与 loop.ts 的 `retryResetMs` 一致（`*` / `<stage>/` / `<stage>/<shard>` 取最大）。
 * 不共用那个函数是因为 loop 会 import 本模块，反向 import 会成环。
 */
function retryResetMs(state: TaskState | null, stage: string, shard: string): number {
  const map = (state?.retry_resets ?? {}) as Record<string, string>;
  const pick = (k: string): number => {
    const t = Date.parse(map[k] ?? "");
    return Number.isFinite(t) ? t : 0;
  };
  return Math.max(pick("*"), pick(`${stage}/`), pick(`${stage}/${shard}`));
}

/** 失败次数，口径与 loop.ts 的 `shardRetry` 一致：done 之后的失败清零，重置点之前的失败不算。 */
function retryCount(rows: readonly Dispatch[], resetAtMs: number): number {
  let failures = 0;
  for (const d of rows) {
    if (d.status === "failed") {
      const ts = Date.parse(d.done_at ?? d.at);
      if (Number.isFinite(ts) && ts < resetAtMs) continue;
      failures += 1;
    } else if (d.status === "done") {
      failures = 0;
    }
  }
  return failures;
}

/** 契约里这一阶段的并行分片。与 loop.ts 的 stageParallel 同口径（只取 id/action/title）。 */
function stageShards(contract: Contract, stageId: string): Array<{ id: string; title: string; action: string }> {
  const raw = (stageById(contract, stageId) as unknown as { parallel?: unknown } | undefined)?.parallel;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; title: string; action: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.action !== "string") continue;
    out.push({ id: r.id, title: typeof r.title === "string" ? r.title : "", action: r.action });
  }
  return out;
}

/**
 * 把一段 done 规格展开成逐条验收项。
 *
 * `runCheck` 只回答整体过没过、缺什么；而“已达标的验收项”要逐条说得出是哪一条。
 * 这里对 all_of / any_of 的每个子检查单独跑一次，不改变判定，只补明细。
 */
function gateItems(stage: Stage, root: string): ReloadGateItem[] {
  const spec = (stage.done ?? {}) as Record<string, unknown>;
  const list = Array.isArray(spec.checks) ? spec.checks : Array.isArray(spec.of) ? spec.of : null;
  if (!list) {
    const r: CheckResult = runCheck(spec, root);
    return [{ stage: stage.id, label: String(spec.type ?? "done"), ok: r.ok, missing: r.missing }];
  }
  return list.map((raw) => {
    const sub = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const r = runCheck(sub, root);
    const type = String(sub.type ?? "检查");
    const target = String(sub.path ?? sub.file ?? "");
    /* 达标项用“类型:目标”，未达标用检查里写的 msg。 */
    const label = r.ok || !sub.msg ? oneLine(target ? `${type}:${target}` : type) : oneLine(String(sub.msg));
    return { stage: stage.id, label, ok: r.ok, missing: r.missing };
  });
}

/**
 * 构建进度快照。
 *
 * @param gen 重载代次（由 {@link beginReload} 递增）。
 */
export function buildReloadSnapshot(root: string, contract: Contract, gen: number): ReloadSnapshot {
  const state = loadState(root);
  const stageId = String(state?.stage ?? contract.stages[0]?.id ?? "");
  const stage = stageById(contract, stageId);
  const stageIndex = contract.stages.findIndex((s) => s.id === stageId);
  const rows = readDispatches(root);
  const ledger = readLedger(root);
  const events = readEvents(root);
  const directives = listDirectives(root);
  const qa = readJsonl<Record<string, unknown>>(join(supervisorDir(root), "inbox", "qa.jsonl"));

  /*
   * 需求原文：契约 context（判据与禁止事项的大本营）+ 当前阶段的 next + 每个分片的 action。
   * 全部逐字保存。压缩只针对“过程”，不针对“要求”。
   */
  const requirements: ReloadRequirement[] = [];
  const freshness = contractFreshness(root);
  const ctx = contract.data.context;
  if (typeof ctx === "string" && ctx.trim()) requirements.push({ source: "contract.context", text: ctx });
  if (stage?.next && stage.next.trim()) requirements.push({ source: `stage ${stageId}.next`, text: stage.next });
  const shards = stageShards(contract, stageId);
  for (const s of shards) requirements.push({ source: `shard ${stageId}/${s.id}`, text: s.action });

  // 文件边界与禁止事项：从 env_notes 与 context 里逐行挑出约束句，保留原文，不改写。
  const boundaries: string[] = [];
  const summary = contract.data.env_notes?.summary;
  if (typeof summary === "string" && summary.trim()) boundaries.push(summary.trim());
  if (typeof ctx === "string") {
    for (const line of ctx.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      if (/禁止|不许|不得|不要|只改|只动|边界|范围：|别碰|红线/.test(t)) boundaries.push(t);
    }
  }

  // 已达标的验收项在重载后逐条复跑。
  const gates: ReloadGateItem[] = [];
  for (const s of contract.stages) {
    if (stageIndex >= 0 && contract.stages.indexOf(s) > stageIndex) break;
    gates.push(...gateItems(s, root));
  }

  /* 逐片判定范围：当前阶段分片（含已删但仍有派单记录的）、其他阶段处于 review 的单。 */
  const items: ReloadItem[] = [];
  const seen = new Set<string>();
  const pushItem = (sh: { id: string; title: string; action: string }, inContract: boolean): void => {
    const key = `${stageId}/${sh.id || "-"}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(classifyItem(state, stageId, sh.id, sh.title, sh.action, rows, ledger, inContract));
  };

  for (const s of shards) pushItem(s, true);
  for (const d of rows) {
    if (d.stage !== stageId) continue;
    const sid = String(d.shard ?? "");
    if (!sid || seen.has(`${stageId}/${sid}`)) continue;
    // 契约里已经删掉的分片：留一条记录，但不复验（派出去也会被当成过期单作废）。
    pushItem({ id: sid, title: "", action: String(d.action ?? "") }, false);
  }
  for (const d of rows) {
    if (d.status !== "review") continue;
    // 旧阶段的 review 单不过滤：它们进快照是“已做未验证”的记录，本来就不派复验。
    if (d.stage === stageId) continue;
    const key = `${d.stage}/${d.shard || "-"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(classifyItem(state, d.stage, String(d.shard ?? ""), "", String(d.action ?? ""), rows, ledger, false));
  }

  // 只保留未消费的插话：已消费的已并入某一单，重复带入会使工作进程重做。
  const openDirectives: ReloadDirective[] = directives
    .filter((d) => !d.consumed)
    .filter((d) => {
      const ds = String(d.stage ?? "");
      return !ds || ds === stageId;
    })
    .map((d) => ({
      at: String(d.at ?? ""),
      text: String(d.text ?? ""),
      shard: String(d.shard ?? ""),
      stage: String(d.stage ?? ""),
    }));

  // 未裁决提问：open 的 ask 全部保留（包括带 shard 的局部提问）。
  const asks: ReloadAsk[] = openInboxAsks(root).map((q) => ({
    id: String(q.id ?? ""),
    at: String(q.at ?? ""),
    text: String(q.text ?? ""),
    stage: String(q.stage ?? ""),
    shard: String(q.shard ?? ""),
  }));

  // 决策结论：已回填的裁决、用户调度指令、阶段推进；一行一条、去重、最多 20 条，只留结论不留过程。
  const decisions: ReloadDecision[] = [];
  const seenDecision = new Set<string>();
  const addDecision = (at: string, kind: string, text: string): void => {
    const t = oneLine(text).slice(0, 240);
    if (!t || seenDecision.has(t)) return;
    seenDecision.add(t);
    decisions.push({ at, kind, text: t });
  };
  for (const q of qa) {
    if (String(q.type ?? "") !== "answer") continue;
    addDecision(String(q.at ?? ""), "answer", String(q.text ?? ""));
  }
  for (const e of events) {
    const kind = String(e.event ?? e.kind ?? "");
    if (kind === "supervisor_advance") {
      addDecision(String(e.at ?? ""), "advance", `${String(e.from ?? "?")} -> ${String(e.to ?? "?")}`);
    } else if (kind === "supervisor_instruct") {
      addDecision(String(e.at ?? ""), "instruct", String(e.text ?? ""));
    }
  }
  decisions.splice(20);

  const retries: Record<string, number> = {};
  for (const it of items) retries[it.key] = it.retries;

  /* 派单台账行序即下发顺序：dispatch_order 只收在途单；resume_order 按首张派单行序排，未派过的片按契约顺序靠后。 */
  const LIVE_STATUS = new Set(["open", "claimed", "reported", "review"]);
  const dispatchOrder: ReloadOrderEntry[] = rows
    .filter((d) => LIVE_STATUS.has(String(d.status ?? "")))
    .map((d) => ({
      id: String(d.id ?? ""),
      stage: String(d.stage ?? ""),
      shard: String(d.shard ?? ""),
      status: String(d.status ?? ""),
      at: String(d.at ?? ""),
    }));
  const resumeOrder: string[] = [];
  const seenResume = new Set<string>();
  for (const d of rows) {
    const key = `${String(d.stage ?? "")}/${String(d.shard ?? "") || "-"}`;
    if (seenResume.has(key)) continue;
    const item = items.find((i) => i.key === key);
    // 只排“重开后要继续”的条目；已完成的不占恢复次序。
    if (!item || item.state === "done_verified") continue;
    seenResume.add(key);
    resumeOrder.push(key);
  }
  for (const it of items) {
    if (it.state === "done_verified" || seenResume.has(it.key)) continue;
    seenResume.add(it.key);
    resumeOrder.push(it.key);
  }

  const dropped = events.filter((e) => isNoiseEvent(e, items)).length;
  const beforeChars =
    fileChars(join(supervisorDir(root), "events.jsonl")) +
    fileChars(join(supervisorDir(root), "inbox", "dispatch.jsonl")) +
    fileChars(join(supervisorDir(root), "direct.jsonl")) +
    fileChars(join(supervisorDir(root), "inbox", "qa.jsonl"));

  const doneVerified = items.filter((i) => i.state === "done_verified").length;
  const doneUnverified = items.filter((i) => i.state === "done_unverified").length;

  return {
    version: 1,
    gen,
    at: new Date().toISOString(),
    at_ts: Date.now() / 1000,
    target: String(state?.target ?? ""),
    contract: contract.name,
    stage: stageId,
    stage_name: String(stage?.name ?? ""),
    stage_index: stageIndex,
    next_action: String(state?.next_action ?? ""),
    requirements,
    gates,
    items,
    directives: openDirectives,
    asks,
    decisions,
    boundaries: [...new Set(boundaries)].slice(0, 60),
    retries,
    dispatch_order: dispatchOrder,
    resume_order: resumeOrder,
    metrics: {
      before_chars: beforeChars,
      // after_chars 由 buildReloadContext 填；这里先给 0，落盘前会被覆盖。
      after_chars: 0,
      events_total: events.length,
      events_dropped: dropped,
      events_kept: events.length - dropped,
      items: items.length,
      done_verified: doneVerified,
      done_unverified: doneUnverified,
      unfinished: items.length - doneVerified - doneUnverified,
      directives: openDirectives.length,
      asks: asks.length,
    },
  };
}

/**
 * 判定一片的状态。
 * 顺序即优先级：在途 > 失败 > 报完成待确认 > done(有证据) > done(无证据) > 未开始。
 * “done 但无证据”是复验的输入，不落成 done_verified。
 */
function classifyItem(
  state: TaskState | null,
  stage: string,
  shard: string,
  title: string,
  action: string,
  allRows: readonly Dispatch[],
  ledger: readonly LedgerEntry[],
  inContract: boolean,
): ReloadItem {
  const rows = allRows.filter((d) => d.stage === stage && String(d.shard ?? "") === shard);
  const business = rows.filter((d) => d.source !== "reverify");
  const resetAt = retryResetMs(state, stage, shard);
  const failures = retryCount(business, resetAt);
  /* 重派计数取最大 attempt - 1：failed 行只记录过程，重派次数按派单下发回数计。 */
  const maxAttempt = business.reduce((n, d) => Math.max(n, Number(d.attempt ?? 1)), 1);
  const retries = Math.max(0, maxAttempt - 1);

  const refs: ReloadDispatchRef[] = rows.map((d) => ({
    id: String(d.id ?? ""),
    status: String(d.status ?? ""),
    attempt: Number(d.attempt ?? 1),
    at: String(d.at ?? ""),
    note: clip(oneLine(String(d.review_note ?? d.note ?? "")), 160),
    reverify: d.source === "reverify",
  }));

  const dispatchIds = business.map((d) => String(d.id ?? ""));
  const last = business[business.length - 1];
  const live = business.find((d) => d.status === "open" || d.status === "claimed");

  const base = {
    key: `${stage}/${shard || "-"}`,
    stage,
    shard,
    title: oneLine(title || (last as (Dispatch & { title?: string }) | undefined)?.title || shard || stage),
    action: clip(String(action || last?.action || ""), 4000),
    retries,
    failures,
    in_contract: inContract,
    dispatches: refs,
  };

  if (live) {
    return { ...base, state: "in_progress", why: `派单 ${live.id} 处于 ${live.status}` };
  }
  if (!last) {
    return { ...base, state: "not_started", why: "没有任何派单记录" };
  }
  if (last.status === "failed") {
    return { ...base, state: "failed", why: `最后一单 ${last.id} 失败：${oneLine(String(last.note ?? "")) || "无说明"}` };
  }

  /*
   * 复验单的结局优先于业务单状态：在途判未验证，已结单判已验证，失败则由 applyResumePlan 重派。
   * 判定须放在 `review` 之前，否则每次重载都会把已结单的一片重新判成未验证、重复派复验。
   * 复验单不参与业务完成度判定，从 rows 里单独挑，不从 business 里找。
   */
  const reverifies = rows.filter((d) => d.source === "reverify");
  const liveReverify = reverifies.find((d) => d.status === "open" || d.status === "claimed" || d.status === "review");
  if (liveReverify) {
    return { ...base, state: "done_unverified", why: `复验单 ${liveReverify.id} 在途（${liveReverify.status}）` };
  }
  const doneReverify = reverifies.filter((d) => d.status === "done").pop();
  if (doneReverify) {
    return {
      ...base,
      state: "done_verified",
      why: `复验单 ${doneReverify.id} 已结单`,
      verified_by: String(doneReverify.id),
      verified_at: String(doneReverify.done_at ?? doneReverify.at ?? ""),
    };
  }

  if (last.status === "review") {
    return { ...base, state: "done_unverified", why: `已报完成但仍在待确认（${last.id}），没有裁决结论` };
  }
  if (last.status === "done") {
    const hit = confirmedFor(ledger, shard, dispatchIds);
    if (hit) {
      return {
        ...base,
        state: "done_verified",
        why: `证据台账 ${String(hit.id ?? "")} 已 confirmed（四项证据齐全）`,
        verified_by: String(hit.id ?? ""),
        verified_at: String(hit.at ?? ""),
      };
    }
    return { ...base, state: "done_unverified", why: `已结单（${last.id}），但证据台账里没有对应的 confirmed 记录` };
  }
  // open / 其它：没有在途以外的状态落在这里
  return { ...base, state: "in_progress", why: `状态 ${last.status}` };
}

/** 噪音判定：见 {@link NOISE_EVENT} 与 {@link DETAIL_EVENT} 的说明。 */
function isNoiseEvent(e: Record<string, unknown>, items: readonly ReloadItem[]): boolean {
  const kind = String(e.event ?? e.kind ?? "");
  if (NOISE_EVENT.test(kind)) return true;
  if (DETAIL_EVENT.test(kind)) {
    // 已完成的单的明细是重复信息：摘要已在 items 里。
    const dispatch = String(e.dispatch ?? "");
    const owned = items.find((i) => i.dispatches.some((d) => d.id === dispatch));
    return Boolean(owned && (owned.state === "done_verified" || owned.state === "done_unverified"));
  }
  return false;
}

export interface ReloadContextResult {
  text: string;
  chars: number;
}

/**
 * 把快照压成一段可进提示词的简报。
 * 丢弃心跳、`supervisor_tick`、已完成条目的详情与 `tool` 类流水；保留需求原文、未完成项、决策结论、待复验清单与文件边界。
 * 已完成条目只留标题与依据。
 */
export function buildReloadContext(snap: ReloadSnapshot): ReloadContextResult {
  const L: string[] = [];
  L.push(`# 监工重载简报（gen ${snap.gen}）`);
  L.push(`生成于 ${snap.at}｜目标：${snap.target}｜任务列表：${snap.contract}`);
  L.push(`当前阶段：${snap.stage} ${snap.stage_name}${snap.stage_index >= 0 ? `（第 ${snap.stage_index + 1} 段）` : ""}`);
  L.push(`下一步：${oneLine(snap.next_action) || "(空)"}`);
  L.push("");

  /* 契约可能数日未更新。简报标明契约新鲜度，并声明冲突时以派单台账为准。 */
  const fresh = snap.contract_freshness;
  if (fresh?.stale) {
    L.push(
      `契约文件已 ${fresh.age_hours} 小时未更新（最后修改 ` +
        `${String(fresh.mtime).slice(0, 16).replace("T", " ")}）。`,
    );
    L.push("      下面的阶段目标很可能已经过期。动手前先确认它是不是当前要做的事；");
    L.push("      过期就更新契约、或 capitalist advance 推进阶段，不要照着旧目标做。");
    L.push("");
  }
  L.push("## 阶段目标（契约原文，逐字保留 · 不是待办清单）");
  L.push(
    "> 以下是**阶段层面**的目标，可能早于今天的派单（本份简报生成于 " +
      String(snap.at ?? "").slice(0, 16).replace("T", " ") +
      "）。",
  );
  L.push("> 它们不是“现在要立刻做的事”：当前要做的活以派单台账为准。与下面的“未完成”冲突时，以派单为准；");
  L.push("> 台账里 done / closed 的派单是历史，不要按它们恢复任何东西。");
  L.push("");
  if (snap.requirements.length === 0) L.push("(无)");
  for (const r of snap.requirements) {
    L.push(`【${r.source}】`);
    L.push(r.text.trim());
    L.push("");
  }

  L.push("## 验收：已达标 / 未达标");
  const ok = snap.gates.filter((g) => g.ok);
  const bad = snap.gates.filter((g) => !g.ok);
  L.push(ok.length ? `已达标：${ok.map((g) => `${g.stage}:${g.label}`).join("；")}` : "已达标：(无)");
  L.push(bad.length ? `未达标：${bad.map((g) => `${g.stage}:${g.label}`).join("；")}` : "未达标：(无)");
  L.push("");

  if (snap.boundaries.length) {
    L.push("## 文件边界与禁止事项（原文）");
    for (const b of snap.boundaries) L.push(`- ${b}`);
    L.push("");
  }

  const unfinished = snap.items.filter((i) => i.state !== "done_verified" && i.state !== "done_unverified");
  L.push("## 未完成（重载后继续，不重复已完成的工作）");
  if (unfinished.length === 0) L.push("(无)");
  for (const i of unfinished) {
    const fail = i.failures > 0 ? `｜连续失败 ${i.failures} 次` : "";
    L.push(`- [${i.state}] ${i.stage}/${i.shard || "-"} ${i.title}：${clip(i.why, 120)}${fail}｜阶段原要求（历史）：${clip(oneLine(i.action), 300)}`);
  }
  L.push("");

  const reverify = snap.items.filter((i) => i.state === "done_unverified");
  L.push("## 待复验（已做但未验证，重载后必须派复验，不得当完成）");
  if (reverify.length === 0) L.push("(无)");
  for (const i of reverify) {
    const can = i.stage === snap.stage && i.in_contract;
    L.push(`- ${i.stage}/${i.shard || "-"} ${i.title}：${i.why}${can ? "" : "（只记录，不派复验：属于旧阶段或分片已删）"}`);
  }
  L.push("");

  const done = snap.items.filter((i) => i.state === "done_verified");
  L.push("## 已完成（不重派；只留标题与依据）");
  if (done.length === 0) L.push("(无)");
  for (const i of done) L.push(`- ${i.stage}/${i.shard || "-"} ${i.title}（${clip(i.why, 100)}）`);
  L.push("");

  L.push("## 用户未处理的插话（原话，按它执行）");
  if (snap.directives.length === 0) L.push("(无)");
  for (const d of snap.directives) L.push(`- ${d.shard ? `[${d.shard}] ` : ""}${d.text}`);
  L.push("");

  L.push("## 未裁决提问（等人回填，不要自行拍板）");
  if (snap.asks.length === 0) L.push("(无)");
  /* 提问编号用“问N”：`#N` 保留给任务编号（`thread-no.json`），避免与任务号混淆。 */
  for (const a of snap.asks) L.push(`- 问${a.id} ${a.shard ? `[${a.shard}] ` : ""}${a.text}`);
  L.push("");

  L.push("## 决策结论");
  if (snap.decisions.length === 0) L.push("(无)");
  for (const d of snap.decisions) L.push(`- (${d.kind}) ${d.text}`);
  L.push("");

  const retried = Object.entries(snap.retries).filter(([, n]) => n > 0);
  L.push("## 重派计数");
  if (retried.length === 0) L.push("(无)");
  for (const [k, n] of retried) L.push(`- ${k}: 重派 ${n} 次`);

  const text = L.join("\n");
  return { text, chars: text.length };
}

/** 由快照得出恢复计划。 */
export function buildResumePlan(snap: ReloadSnapshot): ResumePlan {
  const skip: ResumePlan["skip"] = [];
  const reverify: ResumeReverifyItem[] = [];
  const deferred: ResumePlan["deferred"] = [];
  const pending: ResumePlan["pending"] = [];
  const state: Record<string, ResumeItemState> = {};

  /* 恢复顺序按 `snap.resume_order` 的原始下发顺序，不按任务编号；编号是身份，不代表次序。 */
  const orderOf = (key: string): number => {
    const at = snap.resume_order.indexOf(key);
    return at >= 0 ? at : Number.MAX_SAFE_INTEGER;
  };

  for (const i of snap.items) {
    if (i.state === "done_verified") {
      skip.push({ key: i.key, stage: i.stage, shard: i.shard, title: i.title, why: i.why });
    } else if (i.state === "done_unverified") {
      /*
       * 只有“本阶段 + 仍在契约里”的片能派复验单。
       *
       * 其余两种派了也活不过一个 调度轮次：旧阶段的在途单会被 supersedeStaleDispatches
       * 作废，契约里删掉的分片不在本案集合里同样被作废。所以它们进 deferred，
       * 留着信息、不制造一张每轮调度 生一次的假单。
       */
      if (i.stage === snap.stage && i.in_contract) {
        reverify.push({ key: i.key, stage: i.stage, shard: i.shard, title: i.title, action: i.action, why: i.why });
        state[i.key] = { state: "pending" };
      } else {
        deferred.push({
          key: i.key,
          stage: i.stage,
          shard: i.shard,
          title: i.title,
          why: i.why,
          reason: i.in_contract ? "属于已推进过去的阶段，复验单会被作废" : "分片已不在任务列表里",
        });
      }
    } else {
      pending.push({ key: i.key, stage: i.stage, shard: i.shard, state: i.state });
    }
  }

  /*
   * 依次恢复：reverify / pending 都按原始下发顺序重排（稳定排序，同序不换位）。
   * applyResumePlan 按数组顺序建复验单，重开调度时因此先恢复最早下发的单。
   */
  const byOrder = <T extends { key: string }>(list: T[]): T[] =>
    list
      .map((item, idx) => ({ item, idx }))
      .sort((a, b) => orderOf(a.item.key) - orderOf(b.item.key) || a.idx - b.idx)
      .map((x) => x.item);
  const reverifyOrdered = byOrder(reverify);
  const pendingOrdered = byOrder(pending);

  return { gen: snap.gen, at: new Date().toISOString(), skip, reverify: reverifyOrdered, deferred, pending: pendingOrdered, state };
}

/** 读恢复计划；没有重载过时返回 null。 */
export function readResumePlan(root: string): ResumePlan | null {
  const p = readJson<ResumePlan | null>(resumePath(root), null);
  return p && Array.isArray(p.reverify) ? p : null;
}

/** 复验单正文须写明“复验不是重做”，避免工作进程按原要求重新实现、改回已通过的实现。 */
function reverifyAction(item: ResumeReverifyItem): string {
  return [
    `复验（不是重做）：${item.stage}/${item.shard || "整阶段"} ${item.title}`,
    `上一轮已报完成，但没有可核对的确认（${item.why}），不能直接当完成。`,
    "做三件事：1) 按下面的原要求逐条核对是否真的做到；2) 每条给出证据（命令输出、文件与行号、截图路径），结论用 capitalist ledger add 入账；",
    "3) 成立就在回报里写“已验证”，不重写已经通过的实现，不动别的分片的文件；不成立就说清缺哪条。",
    `原要求：${clip(oneLine(item.action), 1200)}`,
  ].join("\n");
}

/**
 * 应用恢复计划：为“已做但未验证”的条目补派复验单。
 * 幂等：同一条目已有在途复验单时不再新建；复验单 done 后条目标 verified。只处理当前阶段，避免占满并发槽。
 * @param currentStage 当前阶段 id；为空时处理全部。
 * @returns 新建的复验单数量。
 */
export function applyResumePlan(root: string, currentStage: string, out: (s: string) => void): number {
  const plan = readResumePlan(root);
  if (!plan || plan.reverify.length === 0) return 0;

  const rows = readDispatches(root);
  let made = 0;
  /* 落盘去重：每轮都调用，内容未变时不重写。 */
  const before = JSON.stringify(plan);

  for (const item of plan.reverify) {
    if (currentStage && item.stage !== currentStage) continue;
    const st: ResumeItemState = plan.state[item.key] ?? { state: "pending" };
    plan.state[item.key] = st;
    if (st.state === "verified") continue;

    if (st.verify_dispatch) {
      const d = rows.find((r) => r.id === st.verify_dispatch);
      if (!d) {
        // 派单已被归档或清理时允许重新下发。
        delete st.verify_dispatch;
        st.state = "pending";
      } else if (d.status === "done") {
        st.state = "verified";
        st.verified_by = d.id;
        st.verified_at = String(d.done_at ?? d.at ?? "");
        recordEvent(root, "reverify_confirmed", {
          item: item.key,
          dispatch: d.id,
          stage: item.stage,
          shard: item.shard,
          gen: plan.gen,
        });
        out(`[监工] 复验成立：${item.key}（${d.id}）`);
        continue;
      } else if (d.status === "failed") {
        delete st.verify_dispatch;
        st.state = "pending";
      } else {
        /* open / claimed / review：还在路上，不重复派。
         * superseded 也落在这里：说明契约在这一代重载之后变了，再派只会被继续作废；
         * 下一次 reload 会把它判成 in_contract=false 进 deferred，不会卡死。 */
        continue;
      }
    }

    // 进程重启后，同片已有在途复验单即复用，不重复派。
    const live = rows.find(
      (r) =>
        r.source === "reverify" &&
        r.stage === item.stage &&
        String(r.shard ?? "") === item.shard &&
        (r.status === "open" || r.status === "claimed" || r.status === "review"),
    );
    if (live) {
      st.verify_dispatch = live.id;
      st.state = "verifying";
      continue;
    }

    const id = newDispatchId();
    /* title 是派单上的扩展字段（见 loop.ts 的 DispatchEx）：核心 Dispatch 不带它，
       但界面按它显示任务名，所以这里一并写进去。 */
    const d: Dispatch & { title?: string } = {
      id,
      at: new Date().toISOString(),
      stage: item.stage,
      shard: item.shard,
      title: `复验 · ${clip(item.title, 40)}`,
      action: reverifyAction(item),
      status: "open",
      source: "reverify",
      attempt: 1,
      note: `重载 gen ${plan.gen} 派出的复验单：${item.why}`,
    };
    appendDispatch(root, d);
    recordEvent(root, "dispatch_reverify", {
      dispatch: id,
      stage: item.stage,
      shard: item.shard,
      item: item.key,
      gen: plan.gen,
    });
    st.verify_dispatch = id;
    st.state = "verifying";
    made += 1;
    out(`[监工] 重载后复验：${item.key}，派单 ${id}（不重做，只核对并给证据）`);
  }

  if (plan.applied_at === undefined) plan.applied_at = new Date().toISOString();
  if (JSON.stringify(plan) !== before) writeJson(resumePath(root), plan);
  return made;
}

/*
 * 监工对话上下文读数由 board 从 stream-json result 行提取，落到 `.capitalist/reload/capitalist-ctx.json`。
 * 看板与主循环分属不同进程，判据经磁盘共享；主循环每轮读取，超阈值即触发重载。
 */

/** 上下文已用占生效上限的比例达到该值即自动重载。 */
export const CAPITALIST_CTX_RELOAD_RATIO = 0.85;
/** 已用量低于该值不触发重载，避免短会话误判。 */
const CAPITALIST_CTX_MIN_USED = 60_000;

/**
 * 判为宿主侧压缩的降幅：后一次读数不超过前一次的一半。
 * 宿主 stream-json 不报压缩事件，只能按读数回落幅度推断；上下文大幅回落只发生在压缩或换会话时。
 */
export const CTX_COMPACT_DROP_RATIO = 0.5;

/**
 * 相邻两次上下文读数是否构成一次压缩。
 * 调用方校验同一会话与读数口径，本函数只判数值：空读数与非正数不算压缩。
 */
export function ctxDropIsCompaction(
  before: number | null | undefined,
  after: number | null | undefined,
): boolean {
  const b = Number(before);
  const a = Number(after);
  if (!Number.isFinite(b) || !Number.isFinite(a) || b <= 0 || a <= 0) return false;
  return a <= b * CTX_COMPACT_DROP_RATIO;
}

function supervisorCtxPath(root: string): string {
  return join(reloadDir(root), "capitalist-ctx.json");
}

/** 监工对话上下文的最近一次读数。 */
export interface SupervisorContextRecord {
  /** 上下文已用 token */
  used: number;
  /** 上下文窗口 token（宿主没报时为 0） */
  window: number;
  /** used / window（window 缺失时为 0） */
  ratio: number;
  at: string;
  /** 这条读数属于哪一代监工会话；重载换代后旧读数不能再当判据。 */
  gen: number;
  /** 读数的模型名（宿主 modelUsage 的键）；没报时为空。 */
  model: string;
  /** 已用是否为估算值：宿主没有 contextUsed 时按会话消息文本折算 */
  estimate: boolean;
}

/**
 * 按宿主会话记录估算监工对话的上下文已用 token。
 * 宿主 stream-json 不报 contextUsed；会话记录（`<配置目录>/projects/<项目>/<会话 id>.jsonl`）存有本会话全部消息与工具结果，
 * 按与工作进程同一条 {@link estimateContextTokens} 折算：中文 3 字符/token、其余 4 字符/token。
 * 无可估算记录时返回 null，由调用方按“未上报”处理。
 */
interface SessionEstimate {
  size: number;
  mtime_ms: number;
  tokens: number;
}

const sessionEstCache = new Map<string, SessionEstimate>();

/** 在宿主配置目录的 projects/* 下找该会话最新的一份记录。 */
function hostSessionFile(sessionId: string): string {
  let best = "";
  let bestMtime = -1;
  for (const d of dirs()) {
    const base = join(homedir(), d.dir, "projects");
    if (!existsSync(base)) continue;
    let projects: string[] = [];
    try {
      projects = readdirSync(base, { withFileTypes: true })
        .filter((x) => x.isDirectory())
        .map((x) => x.name);
    } catch {
      continue;
    }
    for (const p of projects) {
      const file = join(base, p, `${sessionId}.jsonl`);
      try {
        const st = statSync(file);
        if (st.isFile() && st.mtimeMs >= bestMtime) {
          best = file;
          bestMtime = st.mtimeMs;
        }
      } catch {
        /* 该目录没有这一代会话：继续找 */
      }
    }
  }
  return best;
}

export function estimateSessionContextTokens(sessionId: string): number | null {
  const id = String(sessionId || "").trim();
  if (!id) return null;
  const file = hostSessionFile(id);
  if (!file) return null;
  let size = 0;
  let mtime = 0;
  try {
    const st = statSync(file);
    size = st.size;
    mtime = st.mtimeMs;
  } catch {
    return null;
  }
  const cached = sessionEstCache.get(file);
  if (cached && cached.size === size && cached.mtime_ms === mtime) return cached.tokens || null;
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const acc = newTextTally();
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      if (o && o.type === "message") tallyMessage(acc, o);
    } catch {
      /* 末尾半行跳过，避免解析不完整记录 */
    }
  }
  const tokens = estimateContextTokens(acc);
  if (sessionEstCache.size > 32) sessionEstCache.clear();
  sessionEstCache.set(file, { size, mtime_ms: mtime, tokens });
  return tokens > 0 ? tokens : null;
}

/** 当前监工对话会话的代次（session.json 的 gen）。 */
function currentSupervisorGen(root: string): number {
  const sess = readJson<SessionRecord | null>(sessionPath(root), null);
  return Math.max(0, Number(sess?.gen ?? 0));
}

/**
 * 记录监工对话上下文的最近一次读数（board 在每轮 capitalist-chat 结束后调用）。
 * 读数缺失（used <= 0）时不写，与 usage.ts 口径一致。`estimate` 标记估算口径：宿主未报 contextUsed 时由
 * {@link estimateSessionContextTokens} 估算，界面加 `≈`；宿主真读数一律 false。
 */
export function recordSupervisorContext(
  root: string,
  used: number,
  window: number,
  model = "",
  estimate = false,
): SupervisorContextRecord | null {
  const u = Number(used);
  if (!Number.isFinite(u) || u <= 0) return null;
  /* 压缩无事件可依，按相邻两次读数比较；须同代、同口径。换代归 reload 事件，估算与真读数互换不构成压缩。 */
  const prev = readSupervisorContext(root);
  /* 窗口在落盘前按默认表校正，避免各调用方重复换算；宿主对未收录模型只报 300k 占位值。 */
  const w = resolveContextWindow(String(model || "").trim(), Number(window)) ?? 0;
  const rec: SupervisorContextRecord = {
    used: Math.round(u),
    window: Math.round(w),
    ratio: w > 0 ? u / w : 0,
    at: new Date().toISOString(),
    gen: currentSupervisorGen(root),
    model: String(model || "").trim(),
    estimate: Boolean(estimate),
  };
  try {
    mkdirSync(reloadDir(root), { recursive: true });
    writeJson(supervisorCtxPath(root), rec);
  } catch {
    return rec;
  }
  if (
    prev &&
    prev.gen === rec.gen &&
    prev.estimate === rec.estimate &&
    ctxDropIsCompaction(prev.used, rec.used)
  ) {
    /* 来源 inferred 表示按读数降幅推断，与 reload 区分；窗口缺失时才扫描日志借用其他读数。 */
    const limitWindow = rec.window > 0 ? rec.window : supervisorContextModelWindow(root, rec);
    recordEvent(root, "context_compacted", {
      scope: "capitalist",
      session: reloadSessionId(root),
      before_used: prev.used,
      after_used: rec.used,
      limit: effectiveSupervisorContextLimit(supervisorContextConfigLimit(root), limitWindow),
      source: "inferred",
      gen: rec.gen,
    });
  }
  return rec;
}

/** 读监工对话上下文的最近一次读数；没有就 null。 */
export function readSupervisorContext(root: string): SupervisorContextRecord | null {
  const r = readJson<SupervisorContextRecord | null>(supervisorCtxPath(root), null);
  if (!r || !Number.isFinite(Number(r.used)) || Number(r.used) <= 0) return null;
  return {
    used: Math.round(Number(r.used)),
    window: Number.isFinite(Number(r.window)) && Number(r.window) > 0 ? Math.round(Number(r.window)) : 0,
    ratio: Number.isFinite(Number(r.ratio)) ? Number(r.ratio) : 0,
    at: String(r.at ?? ""),
    gen: Number.isFinite(Number(r.gen)) ? Number(r.gen) : 0,
    model: String(r.model ?? ""),
    estimate: Boolean(r.estimate),
  };
}

/**
 * 监工配置的上下文上限（supervisor.json 的 `supervisor_context_limit`）。
 *
 * 未配置时取 {@link DEFAULT_SUPERVISOR_CONTEXT_LIMIT}；显式写 0 表示“只按模型窗口”。
 * 返回值 0 就是“没有配置上限”。
 */
export function supervisorContextConfigLimit(root: string): number {
  const raw = loadSupervisor(root)?.supervisor_context_limit;
  if (raw === undefined || raw === null) return DEFAULT_SUPERVISOR_CONTEXT_LIMIT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** 当前监工对话的模型：`--capitalist-model` 显式配置 > 读数自报模型 > 最近一个工作进程的模型（宿主默认锚点）。 */
export function supervisorContextModel(root: string, rec: SupervisorContextRecord | null = readSupervisorContext(root)): string {
  const configured = String(loadSupervisor(root)?.supervisor_model ?? "").trim();
  if (configured) return configured;
  if (rec?.model) return rec.model;
  const rows = listWorkers(root).sort((a, b) =>
    String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")),
  );
  for (const w of rows) {
    const u = workerUsageRow(w);
    if (u.model) return u.model;
  }
  return "";
}

/**
 * 当前模型的上下文窗口（生效值，经 {@link resolveContextWindow}）。
 * 取窗口的顺序：监工读数、同模型工作进程读数、默认表；均借不到返回 0，界面只显示已用。
 * 工作进程读数的 `context_window` 已在 usage.ts 校正；`capitalist-ctx.json` 可能存有升级前的宿主原值 300k，这里再校正一次。
 */
export function supervisorContextModelWindow(
  root: string,
  rec: SupervisorContextRecord | null = readSupervisorContext(root),
  model = supervisorContextModel(root, rec),
): number {
  const modelRows = listWorkers(root)
    .map((w) => workerUsageRow(w))
    .filter((r) => r.context_window !== null && r.context_window > 0);
  if (model) {
    const same = modelRows.find((r) => r.model === model);
    if (same?.context_window) return same.context_window;
  }
  if (rec?.window && (!rec.model || !model || rec.model === model)) {
    return resolveContextWindow(model || rec.model, rec.window) ?? 0;
  }
  if (model) return resolveContextWindow(model, null) ?? 0;
  /* 模型未知：取最近有窗口读数的那一行（宿主默认模型的代理）。 */
  return modelRows[0]?.context_window ?? 0;
}

/** 生效上限 = min(配置值, 模型实际上限)；两者都缺时为 0，界面只显示已用。 */
export function effectiveSupervisorContextLimit(configLimit: number, modelWindow: number, chosen?: number | null): number {
  /* 面板显式选择的窗口优先采用，不再与模型窗口取小；宿主对未收录模型只报 300000，取小会压低选定值。 */
  const pick = Number(chosen);
  if (Number.isFinite(pick) && pick > 0) return Math.round(pick);
  const cfg = Number.isFinite(configLimit) && configLimit > 0 ? Math.round(configLimit) : 0;
  const win = Number.isFinite(modelWindow) && modelWindow > 0 ? Math.round(modelWindow) : 0;
  if (cfg > 0 && win > 0) return Math.min(cfg, win);
  return cfg || win || 0;
}

/**
 * 看板“监工 · 上下文”一格的视图（GET /api/supervisor 的 `context`）。
 * 只反映监工自身对话的用量与上限，与工作进程的上下文分开；上限按 {@link effectiveSupervisorContextLimit} 算。
 * 重载换代后旧读数不作为当前值，显示为空并给出原因。
 */
export interface SupervisorContextView {
  used: number | null;
  /** 已用是否为估算值（界面加 `≈`） */
  estimate: boolean;
  /** 已用是否超过生效上限（`used` 已夹到 `limit`） */
  over: boolean;
  /** 模型窗口（原始读数；没有为 null） */
  window: number | null;
  /** 生效上限：min(配置, 模型窗口) */
  limit: number | null;
  /** 监工配置值（0 = 未配置，只按模型窗口） */
  config_limit: number;
  ratio: number | null;
  threshold: number;
  model: string;
  at: string;
  source: "supervisor_session" | "none";
  reason: string;
}

export function buildSupervisorContextView(root: string): SupervisorContextView {
  const rec = readSupervisorContext(root);
  const gen = currentSupervisorGen(root);
  const configLimit = supervisorContextConfigLimit(root);
  const model = supervisorContextModel(root, rec);
  const window = supervisorContextModelWindow(root, rec, model);
  const limit = effectiveSupervisorContextLimit(configLimit, window, readCtxWindowChosen(root, "supervisor"));
  const fresh = Boolean(rec && rec.gen === gen);
  const rawUsed = fresh ? rec?.used ?? null : null;
  /* 已用夹到生效上限，避免估算值超出窗口显示为“1.2M / 600k”；夹取后保留 `over` 供界面标超限。 */
  const over = rawUsed !== null && limit > 0 && rawUsed > limit;
  const used = rawUsed !== null && limit > 0 ? Math.min(rawUsed, limit) : rawUsed;
  const ratio = used !== null && limit > 0 ? used / limit : null;
  let reason = "";
  if (!rec) reason = "还没和监工对话过：没有会话上下文读数";
  else if (!fresh) reason = "上下文刚优化过，等待新会话的读数";
  else if (!limit) reason = "没有可用的上下文上限（模型未上报窗口，也没有配置）";
  return {
    used,
    estimate: Boolean(fresh && rec?.estimate),
    over,
    window: window > 0 ? window : null,
    limit: limit > 0 ? limit : null,
    config_limit: configLimit,
    ratio,
    threshold: CAPITALIST_CTX_RELOAD_RATIO,
    model,
    at: fresh ? rec?.at ?? "" : "",
    source: fresh ? "supervisor_session" : "none",
    reason,
  };
}

/** 自动重载的判定结果。 */
export interface SupervisorCtxCheck {
  hit: boolean;
  reason: string;
  record: SupervisorContextRecord | null;
}

/**
 * 是否应该自动重载。
 * 四个条件同时成立才算超限：有真实读数、读数属于当前会话代次、占比达到 {@link CAPITALIST_CTX_RELOAD_RATIO}
 * （分母为 min(配置, 模型窗口)）、已用量不低于 {@link CAPITALIST_CTX_MIN_USED}；已有重载进行中不重复触发。
 * 读数须属于当前代次：重载只换会话 id，不清上一代读数，不校验代次会在重载后按旧读数再次触发。
 */
export function shouldAutoReload(root: string): SupervisorCtxCheck {
  const rec = readSupervisorContext(root);
  if (!rec) return { hit: false, reason: "没有上下文读数", record: null };
  if (reloadStatus(root).active) return { hit: false, reason: "重载已在进行中", record: rec };
  const gen = currentSupervisorGen(root);
  if (rec.gen !== gen) {
    return { hit: false, reason: `读数是第 ${rec.gen} 代会话的，当前已是第 ${gen} 代`, record: rec };
  }
  if (rec.used < CAPITALIST_CTX_MIN_USED) {
    return { hit: false, reason: `已用 ${rec.used} token，未达下限 ${CAPITALIST_CTX_MIN_USED}`, record: rec };
  }
  const configLimit = supervisorContextConfigLimit(root);
  const window = supervisorContextModelWindow(root, rec);
  const limit = effectiveSupervisorContextLimit(configLimit, window, readCtxWindowChosen(root, "supervisor"));
  if (!limit) {
    return { hit: false, reason: "没有可用的上下文上限（模型未上报窗口，也没有配置）", record: rec };
  }
  /* 分母与显示同源；已用夹到上限，超限时占比按 100% 算，理由里不写超过分母的读数。 */
  const used = Math.min(rec.used, limit);
  const ratio = used / limit;
  if (ratio < CAPITALIST_CTX_RELOAD_RATIO) {
    return {
      hit: false,
      reason: `占比 ${(ratio * 100).toFixed(1)}%，未达阈值 ${(CAPITALIST_CTX_RELOAD_RATIO * 100).toFixed(0)}%（上限 ${limit} token）`,
      record: rec,
    };
  }
  return {
    hit: true,
    reason:
      `上下文已用 ${used} token / 上限 ${limit} token` +
      `（配置 ${configLimit || "未配置"}｜模型 ${window || "未上报"}，占比 ${(ratio * 100).toFixed(1)}%）`,
    record: rec,
  };
}

/** 读重载状态。过期（进程崩在中途）的标记会被清掉，避免看板永久显示“重载中”。 */
export function reloadStatus(root: string): ReloadStatus {
  const sess = readJson<SessionRecord | null>(sessionPath(root), null);
  const gen = Number(sess?.gen ?? 0);
  const marker = readJson<ActiveMarker | null>(activePath(root), null);
  if (!marker) {
    return { active: false, phase: "idle", gen, started_at: "", age_sec: 0, trigger: "" };
  }
  const started = String(marker.started_at ?? "");
  const phase = String(marker.phase ?? "snapshot");
  /* `done` 表示重载已完成、仅收尾删标记失败，按已结束处理，否则看板会持续显示“上下文优化中”。 */
  if (phase === "done") {
    return { active: false, phase: "done", gen: Number(marker.gen ?? gen), started_at: started, age_sec: 0, trigger: "" };
  }
  const ts = Number(marker.at_ts ?? 0) * 1000;
  const ageMs = Number.isFinite(ts) && ts > 0 ? Date.now() - ts : RELOAD_STALE_MS + 1;
  if (ageMs > RELOAD_STALE_MS) {
    try {
      rmSync(activePath(root), { force: true });
    } catch {
      /* 删不掉就留着，下一个读者再试 */
    }
    recordEvent(root, "supervisor_reload_stale", { gen: marker.gen, phase: marker.phase, age_sec: Math.round(ageMs / 1000) });
    return { active: false, phase: "stale", gen, started_at: started, age_sec: Math.round(ageMs / 1000), trigger: "" };
  }
  return {
    active: true,
    phase,
    gen: Number(marker.gen ?? gen),
    started_at: started,
    age_sec: Math.max(0, Math.round(ageMs / 1000)),
    trigger: String(marker.trigger ?? "manual"),
  };
}

/** 重载后的监工对话会话 id；换会话即丢弃旧会话的历史输出，未重载过时沿用 `capitalist-chat`。 */
export function reloadSessionId(root: string): string {
  const sess = readJson<SessionRecord | null>(sessionPath(root), null);
  const id = String(sess?.session_id ?? "").trim();
  return id || "capitalist-chat";
}

/**
 * 监工对话单轮注入的历史上限（token）。
 * 与自动重载（按上下文占比触发）并列：此处在每轮对话前按会话记录体量换代，超限即换新会话 id
 * （`capitalist-chat-c<gen>`），为下一轮注入量设定上界。换代只裁历史，不写快照、不动派单队列。
 * token 估算用 {@link estimateSessionContextTokens}（带 size/mtime 缓存）；估算不可用时按会话文件字节数判断。
 */
export const CAPITALIST_CHAT_TURN_TOKEN_CAP = 600_000;

/** 回落上限（字节）：token 估算不可用时按会话记录文件的字节数判断。 */
export const CAPITALIST_CHAT_TURN_CHAR_CAP = 600_000;

/** 生效上限：`.capitalist/ctx-window.json` 指定的窗口 × 0.8，余下两成留给模型输出。 */
function supervisorChatCapOf(root: string): number {
  const want = readCtxWindow(root, "supervisor");
  return Math.floor(want * 0.8);
}

/**
 * 监工对话该用哪个会话 id。
 * 未超上限沿用当前会话（`reloadSessionId`）；超限则换代：gen + 1，写 `session.json`，
 * 落一条 `context_compacted` 事件（`source: "turn_cap"`），新会话从空上下文开始。
 * 换代只换会话 id，不写快照、不动派单队列；完整重载由 {@link beginReload} 负责。
 * 写盘失败时沿用旧会话并放弃裁剪。
 */
export function supervisorChatTurnSessionId(root: string): string {
  const id = reloadSessionId(root);
  const tokens = estimateSessionContextTokens(id);
  let chars = 0;
  const file = hostSessionFile(id);
  if (file) {
    try {
      chars = statSync(file).size;
    } catch {
      chars = 0;
    }
  }
  const cap = supervisorChatCapOf(root);
  const over = tokens !== null ? tokens > cap : chars > CAPITALIST_CHAT_TURN_CHAR_CAP;
  if (!over) return id;

  const prev = readJson<SessionRecord | null>(sessionPath(root), null);
  const gen = Math.max(0, Number(prev?.gen ?? 0)) + 1;
  const next = `capitalist-chat-c${gen}`;
  try {
    writeJson(sessionPath(root), {
      gen,
      session_id: next,
      at: new Date().toISOString(),
      brief_chars: Number(prev?.brief_chars ?? 0),
    });
  } catch {
    return id;
  }
  recordEvent(root, "context_compacted", {
    scope: "capitalist",
    session: id,
    next_session: next,
    before_used: tokens ?? null,
    after_used: null,
    limit: tokens !== null ? cap : CAPITALIST_CHAT_TURN_CHAR_CAP,
    source: "turn_cap",
    trigger: "turn_cap",
    gen_from: Number(prev?.gen ?? 0),
    gen_to: gen,
  });
  return next;
}

/**
 * 严重异常事件白名单：只有这一类进监工对话上下文，心跳与过程流水不进。
 * 采用白名单而非黑名单：新增过程事件默认不进，须在此显式登记，避免漏配后心跳流水挤占上下文。
 */
const SEVERE_SUPERVISOR_EVENT =
  /^(worker_killed|worker_looping_killed|worker_gone|worker_launch_failed|dispatch_failed|redispatch_capped|dispatch_forced_finished|contract_error|contract_refused|contract_unstable|stuck_detected|stuck_killed|stuck_escalated|stage_stalled|board_reload_blocked|duplicate_launch_refused|retry_refused)$/i;

/** 台账尾部窗口（字节）：严重异常摘要只从这里找，不全量解析台账。 */
const SEVERE_EVENT_TAIL_BYTES = 512_000;

/** 从台账尾部取最近的严重异常，一行一条（时间正序，最多 {@link max} 条）；无严重异常时返回空数组。 */
export function severeSupervisorEventLines(root: string, max = 8): string[] {
  const file = join(supervisorDir(root), "events.jsonl");
  let buf = "";
  try {
    const size = statSync(file).size;
    const handle = openSync(file, "r");
    try {
      const want = Math.min(size, SEVERE_EVENT_TAIL_BYTES);
      const b = Buffer.alloc(want);
      readSync(handle, b, 0, want, size - want);
      buf = b.toString("utf8");
    } finally {
      closeSync(handle);
    }
  } catch {
    return [];
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const line of buf.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      if (o && typeof o === "object") rows.push(o);
    } catch {
      /* 半行写入跳过，避免解析不完整记录 */
    }
  }
  const out: string[] = [];
  /* 事件名与说明完全相同的只留最近一条，兼容老台账里未节流的成堆重复；不同原因各占一行。 */
  const seen = new Set<string>();
  for (let i = rows.length - 1; i >= 0 && out.length < max; i -= 1) {
    const e = rows[i]!;
    const name = String(e.event ?? e.kind ?? "");
    if (!SEVERE_SUPERVISOR_EVENT.test(name)) continue;
    const who = String(e.dispatch ?? e.worker ?? "").trim();
    const detail = oneLine(
      String(e.text ?? e.reason ?? e.error ?? e.why ?? e.detail ?? e.note ?? ""),
    ).slice(0, 160);
    const dedupeKey = `${name}|${who}|${detail}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const at = String(e.at ?? "").slice(5, 16).replace("T", " ");
    /* `repeat` 是节流写入攒下的次数：连续发生 N 次只落一条，这里如实标出来。 */
    const rep = Number(e.repeat ?? 0);
    const times = Number.isFinite(rep) && rep > 1 ? ` ×${rep}` : "";
    out.push(`- ${at} ${EVENT_ZH[name] ?? name}${who ? `（${who}）` : ""}${detail ? `：${detail}` : ""}${times}`);
  }
  return out.reverse();
}

/**
 * 把用户最近几条发言原文摆进监工上下文。
 * 只取 `supervisor_chat_ask` 且 from=user 的发言，压成一行、截断，最多 {@link max} 条；附件行不进本段，路径由截图段单独给出。
 */
export function recentUserLines(root: string, max = 6): string[] {
  const file = join(supervisorDir(root), "events.jsonl");
  let buf = "";
  try {
    const size = statSync(file).size;
    const handle = openSync(file, "r");
    try {
      const want = Math.min(size, 262_144);
      const b = Buffer.alloc(want);
      readSync(handle, b, 0, want, size - want);
      buf = b.toString("utf8");
    } finally {
      closeSync(handle);
    }
  } catch {
    return [];
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const line of buf.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      if (o && typeof o === "object") rows.push(o);
    } catch {
      /* 半行写入跳过，避免解析不完整记录 */
    }
  }
  const out: string[] = [];
  for (let i = rows.length - 1; i >= 0 && out.length < max; i -= 1) {
    const e = rows[i]!;
    const name = String(e.event ?? e.kind ?? "");
    if (name !== "supervisor_chat_ask") continue;
    if (String(e.from ?? "user") !== "user") continue;
    const text = oneLine(String(e.text ?? "").replace(/\[附件\][^\n]*/g, " ")).slice(0, 100);
    if (!text) continue;
    out.push(`- ${hhmmOf(e.at)} 用户消息：${text}`);
  }
  return out.reverse();
}

/**
 * 重载简报：给监工对话层注入的继承上下文。
 * 按段落挑选而非按序截前 N 字：优先保留未完成、待复验、插话、未裁决、结论、重派计数等增量段落，
 * 再把剩余额度给需求原文等存量段落（契约与派单中另有一份）。超出时从占用最大的段落开始截，并在末尾标明。
 */
export function reloadBrief(root: string, maxChars = 12000): string {
  let text = "";
  try {
    if (!existsSync(contextPath(root))) return "";
    text = readFileSync(contextPath(root), "utf8").trim();
  } catch {
    return "";
  }
  if (text.length <= maxChars) return text;

  /* 按 `## ` 切段，第一段是标题行。 */
  const parts = text.split(/\n(?=## )/);
  const head = parts[0] ?? "";
  const sections = parts.slice(1).map((s) => ({ title: (s.split("\n")[0] ?? "").trim(), body: s }));

  /** 优先级：数字小的先保；需求原文放最后，契约里另有一份。 */
  const rank = (title: string): number => {
    if (/未完成/.test(title)) return 0;
    if (/待复验/.test(title)) return 1;
    if (/插话/.test(title)) return 2;
    if (/未裁决/.test(title)) return 3;
    if (/决策结论/.test(title)) return 4;
    if (/重派计数/.test(title)) return 5;
    if (/验收/.test(title)) return 6;
    if (/边界|禁止/.test(title)) return 7;
    if (/需求原文/.test(title)) return 8;
    return 9;
  };

  const sorted = [...sections].sort((a, b) => rank(a.title) - rank(b.title));
  /* 需求原体量最大且排在简报最前，按序取或纯按优先级都会挤掉其他段落，故先划出 30% 固定配额，其余给增量段落。 */
  const needQuota = Math.floor(maxChars * 0.3);
  let budget = maxChars - head.length - 200;
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const s of sorted) {
    const isNeed = rank(s.title) === 8;
    const room = isNeed ? Math.min(needQuota, budget) : budget;
    if (s.body.length <= room) {
      kept.push(s.body);
      budget -= s.body.length + 1;
      continue;
    }
    if (room > 400) {
      kept.push(`${s.body.slice(0, room)}\n…（这一段超出配额，截断；全文在 .capitalist/reload/context.md）`);
      budget -= room;
    } else {
      dropped.push(s.title.replace(/^#+\s*/, ""));
    }
  }
  /* 保住的按原文顺序回排，读起来才连贯。 */
  kept.sort((a, b) => text.indexOf(a) - text.indexOf(b));
  const tail = dropped.length ? `\n\n（因上限未纳入的段落：${dropped.join("、")}；完整内容在 .capitalist/reload/context.md）` : "";
  return `${head}\n${kept.join("\n")}${tail}`;
}

function writeMarker(root: string, gen: number, phase: string, startedAt: string, trigger = "manual"): void {
  mkdirSync(reloadDir(root), { recursive: true });
  const marker: ActiveMarker = {
    gen,
    phase,
    pid: process.pid,
    started_at: startedAt,
    at_ts: Date.now() / 1000,
    trigger,
  };
  writeJson(activePath(root), marker);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** `capitalist reload` 的入参。 */
export interface ReloadOptions {
  /** 让“监工重载中”多停几秒，便于人/脚本观察到这个状态；0 表示不停。 */
  holdSec?: number;
  out?: (s: string) => void;
  /** 触发来源：manual（默认）| context_overflow（上下文超限自动重载）。进事件与 active 标记。 */
  trigger?: string;
  /** 是否生成压缩简报（默认 false）。压缩由宿主调度，本模块只在宿主压缩后用 `context_compacted` 事件同步状态。 */
  compress?: boolean;
}

/** 一次重载的结论，CLI 直接照着打印。 */
export interface ReloadSummary {
  gen: number;
  snapshot: string;
  context: string;
  resume: string;
  session_id: string;
  before_chars: number;
  after_chars: number;
  events_total: number;
  events_dropped: number;
  items: number;
  skip: number;
  reverify: number;
  /** 已做但未验证、又不能在本阶段派复验的条目（旧阶段 / 已删分片） */
  deferred: number;
  pending: number;
}

/**
 * 执行一次重载。
 * 顺序不可调换：先落盘快照 -> 压缩 -> 换会话 -> 写恢复计划。任一步失败保留 active 标记，由 {@link reloadStatus} 超时清理。
 * @throws 已有重载进行中时抛出（并发重载会互相覆盖快照）。
 */
export async function beginReload(root: string, contract: Contract, opts: ReloadOptions = {}): Promise<ReloadSummary> {
  const out = opts.out ?? ((s: string) => process.stdout.write(`${s}\n`));
  const running = reloadStatus(root);
  if (running.active) {
    throw new Error(
      `已有重载在进行中（gen ${running.gen}，阶段 ${running.phase}，已 ${running.age_sec}s）。等它结束再重载；` +
        `进程若已崩，${Math.round(RELOAD_STALE_MS / 60000)} 分钟后标记自动失效。`,
    );
  }

  const prev = readJson<SessionRecord | null>(sessionPath(root), null);
  const gen = Number(prev?.gen ?? 0) + 1;
  const startedAt = new Date().toISOString();
  const trigger = String(opts.trigger ?? "manual");
  /*
   * 重载前的读数与被换掉的会话 id：压缩事件要写清“从哪条会话、多少占用”开始。
   * 这两份必须在换 session.json 之前取，否则读到的已经是新会话。
   */
  const ctxBefore = readSupervisorContext(root);
  const prevSessionId = String(prev?.session_id ?? "").trim() || "capitalist-chat";
  const limitBefore = effectiveSupervisorContextLimit(
    supervisorContextConfigLimit(root),
    supervisorContextModelWindow(root, ctxBefore),
  );

  mkdirSync(historyDir(root), { recursive: true });
  writeMarker(root, gen, "snapshot", startedAt, trigger);

  // 1. 快照
  const snap = buildReloadSnapshot(root, contract, gen);

  /* 压缩简报默认不生成；不压缩时 after_chars 记成 before_chars，避免写 0 被误读为上下文已清空。 */
  const doCompress = opts.compress === true;
  let afterChars = snap.metrics.before_chars;
  if (doCompress) {
    writeMarker(root, gen, "compress", startedAt, trigger);
    const ctx = buildReloadContext(snap);
    afterChars = ctx.chars;
    writeFileSync(contextPath(root), `${ctx.text}\n`, "utf8");
  }
  snap.metrics.after_chars = afterChars;
  writeJson(snapshotPath(root), snap);
  // 历史副本：重载可以复盘。文件名带 gen 与时间，不覆盖上一代。
  writeJson(join(historyDir(root), `gen-${gen}-${startedAt.replace(/[:.]/g, "-")}.json`), snap);

  // 3. 新会话：换 id 即换上下文，老会话不再被读
  const session: SessionRecord = {
    gen,
    session_id: `capitalist-chat-r${gen}`,
    at: startedAt,
    brief_chars: afterChars,
  };
  writeJson(sessionPath(root), session);

  // 4. 恢复计划
  const plan = buildResumePlan(snap);
  writeJson(resumePath(root), plan);
  writeMarker(root, gen, "resume", startedAt, trigger);

  const holdMs = Math.max(0, Math.min(60, Number(opts.holdSec ?? 0))) * 1000;
  if (holdMs > 0) await sleep(holdMs);

  /* 收尾：撤掉“重载进行中”标记。删除失败不判重载失败：此时快照、压缩、换会话均已落盘。 */
  let cleaned = false;
  try {
    rmSync(activePath(root), { force: true });
    cleaned = true;
  } catch {
    cleaned = false;
  }
  if (!cleaned) {
    try {
      /* 删标记失败时改写终态 `done`，`reloadStatus` 视同已结束，不依赖删除成功。 */
      writeMarker(root, gen, "done", startedAt, trigger);
    } catch {
      /* 标记也写不了时留给 stale 超时清理。 */
    }
  }
  recordEvent(root, "supervisor_reload", {
    gen,
    trigger,
    stage: snap.stage,
    items: snap.items.length,
    skip: plan.skip.length,
    reverify: plan.reverify.length,
    pending: plan.pending.length,
    before_chars: snap.metrics.before_chars,
    after_chars: afterChars,
    dropped_events: snap.metrics.events_dropped,
    session_id: session.session_id,
  });
  /* 仅真正压缩时记 `context_compacted`（source=reload）：新会话无读数，`after_used` 留 null。 */
  if (doCompress) {
    recordEvent(root, "context_compacted", {
      scope: "capitalist",
      session: prevSessionId,
      next_session: session.session_id,
      before_used: ctxBefore?.used ?? null,
      after_used: null,
      limit: limitBefore,
      source: "reload",
      trigger,
      gen_from: Number(prev?.gen ?? 0),
      gen_to: gen,
    });
  }

  out(
    `[监工] 重载完成 gen ${gen}：快照 ${snap.items.length} 片｜` +
      `${doCompress ? `上下文 ${snap.metrics.before_chars} -> ${afterChars} 字（移除 ${snap.metrics.events_dropped} 条心跳/tick/已完成明细）` : "未压缩（交给宿主）"}｜` +
      `不重派 ${plan.skip.length}｜待复验 ${plan.reverify.length}` +
      (plan.deferred.length ? `｜只记录 ${plan.deferred.length}` : "") +
      `｜继续 ${plan.pending.length}`,
  );

  return {
    gen,
    snapshot: snapshotPath(root),
    context: contextPath(root),
    resume: resumePath(root),
    session_id: session.session_id,
    before_chars: snap.metrics.before_chars,
    after_chars: afterChars,
    events_total: snap.metrics.events_total,
    events_dropped: snap.metrics.events_dropped,
    items: snap.items.length,
    skip: plan.skip.length,
    reverify: plan.reverify.length,
    deferred: plan.deferred.length,
    pending: plan.pending.length,
  };
}
