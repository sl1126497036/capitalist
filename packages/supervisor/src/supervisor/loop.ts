/**
 * 监工循环。
 *
 * 监工是独立进程，负责建根、定契约、派单、验收、判死重派，不直接执行任务。工作进程由监工拉起，
 * 各自是独立宿主进程（`<cli> -p`），有独立 pid、会话与上下文，进程之间互不可见；
 * 监工与工作进程只通过 `.capitalist/` 交换数据。
 *
 * 并行度只取用户设定值（`--workers` 或运行时指令），契约分片数不参与封顶；分片只决定当前阶段
 * 有几张单可派，空出的槽位留待后续派单。
 *
 * 监工自身异常不中断循环：单次判定失败记录后继续，连续失败记入 supervisor.json。
 * 手动暂停（`.capitalist/pause.json`）时不派新单，心跳、判死回收与已完成派单的结算照常。
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { LEGACY_ACCEPTANCE_DIR } from "../host/impl/shared/hostHints";
import { byId } from "../host/registry";

import { runCheck } from "../core/checks";
import { askModel, AUTH_REQUIRED_TEXT, isQuotaText, looksLikeAuth, looksLikeQuota, QUOTA_EXHAUSTED_TEXT } from "./llm";
import {
  activeTakeover,
  appendDirective,
  appendSection,
  claimDirectives,
  closeTask,
  directiveRef,
  isHeld,
  laneKeyOf,
  listDirectives,
  promoteTask,
  spliceDirectives,
  takeoverShard,
} from "../core/commands";
import {
  buildIntervention,
  classifyStuck,
  DEFAULT_STUCK_SEC,
  normalizeStuckSec,
  readLogTail,
  repeatSignal,
  stuckGapSec,
  stuckStateOf,
  type StuckEvidence,
} from "./stuck";
import {
  ignoredSignature,
  inboxDir,
  openInboxAsks,
  readInbox,
} from "../core/inbox";
import {
  type Contract,
  detectRequirementViolation,
  isLastStage,
  leaseAlive,
  leaseTaskName,
  loadContract,
  newInstanceLease,
  nextStageId,
  orchestrationDiff,
  readLease,
  reloadContract,
  requirementFingerprint,
  resolveShardModel,
  resolveShardModelFallback,
  savePrevContract,
  stageById,
  stageIds,
  touchLease,
  writeLease,
} from "../core/contract";
import { createTaskRoot, enterStage } from "../core/init";
import { appendJsonl, pruneTempFiles, readJson, readJsonl, writeJson, writeJsonl } from "../core/json";
import { recordEvent, recordEventThrottled } from "../core/ledger";
/* 文件写锁供调度查询占用，避免派单命中已被占用的文件。 */
import { reap as reapFileLocks, releaseAll as releaseFileLocks, writeHolderOf } from "../core/fileLock";
import { extractLocalPaths } from "../core/localGuard";
import { ASK_BLOCK_MS, DEFAULT_SUPERVISOR_CONTEXT_LIMIT, VERDICT_HOLD_MS, WAKE_GRACE_MS } from "../core/limits";
import { clockOf } from "../core/clock";
import { copyStandardNote, memoriesFor, primeMemory, rememberLesson, renderMemoryConstraints, withLessons } from "./memory";
import { commitCursor, readPendingMq, type MqMessage } from "../core/mq";
import { attachmentsIn, bindAttachments, stripAttachments, withAttachmentLines } from "../core/attachments";
import { attachmentsOfMessage } from "../core/messages";
import { ensureTaskForDispatch, titleSimilarity } from "../core/tasks";
import {
  clearPreemptLease,
  isImmediate,
  leaseEnded,
  markYielded,
  readPreemptLease,
  releaseYielded,
  savePreemptLease,
  yieldOrder,
  yieldedDispatches,
} from "../core/preempt";
import { autoRebuild } from "../core/rebuildTree";
import { supervisorDir } from "../core/paths";
import { markQuotaExhausted } from "../core/quota";
import { loadState, updateState } from "../core/state";
import {
  activeDispatches,
  appendDispatch,
  claimDispatch,
  clearStopFlag,
  checkTreeEdge,
  compareQueueOrder,
  dependenciesSettled,
  descendantsOf,
  dispatchForest,
  dispatchPath,
  dispatchPaused,
  finishDispatch,
  frontDispatch,
  holdDispatches,
  isSupervisorAlive,
  isWorkerAlive,
  listWorkers,
  loadSupervisor,
  loadWorker,
  DEFAULT_LOG_STALL_SEC,
  workerLivenessOf,
  workerLogIdleSec,
  workerLogPath,
  missingPrerequisites,
  newDispatchId,
  newWorkerId,
  pausedDispatches,
  pidAlive,
  prerequisitesOf,
  pruneWorkers,
  readDispatches,
  saveSupervisor,
  saveWorker,
  stopRequested,
  stopForced,
  sweepReported,
  sweepReviews,
  DEFAULT_MODEL_ROTATION,
  nextRotatingDefaultModel,
  takeWorkerModel,
  touchWorker,
  type Dispatch,
  type SupervisorRecord,
  type WorkerRecord,
} from "../core/supervisor";
import type { Stage, TaskState } from "../core/types";
import { disposeAll, registerDisposer, __resetDisposers } from "./dispose";
import {
  markSupervisorDirective,
  pendingSupervisorDirectives,
  CAPITALIST_ACTIONS,
  type SupervisorDirective,
  type SupervisorResult,
} from "./direct";
import { planInstruct } from "./instruct";
import { applyResumePlan, beginReload, noteContractChange, shouldAutoReload } from "./reload";
import { reapOrphans } from "./reapOrphans";
import { ensureGuard, stopGuard } from "./guard";
import { laneOfWorker, recordLaneUsage } from "./sessionLane";
import { shardTitle, taskTitle } from "./taskTitle";
import { dispatchNoTable, dispatchOfThreadNo, threadIdByNo } from "./threadNo";
import { decide } from "./brain";
import { brainSessionOf } from "./brainLane";
import { deniedModelsUsed, resolveModel } from "./modelPolicy";
import { triage, worthTriaging, type TriageVerdict } from "./triage";
import { workspaceFacts } from "./workspaceFacts";
import { workerUsage } from "./usage";
import { isLogNoise, tailWithinChars, withoutThinking } from "./workerLog";
import { killTree, sleepSync, waitExit } from "./terminate";
import {
  actionTail,
  BLOCKER_MARKER,
  blockerLines,
  detectWorkerHost,
  findPreviousBlocker,
  launchWorker,
  openVisibleWorker,
  workerImpl,
  type WorkerHost,
} from "./worker";
import type { Served, ServeOptions } from "./board";
import { skillDirs } from "../host/locations";
import { currentHost, siblings, workerHosts } from "../host/registry";

/**
 * 监工进程的启动参数。
 * 除 `root` 必填（指向任务根）外，其余字段可省，取本文件常量与 `detectWorkerHost` 的默认值。
 */
export interface SupervisorOptions {
  root: string;
  /**
   * 是否按契约自动补分片派单（CLI `--auto-dispatch`）。
   * 默认 false：监工只处理用户派进来的单，契约分片不自动认领。
   */
  autoDispatch?: boolean | undefined;
  /**
   * 「启动默认不派单」由 CLI `--auto-start` 跳过。
   * 默认 false：有待办任务时先写 `.capitalist/pause.json`，等用户恢复派单；
   * 无待办时进入待命。
   */
  autoStart?: boolean | undefined;
  target?: string | undefined;
  contractSpec?: string | undefined;
  tickSec?: number | undefined;
  workerTimeoutSec?: number | undefined;
  /**
   * 卡点观察窗口（秒，CLI `--stuck-sec`，环境变量 `CAPITALIST_STUCK_SEC`）。
   * 心跳与日志都超过该窗口未更新才判为卡点，任一在窗口内更新即视为存活；缺省 300 秒，须小于心跳超时。
   */
  stuckSec?: number | undefined;
  /** 并行度上限；实际由契约分片决定 */
  workers?: number | undefined;
  /** 工作进程宿主；缺省按宿主环境判定。命令行不再暴露该参数，保留字段供程序化调用与测试使用。 */
  workerHost?: WorkerHost | undefined;
  /** 透传给工作进程的模型名（CLI `--worker-model`）。 */
  workerModel?: string | undefined;
  /** 推理强度（CLI `--effort`）；缺省取 {@link DEFAULT_EFFORT}，写入 supervisor.json 供看板读取。 */
  workerEffort?: string | undefined;
  /**
   * 监工对话层的模型（CLI `--capitalist-model`）；空值取宿主默认。写进 supervisor.json 的 `supervisor_model`，
   * 供看板与对话通道读取。
   */
  supervisorModel?: string | undefined;
  /**
   * 默认模型（CLI `--default-model`）：未显式指定时用它，覆盖平台默认档。
   * 空值按平台策略（`host/impl/shared/modelPolicy.ts`）取，不留空交给宿主自选；宿主自选会走
   * 内部别名 `fast-model` 并轮转，导致监工与工作进程落到不同模型。
   */
  defaultModel?: string | undefined;
  /** 追加的禁用模型（CLI `--model-denylist "a,b"`），与平台名单取并集。 */
  modelDenylist?: string | undefined;
  /**
   * 监工对话上下文的配置上限（CLI `--capitalist-context`，token）。
   *
   * 生效值取 min(这个值, 当前模型实际上限)；不传时按
   * {@link DEFAULT_SUPERVISOR_CONTEXT_LIMIT}。超限自动重载的阈值按生效值算。
   */
  supervisorContextLimit?: number | undefined;
  /** 自定义工作进程启动命令模板（含 {prompt}），用于没有标准 CLI 的宿主。 */
  workerCmd?: string | undefined;
  /**
   * 以独立控制台窗口启动工作进程（可见模式）。可见模式不写心跳，监工不按心跳判死。
   */
  workerVisible?: boolean;
  /** 只跑一个 tick，用于自检与 cron */
  once?: boolean;
  /** 测试用：跑满 N 个 tick 就退出 */
  maxTicks?: number;
  /** 已有监工在跑时仍强制启动，取代旧实例。 */
  force?: boolean;
  /**
   * 是否由监工拉起工作进程。关闭时监工只派单，工作进程由外部会话用 `capitalist next` 领取；
   * 无非交互入口的宿主强行 spawn 只会得到 never-start 记录。
   */
  spawnWorkers?: boolean | undefined;
  /**
   * 是否允许监工往宿主配置里装 hook（缺省不装，仅 `--with-hooks` 时为 true）。
   * 工作进程的心跳续写与契约红线拦截依赖 hook，故启用时主循环会周期补装。
   * Windows 上每次工具调用 spawn hook 会分配新控制台并闪烁；缺省关闭时心跳改由 reap 的
   * pid 存活与日志增长判定。
   */
  installHooks?: boolean | undefined;
  /**
   * 是否随监工一起起看板服务（缺省开）。`--no-board` 关闭后监工不再监听端口，也不做按构建重启。
   */
  board?: boolean | undefined;
  /**
   * 看板是否校验访问 key（缺省不校验）。`--secure` 启用后需持 `?key=` 或已下发的 cookie。
   */
  boardSecure?: boolean | undefined;
  /**
   * 看板重启的合并窗口（毫秒）：产物版本稳定这么久之后才重启。
   *
   * 省缺取环境变量 `CAPITALIST_BOARD_RELOAD_QUIET_MS`，再缺省 {@link DEFAULT_BOARD_RELOAD_QUIET_MS}。
   */
  boardQuietMs?: number | undefined;
  /**
   * 两次看板重启的最小间隔（毫秒）。
   *
   * 省缺取环境变量 `CAPITALIST_BOARD_RELOAD_MIN_GAP_MS`，再缺省 {@link DEFAULT_BOARD_RELOAD_MIN_GAP_MS}。
   */
  boardMinGapMs?: number | undefined;
  out?: (line: string) => void;
}

const DEFAULT_TICK = 5;
const DEFAULT_WORKER_TIMEOUT = 900;
/**
 * 工作进程的默认推理强度，只影响思考深度，不换模型。
 * 取 `high` 而非宿主默认（宿主默认不推理），也不用 `max`（长任务思考开销高、收益不明显）。
 */
const DEFAULT_EFFORT = "high";
/** 宿主 CLI 接受的档位（`--effort`）；非法值回默认，不传给 CLI。 */
const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 校验推理强度；非法值挡在启动阶段并回报，不往 CLI 传。 */
function normalizeEffort(v?: string): { value: string; bad: boolean } {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return { value: DEFAULT_EFFORT, bad: false };
  if ((EFFORT_LEVELS as readonly string[]).includes(s)) return { value: s, bad: false };
  return { value: DEFAULT_EFFORT, bad: true };
}
/** `--workers` 的缺省上限；需更高并行度时显式指定。 */
const DEFAULT_WORKERS = 3;
/** 看板默认端口；被占用时按 {@link BOARD_PORT_TRIES} 顺延。 */
const DEFAULT_BOARD_PORT = 7788;
const BOARD_PORT_TRIES = 20;
/**
 * 看板重启的合并窗口与最小间隔（毫秒）。build 期间产物连续变化，合并窗口等连写结束后才重启，
 * 最小间隔限制换版本频率。两者可通过 `--board-quiet-ms` / `--board-min-gap-ms` / `CAPITALIST_BOARD_RELOAD_*` 配置。
 */
const DEFAULT_BOARD_RELOAD_QUIET_MS = 8000;
const DEFAULT_BOARD_RELOAD_MIN_GAP_MS = 60000;

/**
 * 阶段卡死判定窗口：连续多少个 tick 无在途进展即报 stall。
 * 12 个 tick（默认每 tick 5 秒，约一分钟）足以区分执行中的长任务与不会再返回的派单。
 */
const STALL_TICKS = 12;

/** 传给启动器的一组参数。 */
interface WorkerSpawnOpts {
  model?: string | undefined;
  /** 推理强度；空表示按宿主默认 */
  effort?: string | undefined;
  cmd?: string | undefined;
  /** 是否为可见窗口模式 */
  visible?: boolean;
}
/**
 * 失败分片按退避间隔重派，避免每 tick 拉起新进程；连续失败到 {@link REDISPATCH_LIMIT} 停止并转 ask。
 * `CAPITALIST_RETRY_DELAYS_MS`（逗号分隔，毫秒）用于把间隔压到毫秒级做自动化验证，生产默认值不变。
 */
function retryDelaysMs(): readonly number[] {
  const raw = process.env.CAPITALIST_RETRY_DELAYS_MS;
  if (raw) {
    const parsed = raw
      .split(",")
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0);
    if (parsed.length > 0) return parsed;
  }
  return DEFAULT_RETRY_DELAYS_MS;
}
const DEFAULT_RETRY_DELAYS_MS = [60_000, 120_000, 240_000];

/**
 * 工作进程退出时判定这一单的失败原因。code 非 0 为常规崩溃；code 0 且无产出时按日志末尾
 * 判定，上游返回 429 时命中配额文案。不携带上游原文，账号链接、request-id 与会话 id 只留在日志。
 */
function workerExitReason(root: string, wid: string, code: number | null): string {
  if (code !== 0) return `worker 进程退出（code ${code ?? "?"}）`;
  let body = "";
  try {
    body = readLogTail(workerLogPath(root, wid), 200)
      .filter((l) => l.trim() && !isLogNoise(l))
      .join("\n")
      .trim();
  } catch {
    /* 日志被强杀截断时按无输出处理。 */
  }
  if (!body) return QUOTA_EXHAUSTED_TEXT;
  if (looksLikeQuota(body)) return QUOTA_EXHAUSTED_TEXT;
  /* 登录态不可用：进程以 code 0 退出，仅模型调用被拒，与静默退出区分。 */
  if (looksLikeAuth(body)) return AUTH_REQUIRED_TEXT;
  return `worker 进程退出（code 0）`;
}

/**
 * 判死结单，并把是否重试交给模型裁决。
 * 结单时写 `retry_verdict: "pending"`，调度层见 pending 不派；附重试历史次数与卡点，
 * 模型答完写 retry / give_up。失败原因无法由存活时长或失败次数机械区分，故交于判定层。
 * 登录态不可用属例外：判定通道同为该登录态，直接写 give_up。
 */
function failDispatchAndJudge(
  root: string,
  d: Dispatch,
  note: string,
  out: (s: string) => void,
): boolean {
  /*
   * 登录态不可用时不进入重试裁决：裁决需调用模型，同一登录态下同样失败，结果落到
   * 「判定通道不可用 → 按可重试处理」并反复重派。直接判死。
   */
  if (note === AUTH_REQUIRED_TEXT) {
    const ok = finishDispatch(root, d.id, "failed", note);
    if (!ok) return false;
    patchDispatch(root, d.id, { retry_verdict: "give_up", retry_why: note } as Partial<Dispatch>);
    recordEvent(root, "dispatch_auth_blocked", {
      dispatch: d.id,
      stage: d.stage,
      shard: d.shard ?? "",
    });
    out(`[监工] 派单 ${d.id} 判死：${AUTH_REQUIRED_TEXT}，不重派`);
    return true;
  }

  const chainKey = String((d as DispatchEx).lineage ?? d.id);
  const chain = readDispatches(root).filter((x) => String((x as DispatchEx).lineage ?? x.id) === chainKey);
  const attempts = chain.filter((x) => x.status === "failed").length + 1;
  const ok = finishDispatch(root, d.id, "failed", note);
  if (!ok) return false;
  patchDispatch(root, d.id, { retry_verdict: "pending", retry_count: attempts } as Partial<Dispatch>);
  /*
   * 同一类卡点第二次出现时沉淀为持久记忆，落在 `.capitalist/memory.json`，重启仍生效，
   * 后续派单与判定时作为硬约束注入。
   */
  if (attempts >= 2) rememberLesson(root, note, d.id);
  enqueueRetryJudgement(root, { ...d, note }, chain, attempts, out);
  /* `failDispatchAndJudge` 是所有判死路径的唯一出口，失败沿树传导只在此触发。 */
  if (attempts >= REDISPATCH_LIMIT) cascadeFailure(root, { ...d, note }, attempts, out);
  return true;
}

/**
 * 父节点失败到重派上限后，整棵子树同步判死，再由监工处理父节点失败原因，无法处理时等待人工检查。
 * 顺序固定：先停进程（让工作进程退出回调看到终态 `failed`，不二次结单），再写 `failed` 与
 * `retry_verdict: "give_up"`（否则 `requeueAdhoc` 会重新拉起整棵子树），最后记事件标明断裂的祖先。
 * `done` / `closed` 的子孙不动。
 * @returns 被级联判死的节点 id（没有子树、或子树已全部收工时为空）。
 */
function cascadeFailure(
  root: string,
  failed: Dispatch,
  attempts: number,
  out: (s: string) => void,
): string[] {
  const rows = readDispatches(root);
  const descendants = descendantsOf(rows, failed.id);
  if (descendants.length === 0) return [];

  const byId = new Map(rows.map((r) => [String(r.id), r] as const));
  const victims = descendants.filter((id) => {
    const r = byId.get(id);
    return r && r.status !== "done" && r.status !== "closed";
  });
  if (victims.length === 0) return [];

  const note = `上游 ${failed.id} 连续失败 ${attempts} 次（上限 ${REDISPATCH_LIMIT}）：级联判为失败，不再重试`;
  const at = new Date().toISOString();

  /* 停掉在跑的子孙；可见窗口不受监工管理，由 killJudgedWorker 内部排除。 */
  const stopped: string[] = [];
  for (const id of victims) {
    const wid = String(byId.get(id)?.worker ?? "");
    if (!wid) continue;
    const w = loadWorker(root, wid);
    if (!w) continue;
    if (w.status !== "running" && w.status !== "starting") continue;
    killJudgedWorker(root, w, true, out);
    saveWorker(root, { ...w, status: "failed" });
    stopped.push(w.id);
  }

  /* 判死并禁止重试。 */
  for (const id of victims) {
    const r = byId.get(id);
    if (!r) continue;
    if (r.status !== "failed") finishDispatch(root, id, "failed", note);
    patchDispatch(root, id, {
      retry_verdict: "give_up",
      retry_why: `级联失败：${note}`,
      cascade_from: failed.id,
      cascade_at: at,
    } as Partial<Dispatch>);
  }

  /* 留痕，标明导致级联的祖先。 */
  recordEvent(root, "dispatch_cascade_failed", {
    ancestor: failed.id,
    ancestor_lineage: String((failed as DispatchEx).lineage ?? failed.id),
    stage: failed.stage,
    shard: failed.shard ?? "",
    attempts,
    limit: REDISPATCH_LIMIT,
    nodes: victims,
    stopped_workers: stopped,
  });
  out(
    `[监工] ${failed.id} 连续失败 ${attempts} 次（上限 ${REDISPATCH_LIMIT}）：` +
      `子树 ${victims.length} 个节点级联判为失败、不再重试` +
      `${stopped.length > 0 ? `；已停止在跑进程 ${stopped.join("、")}` : ""}`,
  );

  /* 诊断父节点失败原因，见 handleBrokenParent。 */
  handleBrokenParent(root, failed, attempts, victims, out);
  return victims;
}

/** 诊断出的失败原因；`unknown` 表示规则无法识别，转人工。 */
type FailureCause =
  | "context_overflow"
  | "denied"
  | "model_down"
  | "proxy"
  | "env"
  | "unknown";

interface Diagnosis {
  cause: FailureCause;
  /** 原因在监工侧可处理（换会话、等待、改环境假设），修完可重跑。 */
  fixable: boolean;
  /** 命中的日志原文片段，或「没有可读日志」。 */
  evidence: string;
  /** 供展示的结论。 */
  summary: string;
}

/**
 * 判定失败原因的规则表。此步位于 `failDispatchAndJudge` 的同步路径上，调模型会拖住整个 tick，
 * 故先按关键词匹配；无法识别的转模型或人工。
 */
const FAILURE_RULES: Array<{ cause: FailureCause; re: RegExp; fixable: boolean; summary: string }> = [
  {
    cause: "context_overflow",
    re: /context[\s_-]*(window|length|limit)|maximum context|too many tokens|prompt is too long|上下文.{0,8}(超|上限|溢出)/i,
    fixable: true,
    summary: "上下文超限：更换会话重新执行，工作内容与判定不变",
  },
  {
    cause: "denied",
    re: /\b40[13]\b|unauthorized|forbidden|permission denied|not permitted|invalid api key|被拒|无权限|拒绝访问|认证失败/i,
    fixable: false,
    summary: "被拒（权限或凭证）：监工改不了这件事，需要人确认账号、凭证或授权范围",
  },
  {
    /*
     * 429、过载、额度类错误重试后原样失败，`fixable=false` 不自动重置；配合
     * `enqueueRetryJudgement` 的短路，第一次失败即 hold 并通知。正则含「额度 / 积分」，
     * 覆盖上游「额度已用尽」与本地「额度已耗尽」两种措辞。
     */
    cause: "model_down",
    re: /\b429\b|rate[ _-]?limit|too many requests|overloaded|\b529\b|服务过载|请求过于频繁|insufficient|余额不足|额度|积分|quota/i,
    fixable: false,
    summary: "模型额度不可用（耗尽 / 限流 / 过载）：额度恢复后把 retry_verdict 改回 retry 再重派",
  },
  {
    cause: "proxy",
    re: /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|EPIPE|\b50[234]\b|proxy|网络中断|连接被重置/i,
    fixable: true,
    summary: "代理或网络中断：属于环境抖动，等退避后重跑",
  },
  {
    cause: "env",
    re: /ENOENT|EACCES|EADDRINUSE|EBUSY|EPERM|ENOSPC|cannot find module|端口.{0,4}占用|磁盘空间/i,
    fixable: true,
    summary: "环境缺件（文件/端口/权限位）：修掉本地条件后重跑",
  },
];

/**
 * 读工作进程日志尾部若干行，取不到返回空串（进程被强杀时日志可能不存在）。
 * 取 200 行 / 24KB 而非更小的窗口，避免前部的 429 额度说明被截断而误判为可重试。
 */
function workerLogTail(root: string, worker: string, lines = 200): string {
  if (!worker) return "";
  try {
    const raw = readFileSync(join(root, ".capitalist", "workers", `${worker}.log`), "utf8");
    /* 先剥纯思考行再截窗口：思考 JSON 单行很长，不过滤会占满窗口把 429 说明切掉。 */
    const clean = withoutThinking(raw.split(/\r?\n/).filter((l) => l.trim()));
    return clean.lines.slice(-lines).join("\n").slice(-24000);
  } catch {
    return "";
  }
}

/**
 * 诊断失败到上限的父节点：读日志尾部按规则认原因，只判「该原因能否由监工处理」。
 * 是否重置由 {@link handleBrokenParent} 结合子树已重置次数决定。
 */
function diagnoseFailure(root: string, d: Dispatch): Diagnosis {
  const tail = workerLogTail(root, String(d.worker ?? ""));
  const hay = `${tail}\n${String(d.note ?? "")}`;
  if (!tail.trim()) {
    return {
      cause: "unknown",
      fixable: false,
      evidence: "没有可读的 worker 日志（进程被强杀或启动即失败）",
      summary: "没有日志可查，无法判断失败原因",
    };
  }
  for (const rule of FAILURE_RULES) {
    const m = hay.match(rule.re);
    if (!m) continue;
    /* 命中位置前后各取一段原文，作为判断依据留在事件里。 */
    const at = Math.max(0, (m.index ?? 0) - 60);
    return {
      cause: rule.cause,
      fixable: rule.fixable,
      evidence: hay.slice(at, at + 220).replace(/\s+/g, " "),
      summary: rule.summary,
    };
  }
  return {
    cause: "unknown",
    fixable: false,
    evidence: tail.slice(-400).replace(/\s+/g, " "),
    summary: "日志里没有可归类的失败特征，无法判断原因",
  };
}

/** 子树按「可修原因」自动重置的上限；超过后转人工，避免无限重试。 */
const CASCADE_AUTO_RESET_MAX = 1;

/**
 * 父节点断掉后的接手动作：能修则重跑子树（父节点开一张继承血缘的后续单，子孙原地重开），
 * 即换会话或换时机重跑；修不了（被拒、无法识别、已自动重置过）则登记待裁决问题并标阻塞。
 * 级联后必须有人接手，否则成为静默失败。
 */
function handleBrokenParent(
  root: string,
  failed: Dispatch,
  attempts: number,
  victims: string[],
  out: (s: string) => void,
): void {
  const dg = diagnoseFailure(root, failed);
  recordEvent(root, "dispatch_cascade_diagnosed", {
    ancestor: failed.id,
    cause: dg.cause,
    fixable: dg.fixable,
    evidence: dg.evidence,
    summary: dg.summary,
    attempts,
  });

  if (!dg.fixable) {
    escalateCascade(root, failed, dg, dg.summary, out);
    return;
  }

  const resets = Number((failed as DispatchEx).cascade_resets ?? 0);
  if (resets >= CASCADE_AUTO_RESET_MAX) {
    escalateCascade(
      root,
      failed,
      dg,
      `${dg.summary}；但这棵子树已自动重置过 ${resets} 次仍然失败，说明原因判断不成立`,
      out,
    );
    return;
  }

  resetSubtree(root, failed, victims, dg, resets + 1, out);
}

/**
 * 重置子树重跑：父节点开一张后续单，子孙原地重开。
 * 父节点的失败历史须留在台账（`attempt` / `retry_count` 为判断依据），故另起新记录、血缘不变；
 * 子节点属级联失败、无失败历史，原地改回 open，并把 `parent` 指向新父单，否则树边仍挂在
 * 已 failed 的记录上导致门禁不放行。
 */
function resetSubtree(
  root: string,
  failed: Dispatch,
  victims: string[],
  dg: Diagnosis,
  resets: number,
  out: (s: string) => void,
): void {
  const de = failed as DispatchEx;
  const nextId = newDispatchId();
  const next: Dispatch = {
    id: nextId,
    at: new Date().toISOString(),
    stage: failed.stage,
    shard: failed.shard ?? "",
    action: stripAttachments(String(failed.action ?? "")),
    status: "open",
    source: "requeue",
    attempt: Number(failed.attempt ?? 1) + 1,
    lineage: String(de.lineage ?? failed.id),
    atts: [],
    ...(de.title ? { title: de.title } : {}),
    ...(failed.tags ? { tags: failed.tags } : {}),
    ...(failed.parent ? { parent: String(failed.parent) } : {}),
    ...(failed.parent_reason ? { parent_reason: String(failed.parent_reason) } : {}),
    ...(Array.isArray(failed.after) && failed.after.length ? { after: [...failed.after] } : {}),
    ...(de.model ? { model: de.model } : {}),
    ...(de.model_fallback ? { model_fallback: de.model_fallback } : {}),
    cascade_resets: resets,
  };
  appendDispatch(root, next);
  ensureTaskForDispatch(root, next);

  for (const id of victims) {
    const r = readDispatches(root).find((x) => x.id === id);
    if (!r || r.status !== "failed") continue;
    const linked = String(r.parent ?? "") === "" || String(r.parent ?? "") === failed.id;
    patchDispatch(root, id, {
      status: "open",
      retry_verdict: "retry",
      retry_why: `子树重置后重跑（源 ${failed.id} → ${nextId}）：${dg.summary}`,
      ...(linked ? { parent: nextId } : {}),
      ...(linked ? { parent_reason: String(r.parent_reason ?? "父节点重置后重跑") } : {}),
      ...(r.worker ? { worker: "" } : {}),
      ...(r.session ? { session: "" } : {}),
    } as Partial<Dispatch>);
  }

  recordEvent(root, "dispatch_subtree_reset", {
    ancestor: failed.id,
    replacement: nextId,
    cause: dg.cause,
    evidence: dg.evidence,
    resets,
    nodes: victims,
  });
  out(
    `[监工] ${failed.id} 的失败原因可修（${dg.cause}：${dg.summary}）：` +
      `重置子树重跑 → ${nextId}（第 ${resets} 次自动重置），子树 ${victims.length} 个节点重开`,
  );
}

/**
 * 转人工：登记待裁决问题并标阻塞。`capitalist ask` 使问题可见，`capitalist block` 使调度停下；
 * 仅 ask 会被超时宽限放过，仅 block 则看不到停机原因，两者须同时具备。
 */
function escalateCascade(
  root: string,
  failed: Dispatch,
  dg: Diagnosis,
  why: string,
  out: (s: string) => void,
): void {
  patchDispatch(root, failed.id, {
    retry_verdict: "give_up",
    retry_why: `子树已级联判死，转人工：${why}`,
  } as Partial<Dispatch>);

  const marker = `级联失败 ${failed.id}`;
  if (!openAsks(root).some((q) => askText(q).includes(marker))) {
    raiseAsk(
      root,
      `${marker}：${why}。该子树已全部判为失败并停止，需要人工决定重跑还是放弃`,
      [
        `失败的节点：${failed.id}（${String((failed as DispatchEx).title ?? "").slice(0, 40)}）`,
        `连续失败 ${Number(failed.retry_count ?? 0) || "?"} 次后级联判死`,
        `诊断原因：${dg.cause}｜${dg.summary}`,
        `判断依据：${dg.evidence.slice(0, 400)}`,
        "处置：确认原因后执行 capitalist answer 本问题；重跑时把该节点的 retry_verdict 改回 retry 并重开",
      ].join("\n"),
      failed.stage,
      "" /* 整阶段级：父节点失败后，该树上的单不再自动推进。 */,
    );
  }

  updateState(root, (s) => {
    const list = Array.isArray(s.blockers) ? [...(s.blockers as unknown[])] : [];
    const dup = list.some((b) => String((b as Record<string, unknown>)?.reason ?? "").includes(marker));
    if (!dup) list.push({ type: "cascade", reason: `${marker}：${why}`, since: new Date().toISOString() });
    s.blockers = list;
  });

  recordEvent(root, "dispatch_cascade_escalated", {
    ancestor: failed.id,
    cause: dg.cause,
    evidence: dg.evidence,
    why,
  });
  out(`[监工] ${failed.id} 的失败原因处理不了（${dg.cause}：${why}）：已登记待裁决并标阻塞，等人工检查`);
}

/** 重试判定的异步池（与 triage 分开：两个池子各自限流，不互相排队）。 */
const retryQueue: Array<() => Promise<void>> = [];
let retryRunning = 0;
const RETRY_POOL_MAX = 2;

function pumpRetry(): void {
  while (retryRunning < RETRY_POOL_MAX) {
    const job = retryQueue.shift();
    if (!job) return;
    retryRunning += 1;
    void job()
      .catch(() => {})
      .finally(() => {
        retryRunning -= 1;
        pumpRetry();
      });
  }
}

function enqueueRetryJudgement(
  root: string,
  d: Dispatch,
  chain: Dispatch[],
  attempts: number,
  out: (s: string) => void,
): void {
  retryQueue.push(async () => {
    /*
     * 模型服务不可用或被拒属不可自愈失败，首次即置 hold、不进模型裁决，避免重试持续原样失败。
     * 置 hold 而非 give_up：服务或凭证恢复后把 verdict 改回 retry 触发重派。
     */
    const dg = diagnoseFailure(root, d);
    if (dg.cause === "model_down" || dg.cause === "denied") {
      patchDispatch(root, d.id, {
        retry_verdict: "hold",
        retry_why: `${dg.summary}（依据：${dg.evidence}）`,
      } as Partial<Dispatch>);
      recordEvent(root, "retry_held", {
        dispatch: d.id,
        stage: d.stage,
        shard: d.shard ?? "",
        attempts,
        why: `${dg.summary}｜${dg.evidence}`,
      });
      out(`[监工] 第 ${attempts} 次失败命中不可自愈原因（${dg.cause}），暂停重派：${dg.summary}`);
      return;
    }
    const verdict = await judgeRetry(root, d, chain, attempts);
    if (verdict.decision === "hold") {
      /* 卡点未消除时记 hold，调度层见 hold 不派，理由写入 `retry_why`；卡点解除后可改回 retry。 */
      patchDispatch(root, d.id, { retry_verdict: "hold", retry_why: verdict.why } as Partial<Dispatch>);
      recordEvent(root, "retry_held", {
        dispatch: d.id,
        stage: d.stage,
        shard: d.shard ?? "",
        attempts,
        why: verdict.why,
        fallback: verdict.fallback === true,
      });
      out(`[监工] 核对卡点未消除，暂不重派（第 ${attempts} 次失败后）：${verdict.why}`);
      return;
    }
    if (verdict.decision === "give_up") {
      patchDispatch(root, d.id, { retry_verdict: "give_up", retry_why: verdict.why } as Partial<Dispatch>);
      recordEvent(root, "retry_refused", {
        dispatch: d.id,
        stage: d.stage,
        shard: d.shard ?? "",
        attempts,
        why: verdict.why,
        fallback: verdict.fallback === true,
      });
      out(`[监工] 判定不再重试（第 ${attempts} 次失败后）：${verdict.why}`);
      return;
    }
    patchDispatch(root, d.id, { retry_verdict: "retry", retry_why: verdict.why } as Partial<Dispatch>);
    recordEvent(root, "retry_allowed", {
      dispatch: d.id,
      stage: d.stage,
      shard: d.shard ?? "",
      attempts,
      why: verdict.why,
      fallback: verdict.fallback === true,
    });
    out(`[监工] 判定可以再试（第 ${attempts} 次失败）：${verdict.why}`);
  });
  pumpRetry();
}

/** 判定的输入：重试历史 + 卡点。给模型的是事实，不是结论。 */
async function judgeRetry(
  root: string,
  d: Dispatch,
  chain: Dispatch[],
  attempts: number,
): Promise<{ decision: "retry" | "give_up" | "hold"; why: string; fallback?: boolean }> {
  /* 只向模型提供事实（失败次数、原因、存活时长、末尾输出），不预设放弃阈值，由模型裁决。 */
  const facts: string[] = [
    `这一单要做什么：${String(d.action ?? "").replace(/\s+/g, " ").slice(0, 700)}`,
    `这条链累计失败 ${attempts} 次`,
  ];
  const hist = chain
    .filter((x) => x.status === "failed" || x.status === "open" || x.status === "claimed")
    .slice(-6);
  hist.forEach((x, i) => {
    const note = String(x.note ?? "无说明").replace(/\s+/g, " ").slice(0, 140);
    const dur =
      x.claimed_at && x.done_at
        ? Math.round((Date.parse(String(x.done_at)) - Date.parse(String(x.claimed_at))) / 1000)
        : null;
    facts.push(`第 ${i + 1} 次：${note}${dur !== null ? `（这个进程活了 ${dur} 秒）` : ""}`);
  });
  const wid = String(d.worker ?? "");
  if (wid) {
    try {
      const raw = readFileSync(join(root, ".capitalist", "workers", `${wid}.log`), "utf8");
      /* 须先过滤全量思考 JSON 再取尾部：思考行单行很长，先取尾部会把真正的报错挤出字符预算。 */
      const clean = withoutThinking(raw.split(/\r?\n/).filter((l) => l.trim()));
      const tail = tailWithinChars(clean.lines, 1800);
      facts.push(
        `它死之前日志的最后几行${clean.dropped ? `（另有 ${clean.dropped} 行思考过程，已略去）` : ""}：\n${tail}`,
      );
    } catch {
      facts.push("它死之前没有留下可读的日志（进程被强杀或启动即失败）");
    }
  }
  /* 历史卡点记忆作为「卡点是否消除」的核对输入。 */
  const lessons = memoriesFor(root, String(d.action ?? "")).slice(0, 5);
  if (lessons.length) facts.push(renderMemoryConstraints(lessons));

  const r = await decide({
    root,
    question: "这一单还要不要再试一次？先核对上一轮的卡点（失败原因、阻塞项）是否已经消除，再作判断。",
    facts,
    actions: [
      {
        name: "retry",
        desc: "再试一次：卡点已消除或本来就该换个时机（环境抖动、端口/文件被临时占用、并发撞车、外部服务超时）",
      },
      {
        name: "give_up",
        desc: "不再试：再试也一样（缺权限或缺依赖、要求本身做不到、方案方向错了）",
      },
      {
        name: "hold",
        desc: "暂不重派：上一轮的卡点核对后仍未消除（缺的依赖还在、前置单未完成、同一处报错未修），重派只会在同一个地方再失败一次",
      },
    ],
    session: "capitalist-brain-retry",
  });

  if (r.fallback) {
    /*
     * 判定通道自身登录态不可用时按判死处理：同一登录态下裁决不可恢复，重派结果相同。
     * 其余通道故障（超时、解析失败）仍按可重试处理。
     */
    if (looksLikeAuth(String(r.error ?? ""))) {
      return { decision: "give_up", why: AUTH_REQUIRED_TEXT, fallback: true };
    }
    /* 通道不可用时按可重试处理。 */
    return { decision: "retry", why: "判定通道不可用，按可重试处理", fallback: true };
  }
  const give = r.actions.find((a) => a.name === "give_up");
  const hold = r.actions.find((a) => a.name === "hold");
  const why = String(r.actions[0]?.why ?? "").slice(0, 200) || "(模型未给理由)";
  /* hold 优先于 give_up：卡点解除后仍可重派，give_up 为终态。 */
  if (hold) return { decision: "hold", why };
  return give ? { decision: "give_up", why } : { decision: "retry", why };
}

/**
 * 同一分片连续失败上限：初始派单后最多自动重派 2 次，第 3 次失败登记 ask 转交裁决并附失败历史；
 * 成功一次（done）清零。
 */
const REDISPATCH_LIMIT = 3;

/**
 * 硬停阈值：连续失败到该次数才真正停止自动重派并登记 ask。
 * {@link REDISPATCH_LIMIT} 到达后仍继续派并升级诊断，以区分偶发失败与契约本身无法完成。
 */
const HARD_STOP_FAILURES = 8;

/* `ASK_BLOCK_MS` 定义在 core/limits.ts，`capitalist report` 的结单判断共用，避免两处数值分叉。 */

interface StageParallel {
  id: string;
  /** 契约里这一片的中文标题；派单落库时写入 `title`，界面只读它。 */
  title?: string | undefined;
  action: string;
  /** 分片级模型，优先级低于契约 default_model 与 --worker-model。 */
  model?: string | undefined;
  /** 是否为必需分片。缺省视为必需（true）；false 为可选项，未达记欠账但允许推进。 */
  required?: boolean | undefined;
}

/** 派单上的扩展字段（不并入核心类型定义，运行时落盘）。 */
interface DispatchEx extends Dispatch {
  /** 这一单的中文标题；建单时写入，老记录读侧按分片映射补齐。 */
  title?: string;
  model?: string;
  model_fallback?: string;
  model_fallback_used?: boolean;
  required?: boolean;
  /** 最近一次被用户消息唤醒的时间（ISO）；宽限期内的在途单不因阶段推进被作废。 */
  wake_at?: string;
  /** 阶段卡死检测强制结单的标记；语义为「确认已死」，不占重派退避窗口，失败计数与重派上限照常。 */
  forced?: boolean;
}

/**
 * 看板服务的类型别名（`serveBoard` 的签名）。
 * `board.ts` 反向引用本文件的 pause 读取，静态 import 会成初始化环，故运行时再 `import()`，此处只用类型。
 */
type ServeFn = (opts: ServeOptions) => Promise<Served>;

/** 提取异常消息；非 Error 也能读成文本。 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 取一个正毫秒值：显式参数 > 环境变量 > 缺省值。
 * 非有限值或非正数一律视为未提供并回落，0 与 NaN 不作有效值（会关闭重启节流）。
 */
function positiveMs(explicit: number | undefined, fromEnv: string | undefined, fallback: number): number {
  for (const v of [explicit, fromEnv === undefined ? undefined : Number(fromEnv)]) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  return fallback;
}

/**
 * 并行度说明。上限由用户设定，不与阶段分片数取小，故只报当前上限。
 * @param capacity 实际并行度
 * @param cap `--workers` 给出的上限
 */
function concurrencyLabel(capacity: number, cap: number): string {
  return `并行度 ${capacity}（上限 ${cap}）`;
}

/** 看板编译产物目录 `dist/supervisor/board/`；只认 dist，src 未构建时重新服务仍是旧产物。 */
function boardDistDir(): string {
  return join(__dirname, "board");
}

/**
 * 当前看板产物的版本标识：全部文件 mtime 之和 + 文件数。构建整批重写产物，任一文件变化都会改变该和，
 * 只读取目录，不把产物读入内存。
 * @returns 目录读不到时返回 null，不参与重启判定。
 */
function boardBuildStamp(): { stamp: string; files: number } | null {
  const dir = boardDistDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let sum = 0;
  let files = 0;
  for (const name of names) {
    try {
      const st = statSync(join(dir, name));
      if (!st.isFile()) continue;
      sum += st.mtimeMs;
      files += 1;
    } catch {
      /* 单个文件读不到不影响整体判定。 */
    }
  }
  return { stamp: `${files}:${sum}`, files };
}

/**
 * 清掉看板产物的模块缓存，否则 `require("./board")` 仍取回启动时的旧模块。
 * 范围是 board 依赖树里位于 `dist/supervisor` 下的模块（含 `board.js` 及其分片），
 * 不含 `dist/core`（其共享可变状态清除后会使 loop 与 board 各持一份实例），也不含 `loop.js` 自身。
 * `dist/core` 的更新须靠完整重启。
 */
function clearBoardModuleCache(): void {
  const supervisorDir = __dirname;
  const targets = new Set<string>();
  const walk = (id: string): void => {
    if (targets.has(id)) return;
    targets.add(id);
    const m = require.cache[id];
    if (m) for (const c of m.children) walk(c.id);
  };
  walk(join(supervisorDir, "board.js"));
  for (const id of targets) {
    /* 不清 loop.js 自身，避免两套调度并存。 */
    if (id === __filename) continue;
    if (!id.startsWith(supervisorDir)) continue;
    delete require.cache[id];
  }
}

/**
 * `dist/core/*.js` 的内容指纹（sha1），用于判断本次构建是否改动 core。
 * 热重载只换 `dist/supervisor` 下的模块，不换 `dist/core`（共享可变状态），故 core 一变就必须完整重启。
 * 按内容而非 mtime 判断：tsc 每次构建重写全部产物，mtime 必变，按 mtime 会禁止所有热重载。
 * @returns 目录读不到时返回 null，按「无法判断」处理，不阻断热重载。
 */
export function coreContentHash(): string | null {
  const dir = join(__dirname, "..", "core");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".js")).sort();
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  const h = createHash("sha1");
  for (const n of names) {
    try {
      h.update(n);
      h.update(readFileSync(join(dir, n)));
    } catch {
      /* 单个文件读不到不影响整体判断。 */
    }
  }
  return h.digest("hex");
}

/**
 * 启动监工进程。
 *
 * 建立任务根（`root` 下没有 `.capitalist` 时按契约新建），随后按 tick 循环派单与验收。
 * 返回值是进程退出码：0 表示正常结束（`once` 完成、达到 `maxTicks`、或收到停止请求），
 * 非 0 表示启动阶段失败。
 *
 * 失败情形：任务根不可写或契约文件缺失时抛异常；`once` 与 `maxTicks` 都未给时不会自行
 * 退出，需要外部发停止请求或收到 SIGTERM。
 */
export async function runSupervisor(opts: SupervisorOptions): Promise<number> {
  const out = opts.out ?? ((s: string) => process.stdout.write(`${s}\n`));
  const tickSec = opts.tickSec ?? DEFAULT_TICK;
  const workerTimeoutSec = opts.workerTimeoutSec ?? DEFAULT_WORKER_TIMEOUT;
  const stuckSec = normalizeStuckSec(opts.stuckSec ?? process.env.CAPITALIST_STUCK_SEC ?? DEFAULT_STUCK_SEC);

  const spawnWorkers = opts.spawnWorkers !== false;
  // 退出清理表是模块级单例，复位以免同进程内重复调用时沿用上一轮的「已清理」标记。
  __resetDisposers();
  const host = opts.workerHost ?? detectWorkerHost();
  if (spawnWorkers && !host && !opts.workerCmd) {
    /*
     * 工作进程仅从当前宿主所属的产品族中选取。跨族选用会借用另一个产品线的登录态，
     * 表现是「界面显示已登录、派单却报 Authentication required」。
     */
    const cur = currentHost();
    const scope = cur ? siblings(cur) : workerHosts();
    const options = scope
      .filter((impl) => impl.worker?.detectPriority !== undefined)
      .map((impl) => impl.worker?.key ?? impl.id);
    const curLabel = byId(cur)?.label ?? cur ?? "未判定";
    out(
      options.length
        ? `[监工] 当前宿主 ${curLabel} 的同族中未找到可用的工作进程入口：需要下列之一：${options.join(" / ")}。`
        : `[监工] 当前宿主 ${curLabel} 没有同族的工作进程入口，且不跨族选用工作进程：其他产品族的 CLI 不共用登录态。`,
    );
    out("[监工] 安装同族 CLI 后重试，或用 --worker-cmd 给出启动命令。");
    out("[监工] 也可以改用 --no-spawn：监工只派单，由另一个会话 capitalist next 领。");
    return 1;
  }
  // 没指定也没探测到时，仍要记一个宿主值：--no-spawn 模式下它只是记录，不拉起进程。
  const curHost = currentHost();
  const scoped = curHost ? [byId(curHost), ...siblings(curHost)] : workerHosts();
  const chosenHost: WorkerHost =
    /* 显式传入的值先归一到 impl 声明的规范 key，避免把别名写进状态与日志。 */
    (host ? workerImpl(host)?.worker?.key : undefined) ??
    scoped.find((impl) => impl?.worker?.detectPriority !== undefined)?.worker?.key ??
    workerHosts()[0]?.worker?.key ??
    "custom";
  if (opts.workerHost && !workerImpl(opts.workerHost)) {
    out(`[监工] 未知宿主：${opts.workerHost}。可用：${workerHosts().map((i) => i.worker?.key).join(" / ")}`);
    return 1;
  }

  const effort = normalizeEffort(opts.workerEffort);
  if (effort.bad) {
    out(
      `[监工] --effort ${String(opts.workerEffort)} 不是合法档位（${EFFORT_LEVELS.join(" / ")}），按 ${effort.value} 跑。`,
    );
  }
  const wopts: WorkerSpawnOpts = {
    model: opts.workerModel,
    effort: effort.value,
    cmd: opts.workerCmd,
    visible: opts.workerVisible === true,
  };

  // 实例租约 `.capitalist/locks/<task>.lock` 记录任务根持有者，检查先于 supervisor.json 的单实例检查。
  // 存活租约（进程在、心跳在窗口内）拒绝启动；--force 仅在持有者心跳超时后允许取代，
  // 取代前把旧实例标 superseded 并记事件。
  const leaseTask = leaseTaskName(opts.root);
  const prevLease = readLease(opts.root, leaseTask);
  /*
   * 持有者只要进程还在就拒绝接管，不看心跳窗口：心跳超时可能只是它卡在一次长调用上，
   * 同一任务根仅允许一个监工实例。
   * 需要强制接管时使用 --force。pid 已消失时按常规接管，并将旧租约标记为 superseded。
   */
  if (prevLease && prevLease.status === "running" && pidAlive(prevLease.pid) && !opts.force) {
    out(
      `[监工] 实例租约被持有：pid ${prevLease.pid}，启动于 ${prevLease.started_at}（.capitalist/locks/${leaseTask}.lock）。`,
    );
    out("[监工] 该进程仍在运行，不接管。需要强制接管时：先执行 capitalist supervise-stop，或使用 --force。");
    return 1;
  }

  // 单实例：两个监工循环共用一个任务根会重复派单、重复拉起工作进程。
  // 与租约一致按 pid 判定；心跳停顿不表示进程已退出。
  const existing = loadSupervisor(opts.root);
  if (
    existing &&
    existing.status === "running" &&
    existing.pid !== process.pid &&
    pidAlive(existing.pid) &&
    !opts.force
  ) {
    out(`[监工] 已有监工在跑（pid ${existing.pid}，第 ${existing.ticks} 轮）。接管前先 capitalist supervise-stop，或加 --force。`);
    const liveBoard = String(existing.board_url ?? "").trim();
    if (liveBoard) out(`[监工] 看板：${liveBoard}`);
    return 1;
  }
  clearStopFlag(opts.root);

  // 监工建根。执行侧不参与这一步。
  const boot = ensureRoot(opts);
  if (!boot.ok) {
    out(boot.message);
    return 1;
  }
  if (boot.created) out(`[监工] 已建任务根：${opts.root}`);

  const myLease = newInstanceLease(process.pid, Math.max(tickSec * 3, 30));
  if (prevLease && prevLease.status === "running" && pidAlive(prevLease.pid)) {
    // 进程仍在但心跳已超窗：取代前先把卡死实例标为下线。
    writeLease(opts.root, leaseTask, {
      ...prevLease,
      status: "superseded",
      superseded_at: new Date().toISOString(),
      superseded_by: myLease.instance_id,
    });
    recordEvent(opts.root, "instance_superseded", {
      instance: prevLease.instance_id,
      pid: prevLease.pid,
      started_at: prevLease.started_at,
      superseded_by: myLease.instance_id,
      forced: opts.force === true,
    });
    out(`[监工] 旧实例 ${prevLease.instance_id}（pid ${prevLease.pid}）心跳已超时，标记 superseded 并接管`);
  }
  writeLease(opts.root, leaseTask, myLease);

  // 部分宿主首次进入目录会停在信任确认，非交互模式下无输出且无法授权写文件；
  // 该前置条件由 impl 的 workspace facet 处理，无此 facet 的宿主不写项目配置。
  if (spawnWorkers) {
    const workspace = workerImpl(chosenHost)?.workspace;
    if (workspace) {
      const r = workspace.prepare(opts.root);
      if (r.added) out(`[监工] ${r.message}`);
      else if (!r.ok) out(`[监工] 工作区准备未完成（不影响启动，但可能停在确认页）：${r.message}`);
    }
  }

  const state0 = loadState(opts.root);
  const contract0 = state0
    ? loadContract(state0.contract_path) ?? loadContract(state0.contract, skillDirs())
    : null;
  if (!state0 || !contract0) {
    out("[监工] 任务根状态或任务列表不可读，退出");
    return 1;
  }

  /*
   * 启动默认不派单：上次退出时未完成的派单统一暂停，队列原样保留，等用户唤醒。
   *
   * 暂停是派单级标记，不写全局暂停：宿主侧新派入的单没有该标记，可以立即执行，
   * 旧单则停在队列里等用户确认。无待办时不写任何标记，直接进入待命。
   * 两种状态都保持在线，不退出进程。
   */
  const pendingWork0 = hasPendingWork(opts.root, contract0, state0);
  if (!pendingWork0) {
    out("[监工] 无待办任务：待命在线（不派单、不轮询），等待派单");
  } else if (!opts.autoStart) {
    /* 旧版本在启动时写全局暂停标记；那是监工写的，不是用户动作，迁移为逐单暂停后删除。 */
    if (readPause(opts.root)?.by === "supervisor") {
      try {
        unlinkSync(pausePath(opts.root));
        out("[监工] 已移除上次启动写入的全局暂停标记：改为逐单暂停，不再阻塞新派单");
      } catch {
        /* 删除失败时保留原状，全局暂停继续生效。 */
      }
    }
    const held = holdLegacyDispatches(opts.root);
    /* 重复启动时本次未新增标记；队列中仍有上次启动时暂停的派单，此时不判定为全部结项。 */
    const stillHeld = pausedDispatches(opts.root).length;
    out(
      held > 0
        ? `[监工] ${held} 张上次未完成的派单已暂停（不影响新派单）。确认后执行 capitalist wake --user，或在看板逐单唤醒。`
        : stillHeld > 0
          ? `[监工] ${stillHeld} 张派单保持暂停（此前已标记）。确认后执行 capitalist wake --user，或在看板逐单唤醒。`
          : "[监工] 启动默认不派单：现有派单均已结项，等待用户派单。",
    );
  }

  // 并行度上限只由用户设定（--workers 或运行时指令），不按阶段分片数取小；命令行缺省取 3。
  const maxWorkers = Math.max(1, opts.workers ?? DEFAULT_WORKERS);
  // 不 spawn 时并行度记 0，使 fillSlots 直接返回，派单留在 open 等外部领取。
  const capacity0 = spawnWorkers ? maxWorkers : 0;

  let rec: SupervisorRecord = {
    pid: process.pid,
    status: "running",
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    heartbeat_ts: Date.now() / 1000,
    target: state0.target,
    contract: contract0.name,
    tick_sec: tickSec,
    worker_timeout_sec: workerTimeoutSec,
    stuck_sec: stuckSec,
    ticks: 0,
    max_workers: capacity0,
    worker_host: spawnWorkers ? chosenHost : "none",
    /* 启动时的宿主声明落盘：重启后的看板与独立进程按同一份声明选凭证族与对话通道。 */
    ...(currentHost() ? { host: currentHost() as string } : {}),
    effort: effort.value,
    /* 监工对话层模型；空为宿主默认。 */
    supervisor_model: String(opts.supervisorModel ?? "").trim(),
    /* 默认模型与追加黑名单只认平台 impl 声明的模型命名。 */
    ...(String(opts.defaultModel ?? "").trim() ? { default_model: String(opts.defaultModel).trim() } : {}),
    ...(String(opts.modelDenylist ?? "").trim()
      ? { model_denylist: String(opts.modelDenylist).split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean) }
      : {}),
    /* 监工对话上下文配置上限，与模型实际上限取小后作为面板显示值与超限阈值。 */
    supervisor_context_limit: Math.max(
      1,
      Math.round(Number(opts.supervisorContextLimit ?? DEFAULT_SUPERVISOR_CONTEXT_LIMIT) || DEFAULT_SUPERVISOR_CONTEXT_LIMIT),
    ),
    // --force 同时清熔断，避免上一次失败计数挡住重试。
    ...(opts.force ? { retry_from: new Date().toISOString() } : {}),
  };
  saveSupervisor(opts.root, rec);

  // --force 清熔断须落到计数起算点：仅写 retry_from 不清 shardRetry 计数，重派上限仍成立。
  if (opts.force) {
    updateState(opts.root, (s) => {
      const map = { ...((s.retry_resets as Record<string, string> | undefined) ?? {}) };
      map["*"] = new Date().toISOString();
      s.retry_resets = map;
    });
  }

  out(`[监工] 已接管 ${opts.root}`);
  /* 记忆按任务根存于 `.capitalist/memory.json`，启动时加载一次并裁掉过期 / 超限条目，不清空、不重置。 */
  const mem = primeMemory(opts.root);
  if (mem.length) {
    const habits = mem.filter((e) => e.kind === "habit").length;
    out(`[监工] 记忆 ${mem.length} 条（习惯 ${habits} / 卡点 ${mem.length - habits}）已加载`);
  }
  out(`[监工] 目标：${state0.target} ｜ 任务列表：${contract0.name}（${contract0.domain || "未标注领域"}）`);
  out(
    `[监工] 工作进程：${spawnWorkers ? `${chosenHost}（自动拉起）` : "外部会话 capitalist next 领单"} ｜ ${concurrencyLabel(
      capacity0,
      maxWorkers,
    )}${opts.workers === undefined ? "（--workers 未指定，取缺省）" : ""}`,
  );
  out(`[监工] tick ${tickSec}s，worker 超时 ${workerTimeoutSec}s。Ctrl-C 停止。`);
  if (spawnWorkers) {
    out("[监工] 工作进程沿用宿主登录态，认证由宿主 CLI 完成");
    if (wopts.visible) out("[监工] 启动方式：可见窗口（每个 worker 独占一个控制台，卡点直接可见）");
  }

  // 看板随监工起停、按构建产物重启；启动失败只报一行原因，不阻断监工。
  const boardEnabled = opts.board !== false;
  // 合并参数可配；自动化验证把它们压到毫秒级以在一次测试内触发多次构建。
  const boardReloadQuietMs = positiveMs(
    opts.boardQuietMs,
    process.env.CAPITALIST_BOARD_RELOAD_QUIET_MS,
    DEFAULT_BOARD_RELOAD_QUIET_MS,
  );
  const boardReloadMinGapMs = positiveMs(
    opts.boardMinGapMs,
    process.env.CAPITALIST_BOARD_RELOAD_MIN_GAP_MS,
    DEFAULT_BOARD_RELOAD_MIN_GAP_MS,
  );
  // 用持有对象装当前 server：赋值在闭包内，普通 let 会被流分析当成恒为 null。
  const boardRef: { serving: Served | null } = { serving: null };
  /** 当前正在服务的看板实现；重启失败时用它恢复旧版。 */
  let boardServe: ServeFn | null = null;
  /** 当前正在服务的产物版本（见 boardBuildStamp），用于判定是否需要重启。 */
  let boardStamp: string | null = null;
  /* 启动那一刻 core 产物的内容指纹；热重载前与它比，变了就不能热重载。 */
  let coreHashAtBoot: string | null = null;
  /* 待重启的产物版本与首次被看到的时刻；一次 build 横跨数秒，重启须待版本稳定并留足间隔。 */
  let boardPendingStamp: string | null = null;
  let boardPendingSince = 0;
  let boardLastReload = 0;

  /**
   * 加载看板产物并预检（清缓存 → 重新 require → 确认前端产物在位）；
   * 预检在关旧服务之前，挡住无法运行的新产物。
   */
  const loadBoardModule = async (): Promise<{ ok: true; serve: ServeFn } | { ok: false; message: string }> => {
    clearBoardModuleCache();
    try {
      const mod = (await import("./board")) as { serveBoard?: ServeFn };
      if (typeof mod.serveBoard !== "function") return { ok: false, message: "board 模块没有导出 serveBoard" };
      /* 看板仅提供 Vue 版本：产物缺失时页面无法加载，预检须拦截并给出构建步骤。 */
      const index = join(__dirname, "..", "board-web", "index.html");
      if (!existsSync(index)) {
        return { ok: false, message: "缺少前端产物 dist/board-web/index.html（先运行 npm run build:web）" };
      }
      return { ok: true, serve: mod.serveBoard };
    } catch (err) {
      return { ok: false, message: errText(err) };
    }
  };

  /*
   * 可被申报唤醒的等待：`POST /api/mq` 调 `wake()` 提前结束本轮空闲。
   * `idle` 仍是「最多等 ms」，推送只决定响应快慢，消息以队列文件为准；推送丢失只放慢响应，消息不丢失。
   */
  let wakeTick: (() => void) | null = null;
  const wake = (): void => {
    wakeTick?.();
  };
  const idle = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        wakeTick = null;
        resolve();
      };
      timer = setTimeout(finish, ms);
      wakeTick = finish;
    });

  /** 起看板并把它记进状态：地址既打给终端，也落 supervisor.json 供 `capitalist status` 用。 */
  const serveBoardNow = async (serve: ServeFn, record: boolean): Promise<Served> => {
    const served = await serve({
      root: opts.root,
      port: DEFAULT_BOARD_PORT,
      maxPortTries: BOARD_PORT_TRIES,
      secure: opts.boardSecure === true,
      onMq: wake,
    });
    boardRef.serving = served;
    boardServe = serve;
    // board_serve 只记首次起服务；重启记独立的 board_reload（含旧端口、新端口、触发文件数）。
    if (record) recordEvent(opts.root, "board_serve", { url: served.url, port: served.port, root: opts.root });
    rec = { ...rec, board_url: served.url };
    saveSupervisor(opts.root, rec);
    return served;
  };

  if (boardEnabled) {
    const loaded = await loadBoardModule();
    if (!loaded.ok) {
      out(`[监工] 看板未启动：${loaded.message}`);
    } else {
      try {
        const served = await serveBoardNow(loaded.serve, true);
        out(`[监工] 看板 ${served.url}`);
        out("[监工] 看板地址见上方输出；页面按间隔轮询状态与指标（账号类间隔较长）。");
        boardStamp = boardBuildStamp()?.stamp ?? null;
        /* 记下启动时的 core 指纹：热重载不换 core，core 变化须拦下热重载。 */
        coreHashAtBoot = coreContentHash();
      } catch (err) {
        // 端口占用、监听失败时监工照常运行，仅无看板。
        out(`[监工] 看板未启动：${errText(err)}`);
      }
    }
  }

  /** 产物变化后更换服务；失败只降级，不影响看板可用。 */
  const reloadBoard = async (next: { stamp: string; files: number }): Promise<void> => {
    /*
     * core 变化时不热重载：新 board 会调用旧 core 不存在的函数导致接口 500。
     * 旧版 board 配旧版 core 自洽，继续服务；监工重启后加载全套新版本。
     */
    const nowCore = coreContentHash();
    if (nowCore && coreHashAtBoot && nowCore !== coreHashAtBoot) {
      boardStamp = next.stamp;
      out(
        "[监工] 看板未热重载：本次构建改动了 core，热重载会得到「新版 board + 旧版 core」（接口会 500）。" +
          "看板继续用启动时那一版；重启监工后加载新版本。",
      );
      /* 该判断每 tick 命中，按 key 节流以免占满异常窗口；累计次数进 `repeat`。 */
      recordEventThrottled(
        opts.root,
        "board_reload_blocked",
        { files: next.files, reason: "core 产物已变化，热重载无法保证模块同批" },
        { key: "core-changed", windowMs: 10 * 60_000 },
      );
      return;
    }
    const loaded = await loadBoardModule();
    if (!loaded.ok) {
      // 新产物加载失败：旧 server 未动，继续服务；同名构建不重复刷新。
      boardStamp = next.stamp;
      out(`[监工] 看板未按新构建重启，继续用旧版：${loaded.message}`);
      return;
    }
    const oldPort = boardRef.serving?.port ?? DEFAULT_BOARD_PORT;
    try {
      boardRef.serving?.close();
      boardRef.serving = null;
      const served = await serveBoardNow(loaded.serve, false);
      boardStamp = next.stamp;
      out(`[监工] 看板已按新构建重启（端口 ${served.port}）`);
      recordEvent(opts.root, "board_reload", { from_port: oldPort, port: served.port, files: next.files });
    } catch (err) {
      const message = errText(err);
      boardStamp = next.stamp;
      // 新产物起不来：把旧版按原端口恢复。旧实现仍在 boardServe 中，清缓存只影响下次 require。
      const fallback = boardServe;
      if (fallback) {
        try {
          await serveBoardNow(fallback, false);
          out(`[监工] 看板未按新构建重启，继续用旧版（端口 ${boardRef.serving?.port ?? oldPort}）：${message}`);
          return;
        } catch {
          /* 旧版也恢复失败，走下面的统一失败提示。 */
        }
      }
      out(`[监工] 看板未启动：${message}`);
    }
  };

  // 热加载状态：跨 tick 保留上一份契约，用于判变化与解析失败时回落。
  let hot: { file: string; mtimeMs: number; hash: string; contract: Contract } | null = null;
  // 需求层违规的拒绝签名，避免每个 tick 重复 ask。
  let lastRefusalSig: string | null = null;
  /* 同一段契约错误只报一次：按 tick 重读会每几秒报一遍，台账和看板都受不了。 */
  let lastContractError: string | null = null;
  // 最近几个 tick 的变更计数，用于「契约本身不稳定」提示。
  let recentChangeTicks: number[] = [];
  // 面板调度指令 `concurrency` 的运行时覆盖值只活在本进程，重启后回到 --workers，不作为长期配置。
  let concurrencyOverride: number | null = null;

  let stopping = false;
  const onSignal = (): void => {
    stopping = true;
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  // 进程自然 exit（循环外的 return、未捕获分支）时也走同一 dispose；disposeAll 幂等，与 finally 不冲突。
  const onBeforeExit = (): void => {
    for (const f of disposeAll("beforeExit")) out(`[监工] 退出清理失败：${f}`);
  };
  process.on("beforeExit", onBeforeExit);

  // 退出清理表：看板端口与工作进程登记于此，各退出路径共用同一段收尾；只登记已创建的资源。
  registerDisposer("board", () => {
    boardRef.serving?.close();
    boardRef.serving = null;
  });
  registerDisposer("workers", () => {
    // `--once` 只跑一轮判定，工作进程须继续做完当前派单。
    if (!opts.once) terminateWorkers(opts.root, out);
  });
  registerDisposer("guard", () => {
    /* 正常退出时停掉守护：工作进程已回收，守护继续运行会重复回收并写冗余记录。 */
    if (!opts.once) stopGuard(opts.root, process.pid);
  });

  // 清理原子写残留的 `*.tmp`（mtime 超过 10 分钟），不误删正在写的文件。
  // 清理按批封顶，未清完的留到下次启动。
  try {
    const pruned = pruneTempFiles([supervisorDir(opts.root), inboxDir(opts.root), join(supervisorDir(opts.root), "workers")]);
    if (pruned.removed > 0) {
      out(`[监工] 已清理 ${pruned.removed} 个原子写残留的临时文件`);
      if (pruned.truncated) {
        out("[监工] 残留较多，本轮只清了一批；下次启动继续清（不影响本轮派单）");
      }
    }
  } catch (err) {
    out(`[监工] 清理临时文件失败（不影响启动）：${errText(err)}`);
  }

  // 回收历史工作进程记录（每单一对 json + log），避免 listWorkers 与看板快照反复读取。
  // 规则见 pruneWorkers：在跑的不删、最近 50 条不删、24 小时内的不删。
  try {
    const prunedW = pruneWorkers(opts.root);
    if (prunedW.removed > 0) {
      out(`[监工] 已回收 ${prunedW.removed} 条历史 worker 记录（保留 ${prunedW.kept} 条）`);
    }
  } catch (err) {
    out(`[监工] 回收 worker 记录失败（不影响启动）：${errText(err)}`);
  }

  // 进 tick 循环前回收上一轮遗留的工作进程：被强杀的监工不执行信号处理器，detached 工作进程
  // 不会随父进程退出，故派单前先清孤儿，避免新旧进程处理同一单。归属不明的不处理。
  try {
    const reaped = reapOrphans(opts.root, out);
    if (reaped.length > 0) {
      out(`[监工] 启动清理：收掉 ${reaped.length} 个上一轮遗留的 worker（事件 worker_reaped 已入台账）`);
    }
  } catch (err) {
    out(`[监工] 清孤儿失败（不影响启动）：${errText(err)}`);
  }

  // 首 tick 前修复存量台账结构：重派与重试会给同一件事留下多行，`parent` 只在建单时写一次，
  // 会形成互不相连的根。未完工单超过一张且全无父节点时按正文归组重建（判据见 `looksFlat`），只跑一次。
  try {
    const rebuilt = autoRebuild(opts.root);
    if (rebuilt) {
      recordEvent(opts.root, "tree_rebuilt", { note: rebuilt });
      out(`[监工] ${rebuilt}`);
    }
  } catch (err) {
    out(`[监工] 重建派单树失败（不影响启动）：${errText(err)}`);
  }

  // 起守护盯住本进程：硬杀（`taskkill /F`）不执行信号处理器，工作进程自检与启动清孤儿都覆盖不到。
  // 守护是脱离会话的 detached 进程，本进程消失后仍继续运行，发现监工 pid 不在即回收工作进程并退出。
  // `--once` 不拉守护，该模式不留工作进程。
  if (!opts.once) {
    try {
      const g = ensureGuard(opts.root);
      if (g.pid > 0) {
        out(
          g.spawned
            ? `[监工] 已起守护进程（pid ${g.pid}）：本进程被强杀时由它回收工作进程`
            : `[监工] 守护进程已在跑（pid ${g.pid}），沿用`,
        );
      } else {
        out("[监工] 守护进程没起来（取不到入口路径）：强杀本进程后工作进程只能等下次启动清孤儿");
      }
    } catch (err) {
      out(`[监工] 起守护失败（不影响启动）：${errText(err)}`);
    }
  }

  const limit = opts.once ? 1 : (opts.maxTicks ?? Number.POSITIVE_INFINITY);
  /** hook 自检的上次时间戳，节流用。声明在循环外，跨 tick 保留。 */
  let lastHookHeal = 0;

  // 阶段卡死检测状态，跨 tick 保留。
  /**
   * 在途签名含派单状态与工作进程日志字节数：长任务不换派单状态属正常，但日志在增长即视为推进，不判卡死；签名一变即重新计数。
   */
  let stallSig = "";
  let stallTicks = 0;
  let stallReported = false;
  /**
   * 待命态：无待办任务时只保心跳与看板，不跑调度；进入与退出各播报一次。
   * 启动时已判过并播报过的，这里直接继承，避免首轮重复输出同一句话。
   */
  let standby = !pendingWork0;
  /** 任务达标只播报一次；之后转入待命，不再重复。 */
  let doneAnnounced = false;

  try {
    for (let i = 0; i < limit; i += 1) {
      /*
       * ticks 统计实际执行调度的轮次，待命轮次不计。
       * 心跳每轮都刷，待命时进程也要能被判定为在线。
       */
      rec = { ...rec, heartbeat_at: new Date().toISOString(), heartbeat_ts: Date.now() / 1000 };
      /*
       * `rec` 是启动时的内存快照，看板通过 /api/capitalist-command 改的是磁盘 supervisor.json。
       * 每 tick 用内存快照整份写回会覆盖外部改的 supervisor_model，故只从磁盘同步该字段与上下文上限，
       * 其余字段以监工内存为准；仅在磁盘有新值时同步，避免旧记录覆盖。
       */
      const diskRec = loadSupervisor(opts.root);
      if (diskRec && diskRec.supervisor_model !== rec.supervisor_model) rec = { ...rec, supervisor_model: String(diskRec.supervisor_model ?? "") };
      if (diskRec && Number(diskRec.supervisor_context_limit ?? 0) > 0 && diskRec.supervisor_context_limit !== rec.supervisor_context_limit) {
        rec = { ...rec, supervisor_context_limit: Number(diskRec.supervisor_context_limit) };
      }
      saveSupervisor(opts.root, rec);
      // 租约心跳与监工心跳同步刷新；实例已被其它进程持有时 touchLease 拒绝写入。
      touchLease(opts.root, leaseTask, myLease.instance_id);

      // 看板随构建重启：产物版本变化后待稳定并留足间隔再换服务；看板未起时不参与判定。
      if (boardEnabled && boardRef.serving) {
        const cur = boardBuildStamp();
        if (cur && cur.stamp !== boardStamp) {
          if (boardPendingStamp !== cur.stamp) {
            // 新版本首次出现时先记录，等稳定后再重启。
            boardPendingStamp = cur.stamp;
            boardPendingSince = Date.now();
          } else if (
            Date.now() - boardPendingSince >= boardReloadQuietMs &&
            Date.now() - boardLastReload >= boardReloadMinGapMs
          ) {
            boardPendingStamp = null;
            boardLastReload = Date.now();
            await reloadBoard(cur);
          }
        }
      }

      if (stopRequested(opts.root)) {
        /* 有在途任务时排空式停止：先停派单，等手里的活自然结束后再退；--force 立即退出。 */
        const live = listWorkers(opts.root).filter((w) => w.status === "running");
        if (live.length > 0 && !stopForced(opts.root)) {
          if (!readPause(opts.root)) {
            writeJson(pausePath(opts.root), {
              at: new Date().toISOString(),
              reason: "停止请求：等在跑的任务结束后退出",
              by: "supervisor",
            });
            recordEvent(opts.root, "stop_pending", { running: live.map((w) => w.id) });
            out(
              `[监工] 收到停止请求：还有 ${live.length} 个在跑（#${live
                .map((w) => w.id)
                .join(" #")}），已停派单，等它们结束后自动退出；要立即退用 capitalist supervise-stop --force`,
            );
          }
        } else {
          out("[监工] 收到停止请求，退出");
          return 0;
        }
      }
      const disk = loadSupervisor(opts.root);
      if (disk && disk.status === "stopped") {
        out("[监工] 收到停止请求，退出");
        return 0;
      }

      const state = loadState(opts.root);
      if (!state) {
        out("[监工] 任务根状态不可读，退出");
        return 1;
      }

      /*
       * 待命：任务已完工，没有任何在途环节。不评估门槛、不重读契约、不派单、不记 tick，
       * 只刷新心跳与看板服务；进程保持在线，等待用户派单，不自行退出。
       * 面板指令仍需消费：用户点击「派单」时无其他调度方处理该派单。
       */
      if (!hasPendingWork(opts.root, hot?.contract ?? contract0, state)) {
        if (!standby) {
          standby = true;
          out("[监工] 无待办任务：待命在线（不派单、不轮询），等待派单");
        }
        /*
         * 指令执行可能调用模型（派单前检查、自然语言判定），该过程可能持续数十秒。
         * 该期间继续刷新心跳与租约。
         */
        const beat = setInterval(() => {
          rec = { ...rec, heartbeat_at: new Date().toISOString(), heartbeat_ts: Date.now() / 1000 };
          saveSupervisor(opts.root, rec);
          touchLease(opts.root, leaseTask, myLease.instance_id);
        }, 3000);
        let standbyDirect: { concurrency: number | null };
        try {
          standbyDirect = await applySupervisorDirectives({
            root: opts.root,
            contract: hot?.contract ?? contract0,
            state,
            wopts,
            concurrency: concurrencyOverride,
            out,
          });
        } finally {
          clearInterval(beat);
        }
        concurrencyOverride = standbyDirect.concurrency;
        /* 指令可能刚派了单：这一轮转回正常调度，不在下一 tick 才处理该派单。 */
        if (!hasPendingWork(opts.root, hot?.contract ?? contract0, loadState(opts.root) ?? state)) {
          /* 待命轮次使用 continue，该分支同样需要处理信号退出。 */
          if (stopping) break;
          await idle(tickSec * 1000);
          continue;
        }
        standby = false;
      } else {
        standby = false;
      }
      rec = { ...rec, ticks: rec.ticks + 1 };

      // tick 记录进台账供面板统计「过去 1 分钟 N 个 tick」；该数只能由逐 tick 记录得出，
      // 心跳间隔在暂停与重载时不准。记录只含序号与阶段，不参与 FEED_EVENTS。
      recordEvent(opts.root, "supervisor_tick", { n: rec.ticks, stage: state.stage });

      /* 暂停时停掉在跑进程并把派单退回 open，恢复后按原样重派；排在 step 之前，step 负责不再派新单。 */
      if (readPause(opts.root)) stopWorkersForPause(opts.root, out);

      // 收件箱自检：畸形记录不参与调度但要可见（同一批只报一次）；须排在 step 之前，两者读同一份台账。
      warnIgnoredInbox(opts.root, out);

      // 契约热加载：每 tick 重读，按 mtime 与哈希判变化。
      let reloaded;
      try {
        reloaded = reloadContract(state.contract, skillDirs(), hot ?? undefined, state.contract_path);
      } catch (e) {
        out(`[监工] 任务列表首读失败：${String((e as Error).message ?? e)}`);
        return 1;
      }

      let contract: Contract = reloaded.contract;

      if (reloaded.error) {
        // 解析失败时沿用上一份可用契约；同一段错误只在首次出现时上报。
        if (reloaded.error !== lastContractError) {
          lastContractError = reloaded.error;
          recordEvent(opts.root, "contract_error", { error: reloaded.error, kept: reloaded.contract.name });
          out(`[监工] 任务列表解析失败，沿用上一份可用任务列表：${reloaded.error}`);
        }
        if (!hot) hot = { file: reloaded.file, mtimeMs: reloaded.mtimeMs, hash: reloaded.hash, contract };
      } else if (reloaded.changed) {
        lastContractError = null;
        if (hot) {
          const prevData = hot.contract.data;
          const nextData = reloaded.contract.data;
          const violations = detectRequirementViolation(prevData, nextData);
          if (violations.length > 0) {
            // 需求层被删除或降低门槛时拒绝采用，转交 ask 裁决。
            const sig = JSON.stringify(violations);
            if (sig !== lastRefusalSig) {
              recordEvent(opts.root, "contract_refused", {
                kind: "requirement_violation",
                violations,
                kept: reloaded.contract.name,
              });
              raiseAsk(
                opts.root,
                "任务列表改动触及需求层（删除需求条目或降低验收标准），监工拒绝采用并转交裁决",
                `违反项：${violations.map((v) => `${v.kind}:${v.stage ?? ""}:${v.detail}`).join("; ")}`,
              );
              out(
                `[监工] 检测到需求层被改动（${violations.map((v) => v.kind).join("、")}），拒绝采用，转交操作者裁决`,
              );
              lastRefusalSig = sig;
            }
            // 沿用上一份可用契约，不更新 hot，不记 contract_reload。
            contract = hot.contract;
          } else {
            // 编排层变更或需求层未降低门槛时采用，记 contract_change 并保留上一版。
            const orchDiff = orchestrationDiff(prevData, nextData);
            const reqChanged = requirementFingerprint(prevData) !== requirementFingerprint(nextData);
            const reason = reqChanged
              ? "任务列表文件被外部（操作者）修改：需求层有微调但未降低标准，编排层可能同步改动"
              : "任务列表文件被外部（操作者）修改（编排层）";
            recordEvent(opts.root, "contract_change", {
              reason,
              req_changed: reqChanged,
              orch_diff: orchDiff,
              prev_stages: reloaded.prev?.stages,
              next_stages: reloaded.next?.stages,
              prev_shards: reloaded.prev?.shardCount,
              next_shards: reloaded.next?.shardCount,
              prev_thresholds: reloaded.prev?.thresholdCount,
              next_thresholds: reloaded.next?.thresholdCount,
            });
            savePrevContract(opts.root, prevData); // 保留上一版供回滚
            recordEvent(opts.root, "contract_reload", {
              file: reloaded.file,
              prev_stages: reloaded.prev?.stages,
              next_stages: reloaded.next?.stages,
              prev_shards: reloaded.prev?.shardCount,
              next_shards: reloaded.next?.shardCount,
              prev_thresholds: reloaded.prev?.thresholdCount,
              next_thresholds: reloaded.next?.thresholdCount,
            });
            out(`[监工] 任务列表热加载（编排层变更）：${reloaded.file}`);
            out(
              `[监工]   阶段：${(reloaded.prev?.stages ?? []).join(",")} → ${(reloaded.next?.stages ?? []).join(",")}`,
            );
            out(
              `[监工]   分片数：${reloaded.prev?.shardCount} → ${reloaded.next?.shardCount}；门槛条数：${reloaded.prev?.thresholdCount} → ${reloaded.next?.thresholdCount}`,
            );
            out(`[监工]   已保留原契约到 .capitalist/contract.prev.json（可回滚）`);
            hot = { file: reloaded.file, mtimeMs: reloaded.mtimeMs, hash: reloaded.hash, contract: reloaded.contract };
            rec = { ...rec, contract: reloaded.contract.name };
            contract = reloaded.contract;
            lastRefusalSig = null;
            // 连续三个 tick 内变更超过三次时提示契约不稳定。
            recentChangeTicks.push(rec.ticks);
            recentChangeTicks = recentChangeTicks.filter((t) => rec.ticks - t <= 3);
            if (recentChangeTicks.length > 3) {
              recordEvent(opts.root, "contract_unstable", { changes_in_3_ticks: recentChangeTicks.length });
              out(`[监工] 连续 3 个 tick 内变更超过 3 次，任务列表可能不稳定`);
            }
          }
        } else {
          // 首读无上一版可比，直接采用并记 contract_reload。
          recordEvent(opts.root, "contract_reload", {
            file: reloaded.file,
            prev_stages: undefined,
            next_stages: reloaded.next?.stages,
            prev_shards: undefined,
            next_shards: reloaded.next?.shardCount,
            prev_thresholds: undefined,
            next_thresholds: reloaded.next?.thresholdCount,
          });
          out(`[监工] 任务列表热加载：${reloaded.file}`);
          out(`[监工]   阶段：${(reloaded.next?.stages ?? []).join(",")}`);
          out(
            `[监工]   分片数：${reloaded.next?.shardCount}；门槛条数：${reloaded.next?.thresholdCount}`,
          );
          hot = { file: reloaded.file, mtimeMs: reloaded.mtimeMs, hash: reloaded.hash, contract: reloaded.contract };
          rec = { ...rec, contract: reloaded.contract.name };
        }
      }

      // 阶段 id 消失时回落到首个未达标阶段并记事件。
      if (!stageIds(contract).includes(state.stage)) {
        const fb = firstUnmetStage(contract, opts.root);
        recordEvent(opts.root, "stage_fallback", {
          from: state.stage,
          to: fb,
          reason: "阶段 id 在当前任务列表中不存在",
        });
        out(`[监工] 当前阶段 ${state.stage} 不在新任务列表中，回落到首个未达标阶段 ${fb}`);
        updateState(opts.root, (s) => enterStage(s, stageById(contract, fb)!));
        supersedeStaleDispatches(opts.root, contract, fb, out);
      }

      // 面板调度指令每 tick 开头读一次，须排在并行度与 pause 读取之前，使 concurrency 与 pause/resume 本 tick 生效。
      const direct = await applySupervisorDirectives({
        root: opts.root,
        contract,
        state: loadState(opts.root) ?? state,
        wopts,
        concurrency: concurrencyOverride,
        out,
      });
      concurrencyOverride = direct.concurrency;

      /* 并行度上限只取用户设定值（--workers 或 concurrency 运行时指令），不按契约分片数封顶。 */
      const capWanted = concurrencyOverride ?? maxWorkers;
      const capacity = spawnWorkers ? capWanted : 0;
      rec = { ...rec, max_workers: capacity };

      // hook 周期自检：工作进程心跳续写与契约红线拦截依赖它，缺失不报错，只表现为心跳不涨、红线不拦。
      // settings.local.json 可能被 git clean、手工清理或换机 clone 后不存在，故不能只查启动时一次。
      // 补装受 `installHooks` 控制，避免 `--no-hooks` 下被循环写回；按 60 秒节流。
      if (spawnWorkers && opts.installHooks === true && Date.now() - lastHookHeal > 60_000) {
        lastHookHeal = Date.now();
        try {
          const { ensureHooks } = await import("../install/install");
          const healed = ensureHooks([chosenHost], opts.root);
          if (healed.installed.length > 0) {
            out(`[监工] 已补装 hook：${healed.installed.join("、")}（缺了 worker 就续不了心跳）`);
          }
          for (const f of healed.failed) out(`[监工] hook 补装失败（${f.id}）：${f.message}`);
        } catch {
          /* 补装失败不阻断主循环。 */
        }
      }

      /* 顺序：先刷新车道占用，再回收、再填槽；占用未落盘时闸门读不到实时读数。 */
      refreshLaneUsage(opts.root, readDispatches(opts.root));

      await reap(opts.root, workerTimeoutSec, out, stuckSec);

      /* 消费申报排在 reap 之后：先确认已判死进程，再处理存活进程的申报，避免依据过期局面裁决。 */
      await consumeMq({
        root: opts.root,
        contract,
        state: loadState(opts.root) ?? state,
        out,
      });

      /* 待确认超时的单自动结单；须排在 reap 之后，reap 与 forceFinishHung 只处理 claimed，不会提前清理这些单。 */
      for (const rd of sweepReviews(opts.root)) {
        recordEvent(opts.root, "dispatch_review_timeout", {
          dispatch: rd.id,
          stage: rd.stage,
          shard: rd.shard ?? "",
          worker: rd.worker ?? "",
        });
        out(
          `[监工] 派单 ${rd.id}（${rd.stage}/${rd.shard || "整阶段"}）等待确认超时，自动结单`,
        );
      }
      /* 上报后长期未裁决的单退回 open，由调度层重派。 */
      for (const rd of sweepReported(opts.root)) {
        recordEvent(opts.root, "dispatch_reported_stale", {
          dispatch: rd.id,
          stage: rd.stage,
          shard: rd.shard ?? "",
        });
        out(`[监工] 派单 ${rd.id}（${rd.stage}/${rd.shard || "整阶段"}）上报后一直没人裁决，退回重派`);
      }

      // 暂停时不派新单；心跳、判死回收与已完成派单的结算照常。
      const pause = readPause(opts.root);
      if (pause) {
        out(
          `[监工] 已暂停（自 ${pause.at || "?"}，原因：${pause.reason || "未填写"}）。不派新单；` +
            "手里的进程随后停掉，恢复后按原样重派（capitalist resume 恢复）",
        );
      }

      // 模型启动失败回退会补开新派单，暂停期间一并停掉。
      if (!pause) handleModelFallback(opts.root, contract, chosenHost, wopts, out);
      /* 复验单须先入队，排在本 tick 的 step 之前，使在途状态阻止阶段推进。 */
      /* 契约文件被外部改动时按 mtime 留痕并播报。 */
      if (!pause) {
        const cc = noteContractChange(opts.root);
        if (cc) {
          out(
            `[监工] 契约文件已更新（${cc.from.slice(0, 16).replace("T", " ")} → ${cc.to.slice(0, 16).replace("T", " ")}` +
              `${cc.gap_hours === null ? "" : `，间隔 ${cc.gap_hours} 小时`}），已按新内容重读`,
          );
          recordEvent(opts.root, "contract_changed", { from: cc.from, to: cc.to, gap_hours: cc.gap_hours });
        }
      }
      /* 契约文件被外部改动时按 mtime 留痕并播报。 */
      if (!pause) {
        const cc = noteContractChange(opts.root);
        if (cc) {
          out(
            `[监工] 契约文件已更新（${cc.from.slice(0, 16).replace("T", " ")} → ${cc.to.slice(0, 16).replace("T", " ")}` +
              `${cc.gap_hours === null ? "" : `，间隔 ${cc.gap_hours} 小时`}），已按新内容重读`,
          );
          recordEvent(opts.root, "contract_changed", { from: cc.from, to: cc.to, gap_hours: cc.gap_hours });
        }
      }
      if (!pause) applyResumePlan(opts.root, state.stage, out);
      /*
       * 上下文占比达阈值时自动重载，复用 capitalist reload 链路；暂停期间不触发。
       * 未完成条目按快照记录的原始下发顺序恢复，不按任务编号排序（编号表身份，不表次序）。
       */
      if (!pause) {
        const ctxCheck = shouldAutoReload(opts.root);
        if (ctxCheck.hit) {
          out(`[监工] 对话上下文超限，自动重载：${ctxCheck.reason}`);
          try {
            /* holdSec 须覆盖看板轮询周期与接口缓存时长，否则「重载中」状态不可见。 */
            const summary = await beginReload(opts.root, contract, {
              holdSec: 3,
              out,
              trigger: "context_overflow",
            });
            recordEvent(opts.root, "supervisor_reload_auto", {
              gen: summary.gen,
              trigger: "context_overflow",
              reason: ctxCheck.reason,
              reverify: summary.reverify,
              pending: summary.pending,
            });
            out(`[监工] 自动重载完成 gen ${summary.gen}：调度按原始下发顺序继续`);
          } catch (err) {
            out(`[监工] 自动重载失败（下一轮重试）：${String((err as Error).message ?? err)}`);
          }
        }
      }
      const verdict = step(opts.root, contract, chosenHost, capacity, wopts, out, pause !== null, opts.autoDispatch === true);
      out(
        `[监工] tick ${rec.ticks} ｜ ${loadState(opts.root)?.stage ?? "?"} ｜ ` +
          `${concurrencyLabel(capacity, capWanted)} ｜ ${describeQueue(opts.root, contract, capacity)}`,
      );

      // 阶段卡死判据：在途签名（派单 id/状态 + 工作进程日志字节数）连续 {@link STALL_TICKS} 个 tick 未变。
      // 签名含日志增量，运行时长不计入卡死判定。
      if (!pause) {
        const stall = stageProgress(opts.root, contract);
        if (stall.sig !== stallSig) {
          stallSig = stall.sig;
          stallTicks = 0;
          stallReported = false;
        } else {
          stallTicks += 1;
          if (stallTicks >= STALL_TICKS) {
            if (!stallReported) {
              stallReported = true;
              reportStageStalled(opts.root, stall, stallTicks, tickSec, out);
            }
            // 超过 2 倍工作进程超时仍未结单的单强制结单重派，不占退避窗口；先报告 stall 再处置。
            forceFinishHung(opts.root, workerTimeoutSec * 2, out);
          }
        }
      }

      if (verdict === "done") {
        /*
         * 达标不等于退出：任务结束与否由用户决定。监工保持在线，下一轮转入待命，
         * 既不派单也不轮询；用户派入新单或清空重开时恢复调度。
         */
        if (!doneAnnounced) {
          doneAnnounced = true;
          out("[监工] 最后阶段已达标：任务完成，监工待命在线（不派单、不轮询）");
        }
      }

      if (stopping) break;
      if (i + 1 < limit) await idle(tickSec * 1000);
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("beforeExit", onBeforeExit);

    // 看板服务与工作进程须随监工一并释放；所有退出路径汇集到同一 dispose，否则残留占端口的服务与进程。
    for (const f of disposeAll("shutdown")) out(`[监工] 退出清理失败：${f}`);

    // 退场时只释放 instance_id 匹配的租约，不改动其它实例持有的记录。
    const curLease = readLease(opts.root, leaseTask);
    if (curLease && curLease.instance_id === myLease.instance_id) {
      writeLease(opts.root, leaseTask, {
        ...curLease,
        status: "released",
        heartbeat_at: new Date().toISOString(),
        heartbeat_ts: Date.now() / 1000,
      });
    }

    const diskRec = loadSupervisor(opts.root);
    if (diskRec && diskRec.status !== "done") {
      saveSupervisor(opts.root, {
        ...diskRec,
        status: "stopped",
        heartbeat_at: new Date().toISOString(),
        heartbeat_ts: Date.now() / 1000,
      });
    }
  }

  out("[监工] 已停止");
  return 0;
}

function ensureRoot(opts: SupervisorOptions): { ok: true; created: boolean } | { ok: false; message: string } {
  if (existsState(opts.root)) return { ok: true, created: false };
  if (!opts.target) {
    return { ok: false, message: "[监工] 当前目录没有任务根，且未给 --target。监工负责建根，这一步不能省。" };
  }
  try {
    createTaskRoot({
      target: opts.target,
      contractSpec: opts.contractSpec,
      root: opts.root,
      contractDirs: skillDirs(),
    });
    return { ok: true, created: true };
  } catch (err) {
    return { ok: false, message: `[监工] 建根失败：${String((err as Error).message ?? err)}` };
  }
}

function existsState(root: string): boolean {
  try {
    return loadState(root) !== null;
  } catch {
    return false;
  }
}

/**
 * 契约阶段的并行分片定义；无 `parallel` 时不分片。
 * 每片派一单，同时执行的工作进程数由用户设定的并行度上限约束。
 */
function stageParallel(contract: Contract, stageId: string): StageParallel[] {
  const stage = stageById(contract, stageId);
  const raw = (stage as unknown as { parallel?: unknown })?.parallel;
  if (!Array.isArray(raw)) return [];
  const out: StageParallel[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.action !== "string") continue;
    out.push({
      id: r.id,
      title: typeof r.title === "string" ? r.title : undefined,
      action: r.action,
      model: typeof r.model === "string" ? r.model : undefined,
      // required 缺省视为必需；显式 false 才是可选项。
      required: r.required === false ? false : undefined,
    });
  }
  return out;
}

/**
 * 取分片在契约中的当前 action；分片不在契约里时返回 null。
 * 重派一律以它为准，不读派单快照或本 tick 早先的 shard 对象：契约热加载后两者可能过期。
 */
function contractShardAction(contract: Contract, stageId: string, shardId: string): string | null {
  if (!shardId) return null;
  const hit = stageParallel(contract, stageId).find((s) => s.id === shardId);
  return hit ? hit.action : null;
}

/**
 * 结束工作进程：先发 SIGTERM，再按进程树强杀，以确认退出为准。
 * 启动清孤儿与退出清场复用 `terminate.ts` 的同一套动作。
 * Windows 宿主的 `.cmd` shim 才是台账记录的 pid，只结束它会残留 CLI 与工具进程。
 */
const killWorkerPid = killTree;

/** 判死时先结束工作进程的 pid 并确认退出、记 worker_killed 事件，再落终态结单；进程已不在时不发信号、不记事件。 */
function killJudgedWorker(root: string, w: WorkerRecord, stale: boolean, out: (s: string) => void): void {
  // 可见窗口不由监工管理；pid 非法或为监工自身（记录损坏）时不发信号。
  if (w.mode === "visible" || w.pid <= 0 || w.pid === process.pid) return;
  const how = killWorkerPid(w.pid);
  if (how === "gone") return;
  const confirmed = how !== "unconfirmed";
  recordEvent(root, "worker_killed", {
    worker: w.id,
    dispatch: w.dispatch,
    pid: w.pid,
    how,
    confirmed,
    stale,
  });
  out(
    `[监工] worker ${w.id}（pid ${w.pid}）已${how === "term" ? "软终止" : how === "kill" ? "强杀" : "终止但未确认退出"}${
      confirmed ? "" : "可能有残留进程，需人工核查"
    }`,
  );
}

/** 工作进程日志距最后一次输出多少秒。读不到日志（未建、已删）按无穷大处理。 */
function logIdleSec(log: string, nowMs = Date.now()): number {
  return workerLogIdleSec(log, nowMs);
}

/** 卡点处置结果：`kept` 保留进程，`killed` 判死重派，`reap` 无可送达派单、交回 reap 收尾。 */
type StuckAction = "kept" | "killed" | "reap";

/** 重复度探测节流表：工作进程 id → 上次探测时刻。 */
const loopProbeAt = new Map<string, number>();
/** 两次重复度探测之间的最小间隔。 */
const LOOP_PROBE_GAP_MS = 10_000;

/** 按 10 秒节流探测日志重复；两次探测之间沿用工作进程记录中已判定的卡点类型，未探测不清除卡点。 */
function probeLooping(w: WorkerRecord, logFile: string, nowMs: number, force = false): ReturnType<typeof looksLooping> {
  const last = loopProbeAt.get(w.id) ?? 0;
  if (!force && nowMs - last < LOOP_PROBE_GAP_MS) {
    if (w.stuck && (w.stuck.kind === "retry" || w.stuck.kind === "error_loop")) {
      return { looping: true, sample: w.stuck.why, times: 0, tail: readLogTail(logFile, 120) };
    }
    return { looping: false, sample: "", times: 0, tail: [] };
  }
  loopProbeAt.set(w.id, nowMs);
  return looksLooping(logFile);
}

/**
 * 卡点判定与干预。心跳续写或日志增长任一在窗口内发生即视为有推进，两者都过期才进入分类与干预。
 * 处置顺序固定：先清已恢复卡点；同一类干预已两次且观察窗口已过则判死重派；否则写一次指导到
 * `direct.jsonl`，由工作进程下次工具调用前的 hook 领取。干预按次计数，两次至少隔 {@link stuckGapSec}。
 */
export async function handleStuckWorker(
  root: string,
  w: WorkerRecord,
  opts: {
    heartbeatSec: number;
    stuckSec: number;
    nowSec: number;
    out: (s: string) => void;
    /** 调用方已经做过的重复度探测，避免同一轮重复读取日志。 */
    looped?: ReturnType<typeof looksLooping>;
  },
): Promise<StuckAction> {
  const out = opts.out;
  const nowMs = opts.nowSec * 1000;
  const live = workerLivenessOf(w, {
    heartbeatSec: opts.heartbeatSec,
    logStallSec: opts.stuckSec,
    nowMs,
  });
  const logFile = w.log || join(root, ".capitalist", "workers", `${w.id}.log`);
  /* 心跳与日志正常的原地重复进程无法靠静默判据发现，故日志新鲜时仍按节流探测重复度。 */
  const looped = opts.looped ?? (live.alive ? probeLooping(w, logFile, nowMs) : { looping: false, sample: "", times: 0, tail: [] });

  if (live.alive && !looped.looping) {
    if (w.stuck) {
      saveWorker(root, { ...w, stuck: undefined });
      recordEvent(root, "stuck_cleared", {
        worker: w.id,
        dispatch: w.dispatch,
        kind: w.stuck.kind,
        attempts: w.stuck.attempts,
      });
      out(`[监工] worker ${w.id} 已恢复推进（${w.stuck.label}解除），卡点标记清除`);
    }
    return "kept";
  }

  const d = w.dispatch ? readDispatches(root).find((x) => x.id === w.dispatch) : undefined;
  if (!d || (d.status !== "claimed" && d.status !== "open")) {
    /* 无可送达的派单：交回 reap 按进程与心跳收尾。 */
    return "reap";
  }

  const tail = [
    ...readLogTail(logFile, 160),
    ...readLogTail(`${logFile}.err`, 80),
  ].filter((l) => l.trim() !== "");
  const ev: StuckEvidence = classifyStuck(tail, repeatSignal(tail));

  let prev = w.stuck && w.stuck.kind === ev.kind ? w.stuck : undefined;
  /* 写入 `direct.jsonl` 只表示排进 hook 通道；`consumed` 由领取方置位，是送达的唯一可信证据。 */
  if (prev?.directive_at && !prev.delivered) {
    const at = prev.directive_at;
    const took = listDirectives(root).some((r) => r.at === at && r.consumed);
    if (took) {
      prev = { ...prev, delivered: true, channel: "consumed" };
      saveWorker(root, { ...w, stuck: prev });
      recordEvent(root, "stuck_guidance_delivered", {
        worker: w.id,
        dispatch: d.id,
        kind: prev.kind,
        attempts: prev.attempts,
      });
      out(`[监工] 给 worker ${w.id} 的卡点指导已被领取（${prev.label}，第 ${prev.attempts} 次）`);
    }
  }

  const gap = prev ? (nowMs - Date.parse(prev.last_at)) / 1000 : Number.POSITIVE_INFINITY;
  if (prev && gap < stuckGapSec(opts.stuckSec)) return "kept";

  if (prev && prev.attempts >= 2) {
    /* 两次同类干预未推进即按卡死处理；原地重复一类先经模型复查，避免把重复执行误判为死循环。 */
    if (looped.looping) {
      const verdict = await reviewLooping({
        root,
        worker: w.id,
        shard: String(w.shard ?? ""),
        action: String((d as { action?: string }).action ?? ""),
        tail: looped.tail,
      });
      if (verdict.reviewed && !verdict.kill) {
        saveWorker(root, { ...w, stuck: { ...prev, last_at: new Date(nowMs).toISOString() } });
        out(`[监工] worker ${w.id} 重复度高但模型判断仍在推进（${verdict.why}），暂不判死`);
        return "kept";
      }
    }
    const note =
      `卡死（${ev.label}）：同类指导 ${prev.attempts} 次均未生效。` +
      `判定依据：${ev.why}；已试手段：写入干预 ${prev.attempts} 次（${
        prev.channel === "consumed"
          ? "hook 通道，已被领取"
          : prev.channel === "hook"
            ? "hook 通道，工作进程未领取"
            : "写入失败"
      }）。`;
    killJudgedWorker(root, w, true, out);
    saveWorker(root, { ...w, status: "failed", stuck: prev });
    failDispatchAndJudge(root, d, note, out);
    recordEvent(root, "stuck_killed", {
      worker: w.id,
      dispatch: d.id,
      stage: d.stage,
      shard: d.shard ?? "",
      kind: ev.kind,
      label: ev.label,
      why: ev.why,
      attempts: prev.attempts,
      heartbeat_age_sec: live.heartbeat_age_sec,
      log_idle_sec: live.log_idle_sec,
    });
    out(`[监工] worker ${w.id} 判卡死（${ev.label}，指导 ${prev.attempts} 次未生效），停进程并重开派单 ${d.id}`);
    return "killed";
  }

  /* 发一次指导。次数从 1 开始；同类卡点沿用同一个 since，方便看板回答「卡了多久」。 */
  const attempts = (prev?.attempts ?? 0) + 1;
  const text = buildIntervention(ev, live.log_idle_sec, attempts);
  let delivered = false;
  let directiveAt: string | undefined;
  try {
    const rec = appendDirective(root, {
      text,
      target: d.id,
      shard: d.shard ?? null,
      stage: d.stage,
      lineage: String((d as DispatchEx).lineage ?? d.id),
      lane: laneKeyOf(d as { stage?: string; shard?: string | null; lineage?: string; id?: string }),
      via: "capitalist",
    });
    delivered = rec !== null;
    directiveAt = rec?.at;
  } catch {
    delivered = false;
  }
  const state = stuckStateOf({
    ev,
    guidance: text,
    attempts,
    ...(prev?.since ? { since: prev.since } : {}),
    now: nowMs,
    /* delivered 初始为 false，待领取方置 consumed 后才置真。 */
    delivered: false,
    channel: delivered ? "hook" : "failed",
    ...(directiveAt ? { directiveAt } : {}),
  });
  saveWorker(root, { ...w, status: "running", stuck: state });
  recordEvent(root, "stuck_detected", {
    worker: w.id,
    dispatch: d.id,
    stage: d.stage,
    shard: d.shard ?? "",
    kind: ev.kind,
    label: ev.label,
    why: ev.why,
    attempts,
    heartbeat_age_sec: live.heartbeat_age_sec,
    log_idle_sec: live.log_idle_sec,
    looping: looped.looping,
  });
  recordEvent(root, "stuck_intervention", {
    worker: w.id,
    dispatch: d.id,
    kind: ev.kind,
    attempts,
    /* written 表示已写入送达通道；送达另由 stuck_guidance_delivered 事件记录。 */
    written: delivered,
    channel: state.channel,
    text: text.slice(0, 400),
  });
  out(
    `[监工] worker ${w.id} 判为卡点（${ev.label}）：心跳 ${live.heartbeat_age_sec}s、` +
      `日志 ${live.log_idle_sec < 0 ? "无" : `${live.log_idle_sec}s`} 无更新；` +
      `已下发第 ${attempts} 次指导（${delivered ? "hook 通道，等待领取" : "写入失败，需人工介入"}）`,
  );
  if (!delivered) {
    out(`[监工] 指导未送达 worker ${w.id}：看板任务卡已标注卡点与建议，需人工介入`);
  }
  return "kept";
}

/**
 * 运行中按日志增量刷新车道占用，使会话闸门读到在跑会话的实时读数而非仅退出时的终值。
 * 日志字节数未变则跳过；变化才经 `workerUsage` 估算写回 `ctx_used`，同一日志按 offset 增量解析。
 * `seen` 记上次处理的字节数，日志增长是重算的唯一信号。
 */
const laneUsageSeen = new Map<string, number>();

export function refreshLaneUsage(root: string, dispatches: readonly Dispatch[]): void {
  const alive = new Set<string>();
  for (const w of listWorkers(root)) {
    if (w.status !== "running" && w.status !== "starting") continue;
    const lane = laneOfWorker(w);
    if (!lane) continue;
    alive.add(w.id);
    const log = w.log || join(root, ".capitalist", "workers", `${w.id}.log`);
    const size = logBytes(log);
    if (size <= 0) continue;
    if (laneUsageSeen.get(w.id) === size) continue;
    laneUsageSeen.set(w.id, size);
    try {
      const u = workerUsage(w, dispatches);
      if (u.context_used === null) continue;
      recordLaneUsage(root, lane, {
        context_used: u.context_used,
        context_window: u.context_window,
        context_model: u.model,
      });
    } catch {
      /* 日志正写入、读到半行时跳过，下一轮日志增长后重算。 */
    }
  }
  // 清除不再运行的工作进程水位，避免随历史进程累积占用内存。
  for (const id of [...laneUsageSeen.keys()]) {
    if (!alive.has(id)) laneUsageSeen.delete(id);
  }
}

/**
 * 收割：工作进程心跳超时或进程已退出时判死其派单，等待下一轮按退避重派。
 * 两遍扫描顺序固定：先按工作进程记录判死并标终态，再扫全部 claimed 派单就地结单。
 * 心跳超时的进程可能仍存活，先结束并确认退出再结单，避免残留孤儿进程。
 * 第二遍须遍历全部 claimed，分片并行时只查一张会漏掉其它僵尸派单。
 */
async function reap(
  root: string,
  timeoutSec: number,
  out: (s: string) => void,
  stuckSec: number = DEFAULT_STUCK_SEC,
): Promise<void> {
  const nowSec = Date.now() / 1000;

  /* 心跳超 ttl 且进程确已退出时回收文件锁；visible 模式不写心跳，不按此回收。 */
  const { reclaimed } = reapFileLocks(root);
  for (const r of reclaimed) {
    recordEvent(root, "lock_reclaimed", { path: r.path, holder: r.holder, why: r.why });
    out(`[监工] 回收文件锁 ${r.path}（${r.holder}：${r.why}）`);
  }

  for (const w of listWorkers(root)) {
    if (w.status !== "running" && w.status !== "starting") continue;
    // 可见窗口模式不写心跳，pid 属于启动它的 cmd.exe、开窗后即退出，故结束只认进程写回的 report。
    if (w.mode === "visible") continue;
    const gone = w.pid > 0 && !pidAlive(w.pid);
    const stale = !isWorkerAlive(root, w.id, timeoutSec, undefined, stuckSec);

    /*
     * 存活与否都走卡点判定：原地重复的进程心跳与日志都正常，仅按两信号过期判不到它。
     * 仍存活但两信号过期或日志重复度高时，先判卡点、发指导，同类指导两次无效才判死重派。
     */
    if (!gone) {
      /* 同步预判跳过健康且无卡点记录的进程，避免对每个健康进程 await 使 reap 提前让出执行权。 */
      const logFile = w.log || join(root, ".capitalist", "workers", `${w.id}.log`);
      const looped = stale || w.stuck ? undefined : probeLooping(w, logFile, Date.now());
      if (!stale && !w.stuck && !looped?.looping) continue;

      const act = await handleStuckWorker(root, w, {
        heartbeatSec: timeoutSec,
        stuckSec,
        nowSec,
        out,
        ...(looped ? { looped } : {}),
      });
      if (act !== "reap") continue;
      /* 无可送达派单且判活信号仍在时继续观察，不按死进程处理。 */
      if (!stale) continue;
    }

    // 先结束进程并确认退出，再落终态。
    killJudgedWorker(root, w, stale, out);

    const status = gone ? "exited" : "failed";
    saveWorker(root, { ...w, status, exit_code: gone ? 0 : undefined });
    recordEvent(root, "worker_gone", { worker: w.id, dispatch: w.dispatch, pid: w.pid, stale });
    /* 宿主可能未按 `--model` 执行而改用内部别名并轮转，故收尾时扫一次日志 model 字段，命中禁用名单则留事件。 */
    try {
      const hostOfRoot = String(loadSupervisor(root)?.worker_host ?? "");
      const bad = deniedModelsUsed(root, hostOfRoot, workerLogTail(root, w.id));
      if (bad.length) {
        recordEvent(root, "model_fallback_detected", {
          worker: w.id,
          dispatch: w.dispatch,
          used: bad,
          note: "宿主没有按 --model 执行，实际用到了禁用名单里的模型",
        });
        out(`[监工] worker ${w.id} 实际使用了禁用模型：${bad.join("、")}`);
      }
    } catch {
      /* 核对失败不影响收尾。 */
    }
    out(`[监工] worker ${w.id} ${gone ? "已退出" : "心跳超时"}，回收`);
  }

  for (const d of readDispatches(root)) {
    if (d.status !== "claimed") continue;
    const w = d.worker ? loadWorker(root, d.worker) : null;
    let reason = "";
    if (!w) {
      reason = "worker 记录丢失";
    } else if (w.status === "exited" || w.status === "failed" || w.status === "done") {
      reason = `worker ${w.status}`;
    } else if (w.mode !== "visible" && w.pid > 0 && !pidAlive(w.pid)) {
      saveWorker(root, { ...w, status: "exited", exit_code: w.exit_code ?? 0 });
      reason = "worker 进程已退出";
    } else if (w.mode !== "visible") {
      /* 与第一遍同口径：心跳或日志任一在窗口内更新即视为推进，不结单；带 stuck 的单刚发过指导，不提前结单。 */
      const live = workerLivenessOf(w, {
        heartbeatSec: timeoutSec,
        logStallSec: stuckSec,
        nowMs: nowSec * 1000,
      });
      if (live.alive) {
        if (w.status === "starting") touchWorker(root, w.id, { status: "running" });
      } else if (!w.stuck) {
        killJudgedWorker(root, w, true, out);
        saveWorker(root, { ...w, status: "failed" });
        reason = "worker 心跳与日志均已停滞";
      }
    }
    if (!reason) continue;

    failDispatchAndJudge(root, d, reason, out);
    recordEvent(root, "dispatch_orphan", {
      dispatch: d.id,
      stage: d.stage,
      shard: d.shard ?? "",
      worker: d.worker ?? "",
      worker_status: w?.status ?? "missing",
      reason,
    });
    out(`[监工] 派单 ${d.id}（${d.stage}/${d.shard ?? "整阶段"}）无人认领：${reason}，结单并等待重派`);
  }
}

/** 日志文件当前字节数；读不到按 0（新单、日志被删）。 */
function logBytes(log: string): number {
  try {
    return statSync(log).size;
  } catch {
    return 0;
  }
}

/** 一张在途派单的现场快照，用于诊断输出。 */
interface InflightSnapshot {
  id: string;
  status: string;
  shard: string;
  /** 从派单落地到现在多少秒。 */
  age_sec: number;
  worker: string;
  /** 工作进程号；没有记录为 0。 */
  pid: number;
  /** 工作进程日志距最后一次写入多少秒；读不到为 -1。 */
  idle_sec: number;
  /** 工作进程日志字节数。 */
  log_bytes: number;
  /** 进程是否还活着。 */
  pid_alive: boolean;
}

/** 一个阶段的进展快照。 */
interface StageProgress {
  stage: string;
  /** 门槛是否已满足。 */
  gateOk: boolean;
  /** 门槛缺什么（已满足时为空）。 */
  missing: string[];
  /** 当前阶段在途（open / claimed）的派单。 */
  inflight: InflightSnapshot[];
  /** 当前阶段最后一张派单（不论状态）。 */
  last: { id: string; status: string; shard: string; at: string; note: string } | null;
  /** 跨 tick 的比较签名。 */
  sig: string;
}

/**
 * 采一份阶段进展快照。签名 `sig` 只含「有无前进」的信息：派单 id 与状态、工作进程日志字节数、心跳。
 * 不含时间戳与 `age_sec`，否则每 tick 都变，签名永不相等，卡死检测不会触发。
 */
function stageProgress(root: string, contract: Contract): StageProgress {
  const state = loadState(root);
  if (!state) {
    return { stage: "", gateOk: true, missing: [], inflight: [], last: null, sig: "no-state" };
  }
  const stage = String(state.stage ?? "");
  const rows = readDispatches(root).filter((d) => d.stage === stage);
  const gate = runCheck(stageById(contract, stage)?.done as Record<string, unknown> | undefined, root);
  const nowSec = Date.now() / 1000;
  const nowMs = Date.now();

  const inflight: InflightSnapshot[] = [];
  const sigParts: string[] = [stage, gate.ok ? "gate-ok" : `gate-no:${gate.missing.join("§")}`];

  for (const d of rows) {
    if (d.status !== "open" && d.status !== "claimed") continue;
    const w = d.worker ? loadWorker(root, d.worker) : null;
    const bytes = w ? logBytes(w.log) : 0;
    const idle = w ? logIdleSec(w.log, nowMs) : Number.POSITIVE_INFINITY;
    const at = Date.parse(d.claimed_at ?? d.at);
    inflight.push({
      id: d.id,
      status: d.status,
      shard: d.shard ?? "",
      age_sec: Number.isFinite(at) ? Math.round(nowSec - at / 1000) : -1,
      worker: w?.id ?? "",
      pid: w?.pid ?? 0,
      idle_sec: Number.isFinite(idle) ? Math.round(idle) : -1,
      log_bytes: bytes,
      pid_alive: Boolean(w && w.pid > 0 && pidAlive(w.pid)),
    });
    sigParts.push(`${d.id}:${d.status}:${bytes}:${w?.heartbeat_ts ?? 0}:${w?.status ?? "none"}`);
  }

  const lastRow = rows[rows.length - 1];
  const last = lastRow
    ? {
        id: lastRow.id,
        status: lastRow.status,
        shard: lastRow.shard ?? "",
        at: lastRow.done_at ?? lastRow.claimed_at ?? lastRow.at,
        note: lastRow.note ?? "",
      }
    : null;

  // 最后一张单的 id 与状态也进签名：整阶段重做时派单被替换属真进展。
  sigParts.push(`last:${last?.id ?? "-"}:${last?.status ?? "-"}`);
  // 无在途单时，门槛是否满足与在途数量本身即进展信息。
  sigParts.push(`n:${inflight.length}`);

  return { stage, gateOk: gate.ok, missing: gate.missing, inflight, last, sig: sigParts.join("|") };
}

/** 报一条 stage_stalled：写事件并打印门槛缺口、最后一张派单状态、进程存活与日志空闲时长。 */
function reportStageStalled(
  root: string,
  progress: StageProgress,
  ticks: number,
  tickSec: number,
  out: (s: string) => void,
): void {
  const payload = {
    stage: progress.stage,
    stalled_ticks: ticks,
    stalled_sec: Math.round(ticks * tickSec),
    gate_ok: progress.gateOk,
    gate_missing: progress.missing,
    inflight: progress.inflight,
    last_dispatch: progress.last,
  };
  recordEvent(root, "stage_stalled", payload);

  out(
    `[监工] ⚠ 阶段 ${progress.stage || "(无阶段)"} 卡死：连续 ${ticks} 个 tick（约 ${Math.round(
      ticks * tickSec,
    )}s）没有任何在途进展`,
  );
  out(
    progress.gateOk
      ? "[监工]   门槛：已满足（卡的不是门槛，是在途的单）"
      : `[监工]   门槛：未满足 —— ${progress.missing.join("；") || "未给出缺失项"}`,
  );
  if (progress.last) {
    out(
      `[监工]   最后一张单：${progress.last.id}（${progress.last.shard || "整阶段"}）` +
        ` 状态 ${progress.last.status}${progress.last.note ? `（${progress.last.note}）` : ""} @ ${progress.last.at}`,
    );
  } else {
    out("[监工]   最后一张单：本阶段没有任何派单记录");
  }
  for (const d of progress.inflight) {
    out(
      `[监工]   在途 ${d.id}（${d.shard || "整阶段"}）${d.status} ${d.age_sec}s` +
        (d.worker
          ? `，worker ${d.worker} pid ${d.pid} ${d.pid_alive ? "存活" : "已不在"}，` +
            `最后输出 ${d.idle_sec < 0 ? "（无日志）" : `${d.idle_sec}s 前`}（日志 ${d.log_bytes}B）`
          : "，无 worker 记录"),
    );
  }
  out("[监工]   处置：超过 2 倍 worker 超时仍未结单的派单会被强制结单并重派；仍不动请 capitalist ask / capitalist pause");
}

/**
 * 强制结单在途超过 `maxAgeSec` 的派单，使其下一轮重派。
 * 结单后打 `forced` 标记，重派不占退避窗口，失败计数与重派上限照常。
 * 可见窗口模式只结单、不结束进程。
 * @returns 被强制结单的派单 id，供调用方汇总。
 */
function forceFinishHung(root: string, maxAgeSec: number, out: (s: string) => void): string[] {
  const nowSec = Date.now() / 1000;
  const done: string[] = [];
  for (const d of readDispatches(root)) {
    if (d.status !== "claimed") continue;
    const at = Date.parse(d.claimed_at ?? d.at);
    if (!Number.isFinite(at)) continue;
    const age = nowSec - at / 1000;
    if (age <= maxAgeSec) continue;

    const w = d.worker ? loadWorker(root, d.worker) : null;
    if (w && w.mode !== "visible" && (w.status === "running" || w.status === "starting")) {
      killJudgedWorker(root, w, true, out);
      saveWorker(root, { ...w, status: "failed" });
    }
    const note = `阶段卡死强制结单（在途 ${Math.round(age)}s > 2×worker 超时 ${maxAgeSec}s）`;
    if (!failDispatchAndJudge(root, d, note, out)) continue;
    patchDispatch(root, d.id, { forced: true } as Partial<DispatchEx>);
    recordEvent(root, "dispatch_forced_finished", {
      dispatch: d.id,
      stage: d.stage,
      shard: d.shard ?? "",
      worker: d.worker ?? "",
      age_sec: Math.round(age),
      limit_sec: maxAgeSec,
      reason: "stage_stalled",
    });
    out(`[监工] 派单 ${d.id}（${d.stage}/${d.shard || "整阶段"}）在途 ${Math.round(age)}s 未结单，强制结单并重派`);
    done.push(d.id);
  }
  return done;
}

/**
 * 工作进程以选定模型启动失败时，按优先级链取上一档模型重试一次并记 model_fallback 事件。
 * 已用回退则不再回退，避免死循环。
 */
function handleModelFallback(
  root: string,
  contract: Contract,
  _host: WorkerHost,
  _wopts: WorkerSpawnOpts,
  out: (s: string) => void,
): void {
  const heldScope = activeTakeover(root);
  for (const w of listWorkers(root)) {
    if (w.status !== "failed") continue;
    const ds = readDispatches(root).filter((x) => x.id === w.dispatch);
    const d = ds[ds.length - 1];
    if (!d) continue;
    const ex = d as DispatchEx;
    if (!ex.model_fallback || ex.model_fallback_used) continue;
    // 分片已被人工持有时，换模型重试同属自动重派，不在该范围内进行。
    if (heldScope.all || (d.shard && heldScope.shards.includes(d.shard))) continue;

    patchDispatch(root, d.id, { model_fallback_used: true } as Partial<DispatchEx>);
    recordEvent(root, "model_fallback", {
      dispatch: d.id,
      worker: w.id,
      from_model: ex.model ?? "",
      to_model: ex.model_fallback,
      stage: d.stage,
      shard: d.shard ?? "",
    });
    out(`[监工] 模型 ${ex.model ?? "（宿主默认）"} 启动即失败，回退到 ${ex.model_fallback} 重试一次（单 ${d.id}）`);

    const fb = ex.model_fallback;
    const nid = newDispatchId();
    const taken = claimDirectives(root, {
      shard: d.shard ?? "",
      stage: d.stage,
      dispatchId: nid,
      lane: laneKeyOf({ stage: d.stage, shard: d.shard, lineage: String((d as DispatchEx).lineage ?? d.id) }),
    });
    // 换模型重试属重派：基础文字取契约当前值，不续用旧快照；分片不在契约里时退回快照，且不再叠验收清单（快照已叠过）。
    const freshAction = contractShardAction(contract, d.stage, d.shard ?? "");
    const action = freshAction === null
      ? spliceDirectives(d.action, taken)
      : withAcceptance(root, spliceDirectives(freshAction, taken));
    const nd = {
      id: nid,
      at: new Date().toISOString(),
      stage: d.stage,
      shard: d.shard,
      /* 换模型重试沿用原单标题；原单无标题时按分片映射补齐。 */
      title: ex.title || shardTitle(d.shard) || taskTitle({ shard: d.shard, action }),
      action,
      status: "open",
      source: "requeue",
      model: fb,
    } as DispatchEx;
    nd.lineage = nd.lineage ?? nd.id;
    appendDispatch(root, nd);
    ensureTaskForDispatch(root, nd);
    recordEvent(root, "dispatch_open", {
      dispatch: nd.id,
      stage: nd.stage,
      shard: nd.shard ?? "",
      action: nd.action,
      source: "requeue",
      model: fb,
      note: "model_fallback",
    });
  }
}

/**
 * 本进程内已执行过的指令 id。
 * 拿不到跨进程锁时记录仍为未消费状态，此集合避免下一 tick 重复执行同一条指令。
 */
const executedDirectiveIds = new Set<string>();

/**
 * 每个任务根最近一次门槛判定的签名。
 * 仅当通过与否或缺失项变化时记 `gate_eval`，避免结果未变时重复写事件。
 */
const lastGateSig = new Map<string, string>();

/** 写 `.capitalist/pause.json`（与 `capitalist pause` 同源，面板指令不另立暂停态）。 */
function writePauseFile(root: string, reason: string, by: string): void {
  writeJson(pausePath(root), { at: new Date().toISOString(), reason, by });
  recordEvent(root, "pause_set", { reason, by });
}

/**
 * 解除暂停：删除 `pause.json` 即恢复，与 `capitalist resume` 同一路径。
 * 删除失败先重试，再回落到改名；Windows 上文件被 hook 或轮询短暂持有时 unlink 返回 EPERM/EBUSY，
 * 同卷 rename 通常可用，改名后读取侧即视为已解除。全部失败时如实报错。
 */
function clearPauseFile(root: string, by: string): { ok: boolean; error?: string } {
  const p = pausePath(root);
  let lastErr: unknown = null;
  for (let i = 0; i < 6; i += 1) {
    try {
      if (!existsSync(p)) {
        /* 恢复派单同时取消停止请求，否则下一 tick 会重新写回暂停。 */
        clearStopFlag(root);
        recordEvent(root, "pause_cleared", { by });
        return { ok: true };
      }
      unlinkSync(p);
      clearStopFlag(root);
      recordEvent(root, "pause_cleared", { by });
      return { ok: true };
    } catch (e) {
      lastErr = e;
      try {
        const stale = `${p}.${Date.now()}.stale`;
        renameSync(p, stale);
        try {
          unlinkSync(stale);
        } catch {
          /* 改名成功即已解除；残留的 `.stale` 不影响判定，留待下次清理。 */
        }
        recordEvent(root, "pause_cleared", { by, via: "rename" });
        clearStopFlag(root);
        return { ok: true };
      } catch {
        /* 改名失败时继续重试。 */
      }
    }
  }
  return { ok: false, error: lastErr instanceof Error ? lastErr.message : String(lastErr ?? "未知原因") };
}

function reject(reason: string): SupervisorResult {
  return { ok: false, reason, detail: "" };
}

/**
 * 回执里标识派单的编号（`#12`），取自 `thread-no.json`，与任务列表同源。
 * 表中无此单时返回空串，不退回内部 id，也不按队列顺序生成。
 */
function dispatchNoLabel(root: string, id: string): string {
  const no = dispatchNoTable(root).get(String(id ?? "").trim());
  return no ? `#${no}` : "";
}

/**
 * 用当前状态回答 `ask` 的问题。只读，只陈述阶段进度、并行度、在途数、派单构成、`runCheck` 结果、
 * 暂停与裁决与欠账、重派最多的分片、下一步，不给建议也不改变调度状态。问题原文置于开头。
 */
function answerSupervisorQuestion(root: string, contract: Contract, state: TaskState, question: string): string {
  const stageId = String(state.stage ?? "");
  const stage = stageId ? stageById(contract, stageId) : undefined;
  const idx = stageId ? contract.stages.findIndex((s) => s.id === stageId) : -1;
  const total = contract.stages.length;
  const shards = stageParallel(contract, stageId);
  const rows = readDispatches(root).filter((d) => d.stage === stageId);
  const inflight = rows.filter((d) => d.status === "open" || d.status === "claimed").length;
  const done = rows.filter((d) => d.status === "done").length;
  const failed = rows.filter((d) => d.status === "failed").length;
  const gate = runCheck(stage?.done as Record<string, unknown> | undefined, root);
  const pause = readPause(root);
  const asks = openAsks(root).length;
  const debt = Array.isArray(state.debt) ? state.debt.length : 0;
  const capitalist = loadSupervisor(root);
  const tick = capitalist?.ticks ?? 0;
  const parallel = capitalist?.max_workers ?? shards.length;

  const retries = shards
    .map((s) => ({
      id: s.id,
      n: shardRetry(rows.filter((d) => (d.shard ?? "") === s.id)).failures,
    }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);

  const bits: string[] = [];
  bits.push(`现在在 ${stageId || "(无阶段)"}${idx >= 0 ? `（第 ${idx + 1}/${total} 阶段）` : ""}，第 ${tick} 个 tick`);
  bits.push(
    `并行 ${parallel}，在途 ${inflight}，本阶段派单 ${rows.length} 单（完成 ${done}，失败 ${failed}）`,
  );
  bits.push(
    gate.ok
      ? `门槛已过${gate.missing.length ? `（${gate.missing.slice(0, 3).join("；")}）` : ""}`
      : `门槛未过：${gate.missing.slice(0, 4).join("；") || "未给出缺失项"}`,
  );
  bits.push(pause ? `派单已暂停（${pause.reason || "手动暂停"}），手里的进程已停、等恢复后重派` : "派单未暂停");
  if (asks) bits.push(`有 ${asks} 条待裁决问题（capitalist inbox）`);
  if (debt) bits.push(`欠账 ${debt} 条`);
  if (retries.length) bits.push(`重派最多的分片：${retries.slice(0, 3).map((x) => `${x.id} ×${x.n}`).join("，")}`);
  if (state.next_action) bits.push(`下一步：${state.next_action}`);

  return `${question.trim() ? `问：${question.trim()}｜` : ""}${bits.join("；")}。`;
}

/**
 * 调度指令的附件归属：优先取指令固化的 `atts`（空数组表示明确不带图），
 * 否则按 `msg_id` 回查用户消息自带的 `atts`。不从 `arg` 正文解析，正文可能混入历史附件路径。
 */
function directiveAttachments(
  root: string,
  d: SupervisorDirective,
  arg: string,
): { atts: string[]; msgId: string; source: "field" | "message" | "none" } {
  const msgId = String(d.msg_id ?? "");
  if (Array.isArray(d.atts)) {
    return {
      atts: d.atts.map((p) => String(p ?? "").trim()).filter(Boolean),
      msgId,
      source: "field",
    };
  }
  if (msgId) {
    const back = attachmentsOfMessage(root, msgId);
    if (back !== null) {
      return { atts: back, msgId, source: "message" };
    }
  }
  /* `arg` 正文中的 `[附件]` 行不采信，记录 attachment_unbound 事件供追溯无归属附件。 */
  if (attachmentsIn(arg).length > 0) {
    recordEvent(root, "attachment_unbound", {
      msg_id: msgId,
      text: String(arg).slice(0, 120),
      count: attachmentsIn(arg).length,
    });
  }
  return { atts: [], msgId, source: "none" };
}

async function applyOneDirective(
  args: {
    root: string;
    contract: Contract;
    wopts: WorkerSpawnOpts;
    out: (s: string) => void;
  },
  d: SupervisorDirective,
): Promise<SupervisorResult> {
  const { root, contract, wopts, out } = args;
  const state = loadState(root);
  if (!state) return reject("任务根状态不可读，指令未执行");
  const action = d.action;
  const arg = String(d.arg ?? "").trim();

  if (action === "pause") {
    writePauseFile(root, `面板指令 ${d.id}`, "supervisor-direct");
    return { ok: true, reason: "", detail: "已暂停派单；手里的进程下一轮被停掉，恢复后重派" };
  }

  if (action === "resume") {
    /*
     * 恢复派单是用户动作：监工对话层（via: "capitalist"）下发的请求会被拒绝。
     * 看板「恢复调度」按钮走 via: "user"，不受此限制。
     */
    if (d.via === "capitalist") {
      return reject(
        "恢复派单需要用户动作：监工对话层不自行解除暂停。用户可在看板点击「恢复调度」，或明确要求恢复派单。",
      );
    }
    const had = readPause(root) !== null;
    const cleared = clearPauseFile(root, "supervisor-direct");
    if (!cleared.ok) {
      return reject(
        `暂停状态没清掉（${cleared.error ?? "文件被占用"}）：派单仍会被拒。稍后重试，或手动删除 .capitalist/pause.json。`,
      );
    }
    return { ok: true, reason: "", detail: had ? "已恢复派单" : "未处于暂停状态，已置为恢复态" };
  }

  if (action === "set-next") {
    if (!arg) return reject("set-next 缺少内容：写成 set-next <一句话>");
    if (arg.length > 500) return reject("set-next 内容过长（上限 500 字）");
    if (updateState(root, (s) => { s.next_action = arg; }) === null) {
      return reject("状态写入冲突，指令未生效，请重发一次");
    }
    return { ok: true, reason: "", detail: `下一步 → ${arg}` };
  }

  /* 复用 `closeTask`：closed 为终态，结单后不再重派。 */
  if (action === "cancel") {
    const m = /^\s*#?\s*(\d{1,4})\b/.exec(arg);
    if (!m) return reject("cancel 要写编号：`DO: cancel #<编号>`");
    const no = Number(m[1]);
    const hit = dispatchOfThreadNo(root, no, readDispatches(root));
    if (!hit) return reject(`没有 #${no} 这一单（编号看【任务编号表】）`);
    const r = closeTask(root, String(hit.id), { reason: "监工作废", by: "supervisor" });
    if (!r) return reject(`#${no} 已经结项（${String(hit.status)}），不用取消`);
    return {
      ok: true,
      reason: "",
      detail: `已作废 #${no}${r.killed ? "（执行进程已结束）" : ""}，不会再派`,
      dispatch: String(hit.id),
    };
  }

  /*
   * amend 复用 `direct.jsonl` 追加通道：排队单启动时并入 action，执行中进程在下一个工具间隙收到；
   * 目标由 `target` 或正文编号指认，无目标时拒绝。收尾由 `--added` 说明改动，监工据此复审。
   */
  if (action === "amend") {
    if (!arg) return reject("amend 缺少内容：写成 amend <补充或更正的要求>");
    if (arg.length > 4000) return reject("amend 内容过长（上限 4000 字）");
    const bound = directiveAttachments(root, d, arg);
    /* 正文开头的编号由 threadNo.ts 分配，仅翻回线程键，不按队列顺序推断。 */
    const noM = /^\s*#\s*(\d{1,4})\b/.exec(arg);
    const text = bindAttachments(arg.replace(/^\s*#\s*\d{1,4}\s*/, ""), bound.atts).text;
    const rows = readDispatches(root);
    const want = String(d.target ?? "").trim();
    const byId = want ? rows.find((x) => String(x.id) === want) : undefined;
    /* 按编号定位链上的在途单（见 dispatchOfThreadNo）。 */
    const byNo = noM ? dispatchOfThreadNo(root, Number(noM[1]), rows) : undefined;
    const live = (st: string): boolean => ["open", "claimed", "reported", "review"].includes(st);
    /* 正文编号优先于会话推断的 target；无目标时拒绝，不回落到最近一张在途单。 */
    /* 明确指向的单若已终结，固定在该链并重新开出。 */
    const settledPin =
      byNo && !live(String(byNo.status ?? ""))
        ? byNo
        : byId && !live(String(byId.status ?? ""))
          ? byId
          : undefined;
    const livePick =
      byNo ?? (byId && live(String(byId.status ?? "")) ? byId : undefined);
    const pick = livePick ?? settledPin;
    if (!pick) {
      /* 两种情形分开报：写给编号但该编号已无在途单，与完全没写编号，处置不同。 */
      return reject(
        noM
          ? `#${Number(noM[1])} 没有可追加的派单（已终结或已取代），改用当前在途单的编号`
          : "这条追加缺少单号：正文前写 #编号（如 #1）",
      );
    }
    const rec = appendDirective(root, {
      text,
      target: String(pick.id),
      shard: pick.shard ?? null,
      stage: pick.stage || state.stage,
      lineage: String((pick as DispatchEx).lineage ?? pick.id),
      lane: laneKeyOf(pick as { stage?: string; shard?: string | null; lineage?: string; id?: string }),
      /* via 标记为 capitalist：追加来自监工对话层，回显按监工侧处理。 */
      via: "capitalist",
      ...(bound.msgId ? { msgId: bound.msgId } : {}),
      ...(bound.atts.length ? { atts: bound.atts } : {}),
    });
    if (!rec) return reject("追加内容写入失败（.capitalist 不可写？）");
    /*
     * 目标单已终结时翻回 open，由同一 prompt 带上追加重新拉起；
     * 须同时清除 `retry_verdict`、`done_at`、`review_until`，否则重派闸拦截或再次被回收。
     */
    let reopened = "";
    if (settledPin) {
      const why = `用户在这条线程追加了新内容（${String(settledPin.status)} → open）`;
      reopenSettledDispatch(root, settledPin.id, why);
      reopened = settledPin.id;
      recordEvent(root, "directive_reopen", {
        dispatch: settledPin.id,
        stage: settledPin.stage,
        from: String(settledPin.status),
        text: text.slice(0, 200),
      });
      out(`[监工] 追加的目标单 ${settledPin.id} 已终结（${settledPin.status}），已翻回 open 让这条追加有进程执行`);
    }
    recordEvent(root, "directive_amended", {
      dispatch: pick.id,
      stage: pick.stage,
      shard: pick.shard ?? "",
      status: pick.status,
      text: text.slice(0, 300),
      atts: bound.atts,
      wanted: want,
      wanted_no: noM ? noM[1] : "",
      /* guessed 记录无目标时由推断选定，供复核识别。 */
      guessed: !want && !byNo,
      reopened,
    });
    const pickLabel = dispatchNoLabel(root, pick.id);
    return {
      ok: true,
      reason: "",
      detail: reopened
        ? `已追加到派单${pickLabel ? ` ${pickLabel}` : ""}（它已终结，已翻回 open，下一轮携带原上下文重新拉起）`
        : `已追加到在途派单${pickLabel ? ` ${pickLabel}` : ""}（${pick.status === "open" ? "还没拉起，启动时带入" : "执行中的进程会在下一个动作间隙收到"}）` +
          "；它收尾时用 --added 说明，复审按新口径验",
      /* dispatch 供回执卡片查任务编号（见 direct.ts 的 SupervisorResult.dispatch）。 */
      dispatch: pick.id,
    };
  }

  /*
   * 立即落一张 urgent 单，fillSlots 当轮即会派发；与 set-next 只登记文字不同。
   * shard 留空：临时单不属契约分片，不参与必需分片判定，但占一个并行槽。
   */
  if (action === "dispatch") {
    if (!arg) return reject("dispatch 缺少任务内容：写成 dispatch <要做什么>");
    if (arg.length > 4000) return reject("dispatch 内容过长（上限 4000 字）");
    /*
     * 附件在组单时按指令的 `atts` 绑定，正文只保留本单选中的图；
     * 未选中的历史截图不写入，避免后续摘除。
     */
    const bound = directiveAttachments(root, d, arg);
    const boundArg = bindAttachments(arg, bound.atts);
    /*
     * `--now`：新建即抢占。建单时即带立即执行语义，避免再补 promote 之间该单被排后。
     * 与 `queue` 的区别保留：queue 只插队到队首，不抢占。
     */
    const nowM = /^\s*--now\s+/i.exec(boundArg.text);
    const wantNow = Boolean(nowM);
    const argClean = nowM ? boundArg.text.slice(nowM[0].length).trim() : boundArg.text;
    /*
     * 分类标签写在正文最前的方括号内，作为会话车道键：同类共用键以复用上下文，
     * 无标签落 `misc` 车道。标签由派单时给出，非固定枚举。
     */
    const tagM = /^\[([^\]\n]{1,24})\]\s*([\s\S]+)$/.exec(argClean);
    const tag = tagM ? String(tagM[1]).trim() : "";
    const body = tagM ? String(tagM[2]).trim() : argClean;
    /* 暂停期间不派单，含插队单；拒绝并说明原因。 */
    if (readPause(root) !== null) {
      return reject(
        "监工处于暂停派单：这条不会执行。先恢复派单（看板指标条的「恢复调度」按钮，或 capitalist resume），再发一次。",
      );
    }
    /*
     * 忽略附件行与空白比较 action：已有 open / claimed / review 的同内容单时不新派，
     * 避免两个进程执行同一任务并互相覆盖。
     */
    const bodyKey = String(body ?? "").replace(/\s+/g, " ").trim();
    const dup = readDispatches(root).find(
      (x) =>
        (x.status === "open" || x.status === "claimed" || x.status === "review") &&
        String(x.action ?? "")
          .replace(/^\s*\[附件\].*$/gm, "")
          .replace(/\s+/g, " ")
          .trim() === bodyKey,
    );
    if (dup) {
      return reject(
        `同一件事已有在途单 ${dup.id}（${dup.status}）：不重复派。要看进展就点开那一单，要重做用 capitalist retry。`,
      );
    }
    /*
     * 将 `PARENT` / `AFTER` 的编号或 id 翻译为台账派单 id：编号表仅用于界面，台账 id 在重派后仍可追踪。
     * 单父节点由 `PARENT` 指定，兄弟由同父派生；`AFTER` 为遗留写法，仍支持多前置与 `*` 屏障。
     * 父节点必须在台账存在，否则拒绝该派单。
     */
    const afterRefs = Array.isArray((d as SupervisorDirective).after)
      ? (d as SupervisorDirective).after!.map((x) => String(x ?? "").trim()).filter(Boolean)
      : [];
    const parentTokRaw = String((d as SupervisorDirective).parent ?? "").trim();
    /* `PARENT: none` 等否定值等价于未指定父节点。 */
    const parentTok = /^(none|no|无|-|—)$/i.test(parentTokRaw) ? "" : parentTokRaw;
    const parentWhy = String((d as SupervisorDirective).parent_reason ?? "").trim();
    const afterRows = afterRefs.length > 0 || parentTok ? readDispatches(root) : [];
    const afterIds: string[] = [];
    for (const tok of afterRefs) {
      if (tok === "*") {
        afterIds.push("*");
        continue;
      }
      const hit = resolveDispatchRef(root, afterRows, tok);
      if (!hit) {
        return reject(
          `AFTER 里的前置单「${tok}」在台账里找不到：依赖关系不落数据就不生效。先派前面的单，或核对编号后重发。`,
        );
      }
      afterIds.push(String(hit.id));
    }
    let parentId = "";
    if (parentTok) {
      const hit = resolveDispatchRef(root, afterRows, parentTok);
      if (!hit) {
        return reject(
          `PARENT 里的父派单「${parentTok}」在台账里找不到：树边不落数据就不生效。先派父节点，或核对编号后重发。`,
        );
      }
      parentId = String(hit.id);
      /* checkTreeEdge 校验父节点存在、未结项、不成环、已写理由；拒绝原因写入指令记录供界面显示。 */
      const chk = checkTreeEdge(afterRows, parentId, parentWhy);
      if (!chk.ok) return reject(chk.reason);
    }
    /* 同标签且内容相似的需求合并到同一 open 单，action 超过 `MERGE_MAX_CHARS` 时改为新建。 */
    const MERGE_MAX_CHARS = 6000;
    /* 带依赖的单不合并：并入他单后依赖边不随记录保存，重启会丢失执行顺序。 */
    if (tag && afterIds.length === 0 && !parentId) {
      /* 标签仅作必要条件，另按标题与正文开头的相似度判定，阈值 0.45。 */
      const head = body.slice(0, 80);
      const same = readDispatches(root).find((x) => {
        if (x.status !== "open") return false;
        const tags = (x as DispatchEx).tags;
        if (!Array.isArray(tags) || !tags.includes(tag)) return false;
        const ttl = String((x as DispatchEx).title ?? "").trim();
        /* 标题为空的单不参与合并：无可比意图。 */
        if (!ttl) return false;
        return titleSimilarity(ttl, head) >= 0.45;
      });
      if (same && String(same.action ?? "").length + body.length <= MERGE_MAX_CHARS) {
        const merged = `${String(same.action ?? "").trimEnd()}\n- ${body}`;
        /*
         * 合并单时把选中的附件并入 `atts`，并把来源消息记入 `src_msgs`，便于追溯附件所属消息；
         * 标题沿用首次登记值，保持合并后仍可定位同一单。
         */
        const mergedAtts = [
          ...new Set([...(Array.isArray(same.atts) ? same.atts.map(String) : []), ...boundArg.kept]),
        ];
        const mergedMsgs = bound.msgId
          ? [...new Set([...(same.src_msgs ?? []), bound.msgId])]
          : same.src_msgs;
        patchDispatch(root, same.id, {
          action: merged,
          atts: mergedAtts,
          ...settlingTitle(same),
          ...(mergedMsgs && mergedMsgs.length ? { src_msgs: mergedMsgs } : {}),
        } as Partial<Dispatch>);
        recordEvent(root, "dispatch_merged", {
          into: same.id,
          stage: state.stage,
          tag,
          chars: merged.length,
          text: body.slice(0, 160),
          atts: mergedAtts,
        });
        /*
         * 回执须写明并入的目标单编号，取自 thread-no.json，与任务列表同源；
         * 批次标签单独写，不复用 `#` 前缀。
         */
        const intoLabel = dispatchNoLabel(root, same.id);
        return {
          ok: true,
          reason: "",
          detail:
            `同类任务已在执行：本条并入派单${intoLabel ? ` ${intoLabel}` : ""}` +
            `（批次 ${tag}，累计 ${merged.length} 字），不新建进程`,
          /* dispatch 供回执卡片查任务编号；历史记录无此字段时由回执正文回填。 */
          dispatch: same.id,
        };
      }
      if (same) {
        const sameLabel = dispatchNoLabel(root, same.id);
        return {
          ok: true,
          reason: "",
          detail:
            `同类在途单${sameLabel ? ` ${sameLabel}` : ""}（批次 ${tag}）已经 ${String(same.action).length} 字，` +
            `再加会超过 ${MERGE_MAX_CHARS} 字上限（上下文过长），所以另开一张。`,
        };
      }
    }
    const id = newDispatchId();
    const taken = claimDirectives(root, {
      shard: "",
      stage: state.stage,
      dispatchId: id,
      lineage: id,
      lane: laneKeyOf({ stage: state.stage, shard: "", lineage: id }),
    });
    /*
     * 随建单领走的插话附件并入 `atts`：优先用指令固化的 `atts`，其次按 `msg_id` 回查整份消息；
     * 不从正文解析历史路径，避免夹带不相关附件。
     */
    const takenAtts = taken.flatMap((x) =>
      Array.isArray(x.atts) ? x.atts.map(String) : x.msg_id ? (attachmentsOfMessage(root, x.msg_id) ?? []) : [],
    );
    const ownAtts = [...new Set([...boundArg.kept, ...takenAtts.map(String)])];
    const srcMsgs = [
      ...new Set([...(bound.msgId ? [bound.msgId] : []), ...taken.map((x) => String(x.msg_id ?? "")).filter(Boolean)]),
    ];
    const actionText = withAcceptance(root, spliceDirectives(body, taken));
    const adhoc = {
      id,
      at: new Date().toISOString(),
      stage: state.stage,
      shard: "",
      /* title 在建单时确定；缺失时界面回落为正文前 40 字。 */
      title: taskTitle({ shard: "", action: body }),
      action: actionText,
      status: "open",
      source: "adhoc",
      attempt: 1,
      urgent: true,
      /* `atts` 在建单时固化，重派按此字段重建附件行。 */
      atts: ownAtts,
      ...(bound.msgId ? { src_msg: bound.msgId } : {}),
      ...(srcMsgs.length ? { src_msgs: srcMsgs } : {}),
      ...(tag ? { tags: [tag] } : {}),
      /* `after` 落库供 fillSlots 每轮重算，重启与重派后执行顺序保持不变。 */
      ...(afterIds.length ? { after: afterIds } : {}),
      /* `parent` 与 `parent_reason` 一起落盘，缺理由时重启后无法判定该依赖是否为必需。 */
      ...(parentId ? { parent: parentId, parent_reason: parentWhy } : {}),
    } as Dispatch;
    adhoc.lineage = adhoc.lineage ?? adhoc.id;
    appendDispatch(root, adhoc);
    ensureTaskForDispatch(root, adhoc);
    /* `--now` 建单当轮由 `promoteTask` 写 `promoted_at` 触发抢占；失败不阻断建单，降级为排队优先。 */
    const nowPrompted = wantNow ? promoteTask(root, id, { by: "supervisor" }) : null;
    if (wantNow && !nowPrompted?.ok) {
      out(`[监工] 立即执行标记没生效：${nowPrompted?.reason ?? "未知原因"}（单已建好，按排队优先处理）`);
    }
    recordEvent(root, "dispatch_open", {
      dispatch: id,
      stage: state.stage,
      shard: "",
      action: actionText,
      source: "adhoc",
      attempt: 1,
      model: "",
      directives: taken.length,
      urgent: true,
      tag,
      atts: ownAtts,
      src_msg: bound.msgId,
      after: afterIds,
      parent: parentId,
      parent_reason: parentWhy,
    });
    /* 回执按槽位占用如实标注是否会立即执行。 */
    const cap = Math.max(1, Number(loadSupervisor(root)?.max_workers ?? 1) || 1);
    const busy = liveWorkers(root).length;
    const when = wantNow && nowPrompted?.ok
      ? "已立即执行：抢占槽位，正在跑的那条让位回排队队首"
      : parentId
      ? `已挂到父节点 ${parentId} 下（${parentWhy}）：父节点完成前不会启动，不占并行槽位`
      : afterIds.length
        ? `已登记依赖 ${afterIds.join("、")}：前置单全部完成前不会启动，不占并行槽位`
        : busy < cap
          ? "当拍拉起进程"
          : `当前 ${busy}/${cap} 个并行槽位已占用，待槽位释放后立即拉起（已置于队首）`;
    return {
      ok: true,
      reason: "",
      detail: `已插入队列优先执行 ${id}：${argClean.slice(0, 80)}｜${when}`,
      /* urgent 标识插队单，回显前缀据此显示。 */
      urgent: true,
      /* dispatch 供执行回执卡查任务编号。 */
      dispatch: id,
    };
  }

  /*
   * diagnose 只查不改，fix 查完即修。两者不受暂停与阻塞限制，且不占业务槽位。
   * fix 使用带派单 id 后缀的全新车道，不复用既有上下文；diagnose 允许同类复用。
   */
  if (action === "diagnose" || action === "fix") {
    if (!arg) return reject(`${action} 缺少内容：写成 ${action} <卡在哪>`);
    if (arg.length > 4000) return reject(`${action} 内容过长（上限 4000 字）`);
    const bound = directiveAttachments(root, d, arg);
    const boundArg = bindAttachments(arg, bound.atts);
    const id = newDispatchId();
    const tag = action === "fix" ? `fix-${id.slice(-6)}` : "diagnose";
    const rec = {
      id,
      at: new Date().toISOString(),
      stage: state.stage,
      shard: "",
      title: `${action === "fix" ? "修复" : "诊断"}：${boundArg.text.slice(0, 56)}`,
      action: boundArg.text,
      status: "open",
      source: "adhoc",
      attempt: 1,
      urgent: true,
      role: action,
      tags: [tag],
      atts: boundArg.kept,
      ...(bound.msgId ? { src_msg: bound.msgId } : {}),
    } as Dispatch;
    rec.lineage = rec.lineage ?? rec.id;
    appendDispatch(root, rec);
    ensureTaskForDispatch(root, rec);
    recordEvent(root, "dispatch_open", {
      dispatch: id,
      stage: state.stage,
      shard: "",
      action: boundArg.text,
      source: "adhoc",
      attempt: 1,
      role: action,
      tag,
      urgent: true,
      atts: boundArg.kept,
      src_msg: bound.msgId,
    });
    return {
      ok: true,
      reason: "",
      detail:
        `已建${action === "fix" ? "修复" : "诊断"}单 ${id}（全新会话 ${`capitalist-${state.stage}-${tag}`}，不占业务槽位）` +
        `：${boundArg.text.slice(0, 80)}`,
    };
  }

  /*
   * 重载落 snapshot 与 resume.json 并更换会话，不重启进程：进程重启由外部拉起。
   */
  if (action === "reload") {
    try {
      const summary = await beginReload(root, contract, { holdSec: 0, out });
      const bits = [
        `已落盘快照 gen ${summary.gen}`,
        `上下文 ${summary.before_chars} → ${summary.after_chars} 字`,
        `待复验 ${summary.reverify} 片、继续做 ${summary.pending} 片`,
      ];
      return { ok: true, reason: "", detail: bits.join("｜") };
    } catch (err) {
      return reject(`重载失败：${String((err as Error).message ?? err)}`);
    }
  }

  if (action === "concurrency") {
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1) return reject(`concurrency 需要正整数，收到「${arg || "(空)"}」`);
    /* 并行度上限由用户设定，不按阶段分片数封顶。 */
    return { ok: true, reason: "", detail: `并行度 → ${n}` };
  }

  /*
   * promote 把排队中的单置顶并腾出并发槽立即执行；只接受排队中的单。
   * preempt 为真表示下一轮挂起一张在跑的任务腾槽。
   */
  /* queue 把单插到排队队首，不抢占正在跑的进程；抢占用 promote。 */
  if (action === "queue") {
    if (!arg) return reject("queue 缺少派单编号（`DO: queue #03` 或直接写派单 id）");
    const qNo = /^\s*#\s*(\d{1,4})\b/.exec(arg);
    const qByNo = qNo ? dispatchOfThreadNo(root, Number(qNo[1])) : undefined;
    if (qNo && !qByNo) {
      return reject(`找不到 #${qNo[1]} 对应的在途单：它可能已执行结束或还没建单`);
    }
    const qTarget = qByNo ? String(qByNo.id) : arg;
    const q = frontDispatch(root, qTarget, "supervisor");
    if (!q) {
      return reject(
        `「${arg}」现在不在排队：插队只对还没开始跑的单有效。要抢跑正在跑的那一张，用 promote（立即执行）。`,
      );
    }
    return { ok: true, reason: "", detail: "已插到排队队首：下一个空出来的槽位先跑它，正在跑的进程不受影响" };
  }

  if (action === "promote") {
    if (!arg) return reject("promote 缺少派单编号（`DO: promote #03` 或直接写派单 id）");
    /* #NN 是任务号，与派单 id 分属不同命名空间，先经 dispatchOfThreadNo 转成派单 id。 */
    const noM = /^\s*#\s*(\d{1,4})\b/.exec(arg);
    const byNo = noM ? dispatchOfThreadNo(root, Number(noM[1])) : undefined;
    if (noM && !byNo) {
      return reject(
        `找不到 #${noM[1]} 对应的在途单：它可能已执行结束或还没建单（编号表里没有这个号时也是一样）`,
      );
    }
    const target = byNo ? String(byNo.id) : arg;
    const r = promoteTask(root, target, { by: "supervisor" });
    if (!r) return reject(`找不到排队中的单「${arg}」：先确认它在【任务编号表】里且还没开始跑`);
    if (!r.ok) return reject(r.reason);
    const bits = [r.preempt ? "已腾槽，下一轮立刻执行" : "已置顶，下一轮拉起"];
    if (r.behind) bits.push(`立即执行单 ${r.behind} 仍在跑，这一单排在它之后`);
    else if (r.ahead > 0) bits.push(`越过 ${r.ahead} 张排队单`);
    if (r.already) bits.push("重复置顶，已刷新到队首");
    return { ok: true, reason: "", detail: bits.join("｜") };
  }

  if (action === "retry") {
    if (!arg) return reject("retry 缺少分片 id");
    const shard = stageParallel(contract, state.stage).find((s) => s.id === arg);
    if (!shard) {
      const have = stageParallel(contract, state.stage).map((s) => s.id);
      return reject(
        `本阶段（${state.stage}）没有分片「${arg}」。可用分片：${have.length ? have.join(" / ") : "（本阶段没有分片）"}`,
      );
    }
    const rows = readDispatches(root).filter((x) => x.stage === state.stage && (x.shard ?? "") === arg);
    const inflight = rows.find((x) => x.status === "open" || x.status === "claimed");
    if (inflight) {
      return reject(`分片「${arg}」已有在途派单 ${inflight.id}（${inflight.status}），不重复派`);
    }
    const attempt = shardRetry(rows).failures + 1;
    createOpenShardDispatch(root, contract, state, shard, wopts, out, attempt);
    return { ok: true, reason: "", detail: `已重派 ${state.stage}/${arg}（第 ${attempt} 次）` };
  }

  if (action === "skip") {
    if (arg && arg !== state.stage) {
      return reject(`skip 只能跳过当前阶段 ${state.stage}，收到「${arg}」`);
    }
    if (d.confirm !== true) {
      return reject(`跳过阶段 ${state.stage} 属于危险动作，需要二次确认（快捷清单会再问一次；命令行写 skip ${state.stage} confirm）`);
    }
    if (isLastStage(contract, state.stage)) {
      return reject(`${state.stage} 是最后一个阶段，不能跳过`);
    }
    const nid = nextStageId(contract, state.stage);
    const next = nid ? stageById(contract, nid) : undefined;
    if (!next) return reject("找不到下一阶段，skip 未执行");

    // 跳过的阶段记欠账、不标达标，终审清算时仍会出现。
    const moved = updateState(root, (s) => enterStage(s, next));
    if (moved === null) return reject("状态写入冲突，skip 未执行");
    addDebt(root, state.stage, "skip");
    recordEvent(root, "stage_skipped", {
      from: state.stage,
      to: next.id,
      by: "supervisor-direct",
      directive: d.id,
      confirmed: true,
    });
    supersedeStaleDispatches(root, contract, next.id, out);
    return { ok: true, reason: "", detail: `已跳过 ${state.stage} → ${next.id}（记为欠账，不计达标）` };
  }

  /*
   * instruct 为废弃路径，新需求走 /api/capitalist-chat。解析在 instruct.ts，本处只调用既有原语写入状态。
   * 解析不出具体动作时不推断执行，返回原因与候选。
   */
  if (action === "instruct") {
    if (!arg) return reject("instruct 缺少内容：请写明要执行的操作");
    if (arg.length > 500) return reject("内容过长（上限 500 字）");

    const allStages = (contract as unknown as { stages?: Stage[] }).stages ?? [];
    const flat: { stage: string; id: string; action: string }[] = [];
    for (const s of allStages) {
      for (const sh of stageParallel(contract, s.id)) flat.push({ stage: s.id, id: sh.id, action: sh.action });
    }

    const plan = planInstruct({
      text: arg,
      stages: allStages,
      currentStage: state.stage,
      shards: flat,
    });

    recordEvent(root, "supervisor_instruct", {
      directive: d.id,
      text: arg,
      kind: plan.kind,
      stage: state.stage,
      target: plan.kind === "skip" ? plan.stage : "",
      reason: plan.reason,
    });

    if (plan.kind === "clarify") {
      /* 解析不出具体动作时不拒绝：按原始文本登记为 next_action，随下一次派单生效；危险动作不推断。 */
      const list = plan.candidates.length
        ? `｜候选：${plan.candidates.map((c) => `${c.id} ${c.name}`).join(" / ")}`
        : "";
      updateState(root, (s) => {
        // 加前缀，避免工作进程把这句话当成契约里的任务描述执行。
        s.next_action = `【要求】${arg}`;
      });
      recordEvent(root, "supervisor_instruct_fallback", {
        directive: d.id,
        text: arg,
        stage: state.stage,
        reason: plan.reason,
      });
      return {
        ok: true,
        reason: "",
        detail: `${plan.detail || "未识别出具体动作"}，已按原话登记为「下一步要求」，随下一次派单生效${list}`,
      };
    }

    // 复用既有动作；箭头函数非 async，返回 Promise 交由外层 await。
    const rerun = (act: SupervisorDirective["action"], a: string, confirm = false): Promise<SupervisorResult> =>
      applyOneDirective(args, { ...d, action: act, arg: a, confirm: confirm || d.confirm === true });

    if (plan.kind === "pause") return rerun("pause", "");
    if (plan.kind === "resume") return rerun("resume", "");
    if (plan.kind === "set-next") return rerun("set-next", plan.arg);
    if (plan.kind === "concurrency") return rerun("concurrency", plan.arg);
    if (plan.kind === "retry") return rerun("retry", plan.arg);
    if (plan.kind === "ask") return rerun("ask", plan.arg);
    return rerun("skip", plan.stage, true);
  }

  if (action === "ask") {
    if (!arg) return reject("ask 缺少问题：写成 ask <一句话>");
    if (arg.length > 500) return reject("问题过长（上限 500 字）");
    /* ask 只读，不写状态；回答记为 supervisor_answer 事件，与派单节奏解耦。 */
    const answer = answerSupervisorQuestion(root, contract, state, arg);
    recordEvent(root, "supervisor_answer", {
      id: d.id,
      question: arg,
      answer,
      stage: state.stage,
      tick: loadSupervisor(root)?.ticks ?? 0,
    });
    return { ok: true, reason: "", detail: "已回答，见监工流" };
  }

  return reject(`未知动作「${action || d.text || "(空)"}」。白名单：${CAPITALIST_ACTIONS.join(" / ")}`);
}

/**
 * 把 PARENT: / AFTER: 引用解析成台账行：#NN 按任务编号表转线程键取该链最新一张，其余按派单 id 精确匹配。
 * 落库一律写派单 id；找不到返回 undefined。
 */
function resolveDispatchRef(root: string, rows: Dispatch[], tok: string): Dispatch | undefined {
  const noM = /^#\s*(\d{1,4})$/.exec(tok);
  if (!noM) return rows.find((x) => String(x.id) === tok);
  const key = threadIdByNo(root, Number(noM[1]));
  if (!key) return undefined;
  const [st, tailRaw] = key.split("/");
  const stage = String(st ?? "").trim().toLowerCase();
  const tail = String(tailRaw ?? "").trim().toLowerCase();
  const linTail = tail.startsWith("x") ? tail.slice(1) : "";
  return [...rows].reverse().find((x) => {
    if (stage && String(x.stage ?? "").toLowerCase() !== stage) return false;
    const lin = String(x.lineage ?? x.id);
    if (linTail) return lin.slice(-6).toLowerCase() === linTail;
    if (!tail || tail === "main") return !String(x.shard ?? "").trim();
    return String(x.shard ?? "").toLowerCase() === tail;
  });
}

/**
 * 逐条执行通道指令并记 supervisor_cmd 事件。拒绝也标记已消费。
 * 标记失败由 executedDirectiveIds 保证下一 tick 只补标记、不重复执行。
 */
async function applySupervisorDirectives(args: {
  root: string;
  contract: Contract;
  state: TaskState;
  wopts: WorkerSpawnOpts;
  concurrency: number | null;
  out: (s: string) => void;
}): Promise<{ concurrency: number | null }> {
  const pending = pendingSupervisorDirectives(args.root);
  if (pending.length === 0) return { concurrency: args.concurrency };

  let next = args.concurrency;
  for (const d of pending) {
    if (executedDirectiveIds.has(d.id)) {
      markSupervisorDirective(args.root, d.id, d.result ?? { ok: true, reason: "", detail: "已执行" });
      continue;
    }

    const before = args.contract;
    let res: SupervisorResult;
    try {
      res = await applyOneDirective({ root: args.root, contract: before, wopts: args.wopts, out: args.out }, d);
    } catch (err) {
      res = reject(`执行异常：${String((err as Error).message ?? err)}`);
    }

    if (res.ok && d.action === "concurrency") {
      const n = Number(String(d.arg).trim());
      if (Number.isFinite(n) && n > 0) next = n;
    }

    executedDirectiveIds.add(d.id);
    if (executedDirectiveIds.size > 5000) executedDirectiveIds.clear();

    if (!markSupervisorDirective(args.root, d.id, res)) {
      args.out(`[监工] 指令 ${d.id} 结果未能落盘（锁被占用），下一 tick 只补标记不重复执行`);
    }
    recordEvent(args.root, "supervisor_cmd", {
      id: d.id,
      action: d.action || "",
      arg: d.arg,
      ok: res.ok,
      reason: res.reason,
      detail: res.detail,
      /* urgent 随事件落盘，渲染处据此区分插队派单与已派单。 */
      ...(res.urgent === true ? { urgent: true } : {}),
      text: String(d.text ?? "").slice(0, 120),
      tick: loadSupervisor(args.root)?.ticks ?? 0,
    });
    args.out(
      `[监工] 指令 ${d.action || "(未知)"}${d.arg ? ` ${d.arg}` : ""}：${res.ok ? "已执行" : "被拒"}` +
        `${res.ok ? `（${res.detail}）` : `（${res.reason}）`}`,
    );
  }
  return { concurrency: next };
}

/**
 * 启动时把上次退出时未完成的派单标记为暂停。
 *
 * 覆盖全部未结状态：`claimed` / `reported` 在重启后没有进程接续，判死回收时不该自动重跑。
 * 标记落在派单上而不只在内存里，判死后的重派闸据此继续拦住该单，直到用户唤醒。
 *
 * @returns 新写入标记的张数。
 */
export function holdLegacyDispatches(root: string): number {
  const live = new Set(["open", "claimed", "reported", "review"]);
  const ids = readDispatches(root)
    .filter((d) => live.has(String(d.status ?? "")))
    .map((d) => d.id);
  return holdDispatches(root, ids, "startup", "上次退出时未完成，启动后默认暂停；确认后唤醒");
}

/**
 * 任务根是否还有待办。
 *
 * 「没有任务」只有一种：任务整体已完工（最后阶段达标、`done_at` 已落），且无在途环节。
 * 其余情形均视为有待办：未派的分片、待裁决的问题、阻塞登记、手动派入的派单、待推进的
 * 中间阶段。待命分支据此决定是否执行调度轮询。
 *
 * 与 `step` 的差别：这里只判定是否存在待办，不判门槛能否推进、不派单、不写台账。
 */
export function hasPendingWork(root: string, contract: Contract, state: TaskState): boolean {
  const live = listWorkers(root).filter((w) => w.status === "running" || w.status === "starting");
  if (live.length > 0) return true;

  const dispatches = readDispatches(root);
  if (
    dispatches.some(
      (d) =>
        d.status === "open" ||
        d.status === "claimed" ||
        d.status === "reported" ||
        d.status === "review" ||
        /* 存在暂停单时不派单，监工也不转入待命状态，否则队列显示为空。 */
        (dispatchPaused(d) && d.status !== "done" && d.status !== "closed"),
    )
  ) {
    return true;
  }

  /* 待裁决问题与阻塞均需用户回复，归入待处理状态。 */
  if (openAsks(root).length > 0) return true;
  if ((Array.isArray(state.blockers) ? state.blockers.length : 0) > 0) return true;

  /* 已完工：等待用户派入新单，不执行调度轮询。 */
  if (String(state.done_at ?? "").trim()) return false;

  /* 中间阶段达标后仍需推进下一阶段。 */
  if (!isLastStage(contract, state.stage)) return true;

  /* 最后阶段：门槛未达成时仍有待办。 */
  const gate = runCheck(stageById(contract, state.stage)?.done as Record<string, unknown> | undefined, root);
  return !gate.ok;
}

/** 单 tick 的派发与结算。paused 时只结算不开新单，门槛判定与阶段推进照常。 */
function step(
  root: string,
  contract: Contract,
  host: WorkerHost,
  capacity: number,
  wopts: WorkerSpawnOpts,
  out: (s: string) => void,
  paused = false,
  autoDispatch = false,
): "continue" | "done" {
  const state = loadState(root);
  if (!state) return "continue";

  drainSettledDirectives(root, out);

  /* 待裁决 ask 超过 ASK_BLOCK_MS 后只提醒，不再阻塞派单。 */
  /*
   * 阶段一在任何「是否建新单」判定之前拉起已建单：ask、blocker 与暂停只影响新建单。
   */
  supersedeStaleDispatches(root, contract, state.stage, out);
  refreshOpenDispatchActions(root, contract, state.stage, out);
  if (!paused) {
    /* 插队单不在契约里，先补重派再填槽。 */
    requeueAdhoc(root, state, out);
    /* 悬空追加先于 fillSlots 翻回 open，同一轮可被 claim 拉起。 */
    rescueOrphanDirectives(root, out);
    fillSlots(root, contract, state, host, capacity, wopts, out);
  }

  /* 阶段二起，新建单才受待裁决问题与阻塞登记影响。 */
  const asks = openAsks(root);
  if (asks.length > 0) {
    const fresh = asks.filter((a) => {
      const at = Date.parse(String(a.at ?? ""));
      return !Number.isFinite(at) || Date.now() - at < ASK_BLOCK_MS;
    });
    /*
     * 只有无 shard、无 session、无 worker 的问题才停整个阶段；带 shard 的由 planDispatch 逐片判断。
     */
    const globalFresh = fresh.filter(
      (a) =>
        String(a.shard ?? "") === "" &&
        String(a.session ?? "") === "" &&
        String(a.worker ?? "") === "",
    );
    if (globalFresh.length > 0) {
      out("[监工] 有待裁决问题（全阶段级），暂停新建单（capitalist inbox / capitalist answer）");
      return "continue";
    }
    if (fresh.length === 0) {
      out(
        `[监工] ${asks.length} 条待裁决问题已挂超过 ${Math.round(ASK_BLOCK_MS / 60000)} 分钟没人答，` +
          "不再阻塞派单（capitalist inbox 仍可查看）",
      );
    }
  }

  // 阻塞登记同样只暂停新建单，与 capitalist block 的「不重派」承诺一致。
  const blockers = Array.isArray(state.blockers) ? state.blockers.length : 0;
  if (blockers > 0) {
    out(`[监工] 状态里有 ${blockers} 条阻塞，暂停新建单（capitalist unblock 后继续）`);
    return "continue";
  }

  const shards = stageParallel(contract, state.stage);
  const stageDispatches = readDispatches(root).filter((d) => d.stage === state.stage);
  const requiredShards = shards.filter((s) => s.required !== false);

  // 人工接管（.capitalist/takeover.json）的片不自动重派、不自动验收；接管态只读，写入方仅为用户。
  const hold = activeTakeover(root);
  const held = (shard?: string | null): boolean =>
    hold.all || (Boolean(shard) && hold.shards.includes(String(shard)));
  const holdNote = (): string =>
    hold.all
      ? "整个任务根处于人工接管"
      : `分片 ${hold.shards.join("、")} 处于人工接管`;

  // 必需分片（含热加载新增）缺派单即补，且须跑在 active 短路之前，否则新分片永远拿不到派单。
  // 接管中的片跳过。失败重派按退避间隔，连续失败到上限转 ask 裁决。
  const planDispatch = (shardId: string, redoDone: boolean): number | null => {
    /* 带 shard 的 ask 只停本片，不带 shard 的由全阶段级判定处理。 */
    const blockedByAsk = openAsks(root).some((a) => {
      if (String(a.shard ?? "") !== shardId) return false;
      /* 工作进程提的 ask（带 session 或 worker）不挡调度。 */
      if (String(a.session ?? "") !== "" || String(a.worker ?? "") !== "") return false;
      const at = Date.parse(String(a.at ?? ""));
      return !Number.isFinite(at) || Date.now() - at < ASK_BLOCK_MS;
    });
    if (blockedByAsk) return null;

    // 现读而不复用 tick 开头快照：同一 tick 补过的单也须算在途，否则会重复派单。
    const mine = readDispatches(root).filter(
      (d) => d.stage === state.stage && (d.shard ?? "") === shardId,
    );
    /* review 与 reported 均算在途：它们各有终态收尾路径，期间不该补派同一片。 */
    if (
      mine.some(
        (d) =>
          d.status === "open" ||
          d.status === "claimed" ||
          d.status === "reported" ||
          d.status === "review",
      )
    )
      return null;
    /*
     * 暂停单继续占住该片：该单还没做完，只是等用户唤醒。
     * 不占位就会被当成「没派过」补一张新单，等于绕过暂停。
     */
    if (mine.some((d) => dispatchPaused(d) && d.status !== "done" && d.status !== "closed")) return null;
    /* closed 片不再补单，判断须排在 done 之前：closed 是「不做了」，不应被 redoDone 重跑。 */
    if (mine.some((d) => d.status === "closed")) return null;
    /* give_up、pending、hold 均挡重派；pending 未返回前不派，避免退避到点拉起后判定失效。 */
    const blockedByVerdict = mine.some((x) => {
      const v = (x as DispatchEx).retry_verdict;
      /* hold 表示卡点未消除、暂不重派，与 give_up / pending 同一道闸。 */
      return v === "give_up" || v === "pending" || v === "hold";
    });
    if (blockedByVerdict) return null;
    if (!redoDone && mine.some((d) => d.status === "done")) return null;
    const retry = shardRetry(mine, retryResetMs(state, state.stage, shardId));
    /* 重派上限只拦自动重派；用户主动派发的分片无条件放行。 */
    const userForced = userAskedRecently(root, shardId);
    if (retry.failures >= REDISPATCH_LIMIT) {
      /*
       * 达到重派上限后继续按退避重派，并开只读诊断单查根因。
       * 硬停仅在 HARD_STOP_FAILURES 之后，且登记 ask 转人工裁决。
       */
      if (!userForced) {
        raiseRedispatchCap(root, state.stage, shardId, mine, out);
        escalateStuckShard(root, state.stage, shardId, retry.failures, mine, out);
        if (retry.failures >= HARD_STOP_FAILURES) {
          raiseAsk(
            root,
            `分片 ${state.stage}/${shardId || "整阶段"} 连续失败 ${retry.failures} 次，已超过硬停阈值，停止自动重派`,
            mine
              .filter((d) => d.status === "failed")
              .slice(-5)
              .map((d) => `${d.id}（${d.note ?? "无说明"}）`)
              .join("；"),
            state.stage,
            shardId,
          );
          return null;
        }
        out(
          `[监工] 分片 ${state.stage}/${shardId || "整阶段"} 已连续失败 ${retry.failures} 次：` +
            `继续按退避重派，并已转诊断查根因（硬停在 ${HARD_STOP_FAILURES} 次）`,
        );
      } else {
        out(`[监工] 分片 ${state.stage}/${shardId || "整阶段"} 已达重派上限，但人工介入过，继续重派`);
      }
    }
    // forced 单不占退避窗口（已挂 2 倍工作进程超时）；失败计数照加，上限仍成立。
    const failedRows = mine.filter((d) => d.status === "failed");
    const lastFailed = failedRows[failedRows.length - 1] as DispatchEx | undefined;
    if (
      !userForced &&
      lastFailed?.forced !== true &&
      retry.failures > 0 &&
      Date.now() - retry.lastAt < retryDelayMs(retry.failures)
    ) {
      return null;
    }
    return retry.failures + 1;
  };

  // 暂停中跳过补开与填槽。
  if (!paused) {
    /*
     * 自动补分片仅在 autoDispatch 下执行；manual 只拉起用户自己派的单。
     * fillSlots 不建新单，manual 下同样执行。
     */
    if (autoDispatch) {
      for (const s of requiredShards) {
        if (held(s.id)) continue;
        const attempt = planDispatch(s.id, false);
        if (attempt !== null) createOpenShardDispatch(root, contract, state, s, wopts, out, attempt);
      }
    }

    // 尽量派发 open 派单，受并行度约束。
    fillSlots(root, contract, state, host, capacity, wopts, out);
  }

  // 有在途（claimed / open）就不推进；失效的 claimed 已在 reap 结单。
  if (activeDispatches(root).length > 0) return "continue";

  const stage = stageById(contract, state.stage);
  const gate = runCheck(stage?.done as Record<string, unknown> | undefined, root);
  const gateOk = gate.ok;
  // 门槛结果只记变化点，避免每 tick 重复记录挤占事件窗口。
  const gateSig = `${state.stage}|${gateOk ? "ok" : "no"}|${gate.missing.join("§")}`;
  if (lastGateSig.get(root) !== gateSig) {
    lastGateSig.set(root, gateSig);
    recordEvent(root, "gate_eval", {
      stage: state.stage,
      ok: gateOk,
      missing: gate.missing,
    });
    out(`[监工] 门槛评估 ${state.stage}：${gateOk ? "已满足" : `未达标（${gate.missing.join("；")}）`}`);
  }

  // 整根接管时不重派、不自动验收。
  if (shards.length === 0) {
    if (hold.all) {
      out(`[监工] ${holdNote()}，暂停自动重派与自动验收（capitalist release 后恢复）`);
      return "continue";
    }
    if (!gateOk) {
      // 暂停中不重派整阶段，但门槛已过时照常推进。
      if (paused) return "continue";
      const attempt = planDispatch("", false);
      if (attempt !== null) {
        dispatch(root, contract, state, "stage", wopts, out, attempt);
        fillSlots(root, contract, state, host, capacity, wopts, out);
      }
      return "continue";
    }
    return advanceStage(root, contract, state, host, capacity, wopts, out, paused);
  }

  // closed 与 done 同算：已结项的片不再让阶段停在「缺片」上。
  const requiredDone = requiredShards.every((s) =>
    stageDispatches.some((d) => d.shard === s.id && (d.status === "done" || d.status === "closed")),
  );

  if (!requiredDone || !gateOk) {
    /*
     * 全 done 但门槛未过时缺的是交付件，不重跑，只报告缺项。
     * 有片未 done 时只补该片，由 planDispatch 判退避与重派上限。
     */
    if (!paused) {
      for (const s of requiredShards) {
        if (held(s.id)) continue;
        const attempt = planDispatch(s.id, false);
        if (attempt !== null) createOpenShardDispatch(root, contract, state, s, wopts, out, attempt);
      }
      fillSlots(root, contract, state, host, capacity, wopts, out);
      if (requiredDone && !gateOk) {
        out(
          `[监工] ${state.stage} 全部必需分片已完成，缺的是交付件：${gate.missing.join("；")}` +
            "——不重跑，等补齐",
        );
      }
    }
    return "continue";
  }

  // 仍有分片处于人工接管时不代它验收。
  if (requiredShards.some((s) => held(s.id))) {
    out(`[监工] ${holdNote()}，门槛已过但暂停自动验收（capitalist release 后恢复）`);
    return "continue";
  }

  // 可选项未达标记欠账，允许推进。
  for (const s of shards.filter((sh) => sh.required === false)) {
    if (!stageDispatches.some((d) => d.shard === s.id && (d.status === "done" || d.status === "closed"))) {
      addDebt(root, state.stage, s.id);
      out(`[监工] 可选项 ${state.stage}/${s.id} 未达标，记欠账（允许推进）`);
    }
  }
  return advanceStage(root, contract, state, host, capacity, wopts, out, paused);
}

/** 整任务完成只记一次：以 state.done_at 为判据，已有值则不重复写事件与日志。 */
function recordDoneOnce(root: string, state: TaskState): void {
  const first = updateState(root, (s) => {
    if (String(s.done_at ?? "").trim()) return false;
    s.done_at = new Date().toISOString();
    s.done_stage = s.stage;
    return true;
  });
  if (first !== true) return;
  recordEvent(root, "supervisor_done", { stage: state.stage, target: state.target });
}

/** 阶段推进写 supervisor_advance 事件并派发下一阶段；暂停中只推进不派发。 */
function advanceStage(
  root: string,
  contract: Contract,
  state: TaskState,
  host: WorkerHost,
  capacity: number,
  wopts: WorkerSpawnOpts,
  out: (s: string) => void,
  paused = false,
): "continue" | "done" {
  if (isLastStage(contract, state.stage)) {
    settleDebt(root, out);
    recordDoneOnce(root, state);
    return "done";
  }
  const nid = nextStageId(contract, state.stage);
  const next = nid ? stageById(contract, nid) : undefined;
  if (!next) {
    settleDebt(root, out);
    recordDoneOnce(root, state);
    return "done";
  }

  const moved = updateState(root, (s) => enterStage(s, next));
  if (moved === null) {
    out("[监工] 状态写入冲突，下一轮重试");
    return "continue";
  }

  recordEvent(root, "supervisor_advance", { from: state.stage, to: next.id, target: state.target });
  out(`[监工] 阶段自动推进（R-15.10）：${state.stage} → ${next.id} ${next.name}`);
  const ns = loadState(root) ?? state;
  if (paused) {
    out("[监工] 已暂停：新阶段暂不派单，resume 后自动补上");
    return "continue";
  }
  // 顺序固定：先清算旧阶段、再开新阶段派单、最后填槽；否则旧进程占槽导致新单填不进去。
  supersedeStaleDispatches(root, contract, next.id, out);
  dispatch(root, contract, ns, "stage", wopts, out);
  fillSlots(root, contract, ns, host, capacity, wopts, out);
  return "continue";
}

/**
 * 把不属于当前阶段的在途派单标记 superseded，并结束其工作进程。
 * 人工接管的片与可见窗口模式的工作进程不动。
 */
function supersedeStaleDispatches(
  root: string,
  contract: Contract,
  stageId: string,
  out: (s: string) => void,
): void {
  const shards = new Set(stageParallel(contract, stageId).map((s) => s.id));
  const rows = readDispatches(root);
  let changed = false;
  const out2 = rows.map((d) => {
    if (d.status !== "open" && d.status !== "claimed") return d;
    if (d.stage === stageId && (!d.shard || shards.has(d.shard))) return d;
    if (isHeld(root, d.shard ?? null)) return d;

    /* 唤醒单在 WAKE_GRACE_MS 宽限期内不作废，期满仍是在途的再按阶段推进作废。 */
    const wakeAt = Date.parse(String((d as DispatchEx).wake_at ?? ""));
    if (Number.isFinite(wakeAt) && Date.now() - wakeAt < WAKE_GRACE_MS) {
      out(`[监工] 派单 ${d.id}（${d.stage}/${d.shard || "整阶段"}）是用户刚唤醒的单，宽限期内不作废`);
      return d;
    }

    if (d.status === "claimed") {
      const w = d.worker ? loadWorker(root, d.worker) : null;
      if (w && w.mode !== "visible" && (w.status === "running" || w.status === "starting")) {
        killJudgedWorker(root, w, false, out);
        saveWorker(root, { ...w, status: "done" });
        out(`[监工] worker ${w.id} 的工作已随阶段推进作废，结束它并释放槽位`);
      }
    }

    changed = true;
    recordEvent(root, "dispatch_superseded", {
      dispatch: d.id,
      stage: d.stage,
      shard: d.shard ?? "",
      worker: d.worker ?? "",
      was: d.status,
      reason: "阶段已推进，本单的验收口径不再适用",
    });
    out(`[监工] 派单 ${d.id}（${d.stage}/${d.shard || "整阶段"}）属于已推进的阶段，标记 superseded 并释放槽位`);
    return { ...d, status: "superseded" } as unknown as Dispatch;
  });
  if (changed) writeJsonl(dispatchPath(root), out2);
}

/**
 * 把 status=open 派单的 action 刷新为契约当前值：open 单可能等到契约被改后才被领走。
 * 只改 open；分片不在契约时不碰。按基础文字精确比对，相同则跳过写盘。
 */
function refreshOpenDispatchActions(
  root: string,
  contract: Contract,
  stageId: string,
  out: (s: string) => void,
): void {
  for (const d of readDispatches(root)) {
    if (d.status !== "open" || d.stage !== stageId) continue;
    /* source=reverify 不刷新：正文含复验说明与原要求，按契约取值会覆盖成裸分片文字。 */
    if (d.source === "reverify") continue;
    const base = contractShardAction(contract, d.stage, d.shard ?? "");
    if (base === null) continue;
    // 按基础文字精确比对，不用 startsWith：action 被改短后旧文字会以新值为前缀，导致漏刷新。
    const tail = actionTail(d.action);
    const currentBase = tail ? d.action.slice(0, d.action.length - tail.length) : d.action;
    if (currentBase === base) continue;
    const next = `${base}${tail}`;
    patchDispatch(root, d.id, { action: next, ...settlingTitle(d) } as Partial<Dispatch>);
    recordEvent(root, "dispatch_action_refreshed", {
      dispatch: d.id,
      stage: d.stage,
      shard: d.shard ?? "",
      from: d.action,
      to: next,
      reason: "任务列表里的 action 已改，重派前按当前值刷新",
    });
    out(`[监工] 派单 ${d.id}（${d.stage}/${d.shard ?? "整阶段"}）的 action 已按任务列表当前值刷新`);
  }
}

/** 首个未达标阶段，用于阶段 id 消失后的回落。 */
function firstUnmetStage(contract: Contract, root: string): string {
  for (const s of contract.stages) {
    if (!runCheck(s.done as Record<string, unknown> | undefined, root).ok) return s.id;
  }
  return contract.stages[0]?.id ?? "S0";
}

/** 把空闲槽位填满：同一 tick 刚生成的单也在本轮派发，避免有单无进程。 */
/**
 * 插队单不在契约分片内，失败后由本函数补派单：只建单不拉起，启动交给 fillSlots。
 * 退避与次数沿用 retryDelayMs / HARD_STOP_FAILURES。
 */
/** 重派验收口径取链上最近一次打回结论（review_note）。 */
function retryAcceptOf(chain: Dispatch[]): string {
  const ordered = chain.slice().sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
  for (const r of ordered) {
    const review = String(r.review_note ?? "").trim();
    if (review) return `上次打回的结论：${review.slice(0, 240)}`;
  }
  return "";
}

/** 悬空追加的追诉期：更早的未消费插话不再回收。 */
const ORPHAN_RESCUE_HOURS = 24;

/**
 * 悬空追加按链（lineage）判定：链上无活单时把最新一张翻回 open，复用原上下文重新拉起。
 * 每轮最多回收一条链。
 */
function rescueOrphanDirectives(root: string, out: (s: string) => void): void {
  const now = Date.now();
  const fresh = listDirectives(root).filter((r) => {
    if (r.consumed || typeof r.text !== "string") return false;
    const at = Date.parse(String(r.at ?? ""));
    return !Number.isFinite(at) || now - at < ORPHAN_RESCUE_HOURS * 3600_000;
  });
  if (fresh.length === 0) return;

  const rows = readDispatches(root);
  const byId = new Map(rows.map((d) => [String(d.id), d] as const));
  const laneOfRow = (d: Dispatch): string =>
    laneKeyOf(d as { stage?: string; shard?: string | null; lineage?: string; id?: string });

  /* 未消费插话按指向的链归组；归不出链的不处理。 */
  const chains = new Map<string, { count: number; latest: number }>();
  for (const r of fresh) {
    let chain = "";
    const target = String((r as { target?: string }).target ?? "");
    if (target && !/^W-/i.test(target)) {
      const d = byId.get(target);
      if (d) chain = String((d as DispatchEx).lineage ?? d.id);
    }
    if (!chain && r.lineage) chain = String(r.lineage);
    if (!chain && r.lane) {
      const hit = rows.find((d) => laneOfRow(d) === String(r.lane));
      if (hit) chain = String((hit as DispatchEx).lineage ?? hit.id);
    }
    if (!chain) continue;
    const at = Date.parse(String(r.at ?? "")) || 0;
    const cur = chains.get(chain);
    chains.set(chain, { count: (cur?.count ?? 0) + 1, latest: Math.max(cur?.latest ?? 0, at) });
  }

  const LIVE = new Set(["open", "claimed", "reported", "review"]);
  for (const [chainId, want] of chains) {
    const chain = rows
      .filter((d) => String((d as DispatchEx).lineage ?? d.id) === chainId)
      .sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
    if (chain.length === 0) continue;
    if (chain.some((d) => LIVE.has(String(d.status)))) continue;
    const last = chain[chain.length - 1] as Dispatch;
    if (last.status !== "done" && last.status !== "closed" && last.status !== "failed") continue;
    /* 同一张单十分钟内只回收一次，避免追加领不走时反复重开与拉起进程。 */
    const lastRescue = Date.parse(String((last as { rescued_at?: string }).rescued_at ?? "")) || 0;
    if (lastRescue && now - lastRescue < 10 * 60_000) continue;
    /*
     * done 不设时间闸：单正常完结但追加未消费属漏读，须回收。
     * closed / failed 按时间判定：追加晚于作废时刻才回收。
     */
    if (last.status === "closed" || last.status === "failed") {
      const endedAt = Date.parse(String((last as { done_at?: string }).done_at ?? last.at ?? "")) || 0;
      if (want.latest && endedAt && want.latest <= endedAt) continue;
    }

    const why = `挂着 ${want.count} 条没人读的用户追加`;
    reopenSettledDispatch(root, last.id, why);
    /* 写 rescued_at，防止重开后立即再次结单的循环。 */
    patchDispatch(root, last.id, { rescued_at: new Date().toISOString() } as Partial<Dispatch>);
    recordEvent(root, "directive_rescue", {
      dispatch: last.id,
      stage: last.stage,
      from: String(last.status),
      count: want.count,
    });
    out(`[监工] 派单 ${last.id}（${last.stage}）${why}，已重新开出来`);
    return; // 每轮只处理一条链
  }
}

function requeueAdhoc(root: string, state: TaskState, out: (s: string) => void): void {
  const rows = readDispatches(root);
  const mine = rows.filter((d) => d.stage === state.stage && d.source === "adhoc");
  if (mine.length === 0) return;

  /*
   * 按 lineage 分组，不按 action：action 派发时会被重写，按文本去重不命中。
   * 链上只要有一张活单（含 closed）就不再补派。
   */
  const chains = new Map<string, Dispatch[]>();
  for (const d of mine) {
    const key = String((d as DispatchEx).lineage ?? d.id);
    const list = chains.get(key) ?? [];
    list.push(d);
    chains.set(key, list);
  }

  for (const [chainId, chain] of chains) {
    const failed = chain.filter((x) => x.status === "failed");
    if (failed.length === 0) continue;
    /* 链上仍有暂停单：用户未唤醒，不补派；否则会绕过暂停重复执行。 */
    if (chain.some((x) => dispatchPaused(x) && x.status !== "done" && x.status !== "closed")) continue;
    const alive = chain.some(
      (x) =>
        x.status === "open" ||
        x.status === "claimed" ||
        x.status === "review" ||
        x.status === "done" ||
        x.status === "closed",
    );
    if (alive) continue;
    /* give_up、pending、hold 的链不再自动补派。 */
    if (
      chain.some((x) => {
        const v = (x as DispatchEx).retry_verdict;
        return v === "give_up" || v === "pending" || v === "hold";
      })
    ) {
      continue;
    }

    const d = failed.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] as Dispatch;
    const de = d as DispatchEx;

    const failures = failed.length;
    if (failures >= HARD_STOP_FAILURES) {
      out(`[监工] 插队单「${String(de.title ?? d.action).slice(0, 30)}」已失败 ${failures} 次，停止重派（换个说法或 capitalist fix）`);
      continue;
    }
    const lastAt = Math.max(...failed.map((x) => Date.parse(String(x.done_at ?? x.at ?? "")) || 0));
    if (Date.now() - lastAt < retryDelayMs(failures)) continue;

    const id = newDispatchId();
    const accept = retryAcceptOf(chain);
    /*
     * 卡点经 appendSection / BLOCKER_MARKER 写进 action 追加段：action 重启后必读，
     * 且会话指纹在 marker 之前截断，不计入该段。
     */
    const prevBlocker = failures > 0 ? findPreviousBlocker(root, { lineage: chainId }) : null;
    /* 重派剥离正文附件行并将 atts 清零，避免附件逐轮累积。 */
    const rec: Dispatch = {
      id,
      at: new Date().toISOString(),
      stage: d.stage,
      shard: "",
      action: prevBlocker
        ? appendSection(stripAttachments(String(d.action ?? "")), BLOCKER_MARKER, blockerLines(prevBlocker))
        : stripAttachments(String(d.action ?? "")),
      status: "open",
      source: "adhoc",
      /* attempt 按整条链的失败次数计。 */
      attempt: failures + 1,
      urgent: true,
      atts: [],
      /* 继承 lineage，供下次重派识别同一件事。 */
      lineage: chainId,
      /* 重派继承 parent 与 after，否则树边丢失、重启前后顺序不一致。 */
      ...(Array.isArray(d.after) && d.after.length ? { after: [...d.after] } : {}),
      ...(d.parent ? { parent: String(d.parent) } : {}),
      ...(d.parent_reason ? { parent_reason: String(d.parent_reason) } : {}),
      ...(de.title ? { title: de.title } : {}),
      /* role=fix 的重派改用新车道，不复用上次修复的上下文。 */
      ...(d.tags ? { tags: d.role === "fix" ? [`fix-${id.slice(-6)}`] : d.tags } : {}),
      ...(d.role ? { role: d.role } : {}),
      ...(de.model ? { model: de.model } : {}),
      ...(de.model_fallback ? { model_fallback: de.model_fallback } : {}),
      /* retry_accept 写入独立字段，不拼进 action：避免改变会话指纹导致上下文丢失。 */
      ...(accept ? { retry_accept: accept } : {}),
    };
    rec.lineage = rec.lineage ?? rec.id;
    appendDispatch(root, rec);
    ensureTaskForDispatch(root, rec);
    recordEvent(root, "dispatch_retry", {
      dispatch: id,
      stage: d.stage,
      shard: "",
      attempt: rec.attempt ?? 1,
      previous_failures: failures,
      source: "adhoc",
    });
    out(
      `[监工] 重派插队单 ${id}（第 ${rec.attempt} 次，上次 ${d.note ?? "失败"}）：` +
        `${String(de.title ?? d.action).slice(0, 40)}`,
    );
  }
}


/**
 * 读派单指定模型：只读不删，设定持续生效；清除由面板写空串删文件完成。
 * 空文件、坏文件或空 model 返回空串，调用方回落契约与默认模型。
 */
export function readNextModel(root: string): string {
  const p = join(root, ".capitalist", "next_model.json");
  try {
    if (!existsSync(p)) return "";
    const j = readJson<{ model?: string }>(p, {});
    return String(j?.model ?? "").trim();
  } catch {
    return "";
  }
}


/** 派单被锁挡住超过该时长后照派，不让整个阶段等待单个文件。 */
const LOCK_DEFER_MAX_MS = 300_000;
/** 同一张单「因锁延后」事件的记录间隔。 */
const LOCK_DEFER_LOG_MS = 60_000;
const lockDeferAt = new Map<string, { first: number; last: number }>();

/** 已上报的森林异常（成环 / 父节点缺失）。同一处只报一次；条件消失后摘除键，复发时再报。 */
const forestWarned = new Set<string>();

/** 上报成环与孤儿父节点：dependenciesSettled 对两者的处理是静默的。 */
function reportForestAnomalies(root: string, rows: Dispatch[], out: (s: string) => void): void {
  const f = dispatchForest(rows);
  const live = new Set<string>();
  reportMultiPrereqOrphans(root, rows, f, live, out);
  for (const cyc of f.cycles) {
    const key = `cycle:${cyc.join(">")}`;
    live.add(key);
    if (forestWarned.has(key)) continue;
    recordEvent(root, "dispatch_cycle", { nodes: cyc, size: cyc.length });
    out(`[监工] 派单依赖成环（${cyc.join(" → ")}）：这几单互相等待，没有一张会启动，需人工改树边`);
  }
  for (const id of f.orphans) {
    const key = `orphan:${id}`;
    live.add(key);
    if (forestWarned.has(key)) continue;
    const row = rows.find((x) => String(x.id) === id);
    recordEvent(root, "dispatch_parent_missing", { dispatch: id, parent: String(row?.parent ?? ""), stage: String(row?.stage ?? "") });
    out(`[监工] ${id} 的父节点不在台账里：按已满足处理并放行，顺序可能比原计划靠前`);
  }
  for (const key of [...forestWarned]) if (!live.has(key)) forestWarned.delete(key);
  for (const key of live) forestWarned.add(key);
}

/**
 * 多前置的孤儿前置补报：dispatchForest 只认单父边，多前置表现为根，其失效不会被 orphans 覆盖。
 * 单父边与已在 orphans 的节点跳过，避免重复上报。
 */
function reportMultiPrereqOrphans(
  root: string,
  rows: Dispatch[],
  f: ReturnType<typeof dispatchForest>,
  live: Set<string>,
  out: (s: string) => void,
): void {
  const orphanSet = new Set(f.orphans);
  for (const r of rows) {
    if (r.status !== "open") continue;
    if (orphanSet.has(String(r.id))) continue;
    if (prerequisitesOf(r).ids.length <= 1) continue;
    const missing = missingPrerequisites(r, rows);
    if (missing.length === 0) continue;
    const key = `missing:${r.id}:${missing.join(",")}`;
    live.add(key);
    if (forestWarned.has(key)) continue;
    recordEvent(root, "dispatch_parent_missing", {
      dispatch: r.id,
      stage: String(r.stage ?? ""),
      missing,
    });
    out(`[监工] ${r.id} 挂的前置 ${missing.join("、")} 不在台账里（可能已归档或台账被改）：依赖按已满足放行，顺序可能比原计划靠前`);
  }
}

/**
 * 这一单会碰的文件：契约分片 files 声明优先，其次从 action 抽取任务根内路径。
 * 都取不到返回空，不参与锁预检。
 */
function targetFilesOf(root: string, contract: Contract, d: Dispatch): string[] {
  const set = new Set<string>();
  const shard = stageParallel(contract, d.stage).find((s) => s.id === d.shard);
  const declared = (shard as unknown as { files?: unknown } | undefined)?.files;
  if (Array.isArray(declared)) {
    for (const f of declared) {
      const v = String(f ?? "").trim();
      if (!v) continue;
      set.add(v.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(v) ? v : join(root, v));
    }
  }
  for (const p of extractLocalPaths(String(d.action ?? ""), root)) set.add(p);
  return [...set];
}

/** 返回第一处写锁冲突，供「在等谁」提示。 */
function lockBlockOf(root: string, files: string[]): { path: string; holder: string } | null {
  for (const f of files) {
    const e = writeHolderOf(root, f);
    if (e && e.holder) return { path: e.path, holder: e.holder };
  }
  return null;
}

/**
 * 结束插队租约：清掉让位标记并按 yield_rank 排回队列，不重派、不新建、不换会话。
 * 无租约但仍有让位标记时，按标记收尾并清除。
 */
function releasePreemptLease(root: string, out: (s: string) => void): void {
  const lease = readPreemptLease(root);
  if (!lease) {
    const stale = yieldedDispatches(root);
    const sources = [...new Set(stale.map((d) => String(d.yielded_by ?? "")).filter(Boolean))];
    for (const by of sources) {
      const restored = releaseYielded(root, by);
      recordEvent(root, "dispatch_preempt_released", {
        dispatch: by,
        restored: restored.map((d) => d.id),
        reason: "租约记录缺失，按让位标记收尾",
      });
      out(`[监工] 立即执行单 ${by} 的租约已丢失，按台账标记恢复 ${restored.length} 张让位单`);
    }
    return;
  }
  const rows = readDispatches(root);
  if (!leaseEnded(lease, rows)) return;

  const restored = releaseYielded(root, lease.dispatch);
  clearPreemptLease(root);
  recordEvent(root, "dispatch_preempt_released", {
    dispatch: lease.dispatch,
    worker: lease.worker,
    restored: restored.map((d) => d.id),
    reason: "立即执行单已不在跑",
  });
  if (restored.length > 0) {
    out(
      `[监工] 立即执行单 ${lease.dispatch} 已结束，按原顺序恢复 ${restored.length} 张让位单：` +
        restored.map((d) => d.id).join(" → "),
    );
  }
}

/**
 * 立即执行真插队：挂起在跑进程腾出并发槽；promoteDispatch 只写台账排到队首。
 * 仅对 promoted_at 生效；已有租约不抢第二槽；可见窗口与已有 promoted_at 的进程不让位。
 * @returns 是否真的腾出了槽位。
 */
function preemptForImmediate(root: string, d: Dispatch, out: (s: string) => void): boolean {
  if (!isImmediate(d)) return false;
  const lease = readPreemptLease(root);
  if (lease) {
    if (lease.dispatch !== d.id) {
      recordEvent(root, "dispatch_preempt_refused", {
        dispatch: d.id,
        holding: lease.dispatch,
        reason: "同一时刻只允许一个立即执行",
      });
      return false;
    }
    return false;
  }

  const rows = readDispatches(root);
  const byId = new Map(rows.map((x) => [x.id, x]));
  /* 只挑记录在且 pid 存活的进程；心跳过期未回收的仍算在跑。 */
  const live = listWorkers(root).filter((w) => {
    if (w.status !== "running" && w.status !== "starting") return false;
    if (w.mode === "visible") return false;
    if (!(w.pid > 0) || !pidAlive(w.pid)) return false;
    if (String(w.dispatch ?? "") === d.id) return false;
    const own = byId.get(String(w.dispatch ?? ""));
    /* 另一张立即执行的进程不让位。 */
    return !(own && isImmediate(own));
  });
  if (live.length === 0) return false;

  /* 让位最晚启动的进程；启动时间相同时按 id 收敛，使选择确定。 */
  const victim = [...live].sort((a, b) => {
    const t = String(b.started_at ?? "").localeCompare(String(a.started_at ?? ""));
    return t !== 0 ? t : String(a.id).localeCompare(String(b.id));
  })[0] as WorkerRecord;

  /* 顺序固定为先改台账、再改工作进程记录、最后结束进程；否则退出回调会按 failed 结单。 */
  const ordered = yieldOrder(rows, d.id).map((x) => x.id);
  const changed = markYielded(root, ordered, d.id);
  saveWorker(root, { ...victim, status: "suspended" });
  const how = killWorkerPid(victim.pid);
  /* 结束进程时一并释放其写锁，避免恢复后等待永不释放的锁。 */
  const locks = releaseFileLocks(root, victim.id);

  savePreemptLease(root, {
    dispatch: d.id,
    worker: "",
    at: new Date().toISOString(),
    yielded: ordered,
  });
  recordEvent(root, "dispatch_preempted", {
    dispatch: d.id,
    stage: d.stage,
    shard: d.shard ?? "",
    victim: victim.id,
    victim_dispatch: victim.dispatch ?? "",
    victim_pid: victim.pid,
    how,
    locks,
    yielded: changed,
  });
  out(
    `[监工] 立即执行 ${d.id}：挂起 ${victim.id}（pid ${victim.pid}，派单 ${victim.dispatch ?? "无"}）腾出槽位，` +
      `让位 ${changed.length} 张（${changed.join("、")}）；这一单结束后按原顺序恢复`,
  );
  return true;
}

/**
 * 统计在 VERDICT_HOLD_MS 窗口内、已上报待裁决的单：它们仍占并发槽位。
 * 超时由 sweepReported 退回 open；无 reported_at 的老记录不占槽。
 */
export function awaitingVerdict(rows: readonly Dispatch[]): number {
  const now = Date.now();
  let n = 0;
  for (const d of rows) {
    if (d.status !== "reported") continue;
    const at = Date.parse(String((d as Dispatch & { reported_at?: string }).reported_at ?? ""));
    if (Number.isFinite(at) && now - at < VERDICT_HOLD_MS) n += 1;
  }
  return n;
}

function fillSlots(
  root: string,
  contract: Contract,
  state: TaskState,
  host: WorkerHost,
  capacity: number,
  wopts: WorkerSpawnOpts,
  out: (s: string) => void,
): void {
  const hold = activeTakeover(root);
  /* 填槽前清理上一轮租约，让位标记会带偏排序。 */
  releasePreemptLease(root, out);
  /* 森林异常每轮只检查一次：循环内重复检查会变成平方级开销。 */
  let forestChecked = false;
  for (;;) {
    /* 业务单受 capacity 约束；诊断/修复单多占一个槽（capacity + 1）。 */
    /*
     * 顺序只认台账 after，每轮从磁盘重算、不缓存；判定在 core 的 dependenciesSettled。
     * after 为 "*" 时等所有其它单到终态。
     */
    const allRows = readDispatches(root);
    if (!forestChecked) {
      reportForestAnomalies(root, allRows, out);
      forestChecked = true;
    }
    const open = allRows.filter(
      (x) =>
        x.status === "open" &&
        /* 暂停单不参与派发：用户的意图优先于队列顺序，只有唤醒后才重新进入候选。 */
        !dispatchPaused(x) &&
        dependenciesSettled(x, allRows) &&
        !(hold.all || (Boolean(x.shard) && hold.shards.includes(String(x.shard)))),
    );
    if (open.length === 0) return;
    /*
     * 排序由 compareQueueOrder 决定：promoted_at 的置顶单优先，其次 urgent 插队单。
     * urgent 仍受并行度约束，槽满时只排到队首。
     */
    /*
     * 按队列顺序跳过目标文件被写锁占用的单，槽位先派其它活。
     * 同一单被挡超过 LOCK_DEFER_MAX_MS 后照派，由工作进程自行等锁。
     */
    const ordered = open
      .map((x, i) => ({ x, i }))
      .sort((a, b) => compareQueueOrder(a.x, b.x, a.i, b.i))
      .map((r) => r.x);
    let d: (typeof ordered)[number] | undefined;
    for (const cand of ordered) {
      const files = targetFilesOf(root, contract, cand);
      const blocked = files.length > 0 ? lockBlockOf(root, files) : null;
      if (!blocked) {
        d = cand;
        break;
      }
      const nowMs = Date.now();
      const seen = lockDeferAt.get(cand.id);
      const first = seen?.first ?? nowMs;
      lockDeferAt.set(cand.id, { first, last: nowMs });
      const waited = nowMs - first;
      if (waited >= LOCK_DEFER_MAX_MS) {
        recordEvent(root, "dispatch_lock_timeout", {
          dispatch: cand.id,
          stage: cand.stage,
          shard: cand.shard ?? "",
          file: blocked.path,
          holder: blocked.holder,
          waited_sec: Math.round(waited / 1000),
        });
        out(
          `[监工] ${cand.id} 的目标文件 ${blocked.path} 被 ${blocked.holder} 占用已 ${Math.round(waited / 1000)}s，` +
            "不再等：照派，由工作进程自己撞锁（拿不到会收到三步指引）",
        );
        d = cand;
        break;
      }
      if (!seen || nowMs - seen.last >= LOCK_DEFER_LOG_MS) {
        recordEvent(root, "dispatch_deferred_lock", {
          dispatch: cand.id,
          stage: cand.stage,
          shard: cand.shard ?? "",
          file: blocked.path,
          holder: blocked.holder,
        });
        out(`[监工] ${cand.id} 暂不派：${blocked.path} 正被 ${blocked.holder} 写，等它释放`);
      }
    }
    if (!d) return;
    const special = d.role === "fix" || d.role === "diagnose";
    const cap = special ? capacity + 1 : capacity;
    /* 占槽按活进程数与待裁决单数之和计算；待裁决单最多占 VERDICT_HOLD_MS。 */
    const taken = () => liveWorkers(root).length + awaitingVerdict(allRows);
    if (taken() >= cap) {
      if (!preemptForImmediate(root, d, out)) return;
    }
    if (taken() >= cap) return;
    if (!launch(root, contract, state, d, host, wopts, out)) break;
    lockDeferAt.delete(d.id);
  }
}

/**
 * 取这张单第一次登记时的标题：标题只在建单时定一次，重派按同阶段、同分片、同来源找回。
 * @param like 判定是否为同一张单的前身。
 */
function firstTitle(root: string, like: (d: Dispatch) => boolean): string {
  for (const d of readDispatches(root)) {
    if (!like(d)) continue;
    const t = String((d as DispatchEx).title ?? "").trim();
    if (t) return t;
  }
  return "";
}

/** 缺 title 的老记录在改正文前补写标题，避免标题随正文变化。 */
function settlingTitle(d: Dispatch): { title?: string } {
  if (String((d as DispatchEx).title ?? "").trim()) return {};
  const t = taskTitle({ shard: d.shard, action: d.action });
  return t ? { title: t } : {};
}

/**
 * 派单模型：优先级链（分片 model → 契约 default_model → --worker-model）任一指定即固定使用；
 * 全未指定时在 DEFAULT_MODEL_ROTATION 间轮换。仅对 knownModels 含这些模型的宿主生效；
 * 宿主记录读不到时按 impl 缺省宿主处理。
 */
function defaultDispatchModel(root: string, resolved: string | undefined): string | undefined {
  /* 面板选过的派单模型常驻且优先于契约分片模型与启动参数。 */
  const pinned = readNextModel(root);
  if (pinned) return pinned;
  if (resolved) return resolved;
  let host = "";
  try {
    host = String(loadSupervisor(root)?.worker_host ?? "").trim();
  } catch {
    host = "";
  }
  if (host) {
    const known = byId(host)?.knownModels ?? [];
    if (!DEFAULT_MODEL_ROTATION.some((m) => known.includes(m))) return undefined;
  }
  return nextRotatingDefaultModel(root, DEFAULT_MODEL_ROTATION);
}

/** 派单：有分片按分片派多张，无分片派一张整阶段的。 */
function dispatch(
  root: string,
  contract: Contract,
  state: TaskState,
  source: "stage" | "requeue",
  wopts: WorkerSpawnOpts,
  out: (s: string) => void,
  attempt = 1,
): void {  const fresh = loadState(root) ?? state;
  const shards = stageParallel(contract, fresh.stage);

  if (shards.length > 0) {
    for (const s of shards) {
      const model = defaultDispatchModel(root, resolveShardModel(s, contract, wopts.model));
      const fb = resolveShardModelFallback(s, contract, wopts.model);
      const id = newDispatchId();
      // 用户插话在建单时拼进本次 action 并标记已用。
      const taken = claimDirectives(root, {
        shard: s.id,
        stage: fresh.stage,
        dispatchId: id,
        lane: laneKeyOf({ stage: fresh.stage, shard: s.id }),
      });
      const action = withAcceptance(root, spliceDirectives(s.action, taken));
      const d = {
        id,
        at: new Date().toISOString(),
        stage: fresh.stage,
        shard: s.id,
        /* 标题优先级：契约中文 title → 分片映射 → 正文摘要；重派沿用首次登记的标题。 */
        title:
          source === "requeue"
            ? firstTitle(
                root,
                (x) => String(x.stage ?? "") === fresh.stage && String(x.shard ?? "") === s.id,
              ) || taskTitle({ contractTitle: s.title, shard: s.id, action })
            : taskTitle({ contractTitle: s.title, shard: s.id, action }),
        action,
        status: "open",
        source,
        attempt,
        model: model ?? undefined,
        model_fallback: fb ?? undefined,
      } as DispatchEx;
      d.lineage = d.lineage ?? d.id;
      appendDispatch(root, d);
      ensureTaskForDispatch(root, d);
      recordEvent(root, "dispatch_open", {
        dispatch: d.id,
        stage: d.stage,
        shard: d.shard,
        action,
        source,
        attempt,
        model: model ?? "",
        directives: taken.length,
      });
      out(
        `[监工] 派单 ${d.id}（${fresh.stage}/${s.id}）：${s.action}${model ? ` 模型=${model}` : ""}` +
          (taken.length > 0 ? `（含 ${taken.length} 条用户插话）` : ""),
      );
    }
    return;
  }

  const id = newDispatchId();
  const taken = claimDirectives(root, {
    shard: "",
    stage: fresh.stage,
    dispatchId: id,
    lineage: id,
    lane: laneKeyOf({ stage: fresh.stage, shard: "", lineage: id }),
  });
  const action = withAcceptance(root, spliceDirectives(pickAction(stageById(contract, fresh.stage), fresh), taken));
  /* 整阶段单同样按 defaultDispatchModel 取常驻派单模型。 */
  const model = defaultDispatchModel(root, wopts.model);
  const d = {
    id,
    at: new Date().toISOString(),
    stage: fresh.stage,
    /* 整阶段单标题取阶段名、再退正文摘要；重派沿用首次登记的标题。 */
    title:
      (source === "requeue"
        ? firstTitle(
            root,
            (x) =>
              String(x.stage ?? "") === fresh.stage &&
              !String(x.shard ?? "").trim() &&
              String((x as DispatchEx).source ?? "") !== "adhoc",
          )
        : "") ||
      taskTitle({
        stageName: stageById(contract, fresh.stage)?.name,
        action,
      }),
    action,
    status: "open",
    source,
    attempt,
    model: model ?? undefined,
  } as DispatchEx;
  d.lineage = d.lineage ?? d.id;
  appendDispatch(root, d);
  ensureTaskForDispatch(root, d);
  recordEvent(root, "dispatch_open", {
    dispatch: d.id,
    stage: d.stage,
    action,
    source,
    attempt,
    model: model ?? "",
    directives: taken.length,
  });
  if (attempt > 1) {
    recordEvent(root, "dispatch_retry", {
      dispatch: d.id,
      stage: d.stage,
      attempt,
      previous_failures: attempt - 1,
    });
  }
  out(
    `[监工] ${attempt > 1 ? `重派第 ${attempt} 次 ` : "派单 "}${d.id}（${fresh.stage}）：${action}${model ? ` 模型=${model}` : ""}` +
      (taken.length > 0 ? `（含 ${taken.length} 条用户插话）` : ""),
  );
}

/** 为缺失或失败的分片补一张 open 派单，带分片级模型与回退。 */
function createOpenShardDispatch(
  root: string,
  contract: Contract,
  state: TaskState,
  shard: StageParallel,
  wopts: WorkerSpawnOpts,
  out: (s: string) => void,
  attempt = 1,
): void {
  const model = defaultDispatchModel(root, resolveShardModel(shard, contract, wopts.model));
  const fb = resolveShardModelFallback(shard, contract, wopts.model);
  const id = newDispatchId();
  const taken = claimDirectives(root, {
    shard: shard.id,
    stage: state.stage,
    dispatchId: id,
    lane: laneKeyOf({ stage: state.stage, shard: shard.id }),
  });
  /*
   * 基础文字取契约当前值，不用传入的 shard.action：调用方的 shard 可能在本 tick 热加载前取得。
   * 分片被删或改名时才回落传参。
   */
  const actionText = contractShardAction(contract, state.stage, shard.id) ?? shard.action;
  /*
   * 重派原样下发旧正文，仅在末尾经 appendSection 追加卡点段（BLOCKER_MARKER）。
   * 卡点取材与成文在 worker.ts 的 blockerLines / findPreviousBlocker。
   */
  const prevBlocker = attempt > 1 ? findPreviousBlocker(root, { shard: shard.id }) : null;
  /* 卡点写入 action，验收写入独立字段，避免改变会话指纹。 */
  const accept = attempt > 1
    ? retryAcceptOf(
        readDispatches(root).filter(
          (x) => String(x.stage ?? "") === state.stage && String(x.shard ?? "") === shard.id,
        ),
      )
    : "";
  const action = attempt > 1
    ? appendSection(withAcceptance(root, spliceDirectives(actionText, taken)), BLOCKER_MARKER, blockerLines(prevBlocker ?? {}))
    : withAcceptance(root, spliceDirectives(actionText, taken));
  /* 标题沿用这一片首次登记的值；查不到前身才现生成。 */
  const contractShard = stageParallel(contract, state.stage).find((s) => s.id === shard.id);
  const d = {
    id,
    at: new Date().toISOString(),
    stage: state.stage,
    shard: shard.id,
    title:
      firstTitle(
        root,
        (x) => String(x.stage ?? "") === state.stage && String(x.shard ?? "") === shard.id,
      ) || taskTitle({ contractTitle: contractShard?.title ?? shard.title, shard: shard.id, action }),
    action,
    status: "open",
    source: "requeue",
    attempt,
    model: model ?? undefined,
    model_fallback: fb ?? undefined,
    ...(accept ? { retry_accept: accept } : {}),
  } as DispatchEx;
  d.lineage = d.lineage ?? d.id;
  appendDispatch(root, d);
  ensureTaskForDispatch(root, d);
  recordEvent(root, "dispatch_open", {
    dispatch: d.id,
    stage: d.stage,
    shard: d.shard,
    action,
    source: "requeue",
    attempt,
    model: model ?? "",
    directives: taken.length,
  });
  if (attempt > 1) {
    // 重派另记 dispatch_retry 事件，作为该片反复失败的信号。
    recordEvent(root, "dispatch_retry", {
      dispatch: d.id,
      stage: d.stage,
      shard: d.shard,
      attempt,
      previous_failures: attempt - 1,
    });
  }
  out(
    `[监工] ${attempt > 1 ? `重派第 ${attempt} 次 ` : "补派单 "}${d.id}（${state.stage}/${shard.id}）：${actionText}${model ? ` 模型=${model}` : ""}` +
      (taken.length > 0 ? `（含 ${taken.length} 条用户插话）` : ""),
  );
}

/**
 * 派单动作优先级：state.next_action > stage.next > 默认补齐语。
 * 分片阶段的 action 取 shard.action，不经过本函数。
 */
function pickAction(stage: Stage | undefined, state: TaskState): string {
  const fromState = (state.next_action ?? "").trim();
  if (fromState) return fromState;
  const fromStage = (stage?.next ?? "").trim();
  if (fromStage) return fromStage;
  return `补齐 ${state.stage} 的门槛项`;
}


/** 领单先于拉起工作进程：启动失败的单不留成 open 被重复领取。 */
function launch(
  root: string,
  contract: Contract,
  state: TaskState,
  d: Dispatch,
  host: WorkerHost,
  wopts: WorkerSpawnOpts,
  out: (s: string) => void,
): boolean {
  /* 暂停单不启动。fillSlots 已过滤，此处拦截其它入口：重派、补投递、看板指令均经过 launch。 */
  if (dispatchPaused(d)) return false;
  // 同一分片已有存活进程时拒绝再拉。返回 false 使本轮不再找下一张 open 单，该单留到下一 tick。
  /* 无分片的插队单按派单 id 判重；契约分片按 stage+shard 判重。 */
  const dup = listWorkers(root).find(
    (w) =>
      (w.status === "running" || w.status === "starting") &&
      w.stage === d.stage &&
      (d.shard ? (w.shard ?? "") === (d.shard ?? "") : w.dispatch === d.id) &&
      (w.mode === "visible" || pidAlive(w.pid)),
  );
  if (dup) {
    /* 同一张单在窗口内反复命中同一 dup，按派单 id 节流记录。 */
    recordEventThrottled(
      root,
      "duplicate_launch_refused",
      {
        dispatch: d.id,
        stage: d.stage,
        shard: d.shard ?? "",
        existing_worker: dup.id,
        existing_pid: dup.pid,
      },
      { key: d.id, windowMs: 5 * 60_000 },
    );
    out(`[监工] 拒绝启动：${d.stage}/${d.shard ?? "整阶段"} 已有存活 worker ${dup.id}（pid ${dup.pid}）`);
    return false;
  }

/* 文件冲突由会话车道规避（同类活共 lane、lane 单持有）。 */

  const id = newWorkerId(root);
  const claimed = claimDispatch(root, d.id, id, id);
  if (!claimed) return true;

  // 模型优先级：worker_model.json（按分片定向、消费一次）> 派单固化模型 > 启动参数；
  // 重派仍走同一 lane 的 --resume 以接续对话历史。
  /* 三处来源统一归一化；未指定时用平台默认档，不向宿主传空；命中禁用名单则回落默认档并记事件。 */
  const wantedModel = takeWorkerModel(root, claimed.shard ?? "") || (d as DispatchEx).model || wopts.model;
  const modelPick = resolveModel({ root, host, wanted: wantedModel });
  const model = modelPick.model;
  if (modelPick.denied) {
    recordEvent(root, "model_denied", {
      dispatch: claimed.id,
      worker: id,
      wanted: modelPick.denied,
      used: modelPick.model ?? "",
      why: modelPick.why,
    });
    out(`[监工] ${modelPick.why}`);
  }

  try {
    /*
     * 拉起进程前领一次插话：工作进程启动后追加的内容只进 direct 队列，不自动进入派单。
     * 验收清单只拼 done=false 的条目。
     */
    const takenNow = claimDirectives(root, {
      shard: claimed.shard ?? "",
      stage: claimed.stage,
      dispatchId: claimed.id,
      /* 按血缘领取：对 A 的追加只归 A 链；无分片插队单不传 lineage 会误归到别的单。 */
      lineage: String((claimed as DispatchEx).lineage ?? claimed.id),
      /* 按线程键认领追加，键与看板显示的编号同源。 */
      lane: laneKeyOf(claimed as { stage?: string; shard?: string | null; lineage?: string; id?: string }),
    });
    /*
     * action 以契约当前值为准，不用派单快照：复用旧 open 单重派时快照仍是旧文字。
     * 分片已不在契约时回落快照，且不再叠验收清单，避免清单重复。
     */
    const baseAction = contractShardAction(contract, claimed.stage, claimed.shard ?? "");
    /*
     * 附件按声明重建，不从正文解析：派单 atts 优先（空数组表示明确不带），其次 src_msg 回查，
     * 再按本轮插话的 atts 或 msg_id 补入；顺序为固化附件 → 本轮插话，不设张数上限。
     */
    const srcMsg = String((claimed as DispatchEx).src_msg ?? "");
    const fromMessage = srcMsg ? attachmentsOfMessage(root, srcMsg) : null;
    const attsField = Array.isArray(claimed.atts) ? claimed.atts.map((p) => String(p)) : null;
    const trusted = attsField !== null ? attsField : fromMessage;
    const fromDirectives = takenNow.flatMap((x) => {
      if (Array.isArray(x.atts)) return x.atts.map((p) => String(p));
      return x.msg_id ? (attachmentsOfMessage(root, String(x.msg_id)) ?? []) : [];
    });
    const pool = [
      ...new Set([...(trusted ?? []), ...fromDirectives].map((p) => String(p ?? "").trim())),
    ].filter(Boolean);
    const declared = pool;

    const composed = withCopyStandard(
      root,
      baseAction === null
        ? spliceDirectives(claimed.action, takenNow)
        : withAcceptance(root, spliceDirectives(baseAction, takenNow)),
    );
    /* 先移除正文附件行再按声明重建，否则残留旧行。 */
    const stripped = stripAttachments(composed);
    /* 经验记忆在拼装动作时注入，不在建单时：建单后新学的卡点也能随本单下发。 */
    const actionNow = withLessons(root, withAttachmentLines(stripped, declared));
    /*
     * actionNow 写回台账：capitalist next、看板与 capitalist feed 读单上那一份，不落盘会与实际下发不一致。
     * atts 与 src_msgs 一并写回，字段与下发内容对齐，避免下次重派按正文残留丢弃；仅变化时写盘。
     */
    const srcMsgs = takenNow.map((x) => String(x.msg_id ?? "")).filter(Boolean);
    const mergedMsgs = srcMsgs.length
      ? [...new Set([...(claimed.src_msgs ?? []), ...srcMsgs])]
      : claimed.src_msgs;
    const attsChanged = JSON.stringify(declared) !== JSON.stringify(attsField ?? null);
    if (actionNow !== claimed.action || attsChanged || srcMsgs.length > 0) {
      patchDispatch(root, claimed.id, {
        action: actionNow,
        atts: declared,
        ...settlingTitle(claimed),
        ...(mergedMsgs && mergedMsgs.length ? { src_msgs: mergedMsgs } : {}),
      } as Partial<Dispatch>);
      const prevTail = actionTail(claimed.action);
      const prevBase = prevTail
        ? claimed.action.slice(0, claimed.action.length - prevTail.length)
        : claimed.action;
      if (baseAction !== null && prevBase !== baseAction) {
        recordEvent(root, "dispatch_action_refreshed", {
          dispatch: claimed.id,
          stage: claimed.stage,
          shard: claimed.shard ?? "",
          from: prevBase,
          to: baseAction,
          reason: "任务列表里的 action 已改，发车前按当前值重拼",
        });
      }
    }

    const spawnOpts = {
      root,
      target: state.target,
      host,
      id,
      dispatch: {
        ...claimed,
        action: actionNow,
        atts: declared,
        ...(mergedMsgs && mergedMsgs.length ? { src_msgs: mergedMsgs } : {}),
      },
      model,
      effort: wopts.effort,
      cmd: wopts.cmd,
    };
    // 可见窗口依赖 cmd.exe 与 .cmd，仅 Windows 可用；其它平台回落后台模式。
    const wantVisible = wopts.visible && process.platform === "win32";
    if (wopts.visible && !wantVisible) {
      out("[监工] 可见窗口只在 Windows 可用，本次按后台模式启动。");
    }
    const { record, child } = wantVisible ? openVisibleWorker(spawnOpts) : launchWorker(spawnOpts);
    // 模型写入工作进程记录，供 capitalist workers 与看板读取。
    saveWorker(root, { ...record, model: model ?? "" } as WorkerRecord);
    /* 立即执行单腾槽派单时租约的 worker 字段为空，此处补写实际进程 id。 */
    const leaseNow = readPreemptLease(root);
    if (leaseNow && leaseNow.dispatch === claimed.id) {
      savePreemptLease(root, { ...leaseNow, worker: record.id });
    }
    recordEvent(root, "worker_start", {
      worker: record.id,
      pid: record.pid,
      host,
      dispatch: claimed.id,
      stage: claimed.stage,
      shard: claimed.shard ?? "",
      model: model ?? "",
      mode: record.mode ?? "background",
    });
    out(
      `[监工] 拉起 worker ${record.id}（pid ${record.pid}，${host}${
        record.mode === "visible" ? "，可见窗口" : ""
      }）→ ${claimed.id}${model ? ` 模型=${model}` : ""}`,
    );

    // 可见窗口模式不持有 child 句柄，退出状态由工作进程自行上报。
    child?.on("exit", (code) => {
      const rec = loadWorker(root, id);
      if (rec) {
        /* suspended 是让位而非退出，不按退出码改写状态，否则与失败混淆。 */
        if (rec.status !== "suspended") {
          saveWorker(root, { ...rec, status: code === 0 ? "exited" : "failed", exit_code: code ?? -1 });
        }
        /* 上下文占用写回车道，供下次判定续接或换代；读数取日志 result 行，不估算。 */
        try {
          const u = workerUsage(rec, readDispatches(root));
          recordLaneUsage(root, laneOfWorker(rec), {
            context_used: u.context_used,
            context_window: u.context_window,
            context_model: u.model,
          });
        } catch {
          /* 日志未写完（进程被强杀）时读不到占用，留给下一次派单按未知处理。 */
        }
      }
      // 退出立即结单：等下一轮收割期间该单仍算在途，会挡住阶段推进与重派。
      const cur = readDispatches(root).find((x) => x.id === claimed.id);
      if (cur?.status === "claimed") {
        const why = workerExitReason(root, id, code);
        if (isQuotaText(why)) markQuotaExhausted(root, why);
        failDispatchAndJudge(root, claimed, why, out);
        recordEvent(root, "dispatch_reaped", {
          dispatch: claimed.id,
          stage: claimed.stage,
          shard: claimed.shard ?? "",
          worker: id,
          exit_code: code ?? -1,
          reason: why,
        });
        /* 登录态不可用时 failDispatchAndJudge 已判死，此处不提示等待重派。 */
        const tail = why === AUTH_REQUIRED_TEXT ? "已判死" : "已结单，等待重派";
        out(`[监工] worker ${id} 退出（code ${code ?? "?"}），派单 ${claimed.id} ${tail}`);
      }
    });
  } catch (err) {
    failDispatchAndJudge(root, claimed, `worker 启动失败：${String((err as Error).message ?? err)}`, out);
    recordEvent(root, "worker_launch_failed", { dispatch: claimed.id, error: String((err as Error).message ?? err) });
    out(`[监工] 启动 worker 失败：${String((err as Error).message ?? err)}`);
  }
  return true;
}

function patchDispatch(root: string, id: string, patch: Partial<Dispatch>): void {
  const rows = readDispatches(root);
  const idx = rows.findIndex((d) => d.id === id);
  if (idx < 0) return;
  rows[idx] = { ...rows[idx], ...patch } as Dispatch;
  writeJsonl(dispatchPath(root), rows);
}

/**
 * 把已终结的派单翻回 open 供重新领取。终止字段须 delete 而非置空：
 * done_at、retry_verdict、review_until 任一存在都会重新挡住该单。
 */
function reopenSettledDispatch(root: string, id: string, why: string): Dispatch | null {
  const rows = readDispatches(root);
  const idx = rows.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  const next: Dispatch = { ...(rows[idx] as Dispatch), status: "open", ...(why ? { note: why } : {}) };
  delete next.done_at;
  delete next.review_until;
  delete next.review_note;
  delete next.retry_verdict;
  delete next.retry_why;
  rows[idx] = next;
  writeJsonl(dispatchPath(root), rows);
  return next;
}

/**
 * 把目标单已终结的未消费追加记录翻回 open：判据为插话未消费、明确指向某张单、该单不在途。
 * 无 target 的老记录不推断归属。
 */
export function drainSettledDirectives(root: string, out: (s: string) => void = () => {}): string[] {
  const live = new Set(["open", "claimed", "reported", "review"]);
  const rows = readDispatches(root);
  const byId = new Map(rows.map((d) => [String(d.id), d]));
  const reopened: string[] = [];
  for (const r of listDirectives(root)) {
    if (r.consumed) continue;
    const target = String((r as { target?: unknown }).target ?? "");
    if (!target) continue;
    const d = byId.get(target);
    if (!d) continue;
    const st = String(d.status ?? "");
    if (live.has(st)) continue;
    if (reopened.includes(target)) continue;
    const why = `追加内容补投递（${st} → open）`;
    reopenSettledDispatch(root, target, why);
    recordEvent(root, "directive_reopen", {
      dispatch: target,
      stage: d.stage,
      from: st,
      text: String(r.text ?? "").slice(0, 200),
    });
    out(`[监工] 追加的目标单 ${target} 已终结（${st}），已翻回 open 补投递`);
    reopened.push(target);
  }
  return reopened;
}

/** 按分片独立统计连续失败次数与最后失败时间；done 将计数清零。 */
function shardRetry(rows: Dispatch[], resetAtMs = 0): { failures: number; lastAt: number } {
  let failures = 0;
  let lastAt = 0;
  for (const d of rows) {
    if (d.status === "failed") {
      const ts = Date.parse(d.done_at ?? d.at);
      // 裁决或 --force 接管前的失败不计入，否则该片会一直卡在重派上限。
      if (Number.isFinite(ts) && ts < resetAtMs) continue;
      failures += 1;
      if (Number.isFinite(ts)) lastAt = ts;
    } else if (d.status === "done") {
      failures = 0;
      lastAt = 0;
    }
  }
  return { failures, lastAt };
}

/**
 * 重派计数起算点取 retry_resets 三档最大值：`*` 全局、`<stage>/` 整阶段、`<stage>/<shard>` 单片。
 * 三档都没有时返回 0，统计全部历史。
 */
function retryResetMs(state: TaskState, stage: string, shard: string): number {
  const map = (state.retry_resets ?? {}) as Record<string, string>;
  const pick = (k: string): number => {
    const t = Date.parse(map[k] ?? "");
    return Number.isFinite(t) ? t : 0;
  };
  return Math.max(pick("*"), pick(`${stage}/`), pick(`${stage}/${shard}`));
}

/** 失败等待时间按 1、2、4 分钟递增，封顶 4 分钟。 */
function retryDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  const delays = retryDelaysMs();
  const i = Math.min(failures - 1, delays.length - 1);
  return delays[i] ?? delays[delays.length - 1] ?? 0;
}

function terminateWorkers(root: string, out: (s: string) => void): void {
  for (const w of listWorkers(root)) {
    if (w.status !== "running" && w.status !== "starting") continue;
    // 可见窗口属用户会话，监工退出时不关闭。
    if (w.mode === "visible") {
      out(`[监工] 可见窗口 worker ${w.id} 保留运行（pid ${w.pid}），需要时手动关闭`);
      continue;
    }
    // 先软后强并确认退出，避免残留进程。
    const how = killWorkerPid(w.pid);
    if (how === "unconfirmed") {
      out(`[监工] worker ${w.id}（pid ${w.pid}）终止后仍未确认退出，可能有残留进程`);
    }
    saveWorker(root, { ...w, status: "exited" });
    out(`[监工] 已停 worker ${w.id}（pid ${w.pid}）`);
  }
}

/**
 * 暂停时停掉工作进程并把派单退回 open：只改状态，不写失败、不记重试次数。
 * 可见窗口模式不代关；无 running/starting 进程时直接返回。
 */
function stopWorkersForPause(root: string, out: (s: string) => void): void {
  const live = listWorkers(root).filter((w) => w.status === "running" || w.status === "starting");
  if (live.length === 0) return;
  const dispatches = readDispatches(root);
  for (const w of live) {
    if (w.mode === "visible") {
      out(`[监工] 暂停：可见窗口工作进程 ${w.id}（pid ${w.pid}）保留，窗口由人工管理`);
      continue;
    }
    const how = killWorkerPid(w.pid);
    saveWorker(root, { ...w, status: "exited" });
    /* claimed 单无进程接会一直占队列，且判死只看心跳不看单状态，故退回 open。 */
    const d = w.dispatch ? dispatches.find((x) => x.id === w.dispatch) : undefined;
    if (d && d.status === "claimed") {
      patchDispatch(root, d.id, { status: "open", note: "调度暂停：进程已停，恢复调度后重派" });
    }
    recordEvent(root, "worker_paused", {
      worker: w.id,
      dispatch: w.dispatch ?? "",
      pid: w.pid,
      how,
    });
    out(`[监工] 已暂停 worker ${w.id}（pid ${w.pid}）${how === "unconfirmed" ? "，终止后未确认退出，可能有残留" : ""}`);
  }
}

function liveWorkers(root: string): string[] {
  return listWorkers(root)
    .filter((w) => w.status === "running" || w.status === "starting")
    .map((w) => w.id);
}

/** 未裁决 ask 一律走 core/inbox.ts 的校验读取，畸形记录不进判定。 */
function openAsks(root: string): Array<Record<string, unknown>> {
  return openInboxAsks(root) as Array<Record<string, unknown>>;
}

/** 按任务根记录畸形记录签名：同一批坏行只告警一次，签名变化才重记。 */
const lastInboxWarnSig = new Map<string, string>();

/**
 * 畸形 inbox 记录一律忽略、不改变调度状态，仅记一条 warn 事件留痕。
 * @returns 被忽略的条数，0 表示台账干净。
 */
function warnIgnoredInbox(root: string, out: (s: string) => void): number {
  const { ignored, skipped } = readInbox(root);
  if (ignored.length === 0) {
    lastInboxWarnSig.delete(root);
    return 0;
  }
  const sig = ignoredSignature(ignored);
  if (lastInboxWarnSig.get(root) === sig) return ignored.length;
  lastInboxWarnSig.set(root, sig);

  recordEvent(root, "warn", {
    kind: "inbox_malformed",
    ignored: ignored.length,
    samples: ignored.slice(0, 5).map((i) => ({ line: i.line, reason: i.reason })),
    skipped_files: skipped,
  });
  out(
    `[监工] inbox 有 ${ignored.length} 条畸形记录已忽略（不参与调度）：` +
      `${ignored
        .slice(0, 3)
        .map((i) => `第 ${i.line} 行 ${i.reason}`)
        .join("；")}${ignored.length > 3 ? " …" : ""}`,
  );
  return ignored.length;
}

/** ask 正文的两种历史字段：text（capitalist ask）与 question（早期 raiseAsk），统一经此读取。 */
function askText(q: Record<string, unknown>): string {
  return String(q.text ?? q.question ?? "");
}

/**
 * 登记待裁决 ask 到 inbox/qa.jsonl，字段与 capitalist ask 一致：id、text、context、stage、shard。
 * shard 必须写：缺省会被 step() 当成全阶段级问题，连带暂停其它分片；仅全阶段问题才留空。
 */
function raiseAsk(root: string, question: string, detail = "", stage = "", shard = ""): void {
  appendJsonl(join(supervisorDir(root), "inbox", "qa.jsonl"), {
    type: "ask",
    status: "open",
    /* id 加随机后缀，使同一秒内连续登记不重复。 */
    id: `Q${Math.floor(Date.now() / 1000) % 100000}-${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    at_ts: Date.now() / 1000,
    text: question,
    context: detail,
    stage,
    ...(shard ? { shard } : {}),
  });
}

/* 同一分片五分钟内只记一次重派上限事件。 */
const cappedNoted = new Map<string, number>();

/** 判据：.capitalist/direct.jsonl 中 30 分钟内、分片匹配的记录，用于区分自动重派与人工介入。 */
function userAskedRecently(root: string, shardId: string): boolean {
  if (!shardId) return false;
  try {
    const rows = readJsonl<{ at?: string; shard?: string; text?: string }>(
      join(root, ".capitalist", "direct.jsonl"),
    );
    const since = Date.now() - 30 * 60_000;
    return rows.some((r) => {
      const at = Date.parse(String(r.at ?? "")) || 0;
      if (at < since) return false;
      return String(r.shard ?? "") === shardId;
    });
  } catch {
    return false;
  }
}

function raiseRedispatchCap(
  root: string,
  stage: string,
  shardId: string,
  mine: Dispatch[],
  out: (s: string) => void,
): void {
  const label = `${stage}/${shardId || "整阶段"}`;
  const marker = `重派上限 ${label}`;
  if (openAsks(root).some((q) => askText(q).includes(marker))) return;
  /* 达到上限不登记 ask、不停派，只记一条 redispatch_capped 事件；同一分片五分钟内只记一次。 */
  const key = `${stage}/${shardId}`;
  const now = Date.now();
  if (now - (cappedNoted.get(key) ?? 0) < 5 * 60_000) return;
  cappedNoted.set(key, now);
  const history = mine
    .filter((d) => d.status === "failed")
    .map((d) => `${d.id}#第${d.attempt ?? "?"}次${d.note ? `（${d.note}）` : ""}@${d.done_at ?? d.at}`)
    .join("；");
  recordEvent(root, "redispatch_capped", { stage, shard: shardId, limit: REDISPATCH_LIMIT, history, blocked: false });
  out(`[监工] 分片 ${label} 连续失败 ${REDISPATCH_LIMIT} 次：不停派，转诊断查根因`);
}

/**
 * 分片反复失败时开一张只读诊断单查根因。同一任务根同时只允许一张未完成的诊断单，
 * 且诊断单占用并行度槽位。
 */
function escalateStuckShard(
  root: string,
  stage: string,
  shardId: string,
  failures: number,
  mine: Dispatch[],
  out: (s: string) => void,
): void {
  const rows = readDispatches(root);
  const busy = rows.some(
    (d) =>
      d.role === "diagnose" &&
      (d.status === "open" || d.status === "claimed" || d.status === "review"),
  );
  if (busy) return;
  const mark = `stuck:${stage}/${shardId}`;
  if (rows.some((d) => d.role === "diagnose" && String(d.action).includes(mark))) return;

  const history = mine
    .filter((d) => d.status === "failed")
    .slice(-3)
    .map((d) => `${d.id}（${d.note ?? "无说明"}）`)
    .join("；");
  const id = newDispatchId();
  const rec = {
    id,
    at: new Date().toISOString(),
    stage,
    shard: "",
    title: `诊断：${stage}/${shardId} 连续失败 ${failures} 次`,
    action:
      `[${mark}] 分片 ${stage}/${shardId} 已连续失败 ${failures} 次，查清根因：为什么每次都失败、卡在哪一步。` +
      `失败历史：${history || "（无）"}。只查不改。`,
    status: "open",
    source: "adhoc",
    attempt: 1,
    urgent: true,
    role: "diagnose",
    tags: ["diagnose"],
  } as Dispatch;
  rec.lineage = rec.lineage ?? rec.id;
  appendDispatch(root, rec);
  ensureTaskForDispatch(root, rec);
  recordEvent(root, "stuck_escalated", { dispatch: id, stage, shard: shardId, failures, history });
  /* 连续失败作为反复出现的卡点记入记忆。 */
  rememberLesson(root, `分片 ${stage}/${shardId} 连续失败 ${failures} 次：${history || "无失败说明"}`, id);
  out(`[监工] 分片 ${stage}/${shardId} 连续失败 ${failures} 次 → 已开诊断单 ${id}（只查不改）`);
}


/** 同一（进程 · 申报类型）五分钟内只判一次：判定需调用模型，记录不丢弃。 */
const triagedAt = new Map<string, number>();
const TRIAGE_DEDUPE_MS = 5 * 60_000;

/**
 * 已判过的消息 id：同一行申报只判一次，挡住游标回退导致的重读。
 * done 报告必须按 id 单独裁：打回后重报的 from|kind 与上一份相同，只靠窗口会漏掉第二份。
 */
const triagedIds = new Map<string, number>();
/** id 记录上限：只用于挡住短时间内的重读。 */
const TRIAGED_IDS_MAX = 500;

/** 判定层重做预算：同一血缘上 requeue/reject 最多 2 次，与调度层的失败次数分开计数。 */
const TRIAGE_REDO_LIMIT = 2;
const triageRedo = new Map<string, number>();
/** 已转人工裁决的血缘：同一件事只登记一次。 */
const triageEscalated = new Set<string>();

/** 判定池并发上限 2；判定在 tick 外异步执行，池子只决定后台消化速度。 */
const TRIAGE_POOL_MAX = 2;
/** 排队上限：超过则丢弃最早一条并记事件。 */
const TRIAGE_QUEUE_MAX = 50;

const triageQueue: Array<() => Promise<void>> = [];
let triageRunning = 0;

function pumpTriage(): void {
  while (triageRunning < TRIAGE_POOL_MAX) {
    const job = triageQueue.shift();
    if (!job) return;
    triageRunning += 1;
    void job()
      .catch(() => {
        /* 判定失败不重试：申报已入事件流。 */
      })
      .finally(() => {
        triageRunning -= 1;
        pumpTriage();
      });
  }
}

/** 判定入池后立即返回。调用方须先完成所有同步读盘准备。 */
function enqueueTriage(root: string, job: () => Promise<void>): void {
  if (triageQueue.length >= TRIAGE_QUEUE_MAX) {
    triageQueue.shift();
    recordEvent(root, "mq_triage_dropped", { reason: "判定队列堆积，丢弃最早一条", queued: triageQueue.length });
  }
  triageQueue.push(job);
  pumpTriage();
}

/**
 * 验收对账材料：按送达过这一单取（delivered_by，老记录回退 target），附 capitalist report --outcome 的逐条结论。
 * 无结论的记为「未给结论」，验收按未完成处理。
 */
function directiveLedgerFor(root: string, d: Dispatch | undefined): string[] {
  if (!d) return [];
  const id = String(d.id ?? "");
  const lineage = String(d.lineage ?? id);
  const rows = listDirectives(root).filter((r) => {
    const t = String((r as { target?: string }).target ?? "");
    const db = String((r as { delivered_by?: string }).delivered_by ?? "");
    if (db && db === id) return true;
    return Boolean(t) && (t === id || t === lineage);
  });
  return rows.slice(-12).map((r) => {
    const ref = directiveRef(r);
    const note = String((r as { outcome_note?: string }).outcome_note ?? "").trim();
    const outcome = String((r as { outcome?: string }).outcome ?? "").trim();
    const verdict = outcome ? `${outcome}${note ? `（${note}）` : ""}` : "未给结论";
    return `[${ref}] ${String(r.text ?? "").replace(/\s+/g, " ").slice(0, 180)} ｜ 结论：${verdict}`;
  });
}

function userWordsFor(root: string, d: Dispatch | undefined): string[] {
  if (!d) return [];
  const id = String(d.id ?? "");
  const lineage = String(d.lineage ?? id);
  const hit = listDirectives(root).filter((r) => {
    const t = String((r as { target?: string }).target ?? "");
    const db = String((r as { delivered_by?: string }).delivered_by ?? "");
    /* 送达过这一单的也算：target 指向链首或旧实例时，只看 target 会漏掉。 */
    if (db && db === id) return true;
    return Boolean(t) && (t === id || t === lineage);
  });
  return hit
    .slice(-6)
    /* 用本地时间，与界面一致；见 core/clock.ts。 */
    .map((r) => `${clockOf((r as { at?: string }).at)} ${String(r.text ?? "").slice(0, 200)}`);
}

/**
 * 消费申报队列。判定与执行分离：模型只给结论，状态写入走既有原语。
 * 通道故障时 fallback=true，不执行动作，消息仍入事件流。
 * 游标处理完才提交；中途异常导致的重读由去重挡住。
 */
async function consumeMq(args: {
  root: string;
  contract: Contract;
  state: TaskState;
  out: (s: string) => void;
}): Promise<void> {
  const { root, contract, state, out } = args;
  const { messages, nextOffset, skipped } = readPendingMq(root);
  if (skipped > 0) {
    out(`[监工] 申报队列有 ${skipped} 行读不出来，已跳过（不影响它后面的消息）`);
  }
  if (messages.length === 0) {
    commitCursor(root, nextOffset);
    return;
  }

  for (const msg of messages) {
    recordEvent(root, "mq_message", {
      id: msg.id,
      from: msg.from,
      dispatch: msg.dispatch,
      stage: msg.stage,
      shard: msg.shard,
      kind: msg.kind,
      severity: msg.severity,
      needs: msg.needs,
      text: String(msg.text ?? "").slice(0, 400),
      evidence: msg.evidence ? String(msg.evidence).slice(0, 600) : "",
    });
    out(
      `[监工] 申报 ${msg.from || "?"} · ${msg.kind}（${msg.severity}）：` +
        `${String(msg.text ?? "").slice(0, 70)}`,
    );

    if (!worthTriaging(msg)) continue;
    /*
     * 去重分两道：消息 id 挡游标回退导致的重读；from|kind 时间窗挡同类连发。
     * done 只受 id 约束：打回后重报是新事实，用时间窗合并会丢失。
     */
    if (msg.id) {
      if (triagedIds.has(msg.id)) {
        out(`[监工] 这条申报已经判过（${msg.id}），只记录不重复判`);
        continue;
      }
      triagedIds.set(msg.id, Date.now());
      if (triagedIds.size > TRIAGED_IDS_MAX) {
        const cutoff = Date.now() - TRIAGE_DEDUPE_MS * 6;
        for (const [id, at] of triagedIds) if (at < cutoff) triagedIds.delete(id);
        /* 仍超限时移除最早的一半，防止表无限增长。 */
        if (triagedIds.size > TRIAGED_IDS_MAX) {
          const keys = [...triagedIds.keys()].slice(0, Math.floor(TRIAGED_IDS_MAX / 2));
          for (const k of keys) triagedIds.delete(k);
        }
      }
    }
    if (String(msg.kind) !== "done") {
      const key = `${msg.from}|${msg.kind}`;
      if (Date.now() - (triagedAt.get(key) ?? 0) < TRIAGE_DEDUPE_MS) {
        out(`[监工] 同类申报刚判过（${key}），这条只记录不重复判`);
        continue;
      }
      triagedAt.set(key, Date.now());
    }

    const dispatches = readDispatches(root);
    const d = dispatches.find((x) => x.id === msg.dispatch);
    const same = dispatches.filter(
      (x) => x.stage === msg.stage && (x.shard ?? "") === (msg.shard ?? "") && x.status === "failed",
    );
    /*
     * tick 内只做同步读盘，判定异步入池：同步等待会拖住收割、派单与阶段推进。
     * 并发由 TRIAGE_POOL_MAX 限制。
     */
    enqueueTriage(root, async () => {
      const gate = runCheck(
        stageById(contract, state.stage)?.done as Record<string, unknown> | undefined,
        root,
      );
      /* 判定层同时接收 added_reqs 与定向到该单（或该链）的插话，避免按旧口径审新增要求。 */
      const addedReqs = d && Array.isArray(d.added_reqs) ? d.added_reqs.map(String) : [];
      /*
       * 工作区变动在异步池内采集：git 调用走外部进程，放进 tick 会拖住调度。
       * 非版本控制目录返回空数组。
       */
      const workspace = await workspaceFacts(root);
      const verdict = await triage({
        root,
        contract,
        state,
        msg,
        action: String(d?.action ?? ""),
        failures: same.length,
        live: liveWorkers(root).length,
        capacity: Math.max(1, Number(loadSupervisor(root)?.max_workers ?? 1) || 1),
        gateMissing: gate.missing,
        recent: same.slice(-3).map((x) => `${x.id}：${String(x.note ?? "无说明").slice(0, 140)}`),
        addedReqs,
        /* 报告证据（capitalist report --evidence）；老记录无该字段，由 triage 回落。 */
        evidence: String((d as (Dispatch & { report_evidence?: string }) | undefined)?.report_evidence ?? ""),
        workspace,
        userWords: userWordsFor(root, d),
        /* 逐条对账材料：送达该单的每条要求及其结论，见 directiveLedgerFor。 */
        directiveLedger: directiveLedgerFor(root, d),
      });
      recordEvent(root, "mq_triage", {
        msg: msg.id,
        from: msg.from,
        kind: msg.kind,
        decision: verdict.decision,
        why: verdict.why,
        say: verdict.say ?? "",
        fallback: verdict.fallback === true,
        /* 记录 fallback 的真因：凭证、超时或输出缺动作行。 */
        error: verdict.error ?? "",
        /* 记录本次判定的输入：证据有无、工作区变动行数。 */
        had_evidence: Boolean(msg.evidence || (d as { report_evidence?: string } | undefined)?.report_evidence),
        workspace_lines: workspace.length,
      });
      out(`[监工] 判定 ${msg.kind} → ${verdict.decision}：${verdict.why.slice(0, 90)}`);
      applyVerdict({ root, state, msg, verdict, out });
    });
  }

  commitCursor(root, nextOffset);
}

export function applyVerdict(args: {
  root: string;
  state: TaskState;
  msg: MqMessage;
  verdict: TriageVerdict;
  out: (s: string) => void;
}): void {
  const { root, msg, verdict, out } = args;
  if (verdict.fallback) {
    /*
     * 判定通道不可用时，done 申报按现状结单并在 note 注明未经复核；失败申报仍走 retry。
     */
    const target = msg.dispatch ? readDispatches(root).find((x) => x.id === msg.dispatch) : undefined;
    const kind = String(msg.kind ?? "");
    if (kind === "done" && target && target.status === "reported") {
      const rawNote = String((target as Dispatch & { review_note?: string }).review_note ?? "").trim();
      const why = verdict.error
        ? `判定通道不可用（${verdict.error.slice(0, 160)}），未经 AI 复核，按现状结单`
        : "判定通道不可用，未经 AI 复核，按现状结单";
      const merged = rawNote ? `${rawNote}\n\n（${why}）` : why;
      if (finishDispatch(root, target.id, "done", merged)) {
        recordEvent(root, "dispatch_done_unreviewed", {
          dispatch: target.id,
          stage: target.stage,
          shard: target.shard ?? "",
          worker: target.worker ?? "",
          msg: msg.id,
          error: verdict.error ?? "",
        });
        out(`[监工] 判定通道异常，${target.id} 按现状结单（注明未经复核）：${String(verdict.error ?? "").slice(0, 90)}`);
        return;
      }
    }
    out("[监工] 判定通道异常，本条不执行任何动作（只记录）");
    return;
  }

  /*
   * 防死循环三道闸，仅对有调度副作用的结论生效：同一血缘 requeue/reject 最多 2 次，超限降级 escalate；
   * 同种结论 5 分钟内只执行一次；同一血缘只登记一条 ask。
   */
  const chainKey = (() => {
    const d = readDispatches(root).find((x) => x.id === msg.dispatch);
    const de = d as DispatchEx | undefined;
    return String(de?.lineage ?? d?.id ?? msg.dispatch ?? msg.id);
  })();

  if (verdict.decision === "requeue" || verdict.decision === "reject") {
    const done = (triageRedo.get(chainKey) ?? 0) + 1;
    triageRedo.set(chainKey, done);
    if (done > TRIAGE_REDO_LIMIT) {
      recordEvent(root, "triage_downgraded", {
        chain: chainKey,
        msg: msg.id,
        from: verdict.decision,
        reason: `同一件事已被判定重做 ${done - 1} 次，仍未见效`,
        why: verdict.why,
      });
      out(
        `[监工] 判定 ${verdict.decision} 已重复 ${done - 1} 次（链 ${chainKey}），降级为人工裁决——` +
          "继续重做只会重复同一个失败",
      );
      if (!triageEscalated.has(chainKey)) {
        triageEscalated.add(chainKey);
        raiseAsk(
          root,
          `【反复重做无效】${String(msg.text ?? "").slice(0, 260)}`,
          `同一件事已重做 ${done - 1} 次仍不见效（链 ${chainKey}）。最后一次判定理由：${verdict.why}`,
          msg.stage,
          msg.shard,
        );
      }
      return;
    }
  }

  if (verdict.decision === "escalate" && triageEscalated.has(chainKey)) {
    out(`[监工] 这条链（${chainKey}）已经转人工裁决过，不重复登记 ask`);
    return;
  }

  if (verdict.decision === "nudge") {
    const text = String(verdict.say ?? "").trim();
    if (!text) {
      out("[监工] 判定 nudge 但没给出要说的话，跳过（不推断其意图）");
      return;
    }
    /* nudge 定向写入 target 与 lineage：重派后的同血缘新单仍能领取，其它单领不到。 */
    const rec = appendDirective(root, {
      text,
      target: msg.dispatch,
      shard: msg.shard || null,
      stage: msg.stage,
      ...(chainKey ? { lineage: chainKey } : {}),
      /* via 标为 capitalist：回显时按监工来源渲染。 */
      via: "capitalist",
    });
    return;
  }

  if (verdict.decision === "requeue") {
    const d = readDispatches(root).find((x) => x.id === msg.dispatch);
    if (d && (d.status === "claimed" || d.status === "open")) {
      finishDispatch(root, d.id, "failed", `监工判定重开：${verdict.why}`.slice(0, 200));
      out(`[监工] 按判定把 ${d.id} 结为 failed，等退避后按新口径重派`);
    }
    return;
  }

  if (verdict.decision === "pause_shard") {
    if (!msg.shard) {
      out("[监工] 判定暂停但这条申报没有分片归属，无法只停一片——按 escalate 处理");
      raiseAsk(root, `【${msg.kind}】${String(msg.text).slice(0, 300)}`, verdict.why, msg.stage, "");
      return;
    }
    takeoverShard(root, { shard: msg.shard, reason: `监工判定暂停：${verdict.why}`, by: "supervisor" });
    out(`[监工] 分片 ${msg.shard} 已暂停（人工接管态），原因：${verdict.why}`);
    return;
  }

  if (verdict.decision === "escalate") {
    raiseAsk(
      root,
      `【${msg.kind}】${String(msg.text ?? "").slice(0, 300)}`,
      `来自 ${msg.from || "?"}｜监工判断：${verdict.why}`,
      msg.stage,
      msg.shard,
    );
    out(`[监工] 已转人工裁决（${msg.kind}）`);
    return;
  }

  if (verdict.decision === "reject") {
    const d = readDispatches(root).find((x) => x.id === msg.dispatch);
    if (!d) return;
    /*
     * 原进程存活时写一次性回执就地退回，派单保持 reported、不触发重派；
     * capitalist report 阻塞等待该回执，读到后带原因继续修改。
     */
    const w = d.worker ? loadWorker(root, d.worker) : null;
    const aliveNow = Boolean(w && w.pid > 0 && pidAlive(w.pid));
    if (aliveNow) {
      writeJson(join(root, ".capitalist", "inbox", `reject-${d.id}.json`), {
        at: new Date().toISOString(),
        why: String(verdict.why ?? ""),
        by: "supervisor",
      });
      recordEvent(root, "review_rejected_inline", {
        dispatch: d.id,
        stage: d.stage,
        worker: d.worker ?? "",
        why: String(verdict.why ?? "").slice(0, 200),
      });
      out(`[监工] 报告打回 ${d.id}：原进程还在，就地退回继续改（不重派）`);
      return;
    }
    finishDispatch(root, d.id, "failed", `报告未通过审查：${verdict.why}`.slice(0, 200));
    out(`[监工] 报告打回 ${d.id}：${verdict.why}`);
    return;
  }

  if (verdict.decision === "accept") {
    const d = readDispatches(root).find((x) => x.id === msg.dispatch);
    if (!d) {
      out("[监工] 裁决通过，但该派单已不存在（可能已被手动结项）");
      return;
    }
    const done = finishDispatch(root, d.id, "done", `监工裁决通过：${verdict.why}`.slice(0, 200));
    out(done ? `[监工] 裁决通过，${d.id} 已结单` : `[监工] 裁决通过，但 ${d.id} 已是终态，未改动`);
  }
}


/** `.capitalist/pause.json` 的内容：存在即处于暂停态，删除即恢复。 */
export interface PauseFile {
  at: string;
  reason: string;
  by?: string;
}

/** 暂停文件的绝对路径：`<root>/.capitalist/pause.json`。 */
export function pausePath(root: string): string {
  return join(supervisorDir(root), "pause.json");
}

/** 读暂停文件。文件缺失或损坏均视为未暂停。 */
export function readPause(root: string): PauseFile | null {
  const raw = readJson<Partial<PauseFile> | null>(pausePath(root), null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    at: String(raw.at ?? ""),
    reason: String(raw.reason ?? ""),
    ...(raw.by === undefined ? {} : { by: String(raw.by) }),
  };
}


/** 记一条欠账：可选项未达标但允许推进；写入 state 供 status 输出与终审清算。 */
function addDebt(root: string, stage: string, shard: string): void {
  updateState(root, (s) => {
    const debt = Array.isArray(s.debt)
      ? (s.debt as Array<{ key: string; stage: string; shard: string; at: string }>)
      : [];
    const key = `${stage}/${shard}`;
    if (!debt.some((d) => d.key === key)) {
      debt.push({ key, stage, shard, at: new Date().toISOString() });
      s.debt = debt as unknown as typeof s.debt;
    }
  });
}

/** 终审阶段清算欠账：列出并清空，记 debt_settled 事件。 */
function settleDebt(root: string, out: (s: string) => void): void {
  const st = loadState(root);
  const debt = st && Array.isArray(st.debt) ? (st.debt as Array<{ key: string }>) : [];
  if (debt.length > 0) {
    recordEvent(root, "debt_settled", { items: debt, count: debt.length });
    out(`[监工] 终审阶段：清算欠账 ${debt.length} 条 —— ${debt.map((d) => d.key).join("、")}`);
    updateState(root, (s) => {
      s.debt = [];
    });
  }
}


function describeQueue(root: string, contract: Contract, capacity: number): string {
  const state = loadState(root);
  if (!state) return "";
  const running = listWorkers(root).filter((w) => w.status === "running" || w.status === "starting").length;
  const stageDispatches = readDispatches(root).filter((d) => d.stage === state.stage);
  /* 暂停单不参与派发，单独列出，不与排队状态合并。 */
  const queued = stageDispatches.filter((d) => d.status === "open" && !dispatchPaused(d));
  const held = stageDispatches.filter((d) => d.status === "open" && dispatchPaused(d));
  // 并行度由 tick 行的 concurrencyLabel 给出，此处只报在跑数。
  const parts: string[] = [`在跑 ${running}`];
  if (queued.length > 0) {
    const reason = capacity <= running ? `并行度 ${capacity} 已满，等待空槽` : "等待派发";
    for (const q of queued) {
      parts.push(`排队 ${q.id}(${q.stage}/${q.shard ?? "整阶段"}): ${reason}`);
    }
  }
  for (const q of held) {
    parts.push(`暂停 ${q.id}(${q.stage}/${q.shard ?? "整阶段"}): 等待唤醒`);
  }
  const st = state as TaskState & { debt?: Array<{ key: string }> };
  if (Array.isArray(st.debt) && st.debt.length > 0) {
    parts.push(`欠账 ${st.debt.length} 条（${st.debt.map((d) => d.key).join("、")}）`);
  }
  return parts.join(" ｜ ");
}

/**
 * 判定进程是否原地打转：日志末尾 300 行归一化后，同一内容重复次数与占比同时超阈值。
 * 判活以日志增长为准，打转进程不会触发心跳超时，需单独检测。
 */
function looksLooping(file: string): { looping: boolean; sample: string; times: number; tail: string[] } {
  const none = { looping: false, sample: "", times: 0, tail: [] as string[] };
  try {
    if (!existsSync(file)) return none;
    const size = statSync(file).size;
    if (size < 4096) return none;
    // 只读末尾 256KB：日志可能数百 MB，全量读取会拖住 tick。
    const want = Math.min(size, 256 * 1024);
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(want);
    try {
      readSync(fd, buf, 0, want, size - want);
    } finally {
      closeSync(fd);
    }
    /* 先过滤宿主周期性噪声再统计重复；噪声表复用 workerLog.ts，避免与 board.ts 各写一份规则。 */
    const lines = buf
      .toString("utf8")
      .split("\n")
      .slice(-300)
      .map((l) =>
        l
          .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "")
          .replace(/\b[0-9a-f]{8,}\b/gi, "")
          .replace(/\d+/g, "")
          .trim(),
      )
      .filter((l) => l.length >= 20 && !isLogNoise(l) && !l.startsWith("fetch config failed") && !l.startsWith("{"));
    if (lines.length < 80) return none;
    const count = new Map<string, number>();
    for (const l of lines) count.set(l, (count.get(l) ?? 0) + 1);
    let top = "";
    let times = 0;
    for (const [k, v] of count) if (v > times) ((times = v), (top = k));
    /* 次数与占比须同时超阈值：仅次数高可能是重复改同一文件或跑同一批测试。 */
    const looping = times >= 15 && times / lines.length >= 0.3;
    /* 日志末尾一并返回，供模型复查；重复次数不足以单独定论。 */
    return {
      looping,
      sample: top.slice(0, 120),
      times,
      tail: buf.toString("utf8").split("\n").slice(-120),
    };
  } catch {
    return none;
  }
}

/**
 * 机械检测只作触发器，是否判死由模型复查日志末尾后决定。
 * 通道不可用或结论含糊时放行。
 */
async function reviewLooping(args: {
  root: string;
  worker: string;
  shard: string;
  action: string;
  tail: string[];
}): Promise<{ kill: boolean; why: string; reviewed: boolean }> {
  /* thinking 行不进判定材料：占用字符预算，且判据是命令与报错是否变化。 */
  const clean = withoutThinking(args.tail);
  const shown = tailWithinChars(clean.lines, 3000);
  const prompt = [
    "你在判断一个工作进程是否原地循环。",
    "",
    "【它这一单要做什么】",
    String(args.action || "(未记录)").slice(0, 400),
    "",
    `【它日志的最后 ${args.tail.length} 行${clean.dropped ? `（其中 ${clean.dropped} 行思考过程已略去）` : ""}】`,
    shown,
    "",
    "判断标准：内容在变化、在推进、在产出不同的东西 → 推进；反复输出同一段、同一句命令、",
    "同一段报错，没有任何新信息 → 循环。",
    "",
    "只回答一个词：循环 / 推进。不要解释，不要加标点。",
  ].join("\n");

  const r = await askModel({
    prompt,
    /* sessionId 走判定脑的会话车道，同一进程复用同一条，换代判据与其它判定一致。 */
    sessionId: brainSessionOf(args.root, `capitalist-loopcheck-${args.worker}`).id,
    cwd: args.root,
    timeoutMs: 60_000,
    effort: "high",
    model: loadSupervisor(args.root)?.supervisor_model || undefined,
  });
  if (!r.ok) return { kill: false, why: `模型复查通道不可用（${r.text.slice(0, 80)}）`, reviewed: false };
  const t = r.text.trim();
  const saysLoop = /循环|loop/i.test(t);
  const saysProgress = /推进|progress|正常/i.test(t);
  if (saysLoop && !saysProgress) return { kill: true, why: t.slice(0, 120), reviewed: true };
  return { kill: false, why: t.slice(0, 120) || "(模型没说清楚)", reviewed: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 只把验收清单里 done=false 的条目拼进派单动作；已完成项不再下发。
 * 清单缺失或全部完成时原样返回，不阻断其它阶段。
 */
function withAcceptance(root: string, action: string): string {
  try {
    const rows = readJsonl<Record<string, unknown>>(
      join(root, LEGACY_ACCEPTANCE_DIR, "reports", "vue-acceptance.jsonl"),
    );
    if (rows.length === 0) return action;
    const todo = rows.filter((r) => r.done !== true);
    if (todo.length === 0) return action;
    const lines = todo.map((r) => {
      const id = String(r.id ?? "");
      const title = String(r.title ?? "");
      const how = String(r.how ?? "");
      return `- [${id}] ${title}${how ? `\n  怎么验：${how}` : ""}`;
    });
    return (
      `${action}\n\n【验收清单 · 还没打勾的 ${todo.length} 条】\n${lines.join("\n")}\n` +
      `（做完一条就把 ${LEGACY_ACCEPTANCE_DIR}/reports/vue-acceptance.jsonl 里那条的 done 改成 true，` +
      "并在 evidence 写明核对方式。已经打勾的不要再做一遍。）"
    );
  } catch {
    return action;
  }
}

/* 用关键词近似判定本单是否涉及用户可见文案，措辞标准以 style-guide.md 为准。 */
const COPY_HINT_RE =
  /界面|页面|文案|提示语|提示文字|按钮|菜单|标题|标签|占位|placeholder|toast|弹窗|对话框|看板|文档|帮助|报错信息|错误提示|显示文字|措辞|\bui\b/i;

function involvesUserVisibleCopy(action: string): boolean {
  return COPY_HINT_RE.test(String(action ?? ""));
}

/**
 * 文案规范措辞存于 .capitalist/memory.json（识别词见 memory.ts 的 COPY_STANDARD_MARKER），记忆里有才追加。
 * 仅当正文涉及用户可见文案时追加；先剥离已有规范行，避免重派与二次拼装叠加。
 */
function withCopyStandard(root: string, action: string): string {
  const base = String(action ?? "")
    .split("\n")
    .filter((line) => !line.includes("【文案规范】"))
    .join("\n")
    .trimEnd();
  if (!base) return "";
  const standard = copyStandardNote(root).trim();
  if (!standard) return base;
  return involvesUserVisibleCopy(base) ? `${base}\n\n${standard}` : base;
}

/** 测试用：不建根、不起循环，只跑单步。 */
export const __testing = {
  step,
  reap,
  ensureRoot,
  stageParallel,
  pickAction,
  launch,
  advanceStage,
  supersedeStaleDispatches,
  handleModelFallback,
  shardRetry,
  retryDelayMs,
  retryDelaysMs,
  describeQueue,
  createOpenShardDispatch,
  killWorkerPid,
  killJudgedWorker,
  raiseRedispatchCap,
  pausePath,
  readPause,
  applySupervisorDirectives,
  reportForestAnomalies,
  cascadeFailure,
  diagnoseFailure,
  failDispatchAndJudge,
  workerExitReason,
  REDISPATCH_LIMIT,
  requeueAdhoc,
  rescueOrphanDirectives,
  reopenSettledDispatch,
  writePauseFile,
  clearPauseFile,
  fillSlots,
  preemptForImmediate,
  releasePreemptLease,
  concurrencyLabel,
  stageProgress,
  forceFinishHung,
  warnIgnoredInbox,
  withCopyStandard,
  STALL_TICKS,
  DEFAULT_WORKERS,
};
