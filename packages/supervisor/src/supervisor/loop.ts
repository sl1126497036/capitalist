/**
 * 监工循环。
 *
 * 监工是独立进程，负责建根、定守卫、派单、验收、判定失败后重新派发，不直接执行任务。工作进程由监工拉起，
 * 各自是独立宿主进程（`<cli> -p`），有独立 pid、会话与上下文，进程之间互不可见；
 * 监工与工作进程只通过 `.capitalist/` 交换数据。
 *
 * 并行度只取用户设定值（`--workers` 或运行时指令）；在途派单各占一条并发线，
 * 空出的槽位留待后续派单。
 *
 * 监工自身异常不中断循环：单次判定失败记录后继续，连续失败记入 supervisor.json。
 * 手动暂停（`.capitalist/pause.json`）时不派新单，心跳、判定失败回收与已完成派单的结算照常。
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { errText, sleep } from "../core/text";
import { t } from "../cli/lang";
import { byId } from "../agent/registry";
import { rotationCandidates } from "../agent/modelCatalog";

import { clearBoardModuleCache } from "./boardCache";
import { askModel, AUTH_REQUIRED_TEXT, isQuotaText, judgeFault, QUOTA_EXHAUSTED_TEXT } from "./channel/llm";
import {
  activeTakeover,
  appendDirective,
  appendSection,
  claimDirectives,
  closeTask,
  directiveShortRef,
  dropDirectivesFor,
  isHeld,
  laneKeyOf,
  listDirectives,
  promoteTask,
  spliceDirectives,
  splitDirectiveTag,
  takeoverShard,
} from "../core/dispatch/commands";
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
} from "./worker/stuck";
import {
  appendAsk as raiseAsk,
  ignoredSignature,
  openInboxAsks,
  readInbox,
} from "../core/dispatch/inbox";
import {
  type Policy,
  leaseAlive,
  leaseTaskName,
  loadPolicy,
  newInstanceLease,
  readLease,
  reloadPolicy,
  savePrevPolicy,
  touchLease,
  weakenedRedlines,
  writeLease,
} from "../core/policy/policy";
import { markChannelDown, markChannelUp, readChannelDown } from "../core/message/channel";
import { appendJsonl, pruneTempFiles, readJson, readJsonl, writeJson, writeJsonl } from "../core/record/json";
import { recordEvent, recordEventThrottled } from "../core/record/ledger";
import {
  type PauseFile,
  hasUnfinishedDispatches,
  pauseAll,
  pauseLiveDispatches,
  pausePath,
  readPause,
  resumeAll,
  resumeDanglingMarks,
  setPauseGate,
} from "../core/record/pause";
/* 文件写锁供调度查询占用，避免派单命中已被占用的文件。 */
import { reap as reapFileLocks, releaseAll as releaseFileLocks, writeHolderOf } from "../core/record/fileLock";
import { NoLockTimeoutError, withNoLock } from "../core/record/noLock";
import { extractLocalPaths } from "../core/guard/localGuard";
import { ASK_BLOCK_MS, DEFAULT_SUPERVISOR_CONTEXT_LIMIT, VERDICT_HOLD_MS } from "../core/guard/limits";
import { clockOf } from "../core/clock";
import { copyStandardNote, memoriesFor, primeMemory, rememberLesson, renderMemoryConstraints, withLessons } from "./context/memory";
import { commitCursor, readPendingMq, type MqMessage } from "../core/dispatch/mq";
import { attachmentsIn, bindAttachments, stripAttachments, withAttachmentLines } from "../core/message/attachments";
import { attachmentsOfMessage } from "../core/message/messages";
import { isTerminal } from "../core/record/dispatchState";
import { taskNoOfDispatchId, titleSimilarity } from "../core/record/tasks";
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
} from "../core/dispatch/preempt";
import { autoRebuild } from "../core/dispatch/rebuildTree";
import { commitDispatch, composeDispatch, deriveDispatch } from "../core/dispatch/newDispatch";
import { applyGroupDecl, groupIndexFrom } from "../core/dispatch/groupOps";
import { applyInsertNow } from "./loop/restructure";
import { findBusyDuplicate } from "./loop/dedupe";
import { resolveDispatchRef, resolveParentTokens } from "./loop/refs";
import { resolveSupersede } from "./loop/supersede";
import { isReady } from "../core/dispatch/deps";
import { pinnedModelOf } from "../core/dispatch/pinModel";
import {
  allDirs,
  workers as workersLoc,
  model as modelLoc,
  ledger as ledgerLoc,
  inbox as inboxLoc,
  runtime as runtimeLoc,
} from "../core/record/locations";
import { markQuotaExhausted } from "../core/guard/quota";
import { loadState, updateState } from "../core/record/state";
import {
  activeDispatches,
  claimDispatch,
  clearStopFlag,
  compareQueueOrder,
  dependenciesSettled,
  descendantsOf,
  dispatchForest,
  dispatchPath,
  dispatchPaused,
  finishDispatch,
  frontDispatch,
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
  pidAlive,
  prerequisitesOf,
  pruneWorkers,
  patchDispatch,
  readDispatches,
  wakeDispatch,
  releaseWorkerNo,
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
} from "../core/record/supervisor";
import type { TaskState } from "../core/types";
import { disposeAll, registerDisposer, __resetDisposers } from "./dispose";
import {
  markSupervisorDirective,
  pendingSupervisorDirectives,
  CAPITALIST_ACTIONS,
  type SupervisorDirective,
  type SupervisorResult,
} from "./channel/direct";
import { applyResumePlan, beginReload, notePolicyChange, shouldAutoReload } from "./context/reload";
import { reapOrphans } from "./worker/reapOrphans";
import { ensureGuard, stopGuard } from "./worker/guard";
import { laneOfWorker, recordLaneUsage } from "./judge/sessionLane";
import { TITLE_MAX_CHARS, shardTitle, taskTitle } from "./usage/taskTitle";
import { amendTargetOf, dispatchNoTable, dispatchOfThreadNo } from "./usage/threadNo";
import { dispatchNoLabel as dispatchDisplayLabel, taskNoLabel } from "../core/record/idMap";
import { isGroupRef } from "../core/record/nodeRef";
import { isUserMsgDirection, msgDirection, msgId } from "../core/message/msgId";
import { decide } from "./judge/brain";
import { brainSessionOf } from "./judge/brainLane";
import { deniedModelsUsed, resolveModel } from "./judge/modelPolicy";
import { triage, worthTriaging, type TriageVerdict } from "./judge/triage";
import { workspaceFacts } from "./context/workspaceFacts";
import { workerUsage } from "./usage/usage";
import { ensureRoot } from "./bootstrap/root";
import { createStatusReporter } from "./statusLine";
import { reopenSettledDispatch } from "./reopenDispatch";
import { reopenOneByRef } from "./reopenOne";
import { isLogNoise, tailWithinChars, withoutThinking } from "./worker/workerLog";
import { killTree, sleepSync, waitExit } from "./worker/terminate";
import {
  actionTail,
  BLOCKER_MARKER,
  blockerLines,
  buildSkipBlocker,
  detectWorkerHost,
  findPreviousBlocker,
  launchWorker,
  openVisibleWorker,
  workerImpl,
  type WorkerHost,
} from "./worker/worker";
import { officialAccessToken, tokenInjectionEnabled } from "./channel/officialToken";
import type { Served, ServeOptions } from "./board";
import { skillDirs } from "../agent/locations";
import { currentHost, siblings, workerHosts } from "../agent/registry";
import { supervisorModelOf } from "./judge/supervisorModel";

/**
 * 运行期细节默认不输出到控制台：控制台只保留状态行（running 及随后的停派原因）。逐条追踪用 `--verbose` 或 `CAPITALIST_VERBOSE=1`。
 *
 * 事件本身照常落台账与日志文件，这里只负责终端。
 */
function detail(s: string): void {
  if (process.env.CAPITALIST_VERBOSE !== "1") return;
  process.stdout.write(`${s}\n`);
}

/**
 * 监工进程的启动参数。
 * 除 `root` 必填（指向任务根）外，其余字段可省，取本文件常量与 `detectWorkerHost` 的默认值。
 */
export interface SupervisorOptions {
  root: string;
  /**
   * 宿主令牌（`supervise` 启动时由插件读取宿主登录态取得）。只在进程内存持有，不写文件。
   *
   * 读取失败不报错，返回空值，此后工作进程与对话通道均报“登录状态失效”。取不到时提示
   * 用户重启监工，在访问询问里选择“本次会话内始终允许”。
   */
  token?: string | undefined;
  target?: string | undefined;
  policySpec?: string | undefined;
  tickSec?: number | undefined;
  workerTimeoutSec?: number | undefined;
  /**
   * 卡点观察窗口（秒，CLI `--stuck-sec`，环境变量 `CAPITALIST_STUCK_SEC`）。
   * 心跳与日志都超过该窗口未更新才判为卡点，任一在窗口内更新即视为存活；缺省 300 秒，须小于心跳超时。
   */
  stuckSec?: number | undefined;
  /** 并行度上限；实际能开几个还受在途派单与卡点影响 */
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
   * 打印运行细节（CLI `--verbose`，环境变量 `CAPITALIST_VERBOSE=1`）。
   *
   * 默认只输出看板地址、一行运行状态与错误：启动参数、守护进程、守卫热加载这类
   * 运维细节不进终端，需要时用 `capitalist status` 或加 --verbose 查看。
   */
  verbose?: boolean | undefined;
  /**
   * 监工对话上下文的配置上限（CLI `--capitalist-context`，token）。
   *
   * 生效值取该值与当前模型实际上限中的较小者；不传时按
   * {@link DEFAULT_SUPERVISOR_CONTEXT_LIMIT}。超限自动重载的阈值按生效值算。
   */
  supervisorContextLimit?: number | undefined;
  /** 自定义工作进程启动命令模板（含 {prompt}），用于没有标准 CLI 的宿主。 */
  workerCmd?: string | undefined;
  /**
   * 以独立控制台窗口启动工作进程（可见模式）。可见模式不写心跳，监工不按心跳判定失败。
   */
  workerVisible?: boolean;
  /** 只跑一个调度轮次，用于自检与 cron */
  once?: boolean;
  /** 测试用：跑满 N 个调度轮次就退出 */
  maxTicks?: number;
  /** 已有监工运行中时仍强制启动，取代旧实例。 */
  force?: boolean;
  /**
   * 是否由监工拉起工作进程。关闭时监工只派单，工作进程由外部会话用 `capitalist next` 领取；
   * 没有非交互入口的宿主无法拉起工作进程，强行拉起只会留下未启动记录。
   */
  spawnWorkers?: boolean | undefined;
  /**
   * 是否允许监工往宿主配置里装 hook（非 Windows 缺省为 true；Windows 需显式 `--with-hooks`）。
   * 工作进程的心跳续写与守卫红线拦截依赖 hook，故启用时主循环会周期补装。
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
   * 缺省取环境变量 `CAPITALIST_BOARD_RELOAD_QUIET_MS`，再取 {@link DEFAULT_BOARD_RELOAD_QUIET_MS}。
   */
  boardQuietMs?: number | undefined;
  /**
   * 两次看板重启的最小间隔（毫秒）。
   *
   * 缺省取环境变量 `CAPITALIST_BOARD_RELOAD_MIN_GAP_MS`，再取 {@link DEFAULT_BOARD_RELOAD_MIN_GAP_MS}。
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

/** 校验推理强度；非法值在启动时挡下并回报，不往 CLI 传。 */
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
 * 卡死判定窗口：连续多少个调度轮次无在途进展即报 stall。
 * 12 轮调度（默认每轮调度 5 秒，约一分钟）足以区分执行中的长任务与不会再返回的派单。
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
  /** 宿主令牌，启动监工时传入；空表示回退读取登录态文件。 */
  token?: string | undefined;
}
/**
 * 失败分片按指数退避间隔重派，避免每轮调度都拉起新进程；连续失败到 {@link REDISPATCH_LIMIT} 停止并转 ask。
 * `CAPITALIST_RETRY_DELAYS_MS`（逗号分隔，毫秒）可整段替换阶梯，用于把间隔压到毫秒级做自动化验证；
 * 未给时按基数 × 倍数生成：`CAPITALIST_RETRY_BASE_MS`（缺省 60000）、
 * `CAPITALIST_RETRY_FACTOR`（缺省 2，须大于 1），单次封顶 `CAPITALIST_RETRY_MAX_MS`（缺省 240000）。
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
  const base = envNumber("CAPITALIST_RETRY_BASE_MS", DEFAULT_RETRY_BASE_MS);
  const rawFactor = envNumber("CAPITALIST_RETRY_FACTOR", DEFAULT_RETRY_FACTOR);
  const factor = rawFactor > 1 ? rawFactor : DEFAULT_RETRY_FACTOR;
  const ceiling = Math.max(base, envNumber("CAPITALIST_RETRY_MAX_MS", DEFAULT_RETRY_MAX_MS));
  const ladder: number[] = [];
  /* 上限封顶后阶梯长度有限；32 级只是防御 factor 极接近 1 时算不完。 */
  for (let i = 0; i < 32; i += 1) {
    const v = Math.round(base * factor ** i);
    if (!Number.isFinite(v) || v <= 0) break;
    if (v >= ceiling) {
      ladder.push(ceiling);
      return ladder;
    }
    ladder.push(v);
  }
  if (ladder.length === 0) ladder.push(ceiling);
  return ladder;
}
const DEFAULT_RETRY_BASE_MS = 60_000;
const DEFAULT_RETRY_FACTOR = 2;
const DEFAULT_RETRY_MAX_MS = 240_000;

/** 读一个非负毫秒/倍数配置；缺失或非法回落缺省值。 */
function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 抖动比例：`CAPITALIST_RETRY_JITTER`（0~1，缺省 0.2）。它把同时到期的重派在本地错峰，
 * 不改变阶梯的单调递增与上限。
 */
function retryJitterRatio(): number {
  const n = envNumber("CAPITALIST_RETRY_JITTER", DEFAULT_RETRY_JITTER);
  return n > 1 ? 1 : n;
}
const DEFAULT_RETRY_JITTER = 0.2;

/**
 * 工作进程退出时判定这一单的失败原因。code 非 0 为常规崩溃；code 0 且无产出时按日志末尾
 * 判定，上游返回 429 时命中配额文案。不携带上游原文，账号链接、request-id 与会话 id 只留在日志。
 * 判定在 `channel/fault.ts` 的 `judgeFault("log", …)`，本函数只做文案映射。
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
  if (!body) return "工作进程没有输出就退出";
  const kind = judgeFault("log", body);
  if (kind === "quota") return QUOTA_EXHAUSTED_TEXT;
  /* 登录态不可用：进程以 code 0 退出，仅模型调用被拒，与静默退出区分。 */
  if (kind === "auth") return AUTH_REQUIRED_TEXT;
  return `worker 进程退出（code 0）`;
}

/**
 * 判定失败结束，并把是否重试交给模型裁决。
 * 结束时写 `retry_verdict: "pending"`，调度层见 pending 不派；附重试历史次数与卡点，
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
   * 登录态不可用时不进入重试裁决：裁决需调用模型，同一登录态下同样失败，否则会被当成可重试通道反复重派。这里直接判定失败。
   */
  if (note === AUTH_REQUIRED_TEXT) {
    markChannelDown(root, AUTH_REQUIRED_TEXT);
    const ok = finishDispatch(root, d.id, "failed", note);
    if (!ok) return false;
    patchDispatch(root, d.id, { retry_verdict: "give_up", retry_why: note } as Partial<Dispatch>);
    recordEvent(root, "dispatch_auth_blocked", {
      dispatch: d.id,
      shard: d.shard ?? "",
    });
    /* 输出走调用方给的通道：监工日志与测试收集器只在这一处接入。 */
    out(`[监工] 派单 ${d.id} 判定失败：${AUTH_REQUIRED_TEXT}，不重派`);
    return true;
  }

  /* 非登录态的失败说明进程已启动，通道可用：清掉上一条不可用记录。 */
  markChannelUp(root);
  const chainKey = String((d as DispatchEx).lineage ?? d.id);
  const chain = readDispatches(root).filter((x) => String((x as DispatchEx).lineage ?? x.id) === chainKey);
  const attempts = chain.filter((x) => x.status === "failed").length + 1;
  const ok = finishDispatch(root, d.id, "failed", note);
  if (!ok) return false;
  patchDispatch(root, d.id, { retry_verdict: "pending", retry_count: attempts } as Partial<Dispatch>);
  /*
   * 同一类卡点第二次出现时沉淀为持久记忆，落在 `.capitalist/config/memory.json`，重启仍生效，
   * 后续派单与判定时作为硬约束注入。
   */
  if (attempts >= 2) rememberLesson(root, note, d.id);
  enqueueRetryJudgement(root, { ...d, note }, chain, attempts, detail);
  /* `failDispatchAndJudge` 是所有判定失败路径的唯一出口，失败沿树传导只在此触发。 */
  if (attempts >= REDISPATCH_LIMIT) cascadeFailure(root, { ...d, note }, attempts, detail);
  return true;
}

/**
 * 父节点重派到上限后，整棵子树一并判为失败。监工随后诊断父节点的失败原因；无法处理时转人工检查。
 * 顺序固定：先停进程（让工作进程退出回调看到终态 `failed`，不二次结束），再写 `failed` 与
 * `retry_verdict: "give_up"`（否则 `requeueAdhoc` 会重新拉起整棵子树），最后记事件标明断裂的祖先。
 * `done` / `closed` 的子孙不动。
 * @returns 被级联判定失败的节点 id（没有子树、或子树已全部收工时为空）。
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

  /* 停掉运行中的子孙；可见窗口不受监工管理，由 killJudgedWorker 内部排除。 */
  const stopped: string[] = [];
  for (const id of victims) {
    const wid = String(byId.get(id)?.worker ?? "");
    if (!wid) continue;
    const w = loadWorker(root, wid);
    if (!w) continue;
    if (w.status !== "running" && w.status !== "starting") continue;
    killJudgedWorker(root, w, true, detail);
    saveWorker(root, { ...w, status: "failed" });
    stopped.push(w.id);
  }

  /* 判定失败并禁止重试。 */
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
    shard: failed.shard ?? "",
    attempts,
    limit: REDISPATCH_LIMIT,
    nodes: victims,
    stopped_workers: stopped,
  });
  detail(
    `[监工] ${failed.id} 连续失败 ${attempts} 次（上限 ${REDISPATCH_LIMIT}）：` +
      `子树 ${victims.length} 个节点级联判为失败、不再重试` +
      `${stopped.length > 0 ? `；已停止运行中的进程 ${stopped.join("、")}` : ""}`,
  );

  /* 诊断父节点失败原因，见 handleBrokenParent。 */
  handleBrokenParent(root, failed, attempts, victims, detail);
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
  /** 命中的日志原文片段，或“没有可读日志”。 */
  evidence: string;
  /** 供展示的结论。 */
  summary: string;
}

/**
 * 判定失败原因的规则表。此步位于 `failDispatchAndJudge` 的同步路径上，调模型会拖住整个调度轮次，
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
    summary: "被拒（权限或凭证）：监工无法自行处理，需人工确认账号、凭证或授权范围",
  },
  {
    /*
     * 429、过载、额度类错误重试后原样失败，`fixable=false` 不自动重置；配合
     * `enqueueRetryJudgement` 的短路，第一次失败即 hold 并通知。
     * 429 须带协议上下文：日志整段是 JSON，裸数字会命中 token 数与耗时。
     */
    cause: "model_down",
    re: /rate[ _-]?limit|too many requests|overloaded|\b529\b|服务过载|请求过于频繁|insufficient|余额不足|额度(?:已)?(?:用尽|用完|耗尽|不足)|quota|(?:http|status|code|error|response)[^\n]{0,24}\b429\b/i,
    fixable: false,
    summary: "模型额度不可用（耗尽、限流或过载）：额度恢复后重开这一单再重派",
  },
  {
    cause: "proxy",
    re: /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|EPIPE|\b50[234]\b|proxy|网络中断|连接被重置/i,
    fixable: true,
    summary: "代理或网络中断：等网络恢复后重新执行",
  },
  {
    cause: "env",
    re: /ENOENT|EACCES|EADDRINUSE|EBUSY|EPERM|ENOSPC|cannot find module|端口.{0,4}占用|磁盘空间/i,
    fixable: true,
    summary: "缺少运行条件（文件、端口或权限）：补齐本地条件后重新执行",
  },
];

/**
 * 读工作进程日志尾部若干行，取不到返回空串（进程被强杀时日志可能不存在）。
 * 取 200 行 / 24KB 而非更小的窗口，避免前部的 429 额度说明被截断而误判为可重试。
 */
function workerLogTail(root: string, worker: string, lines = 200): string {
  if (!worker) return "";
  try {
    const raw = readFileSync(workersLoc.output(root, worker), "utf8");
    /* 先剥纯思考行再截窗口：思考 JSON 单行很长，不过滤会占满窗口把 429 说明切掉。 */
    const clean = withoutThinking(raw.split(/\r?\n/).filter((l) => l.trim()));
    return clean.lines.slice(-lines).join("\n").slice(-24000);
  } catch {
    return "";
  }
}

/**
 * 诊断失败到上限的父节点：读日志尾部按规则认原因，只判“该原因能否由监工处理”。
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

/** 子树按“可修原因”自动重置的上限；超过后转人工，避免无限重试。 */
const CASCADE_AUTO_RESET_MAX = 1;

/**
 * 父节点失败到上限后由监工接手：原因可处理时重新执行子树（父节点开一张继承派生链的后续单，子节点原地重开），即换会话或换时机；无法处理（被拒、无法识别或已自动重置过）时登记待裁决问题并标阻塞。级联失败无人接手会变成静默失败。
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
    escalateCascade(root, failed, dg, dg.summary, detail);
    return;
  }

  const resets = Number((failed as DispatchEx).cascade_resets ?? 0);
  if (resets >= CASCADE_AUTO_RESET_MAX) {
    escalateCascade(
      root,
      failed,
      dg,
      `${dg.summary}；但这棵子树已自动重置过 ${resets} 次仍然失败，说明原因判断不成立`,
      detail,
    );
    return;
  }

  resetSubtree(root, failed, victims, dg, resets + 1, detail);
}

/**
 * 重置子树重跑：父节点开一张后续单，子孙原地重开。
 * 父节点的失败历史须留在台账（`attempt` / `retry_count` 为判断依据），故另起新记录、派生链不变；
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
  const issued = issueDispatchId(root, failed.id);
  if (!issued.id) {
    detail(`[监工] 子树重置未执行：${issued.error?.message ?? "取号锁被占用"}`);
    return;
  }
  const nextId = issued.id;
  const next = deriveDispatch(failed, {
    id: nextId,
    shard: failed.shard ?? "",
    action: stripAttachments(String(failed.action ?? "")),
    source: "requeue",
    attempt: Number(failed.attempt ?? 1) + 1,
    lineage: String(de.lineage ?? failed.id),
    atts: [],
    cascadeResets: resets,
    /* 继承树边、标题、标签、模型与多前置，不继承 role。 */
    keys: ["tree", "title", "tags", "model", "after"],
  });
  commitDispatch(root, next);

  for (const id of victims) {
    const r = readDispatches(root).find((x) => x.id === id);
    if (!r || r.status !== "failed") continue;
    const linked = String(r.parent ?? "") === "" || String(r.parent ?? "") === failed.id;
    patchDispatch(root, id, {
      status: "open",
      retry_verdict: "retry",
      retry_why: `子树重置后重跑（源 ${failed.id} -> ${nextId}）：${dg.summary}`,
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
  detail(
    `[监工] ${failed.id} 的失败原因可修（${dg.cause}：${dg.summary}）：` +
      `重置子树重跑 -> ${nextId}（第 ${resets} 次自动重置），子树 ${victims.length} 个节点重开`,
  );
}

/**
 * 转人工须同时登记待裁决问题与阻塞：`capitalist ask` 让问题可见，`capitalist block` 让调度停下。只用 ask，问题超时后会被宽限放过；只用 block，看不到停机原因。
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
    retry_why: `子树已级联判定失败，转人工：${why}`,
  } as Partial<Dispatch>);

  const marker = `级联失败 ${failed.id}`;
  if (!openAsks(root).some((q) => askText(q).includes(marker))) {
    raiseAsk(
      root,
      `${marker}：${why}。该子树已全部判为失败并停止，需要人工决定重跑还是放弃`,
      [
        `失败的节点：${failed.id}（${String((failed as DispatchEx).title ?? "").slice(0, 40)}）`,
        `连续失败 ${Number(failed.retry_count ?? 0) || "?"} 次后级联判定失败`,
        `诊断原因：${dg.cause}｜${dg.summary}`,
        `判断依据：${dg.evidence.slice(0, 400)}`,
        "处置：确认原因后执行 capitalist answer 回答本问题；需要重新执行时在回答后重开该节点并写明原因",
      ].join("\n"),
      "" /* 整根级：父节点失败后，该树上的单不再自动推进。 */,
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
  detail(`[监工] ${failed.id} 的失败原因无法处理（${dg.cause}：${why}）：已登记待裁决并标阻塞，等人工检查`);
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
        shard: d.shard ?? "",
        attempts,
        why: `${dg.summary}｜${dg.evidence}`,
      });
      detail(`[监工] 第 ${attempts} 次失败命中不可自愈原因（${dg.cause}）：${dg.summary}`);
      detail(`[监工] 暂不重派。原因消除后重开这一单：capitalist retry ${d.id}`);
      return;
    }
    const verdict = await judgeRetry(root, d, chain, attempts);
    if (verdict.decision === "hold") {
      /* 卡点未消除时记 hold，调度层见 hold 不派，理由写入 `retry_why`；卡点解除后可改回 retry。 */
      patchDispatch(root, d.id, { retry_verdict: "hold", retry_why: verdict.why } as Partial<Dispatch>);
      recordEvent(root, "retry_held", {
        dispatch: d.id,
        shard: d.shard ?? "",
        attempts,
        why: verdict.why,
        fallback: verdict.fallback === true,
      });
      detail(`[监工] 核对卡点未消除，暂不重派（第 ${attempts} 次失败后）：${verdict.why}`);
      return;
    }
    if (verdict.decision === "give_up") {
      patchDispatch(root, d.id, { retry_verdict: "give_up", retry_why: verdict.why } as Partial<Dispatch>);
      recordEvent(root, "retry_refused", {
        dispatch: d.id,
        shard: d.shard ?? "",
        attempts,
        why: verdict.why,
        fallback: verdict.fallback === true,
      });
      detail(`[监工] 判定不再重试（第 ${attempts} 次失败后）：${verdict.why}`);
      return;
    }
    patchDispatch(root, d.id, { retry_verdict: "retry", retry_why: verdict.why } as Partial<Dispatch>);
    recordEvent(root, "retry_allowed", {
      dispatch: d.id,
      shard: d.shard ?? "",
      attempts,
      why: verdict.why,
      fallback: verdict.fallback === true,
    });
    detail(`[监工] 判定可重试（第 ${attempts} 次失败）：${verdict.why}`);
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
    `本单任务：${String(d.action ?? "").replace(/\s+/g, " ").slice(0, 700)}`,
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
    facts.push(`第 ${i + 1} 次：${note}${dur !== null ? `（该进程运行了 ${dur} 秒）` : ""}`);
  });
  const wid = String(d.worker ?? "");
  if (wid) {
    try {
      const raw = readFileSync(workersLoc.output(root, wid), "utf8");
      /* 须先过滤全量思考 JSON 再取尾部：思考行单行很长，先取尾部会把真正的报错挤出字符预算。 */
      const clean = withoutThinking(raw.split(/\r?\n/).filter((l) => l.trim()));
      const tail = tailWithinChars(clean.lines, 1800);
      facts.push(
        `进程退出前日志的末尾部分${clean.dropped ? `（另有 ${clean.dropped} 行思考过程，已略去）` : ""}：\n${tail}`,
      );
    } catch {
      facts.push("进程退出前未留下可读日志（进程被强制终止或启动即失败）");
    }
  }
  /* 历史卡点记忆作为“卡点是否消除”的核对输入。 */
  const lessons = memoriesFor(root, String(d.action ?? "")).slice(0, 5);
  if (lessons.length) facts.push(renderMemoryConstraints(lessons));

  const r = await decide({
    root,
    question: "是否重试本单？先核对上一轮卡点（失败原因、阻塞项）是否已消除，再作判定。",
    facts,
    actions: [
      {
        name: "retry",
        desc: "重试：卡点已消除，或失败由临时条件导致（环境瞬时波动、端口/文件被临时占用、并发冲突、外部服务超时）",
      },
      {
        name: "give_up",
        desc: "不再重试：重试结果相同（缺权限或依赖、要求无法实现、方案方向有误）",
      },
      {
        name: "hold",
        desc: "暂不重派：上一轮的卡点核对后仍未消除（依赖仍缺失、前置单未完成或同一处报错未修），重派仍会在同一处失败",
      },
    ],
    session: "capitalist-brain-retry",
  });

  if (r.fallback) {
    /*
     * 判定通道自身登录态不可用时按判定失败处理：同一登录态下裁决不可恢复，重派结果相同。
     * 其余通道故障（超时、解析失败）仍按可重试处理。
     */
    if (judgeFault("diag", String(r.error ?? "")) === "auth") {
      return { decision: "give_up", why: AUTH_REQUIRED_TEXT, fallback: true };
    }
    /* 通道不可用时按可重试处理。 */
    return { decision: "retry", why: "判定通道不可用，按可重试处理", fallback: true };
  }
  const give = r.actions.find((a) => a.name === "give_up");
  const hold = r.actions.find((a) => a.name === "hold");
  const why = String(r.actions[0]?.why ?? "").slice(0, 200) || "（模型未给出理由）";
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
 * {@link REDISPATCH_LIMIT} 到达后仍继续派并升级诊断，以区分偶发失败与守卫本身无法完成。
 */
const HARD_STOP_FAILURES = 8;

/* `ASK_BLOCK_MS` 定义在 core/guard/limits.ts，`capitalist report` 的结束判断共用，避免两处数值分叉。 */

/** 派单上的扩展字段（不并入核心类型定义，运行时落盘）。 */
interface DispatchEx extends Dispatch {
  /** 这一单的中文标题；建单时写入，老记录读侧按分片映射补齐。 */
  title?: string;
  model?: string;
  model_fallback?: string;
  model_fallback_used?: boolean;
  required?: boolean;
  /** 最近一次被用户消息唤醒的时间（ISO）。全局暂停期间每轮补标记时跳过该单。 */
  wake_at?: string;
  /** 卡死检测强制结束的标记；表示已确认进程不再推进，不占重派退避窗口，失败计数与重派上限照常。 */
  forced?: boolean;
}

/**
 * 看板服务的类型别名（`serveBoard` 的签名）。
 * `board/routes/chat.ts` 反向引用本文件的 pause 读取，静态 import 会成初始化环，故运行时再 `import()`，此处只用类型。
 */
type ServeFn = (opts: ServeOptions) => Promise<Served>;

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
 * 并行度说明。上限由用户设定，不与分片数取小，故只报当前上限。
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
 * `dist/core` 下全部 `.js` 的内容指纹（sha1），用于判断本次构建是否改动 core；core 已分目录，必须递归。
 * 热重载只换 `dist/supervisor` 下的模块，不换 `dist/core`（共享可变状态），故 core 一变就必须完整重启。
 * 按内容而非 mtime 判断：tsc 每次构建重写全部产物，mtime 必变，按 mtime 会禁止所有热重载。
 * @returns 目录读不到时返回 null，按“无法判断”处理，不阻断热重载。
 */
export function coreContentHash(): string | null {
  const dir = join(__dirname, "..", "core");
  let names: string[];
  try {
    names = readdirSync(dir, { recursive: true }).map(String).filter((n) => n.endsWith(".js")).sort();
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
 * 建立任务根（`root` 下没有 `.capitalist` 时按守卫新建），随后按调度循环派单与验收。
 * 返回值是进程退出码：0 表示正常结束（`once` 完成、达到 `maxTicks`、或收到停止请求），
 * 非 0 表示启动失败。
 *
 * 失败情形：任务根不可写或守卫文件缺失时抛异常；`once` 与 `maxTicks` 都未给时不会自行
 * 退出，需要外部发停止请求或收到 SIGTERM。
 */
export async function runSupervisor(opts: SupervisorOptions): Promise<number> {
  const out = opts.out ?? ((s: string) => process.stdout.write(`${s}\n`));
  /*
   * 终端分两级：`out` 报用户要知道的事（看板地址、状态、错误），`detail` 报运行细节。
   * 细节默认不打印：启动时十几行参数会把真正要看的一行状态挤到屏幕外。
   */
  const verbose = opts.verbose ?? process.env.CAPITALIST_VERBOSE === "1";
  const detail = (s: string): void => {
    if (verbose) out(s);
  };
  const tickSec = opts.tickSec ?? DEFAULT_TICK;
  const workerTimeoutSec = opts.workerTimeoutSec ?? DEFAULT_WORKER_TIMEOUT;
  const stuckSec = normalizeStuckSec(opts.stuckSec ?? process.env.CAPITALIST_STUCK_SEC ?? DEFAULT_STUCK_SEC);

  const spawnWorkers = opts.spawnWorkers !== false;
  // 退出清理表是模块级单例，复位以免同进程内重复调用时沿用上一轮的“已清理”标记。
  __resetDisposers();
  const host = opts.workerHost ?? detectWorkerHost();
  if (spawnWorkers && !host && !opts.workerCmd) {
    /*
     * 工作进程仅从当前宿主所属的产品族中选取。跨族选用会借用另一个产品线的登录态，
     * 表现是“界面显示已登录、派单却报 Authentication required”。
     */
    const cur = currentHost();
    const scope = cur ? siblings(cur) : workerHosts();
    const options = scope
      .filter((impl) => impl.worker?.detectPriority !== undefined)
      .map((impl) => impl.worker?.key ?? impl.id);
    const curLabel = byId(cur)?.label ?? cur ?? t("unjudged", "未判定");
    detail(
      options.length
        ? t(`[supervisor] no worker entry found among the family of host ${curLabel}; one of these is required: ${options.join(" / ")}.`, `[监工] 当前宿主 ${curLabel} 的同族中未找到可用的工作进程入口：需要下列之一：${options.join(" / ")}。`)
        : t(`[supervisor] host ${curLabel} has no family worker entry and will not cross families: CLIs of other products do not share login state.`, `[监工] 当前宿主 ${curLabel} 没有同族的工作进程入口，且不跨族选用工作进程：其他产品族的 CLI 不共用登录态。`),
    );
    out(t("[supervisor] Install a family CLI and retry, or pass --worker-cmd with the start command.", "[监工] 安装同族 CLI 后重试，或用 --worker-cmd 给出启动命令。"));
    out(t("[supervisor] Or use --no-spawn: the supervisor only dispatches; another session claims work with capitalist next.", "[监工] 也可以改用 --no-spawn：监工只派单，由另一个会话 capitalist next 领。"));
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
    detail(
      `[监工] --effort ${String(opts.workerEffort)} 不是合法档位（${EFFORT_LEVELS.join(" / ")}），改用 ${effort.value} 档。`,
    );
  }
  const wopts: WorkerSpawnOpts = {
    model: opts.workerModel,
    effort: effort.value,
    cmd: opts.workerCmd,
    visible: opts.workerVisible === true,
    token: opts.token,
  };

  /*
   * 令牌缺失只提示，不阻断：宿主登录态在部分环境下仍然可用，阻断会挡住正常启动。
   * 缺失的原因是启动命令读取登录态时授权被拒或超时。
   */
  if (spawnWorkers && !opts.token && tokenInjectionEnabled()) {
    const authVar = byId(chosenHost)?.worker?.authEnvVar;
    if (authVar && !officialAccessToken()) {
      detail(
        "[监工] 未取到宿主令牌：派单与对话会因登录状态失效中止。重新执行启动命令，在授权弹窗中选择“本次会话内始终允许”。",
      );
    }
  }

  // 实例租约 `.capitalist/locks/<task>.lock` 记录任务根持有者，检查先于 supervisor.json 的单实例检查。
  // 存活租约（进程在、心跳在窗口内）拒绝启动；--force 仅在持有者心跳超时后允许取代，
  // 取代前把旧实例标 superseded 并记事件。
  const leaseTask = leaseTaskName(opts.root);
  const prevLease = readLease(opts.root, leaseTask);
  /*
   * 持有者进程仍在即拒绝接管，不按心跳窗口判断：心跳超时可能只是该进程仍在执行一次长调用。同一任务根仅允许一个监工实例。
   * 需要强制接管时使用 --force。pid 已消失时按常规接管，并将旧租约标记为 superseded。
   */
  if (prevLease && prevLease.status === "running" && pidAlive(prevLease.pid) && !opts.force) {
    detail(
      t(
        `[supervisor] instance lease held: pid ${prevLease.pid}, started at ${prevLease.started_at} (.capitalist/locks/${leaseTask}.lock).`,
        `[监工] 任务根已有实例持有租约：pid ${prevLease.pid}，启动于 ${prevLease.started_at}（.capitalist/locks/${leaseTask}.lock）。`,
      ),
    );
    detail(
      t(
        "[supervisor] that process is still running; not taking over. To force a takeover: run capitalist supervise-stop first, or use --force.",
        "[监工] 该进程仍在运行，不接管。需要强制接管时：先执行 capitalist supervise-stop，或使用 --force。",
      ),
    );
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
    detail(
      t(
        `[supervisor] already running (pid ${existing.pid}, tick ${existing.ticks}). Before taking over: capitalist supervise-stop, or --force.`,
        `[监工] 已有监工在运行（pid ${existing.pid}，第 ${existing.ticks} 轮）。接管前执行 capitalist supervise-stop，或加 --force。`,
      ),
    );
    const liveBoard = String(existing.board_url ?? "").trim();
    if (liveBoard) out(t(`[supervisor] host: ${liveBoard}`, `[监工] 看板：${liveBoard}`));
    return 1;
  }
  clearStopFlag(opts.root);
  /* 重新启动即重新试一次：上次的通道不可用记录不应挡住本次启动。 */
  markChannelUp(opts.root);

  // 监工建根。执行侧不参与这一步。
  const boot = await ensureRoot(opts);
  if (!boot.ok) {
    out(boot.message);
    return 1;
  }
  if (boot.created) detail(t(`[supervisor] task root created: ${opts.root}`, `[监工] 已建任务根：${opts.root}`));

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
    detail(
      t(
        `[supervisor] previous instance ${prevLease.instance_id} (pid ${prevLease.pid}) heartbeat timed out; marked superseded and taking over`,
        `[监工] 旧实例 ${prevLease.instance_id}（pid ${prevLease.pid}）心跳已超时，标记 superseded 并接管`,
      ),
    );
  }
  writeLease(opts.root, leaseTask, myLease);

  // 部分宿主首次进入目录会停在信任确认，非交互模式下无输出且无法授权写文件；
  // 该前置条件由 impl 的 workspace facet 处理，无此 facet 的宿主不写项目配置。
  if (spawnWorkers) {
    const workspace = workerImpl(chosenHost)?.workspace;
    if (workspace) {
      const r = workspace.prepare(opts.root);
      if (r.added) out(t(`[supervisor] ${r.message}`, `[监工] ${r.message}`));
      else if (!r.ok)
        detail(
          t(
            `[supervisor] workspace not fully prepared (startup not affected, but the host may stop at a confirmation page): ${r.message}`,
            `[监工] 工作区准备未完成（不影响启动，但可能停在确认页）：${r.message}`,
          ),
        );
    }
  }

  const state0 = loadState(opts.root);
  const policy0 = state0
    ? loadPolicy(state0.policy_path) ?? loadPolicy(state0.policy, skillDirs())
    : null;
  if (!state0 || !policy0) {
    out(t("[supervisor] task root state or guard unreadable, exiting", "[监工] 任务根状态或守卫不可读，退出"));
    return 1;
  }

  /* 排空式停止的门闩只为“退出前别再派新单”，不该跨进程生效；先清掉再由启动分支重判。 */
  if (readPause(opts.root)?.by === "supervisor") resumeAll(opts.root, "startup");

  /*
   * 启动等同一次暂停调度：不派单、不改变执行流程，等用户恢复。
   *
   * 判据是“有没有未结派单”，不是“有没有待办”：任务未做完但一张单都没派时没有可冻结的对象，写暂停会让新任务根一启动就停在暂停状态，看板与日志都看不出它已在运行。
   * 有单则先停上次退出留下的存活进程，再写暂停与打标记；没有单时只清理孤儿进程。
   */
  const pendingWork0 = hasPendingWork(opts.root, state0);
  if (!pendingWork0) {
    detail("[监工] 无待办任务：待命在线（不派单、不轮询），等待派单");
  } else if (hasUnfinishedDispatches(opts.root)) {
    /* 崩溃退出时清理没走完，工作进程可能仍在跑；接管前先停，否则恢复后会双跑同一单。 */
    stopLiveWorkers(opts.root, detail);
    const paused = pauseAll(opts.root, "startup", "监工启动：调度暂停，恢复后按原状态继续");
    detail(
      t(
        `[supervisor] ${paused.marked} unfinished dispatches paused (running ${paused.origins.running}, retry-waiting ${paused.origins.retry}, queued ${paused.origins.queued}); resume from the board to continue them`,
        `[监工] ${paused.marked} 张未完成派单已暂停（运行中 ${paused.origins.running}、待重派 ${paused.origins.retry}、排队 ${paused.origins.queued}）。看板“恢复调度”按原状态继续。`,
      ),
    );
  } else {
    stopLiveWorkers(opts.root, detail);
    detail("[监工] 没有未完成的派单：不写暂停，按调度继续");
  }

  // 并行度上限只由用户设定（--workers 或运行时指令），不按分片数取小；命令行缺省取 3。
  const maxWorkers = Math.max(1, opts.workers ?? DEFAULT_WORKERS);
  // 不 spawn 时并行度记 0，使 fillSlots 直接返回，派单留在 open 等外部领取。
  const capacity0 = spawnWorkers ? maxWorkers : 0;
  /* 状态行：去重与首行“已启动”都在 statusLine 里，这里只负责每轮询问一次。 */
  const printStatus = createStatusReporter(opts.root, out);

  let rec: SupervisorRecord = {
    pid: process.pid,
    status: "running",
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    heartbeat_ts: Date.now() / 1000,
    target: state0.target,
    policy: policy0.name,
    tick_sec: tickSec,
    worker_timeout_sec: workerTimeoutSec,
    stuck_sec: stuckSec,
    ticks: 0,
    max_workers: capacity0,
    worker_host: spawnWorkers ? chosenHost : "none",
    /* 启动时的宿主声明落盘：重启后的看板与独立进程按同一份声明选凭证族与对话通道。 */
    ...(currentHost() ? { host: currentHost() as string } : {}),
    /* 只记令牌有无，供登录态检查判断监工通道；值不进文件。 */
    ...(opts.token ? { token_injected: true } : {}),
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

  detail(`[监工] 已接管 ${opts.root}`);
  /* 记忆按任务根存于 `.capitalist/config/memory.json`，启动时加载一次并裁掉过期 / 超限条目，不清空、不重置。 */
  const mem = primeMemory(opts.root);
  if (mem.length) {
    const habits = mem.filter((e) => e.kind === "habit").length;
    detail(`[监工] 记忆 ${mem.length} 条（习惯 ${habits} / 卡点 ${mem.length - habits}）已加载`);
  }
  detail(`[监工] 目标：${state0.target} ｜ 守卫：${policy0.name}（${policy0.domain || "未标注领域"}）`);
  detail(
    `[监工] 工作进程：${spawnWorkers ? `${chosenHost}（自动拉起）` : "外部会话 capitalist next 领单"} ｜ 并行 ${capacity0} 个`,
  );
  detail(`[监工] 每 ${tickSec} 秒检查一次；工作进程超过 ${workerTimeoutSec} 秒无进展即判为卡住。Ctrl-C 停止。`);
  if (spawnWorkers) {
    detail("[监工] 工作进程沿用宿主登录态，认证由宿主 CLI 完成");
    if (wopts.visible) detail("[监工] 启动方式：可见窗口（每个 worker 独占一个控制台，卡点直接可见）");
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
   * 加载看板产物并预检（清缓存 -> 重新 require -> 确认前端产物在位）；
   * 预检在关旧服务之前，挡住无法运行的新产物。
   */
  const loadBoardModule = async (): Promise<{ ok: true; serve: ServeFn } | { ok: false; message: string }> => {
    clearBoardModuleCache(__dirname, __filename);
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
   * `idle` 仍是“最多等 ms”，推送只决定响应快慢，消息以队列文件为准；推送丢失只放慢响应，消息不丢失。
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
      ...(opts.token ? { token: opts.token } : {}),
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
      out(t(`[supervisor] host not started: ${loaded.message}`, `[监工] 看板未启动：${loaded.message}`));
    } else {
      try {
        const served = await serveBoardNow(loaded.serve, true);
        out(t(`[supervisor] host ${served.url}`, `[监工] 看板 ${served.url}`));
        boardStamp = boardBuildStamp()?.stamp ?? null;
        /* 记下启动时的 core 指纹：热重载不换 core，core 变化须拦下热重载。 */
        coreHashAtBoot = coreContentHash();
      } catch (err) {
        // 端口占用、监听失败时监工照常运行，仅无看板。
        out(t(`[supervisor] host not started: ${errText(err)}`, `[监工] 看板未启动：${errText(err)}`));
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
      detail(
        t(
          "[supervisor] board not hot-reloaded: this build changed core; hot reload would pair the new board with the old core (API would 500). " +
            "The board keeps the version from startup; restart the supervisor to load the new one.",
          "[监工] 看板未热重载：本次构建改动了 core，热重载会得到“新版 board + 旧版 core”（接口会 500）。" +
            "看板继续用启动时那一版；重启监工后加载新版本。",
        ),
      );
      /* 该判断每轮调度命中，按 key 节流以免占满异常窗口；累计次数进 `repeat`。 */
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
      detail(
        t(
          `[supervisor] board not restarted on the new build; keeping the old version: ${loaded.message}`,
          `[监工] 看板未按新构建重启，继续用旧版：${loaded.message}`,
        ),
      );
      return;
    }
    const oldPort = boardRef.serving?.port ?? DEFAULT_BOARD_PORT;
    try {
      boardRef.serving?.close();
      boardRef.serving = null;
      const served = await serveBoardNow(loaded.serve, false);
      boardStamp = next.stamp;
      detail(
        t(
          `[supervisor] board restarted on the new build (port ${served.port})`,
          `[监工] 看板已按新构建重启（端口 ${served.port}）`,
        ),
      );
      recordEvent(opts.root, "board_reload", { from_port: oldPort, port: served.port, files: next.files });
    } catch (err) {
      const message = errText(err);
      boardStamp = next.stamp;
      // 新产物起不来：把旧版按原端口恢复。旧实现仍在 boardServe 中，清缓存只影响下次 require。
      const fallback = boardServe;
      if (fallback) {
        try {
          await serveBoardNow(fallback, false);
          detail(
            t(
              `[supervisor] board not restarted on the new build; keeping the old version (port ${boardRef.serving?.port ?? oldPort}): ${message}`,
              `[监工] 看板未按新构建重启，继续用旧版（端口 ${boardRef.serving?.port ?? oldPort}）：${message}`,
            ),
          );
          return;
        } catch {
          /* 旧版也恢复失败，走下面的统一失败提示。 */
        }
      }
      out(t(`[supervisor] host not started: ${message}`, `[监工] 看板未启动：${message}`));
    }
  };

  // 热加载状态：跨调度轮次保留上一份守卫，用于判变化与解析失败时回落。
  let hot: { file: string; mtimeMs: number; hash: string; policy: Policy } | null = null;
  // 需求层违规的拒绝签名，避免每个调度轮次重复 ask。
  let lastRefusalSig: string | null = null;
  /* 同一段守卫错误只报一次：随调度轮次重读会每几秒报一遍，台账与看板无法承受。 */
  let lastPolicyError: string | null = null;
  // 最近几个调度轮次的变更计数，用于“守卫本身不稳定”提示。
  let recentChangeTicks: number[] = [];
  // 面板调度指令 `concurrency` 的运行时覆盖值只活在本进程，重启后回到 --workers，不作为长期配置。
  let concurrencyOverride: number | null = null;

  let stopping = false;
  /** 连续几轮看不到看板在监听。看板重启期间 listening 会短暂为 false，够 3 轮才认下线。 */
  let boardDownTicks = 0;
  const onSignal = (): void => {
    stopping = true;
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  // 进程自然 exit（循环外的 return、未捕获分支）时也走同一 dispose；disposeAll 幂等，与 finally 不冲突。
  const onBeforeExit = (): void => {
    for (const f of disposeAll("beforeExit")) out(t(`[supervisor] exit cleanup failed: ${f}`, `[监工] 退出清理失败：${f}`));
  };
  process.on("beforeExit", onBeforeExit);

  // 退出清理表：看板端口与工作进程登记于此，各退出路径共用同一段收尾；只登记已创建的资源。
  registerDisposer("board", () => {
    boardRef.serving?.close();
    boardRef.serving = null;
  });
  registerDisposer("workers", () => {
    // `--once` 只跑一轮判定，工作进程须继续做完当前派单。
    if (!opts.once) terminateWorkers(opts.root, detail);
  });
  registerDisposer("guard", () => {
    /* 正常退出时停掉守护：工作进程已回收，守护继续运行会重复回收并写冗余记录。 */
    if (!opts.once) stopGuard(opts.root, process.pid);
  });

  // 清理原子写残留的 `*.tmp`（mtime 超过 10 分钟），不误删正在写的文件。
  // 清理按批封顶，未清完的留到下次启动。
  try {
    const pruned = pruneTempFiles(allDirs(opts.root));
    if (pruned.removed > 0) {
      detail(`[监工] 已清理 ${pruned.removed} 个原子写残留的临时文件`);
      if (pruned.truncated) {
        detail("[监工] 残留较多，本轮已清理部分；下次启动继续（不影响本轮派单）");
      }
    }
  } catch (err) {
    out(t(`[supervisor] failed to clean temp files (startup not affected): ${errText(err)}`, `[监工] 清理临时文件失败（不影响启动）：${errText(err)}`));
  }

  // 回收历史工作进程记录（每单一对 json + log），避免 listWorkers 与看板快照反复读取。
  // 规则见 pruneWorkers：运行中的不删、最近 50 条不删、24 小时内的不删。
  try {
    const prunedW = pruneWorkers(opts.root);
    if (prunedW.removed > 0) {
      detail(`[监工] 已回收 ${prunedW.removed} 条历史 worker 记录（保留 ${prunedW.kept} 条）`);
    }
  } catch (err) {
    out(t(`[supervisor] failed to prune worker records (startup not affected): ${errText(err)}`, `[监工] 回收 worker 记录失败（不影响启动）：${errText(err)}`));
  }

  // 进入调度循环前回收上一轮遗留的工作进程：被强杀的监工不执行信号处理器，detached 工作进程
  // 不会随父进程退出，故派单前先清孤儿，避免新旧进程处理同一单。归属不明的不处理。
  try {
    const reaped = reapOrphans(opts.root, detail);
    if (reaped.length > 0) {
      detail(`[监工] 启动清理：回收 ${reaped.length} 个上一轮遗留的 worker（事件 worker_reaped 已入台账）`);
    }
  } catch (err) {
    out(t(`[supervisor] failed to reap orphan processes (startup not affected): ${errText(err)}`, `[监工] 清理孤儿进程失败（不影响启动）：${errText(err)}`));
  }

  // 首个调度轮次前修复存量台账结构：重派与重试会给同一件事留下多行，`parent` 只在建单时写一次，
  // 会形成互不相连的根。未完工单超过一张且全无父节点时按正文归组重建（判据见 `looksFlat`），只跑一次。
  try {
    const rebuilt = autoRebuild(opts.root);
    if (rebuilt) {
      recordEvent(opts.root, "tree_rebuilt", { note: rebuilt });
      detail(`[监工] ${rebuilt}`);
    }
  } catch (err) {
    out(t(`[supervisor] failed to rebuild the dispatch tree (startup not affected): ${errText(err)}`, `[监工] 重建派单树失败（不影响启动）：${errText(err)}`));
  }

  // 起守护盯住本进程：硬杀（`taskkill /F`）不执行信号处理器，工作进程自检与启动清孤儿都覆盖不到。
  // 守护是脱离会话的 detached 进程，本进程消失后仍继续运行，发现监工 pid 不在即回收工作进程并退出。
  // `--once` 不拉守护，该模式不留工作进程。
  if (!opts.once) {
    try {
      const g = ensureGuard(opts.root);
      if (g.pid > 0) {
        detail(
          g.spawned
            ? `[监工] 已起守护进程（pid ${g.pid}）：本进程被强杀时由它回收工作进程`
            : `[监工] 守护进程已运行中（pid ${g.pid}），沿用`,
        );
      } else {
        detail(
          t(
            "[supervisor] guard daemon not started (entry path unknown): if this process is force killed, workers can only be reaped on the next startup",
            "[监工] 守护进程未启动（未取得入口路径）：强制终止本进程后工作进程只能等下次启动清理孤儿。",
          ),
        );
      }
    } catch (err) {
      out(t(`[supervisor] failed to start the guard daemon (startup not affected): ${errText(err)}`, `[监工] 启动守护进程失败（不影响启动）：${errText(err)}`));
    }
  }

  const limit = opts.once ? 1 : (opts.maxTicks ?? Number.POSITIVE_INFINITY);
  /** hook 自检的上次时间戳，节流用。声明在循环外，跨调度轮次保留。 */
  let lastHookHeal = 0;

  // 卡死检测状态，跨调度轮次保留。
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
  /** 上一轮的在途单数：由有到无即队列清空，据此写一次总结。启动时为 -1，不触发。 */
  let prevInFlight = -1;
  /** 总结走模型，耗时以十秒计；期间不再重复发起。 */
  let summaryRunning = false;

  try {
    for (let i = 0; i < limit; i += 1) {
      /*
       * 轮次开头先判断用户是否已经关掉。这一轮后面要写心跳与状态，
       * 放在写入之后检查会把删掉的目录重新建出来。
       */
      if (!existsSync(runtimeLoc.supervisor(opts.root))) {
        out(t("[supervisor] task root deleted, exiting", "[监工] 任务根已删除，退出"));
        break;
      }
      if (boardEnabled && boardRef.serving && !boardRef.serving.server.listening) {
        boardDownTicks += 1;
        if (boardDownTicks >= 3) {
          recordEvent(opts.root, "supervisor_stop", { by: "user", via: "board_down", reason: "看板已下线" });
          out(t("[supervisor] board is down, exiting", "[监工] 看板已下线，退出"));
          break;
        }
      } else {
        boardDownTicks = 0;
      }
      /*
       * ticks 统计实际执行调度的轮次，待命轮次不计。
       * 心跳每轮都刷，待命时进程也要能被判定为在线。
       */
      rec = { ...rec, heartbeat_at: new Date().toISOString(), heartbeat_ts: Date.now() / 1000 };
      /*
       * `rec` 是启动时的内存快照，看板通过 /api/capitalist-command 改的是磁盘 supervisor.json。
       * 每轮调度用内存快照整份写回会覆盖外部改的 supervisor_model，故只从磁盘同步该字段与上下文上限，
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
        /* 有在途任务时排空式停止：先停派单，等在途任务结束后再退；--force 立即退出。 */
        const live = listWorkers(opts.root).filter((w) => w.status === "running");
        if (live.length > 0 && !stopForced(opts.root)) {
          if (!readPause(opts.root)) {
            setPauseGate(opts.root, "supervisor", "停止请求：等待运行中的派单结束后退出", true);
            recordEvent(opts.root, "stop_pending", { running: live.map((w) => w.id) });
            detail(
              t(
                `[supervisor] stop requested: ${live.length} dispatch(es) still running (#${live
                  .map((w) => w.id)
                  .join(" #")}); dispatching halted, will exit when they finish. To exit now: capitalist supervise-stop --force`,
                `[监工] 收到停止请求：${live.length} 个派单仍在运行（#${live
                  .map((w) => w.id)
                  .join(" #")}），已停止派发；结束后自动退出。需立即退出，执行 capitalist supervise-stop --force`,
              ),
            );
          }
        } else {
          out(t("[supervisor] stop request received, exiting", "[监工] 收到停止请求，退出"));
          return 0;
        }
      }
      const disk = loadSupervisor(opts.root);
      if (disk && disk.status === "stopped") {
        out(t("[supervisor] stop request received, exiting", "[监工] 收到停止请求，退出"));
        return 0;
      }

      const state = loadState(opts.root);
      if (!state) {
        out(t("[supervisor] task root state unreadable, exiting", "[监工] 任务根状态不可读，退出"));
        return 1;
      }

      /*
       * 待命：任务已完工，没有任何在途环节。不评估门槛、不重读守卫、不派单、不记调度轮次，
       * 只刷新心跳与看板服务；进程保持在线，等待用户派单，不自行退出。
       * 面板指令仍需消费：用户点击“派单”时无其他调度方处理该派单。
       */
      if (!hasPendingWork(opts.root, state)) {
        if (!standby) {
          standby = true;
          detail("[监工] 无待办任务：待命在线（不派单、不轮询），等待派单");
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
            policy: hot?.policy ?? policy0,
            state,
            wopts,
            concurrency: concurrencyOverride, out: detail,
          });
        } finally {
          clearInterval(beat);
        }
        concurrencyOverride = standbyDirect.concurrency;
        /* 指令可能刚派了单：这一轮转回正常调度，不在下一轮调度才处理该派单。 */
        if (!hasPendingWork(opts.root, loadState(opts.root) ?? state)) {
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

      // 轮次记录进台账，供面板统计“过去 1 分钟 N 轮”；该数只能逐轮累加得出，
      // 心跳间隔在暂停与重载时不准。记录只含序号，不参与 FEED_EVENTS。
      recordEvent(opts.root, "supervisor_tick", { n: rec.ticks });

      /*
       * 暂停每轮补两件事：停掉仍在跑的进程、给尚未标记的单补标记（用户手写 pause.json 时
       * 没有标记）。恢复兜底同在此处：手工删除 pause.json 也能回到调度。
       */
      const pauseNow = readPause(opts.root);
      if (pauseNow) pauseRun(opts.root, pauseNow, detail);
      else resumeDanglingMarks(opts.root, "supervisor");

      // 收件箱自检：畸形记录不参与调度但要可见（同一批只报一次）；须排在 step 之前，两者读同一份台账。
      warnIgnoredInbox(opts.root, detail);

      // 守卫热加载：每轮调度重读，按 mtime 与哈希判变化。
      let reloaded;
      try {
        reloaded = reloadPolicy(state.policy, skillDirs(), hot ?? undefined, state.policy_path);
      } catch (e) {
        out(t(`[supervisor] failed to read the guard: ${String((e as Error).message ?? e)}`, `[监工] 守卫首读失败：${String((e as Error).message ?? e)}`));
        return 1;
      }

      let policy: Policy = reloaded.policy;

      if (reloaded.error) {
        // 解析失败时沿用上一份可用守卫；同一段错误只在首次出现时上报。
        if (reloaded.error !== lastPolicyError) {
          lastPolicyError = reloaded.error;
          recordEvent(opts.root, "policy_error", { error: reloaded.error, kept: reloaded.policy.name });
          detail(
            t(
              `[supervisor] failed to parse the guard; keeping the last usable one: ${reloaded.error}`,
              `[监工] 守卫解析失败，沿用上一份可用守卫：${reloaded.error}`,
            ),
          );
        }
        if (!hot) hot = { file: reloaded.file, mtimeMs: reloaded.mtimeMs, hash: reloaded.hash, policy };
      } else if (reloaded.changed) {
        lastPolicyError = null;
        if (hot) {
          const prevData = hot.policy.data;
          const nextData = reloaded.policy.data;
          // 守卫文件变更直接采用；红线被放宽只记不拦，放宽边界属于操作者的显式决定。
          const weakened = weakenedRedlines(prevData, nextData);
          recordEvent(opts.root, "policy_change", {
            reason: "守卫文件被修改",
            weakened,
          });
          savePrevPolicy(opts.root, prevData); // 保留上一版供回滚
          recordEvent(opts.root, "policy_reload", {
            file: reloaded.file,
            redlines: reloaded.next?.redlineCount,
          });
          detail(`[监工] 守卫文件热加载：${reloaded.file}`);
          if (weakened.length > 0) {
            detail(`[监工]   红线被放宽：${weakened.join("、")}。仅操作者主动放宽时可接受。`);
          }
          hot = { file: reloaded.file, mtimeMs: reloaded.mtimeMs, hash: reloaded.hash, policy: reloaded.policy };
          rec = { ...rec, policy: reloaded.policy.name };
          policy = reloaded.policy;
          // 同一轮调度内变更超过三次时提示守卫文件不稳定。
          recentChangeTicks.push(rec.ticks);
          recentChangeTicks = recentChangeTicks.filter((t) => rec.ticks - t <= 3);
          if (recentChangeTicks.length > 3) {
            recordEvent(opts.root, "policy_unstable", { changes_in_3_ticks: recentChangeTicks.length });
            detail(
              t(
                "[supervisor] more than 3 changes within 3 ticks; the guard file may be unstable",
                "[监工] 连续 3 轮调度内变更超过 3 次，守卫文件可能不稳定",
              ),
            );
          }
        } else {
          // 首读无上一版可比，直接采用并记 policy_reload。
          recordEvent(opts.root, "policy_reload", {
            file: reloaded.file,
            redlines: reloaded.next?.redlineCount,
          });
          detail(`[监工] 守卫文件热加载：${reloaded.file}`);
          hot = { file: reloaded.file, mtimeMs: reloaded.mtimeMs, hash: reloaded.hash, policy: reloaded.policy };
          rec = { ...rec, policy: reloaded.policy.name };
        }
      }

      // 面板调度指令每轮调度开头读一次，须排在并行度与 pause 读取之前，使 concurrency 与 pause/resume 本轮生效。
      const direct = await applySupervisorDirectives({
        root: opts.root,
        policy,
        state: loadState(opts.root) ?? state,
        wopts,
        concurrency: concurrencyOverride, out: detail,
      });
      concurrencyOverride = direct.concurrency;

      /* 并行度上限只取用户设定值（--workers 或 concurrency 运行时指令）。 */
      const capWanted = concurrencyOverride ?? maxWorkers;
      const capacity = spawnWorkers ? capWanted : 0;
      rec = { ...rec, max_workers: capacity };

      // hook 周期自检：工作进程心跳续写与守卫红线拦截依赖它；hook 缺失不报错，只表现为心跳停止增长、红线不再拦截。
      // settings.local.json 可能被 git clean、手工清理或换机 clone 后不存在，故不能只查启动时一次。
      // 补装受 `installHooks` 控制，避免 `--no-hooks` 下被循环写回；按 60 秒节流。
      if (spawnWorkers && opts.installHooks === true && Date.now() - lastHookHeal > 60_000) {
        lastHookHeal = Date.now();
        try {
          const { ensureHooks } = await import("../install/install");
          const healed = ensureHooks([chosenHost], opts.root);
          if (healed.installed.length > 0) {
            detail(`[监工] 已补装 hook：${healed.installed.join("、")}（hook 缺失时心跳无法续写）`);
          }
          for (const f of healed.failed) out(`[监工] hook 补装失败（${f.id}）：${f.message}`);
        } catch {
          /* 补装失败不阻断主循环。 */
        }
      }

      /* 顺序固定：先刷新会话占用，再回收进程，再按空闲并发名额派单；占用未落盘时闸门读到的是旧值。 */
      refreshLaneUsage(opts.root, readDispatches(opts.root));

      await reap(opts.root, workerTimeoutSec, detail, stuckSec);

      /* 消费申报排在 reap 之后：先确认已判定失败进程，再处理存活进程的申报，避免依据过期局面裁决。 */
      await consumeMq({
        root: opts.root,
        policy,
        state: loadState(opts.root) ?? state, out: detail,
      });

      /*
       * 权限申请排在申报之后：申请来自工作进程刚被拦下的动作，裁决前先确认该进程仍在运行。
       * 判定走监工的模型通道，不使用规则表。
       */
      {
        const { judgeGuardRequests } = await import("./guard/judge");
        await judgeGuardRequests({ root: opts.root, out: detail });
      }

      /* 待确认超时的单自动结束；须排在 reap 之后，reap 与 forceFinishHung 只处理 claimed，不会提前清理这些单。 */
      for (const rd of sweepReviews(opts.root)) {
        recordEvent(opts.root, "dispatch_review_timeout", {
          dispatch: rd.id,
          shard: rd.shard ?? "",
          worker: rd.worker ?? "",
        });
        detail(`[监工] 派单 ${rd.id}（${rd.shard || "整单"}）等待确认超时，自动结束`);
      }
      /* 上报后长期未裁决的单退回 open，由调度层重派。 */
      for (const rd of sweepReported(opts.root)) {
        recordEvent(opts.root, "dispatch_reported_stale", {
          dispatch: rd.id,
          shard: rd.shard ?? "",
        });
        detail(`[监工] 派单 ${rd.id}（${rd.shard || "整单"}）上报后无裁决，退回重派`);
      }

      // 暂停时不派新单；心跳、判定失败回收与已完成派单的结算照常。停派原因由状态行说明。
      const pause = readPause(opts.root);

      // 模型启动失败回退会补开新派单，暂停期间一并停掉。
      if (!pause) handleModelFallback(opts.root, policy, chosenHost, wopts, detail);
      /* 复验单须先入队，排在本轮调度的 step 之前，使在途状态挡住完成判定。 */
      /* 守卫文件被外部改动时按 mtime 留痕并播报。 */
      if (!pause) {
        const cc = notePolicyChange(opts.root);
        if (cc) {
          detail(
            t(
              `[supervisor] guard file changed (${cc.from.slice(0, 16).replace("T", " ")} -> ${cc.to.slice(0, 16).replace("T", " ")})` +
                `${cc.gap_hours === null ? "" : `, ${cc.gap_hours}h apart`}; reloaded with the new content`,
              `[监工] 守卫文件已更新（${cc.from.slice(0, 16).replace("T", " ")} -> ${cc.to.slice(0, 16).replace("T", " ")}` +
                `${cc.gap_hours === null ? "" : `，间隔 ${cc.gap_hours} 小时`}），已按新内容重读`,
            ),
          );
          recordEvent(opts.root, "policy_changed", { from: cc.from, to: cc.to, gap_hours: cc.gap_hours });
        }
      }
      if (!pause) applyResumePlan(opts.root, detail);
      /*
       * 上下文占比达阈值时自动重载，复用 capitalist reload 链路；暂停期间不触发。
       * 未完成条目按快照记录的原始下发顺序恢复，不按任务编号排序（编号表身份，不表次序）。
       */
      if (!pause) {
        const ctxCheck = shouldAutoReload(opts.root);
        if (ctxCheck.hit) {
          detail(`[监工] 对话上下文超限，自动重载：${ctxCheck.reason}`);
          try {
            /* holdSec 须覆盖看板轮询周期与接口缓存时长，否则“重载中”状态不可见。 */
            const summary = await beginReload(opts.root, policy, {
              holdSec: 3, out: detail,
              trigger: "context_overflow",
            });
            recordEvent(opts.root, "supervisor_reload_auto", {
              gen: summary.gen,
              trigger: "context_overflow",
              reason: ctxCheck.reason,
              reverify: summary.reverify,
              pending: summary.pending,
            });
            detail(
              t(
                `[supervisor] auto reload finished (gen ${summary.gen}); scheduling continues in the original order`,
                `[监工] 自动重载完成 gen ${summary.gen}：调度按原始下发顺序继续`,
              ),
            );
          } catch (err) {
            detail(
              t(
                `[supervisor] auto reload failed (will retry next tick): ${String((err as Error).message ?? err)}`,
                `[监工] 自动重载失败（下一轮重试）：${String((err as Error).message ?? err)}`,
              ),
            );
          }
        }
      }
      const verdict = step(
        opts.root,
        policy,
        chosenHost,
        capacity,
        wopts, detail,
        pause !== null,
      );
      /* 状态行只在内容变化时打印：常态是一行“运行中”，逐轮重刷会把真正发生的事挤出窗口。 */
      printStatus(capacity);

      /* 在途单由有到无时写一条结束总结：队列空了，用户需要知道各单的结果。 */
      const inFlightNow = inFlightCount(opts.root);
      if (inFlightNow === 0 && prevInFlight > 0 && !summaryRunning) {
        summaryRunning = true;
        void summarizeRun(opts.root, detail)
          .catch(
            (err) =>
              detail(
                t(
                  `[supervisor] failed to write the run summary: ${String((err as Error).message ?? err)}`,
                  `[监工] 结束总结失败：${String((err as Error).message ?? err)}`,
                ),
              ),
          )
          .finally(() => {
            summaryRunning = false;
          });
      }
      prevInFlight = inFlightNow;

      // 卡死判据：在途签名（派单 id/状态 + 工作进程日志字节数）连续 {@link STALL_TICKS} 个调度轮次未变。
      // 签名含日志增量，运行时长不计入卡死判定。
      if (!pause) {
        const stall = workProgress(opts.root);
        if (stall.sig !== stallSig) {
          stallSig = stall.sig;
          stallTicks = 0;
          stallReported = false;
        } else {
          stallTicks += 1;
          if (stallTicks >= STALL_TICKS) {
            if (!stallReported) {
              stallReported = true;
              reportStalled(opts.root, stall, stallTicks, tickSec);
            }
            // 超过两倍工作进程超时仍未结束的单强制结束并重派，不占退避窗口；先报告停滞，再处置。
            forceFinishHung(opts.root, workerTimeoutSec * 2, detail);
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
          detail(
            t(
              "[supervisor] no open work left: task complete; supervisor standing by (no dispatching, no polling)",
              "[监工] 队列已清：任务完成，监工待命在线（不派单、不轮询）",
            ),
          );
        }
      }

      if (stopping) break;
      if (i + 1 < limit) await idle(tickSec * 1000);
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("beforeExit", onBeforeExit);

    // 看板服务与工作进程须随监工一并释放；所有退出路径汇集到同一处清理，否则会留下占用端口的服务与进程。
    for (const f of disposeAll("shutdown")) out(t(`[supervisor] exit cleanup failed: ${f}`, `[监工] 退出清理失败：${f}`));

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

    /* 门闩随进程结束失效：留着会让下个进程把队列已清空的根显示成暂停中，新派单也不跑。 */
    if (readPause(opts.root)?.by === "supervisor") resumeAll(opts.root, "supervisor");
  }

  out(t("[supervisor] stopped", "[监工] 已停止"));
  return 0;
}

/**
 * 结束工作进程：先发 SIGTERM，再按进程树强杀，以确认退出为准。
 * 启动清孤儿与退出清场复用 `terminate.ts` 的同一套动作。
 * Windows 宿主下台账记录的是 `.cmd` 转层进程的 pid，只结束它会残留 CLI 与工具进程。
 */
const killWorkerPid = killTree;

/** 判定失败时先结束工作进程的 pid 并确认退出、记 worker_killed 事件，再落终态结束；进程已不在时不发信号、不记事件。 */
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
  detail(
    `[监工] worker ${w.id}（pid ${w.pid}）已${how === "term" ? "软终止" : how === "kill" ? "强杀" : "终止但未确认退出"}${
      confirmed ? "" : "可能有残留进程，需人工核查"
    }`,
  );
}

/** 工作进程日志距最后一次输出多少秒。读不到日志（未建、已删）按无穷大处理。 */
function logIdleSec(log: string, nowMs = Date.now()): number {
  return workerLogIdleSec(log, nowMs);
}

/** 卡点处置结果：`kept` 保留进程，`killed` 判定失败重派，`reap` 无可送达派单、交回 reap 收尾。 */
type StuckAction = "kept" | "killed" | "reap";

/** 重复度探测节流表：工作进程 id -> 上次探测时刻。 */
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
 * 处置顺序固定：先清已恢复卡点；同一类干预已两次且观察窗口已过则判定失败重派；否则写一次指导到
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
  const logFile = w.log || workersLoc.output(root, w.id);
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
      detail(`[监工] worker ${w.id} 已恢复推进（${w.stuck.label}解除），卡点标记清除`);
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
      detail(`[监工] 给 worker ${w.id} 的卡点指导已被领取（${prev.label}，第 ${prev.attempts} 次）`);
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
        detail(`[监工] worker ${w.id} 重复度高但模型判断仍在推进（${verdict.why}），暂不判定失败`);
        return "kept";
      }
    }
    const note =
      `卡死（${ev.label}）：同类指导已下发 ${prev.attempts} 次均未生效。` +
      `判定依据：${ev.why}。指导发送方式：${
        prev.channel === "consumed"
          ? "已通过 hook 通道送达"
          : prev.channel === "hook"
            ? "已写入 hook 通道但工作进程未领取"
            : "写入失败"
      }。`;
    killJudgedWorker(root, w, true, detail);
    saveWorker(root, { ...w, status: "failed", stuck: prev });
    failDispatchAndJudge(root, d, note, detail);
    recordEvent(root, "stuck_killed", {
      worker: w.id,
      dispatch: d.id,
      shard: d.shard ?? "",
      kind: ev.kind,
      label: ev.label,
      why: ev.why,
      attempts: prev.attempts,
      heartbeat_age_sec: live.heartbeat_age_sec,
      log_idle_sec: live.log_idle_sec,
    });
    detail(`[监工] worker ${w.id} 判卡死（${ev.label}，指导 ${prev.attempts} 次未生效），停进程并重开派单 ${d.id}`);
    return "killed";
  }

  /* 发一次指导。次数从 1 开始；同类卡点沿用同一个 since，方便看板回答“卡了多久”。 */
  const attempts = (prev?.attempts ?? 0) + 1;
  const text = buildIntervention(ev, live.log_idle_sec, attempts);
  let delivered = false;
  let directiveAt: string | undefined;
  try {
    const rec = appendDirective(root, {
      text,
      target: d.id,
      shard: d.shard ?? null,
      lineage: String((d as DispatchEx).lineage ?? d.id),
      lane: laneKeyOf(d as { shard?: string | null; lineage?: string; id?: string }),
      via: "capitalist",
      /* 卡点指导发给工作进程，界面按转告口吻显示，不照抄原文。 */
      audience: "worker",
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
  detail(
    `[监工] worker ${w.id} 判为卡点（${ev.label}）：心跳 ${live.heartbeat_age_sec}s、` +
      `日志 ${live.log_idle_sec < 0 ? "无" : `${live.log_idle_sec}s`} 无更新；` +
      `已下发第 ${attempts} 次指导（${delivered ? "hook 通道，等待领取" : "写入失败，需人工介入"}）`,
  );
  if (!delivered) {
    detail(`[监工] 指导未送达 worker ${w.id}：看板任务卡已标注卡点与建议，需人工介入`);
  }
  return "kept";
}

/**
 * 运行中按日志增量刷新会话占用，使会话闸门读到运行中会话的实时读数而非仅退出时的终值。
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
    const log = w.log || workersLoc.output(root, w.id);
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
 * 回收：工作进程心跳超时或进程已退出时，将其派单判为失败，等待下一轮按退避间隔重派。
 * 两遍扫描顺序固定：先按工作进程记录判定失败并标终态，再扫全部 claimed 派单就地结束。
 * 心跳超时的进程可能仍存活：先结束进程并确认退出，再判定派单失败，避免留下孤儿进程。
 * 第二遍须遍历全部 claimed 派单；分片并行时只查一张会漏掉其他无人处理的派单。
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
    detail(`[监工] 回收文件锁 ${r.path}（${r.holder}：${r.why}）`);
  }

  for (const w of listWorkers(root)) {
    if (w.status !== "running" && w.status !== "starting") continue;
    // 可见窗口模式不写心跳，pid 属于启动它的 cmd.exe、开窗后即退出，故结束只认进程写回的 report。
    if (w.mode === "visible") continue;
    const gone = w.pid > 0 && !pidAlive(w.pid);
    const stale = !isWorkerAlive(root, w.id, timeoutSec, undefined, stuckSec);

    /*
     * 无论进程是否存活都要做卡点判定：原地重复的进程心跳与日志都正常，只看两个信号是否过期无法发现它。
     * 仍存活但两信号过期或日志重复度高时，先判卡点、发指导，同类指导两次无效才判定失败重派。
     */
    if (!gone) {
      /* 同步预判跳过健康且无卡点记录的进程，避免对每个健康进程 await 使 reap 提前让出执行权。 */
      const logFile = w.log || workersLoc.output(root, w.id);
      const looped = stale || w.stuck ? undefined : probeLooping(w, logFile, Date.now());
      if (!stale && !w.stuck && !looped?.looping) continue;

      const act = await handleStuckWorker(root, w, {
        heartbeatSec: timeoutSec,
        stuckSec,
        nowSec, out: detail,
        ...(looped ? { looped } : {}),
      });
      if (act !== "reap") continue;
      /* 无可送达派单且判活信号仍在时继续观察，不按死进程处理。 */
      if (!stale) continue;
    }

    // 先结束进程并确认退出，再落终态。
    killJudgedWorker(root, w, stale, detail);

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
        detail(`[监工] worker ${w.id} 实际使用了禁用模型：${bad.join("、")}`);
      }
    } catch {
      /* 核对失败不影响收尾。 */
    }
    detail(`[监工] worker ${w.id} ${gone ? "已退出" : "心跳超时"}，回收`);
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
      /* 与第一遍同口径：心跳或日志任一在窗口内更新即视为推进，不结束；带 stuck 的单刚发过指导，不提前结束。 */
      const live = workerLivenessOf(w, {
        heartbeatSec: timeoutSec,
        logStallSec: stuckSec,
        nowMs: nowSec * 1000,
      });
      if (live.alive) {
        if (w.status === "starting") touchWorker(root, w.id, { status: "running" });
      } else if (!w.stuck) {
        killJudgedWorker(root, w, true, detail);
        saveWorker(root, { ...w, status: "failed" });
        reason = "worker 心跳与日志均已停滞";
      }
    }
    if (!reason) continue;

    failDispatchAndJudge(root, d, reason, detail);
    recordEvent(root, "dispatch_orphan", {
      dispatch: d.id,
      shard: d.shard ?? "",
      worker: d.worker ?? "",
      worker_status: w?.status ?? "missing",
      reason,
    });
    detail(`[监工] 派单 ${d.id}（${d.shard || "整单"}）无人认领：${reason}，结束并等待重派`);
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

/** 在途进展快照。 */
interface WorkProgress {
  /** 在途（open / claimed）的派单。 */
  inflight: InflightSnapshot[];
  /** 最后一张派单（不论状态）。 */
  last: { id: string; status: string; shard: string; at: string; note: string } | null;
  /** 跨调度轮次的比较签名。 */
  sig: string;
}

/**
 * 采一份进展快照。签名 `sig` 只含“有无前进”的信息：派单 id 与状态、工作进程日志字节数、心跳。
 * 不含时间戳与 `age_sec`，否则每轮调度都变，签名永不相等，卡死检测不会触发。
 */
function workProgress(root: string): WorkProgress {
  const rows = readDispatches(root);
  const nowSec = Date.now() / 1000;
  const nowMs = Date.now();

  const inflight: InflightSnapshot[] = [];
  const sigParts: string[] = [];

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

  // 最后一张单的 id 与状态也进签名：整批重做时派单被替换属真进展。
  sigParts.push(`last:${last?.id ?? "-"}:${last?.status ?? "-"}`);
  sigParts.push(`n:${inflight.length}`);

  return { inflight, last, sig: sigParts.join("|") };
}

/**
 * 报一条 stalled。
 *
 * 停滞细节（在途时长、最后一张单未完成的原因）只进事件台账，用 `capitalist status` /
 * `capitalist log` 查。不向终端输出：连续多少秒没有进展对用户没有可操作信息。
 */
function reportStalled(root: string, progress: WorkProgress, ticks: number, tickSec: number): void {
  const payload = {
    stalled_ticks: ticks,
    stalled_sec: Math.round(ticks * tickSec),
    inflight: progress.inflight,
    last_dispatch: progress.last,
  };
  recordEvent(root, "stalled", payload);
}

/**
 * 强制结束在途超过 `maxAgeSec` 的派单，使其下一轮重派。结束后写入 `forced` 标记：重派不占退避窗口，失败计数与重派上限不变。可见窗口模式只结束派单，不结束进程。
 * @returns 被强制结束的派单 id，供调用方汇总。
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
      killJudgedWorker(root, w, true, detail);
      saveWorker(root, { ...w, status: "failed" });
    }
    const note = `卡死强制结束（在途 ${Math.round(age)}s > 2×worker 超时 ${maxAgeSec}s）`;
    if (!failDispatchAndJudge(root, d, note, detail)) continue;
    patchDispatch(root, d.id, { forced: true } as Partial<DispatchEx>);
    recordEvent(root, "dispatch_forced_finished", {
      dispatch: d.id,
      shard: d.shard ?? "",
      worker: d.worker ?? "",
      age_sec: Math.round(age),
      limit_sec: maxAgeSec,
      reason: "stalled",
    });
    detail(
      t(
        `[supervisor] dispatch ${d.id} (${d.shard || "whole shard"}) in flight ${Math.round(age)}s; finished forcibly and queued for redispatch`,
        `[监工] 派单 ${d.id}（${d.shard || "整单"}）在途 ${Math.round(age)}s 未结束，强制结束并重派`,
      ),
    );
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
  policy: Policy,
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
      shard: d.shard ?? "",
    });
    detail(`[监工] 模型 ${ex.model ?? "（宿主默认）"} 启动即失败，回退到 ${ex.model_fallback} 重试一次（单 ${d.id}）`);

    const fb = ex.model_fallback;
    const issued = issueDispatchId(root, d.id);
    if (!issued.id) {
      detail(`[监工] 换模型重试未执行（${d.id}）：${issued.error?.message ?? "取号锁被占用"}`);
      continue;
    }
    const nid = issued.id;
    const taken = claimDirectives(root, {
      shard: d.shard ?? "",
      dispatchId: nid,
      lane: laneKeyOf({ shard: d.shard, lineage: String((d as DispatchEx).lineage ?? d.id) }),
    });
    /* 换模型重试沿用原单正文：验收清单已叠在快照里，重复叠加会让清单出现两次。 */
    const action = spliceDirectives(d.action, taken);
    const nd = composeDispatch({
      id: nid,
      shard: d.shard,
      /* 换模型重试沿用原单标题；原单无标题时按分片映射补齐。 */
      title: ex.title || shardTitle(d.shard) || taskTitle({ shard: d.shard, action }),
      action,
      source: "requeue",
      model: fb,
    });
    commitDispatch(root, nd);
    recordEvent(root, "dispatch_open", {
      dispatch: nd.id,
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
 * 取不到跨进程锁时记录仍为未消费状态，此集合避免下一轮调度重复执行同一条指令。
 */
const executedDirectiveIds = new Set<string>();

/**
 * 每个任务根最近一次门槛判定的签名。
 * 仅当通过与否或缺失项变化时记 `gate_eval`，避免结果未变时重复写事件。
 */
const lastGateSig = new Map<string, string>();

/**
 * 暂停与恢复都走 `core/record/pause.ts` 的同一对函数：文件与派单标记必须同进同退。
 * 本文件只补进程控制，不再自行拼标记字段。
 */
function writePauseFile(root: string, reason: string, by: string) {
  return pauseAll(root, by, reason);
}

function clearPauseFile(root: string, by: string): { ok: boolean; error?: string } {
  const r = resumeAll(root, by);
  return { ok: r.ok, ...(r.error === undefined ? {} : { error: r.error }) };
}

/** 暂停一轮：先停进程，再补齐派单标记。标记写入幂等，重复调用只补新增的单。 */
function pauseRun(root: string, rec: PauseFile, out: (s: string) => void): void {
  /* 排空式停止只挡新派单：停进程或打暂停标记会把“等在途跑完”变成“当场中断”。 */
  if (rec.drain) return;
  stopLiveWorkers(root, out);
  const marks = pauseLiveDispatches(
    root,
    String(rec.by ?? "supervisor"),
    rec.reason || "调度暂停",
    rec.at || undefined,
  );
  if (marks.marked > 0) {
    out(
      `[监工] 补记 ${marks.marked} 张派单为暂停中（运行中 ${marks.origins.running}、` +
        `待重派 ${marks.origins.retry}、排队 ${marks.origins.queued}）`,
    );
  }
}

function reject(reason: string): SupervisorResult {
  return { ok: false, reason, detail: "" };
}

/**
 * 取号失败即不建单。
 *
 * 取号锁重试用尽后不得静默降级为“按当前最大值猜一个号”，否则会产生重复编号。调用方拿到 `error` 后须把失败如实回给用户，或在监工内部重派时跳过本轮。
 */
function issueDispatchId(
  root: string,
  originDispatchId?: string,
): { id: string; error?: undefined } | { id?: undefined; error: NoLockTimeoutError } {
  try {
    return { id: newDispatchId(root, originDispatchId) };
  } catch (e) {
    if (e instanceof NoLockTimeoutError) return { error: e };
    throw e;
  }
}

/**
 * 回执里标识派单的编号（`#2-2`），取自派单号表，与看板同源。
 * 表中无此单时返回空串，不退回内部 id，也不按队列顺序生成。
 */
function dispatchNoLabel(root: string, id: string): string {
  const no = dispatchNoTable(root).get(String(id ?? "").trim());
  return no ? dispatchDisplayLabel(no) : "";
}

/**
 * 用当前状态回答 `ask` 的问题。只读，只陈述在途数、派单构成、任务树规模、暂停状态、
 * 待裁决问题与下一步，不给建议，也不改变调度状态。问题原文置于开头。
 */
function answerSupervisorQuestion(root: string, state: TaskState, question: string): string {
  const rows = readDispatches(root);
  const inflight = rows.filter((d) => d.status === "open" || d.status === "claimed").length;
  const done = rows.filter((d) => d.status === "done").length;
  const failed = rows.filter((d) => d.status === "failed").length;
  const forest = dispatchForest(rows);
  const pause = readPause(root);
  const asks = openAsks(root).length;
  const capitalist = loadSupervisor(root);
  const tick = capitalist?.ticks ?? 0;
  const parallel = capitalist?.max_workers ?? 0;

  const retries = [...new Set(rows.map((d) => d.shard ?? "").filter(Boolean))]
    .map((shard) => ({ id: shard, n: shardRetry(rows.filter((d) => (d.shard ?? "") === shard)).failures }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);

  const bits: string[] = [];
  bits.push(`第 ${tick} 轮调度`);
  bits.push(
    `并行 ${parallel}，在途 ${inflight}，派单 ${rows.length} 张（完成 ${done}，失败 ${failed}），任务树 ${forest.roots.length} 个根`,
  );
  /* 排空式停止与用户暂停分开写：前者在途还在跑，不能说成“进程已停”。 */
  bits.push(pause ? (pause.drain ? `停止中（${pause.reason || "等待在途结束"}），不再派新单` : `调度暂停中（${pause.reason || "手动暂停"}），在途进程已停，恢复后按原状态继续`) : "派单未暂停");
  if (asks) bits.push(`有 ${asks} 条待裁决问题（capitalist inbox）`);
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
    policy: Policy;
    wopts: WorkerSpawnOpts;
    out: (s: string) => void;
  },
  d: SupervisorDirective,
): Promise<SupervisorResult> {
  const { root, policy, wopts, out } = args;
  const state = loadState(root);
  if (!state) return reject("任务根状态不可读，指令未执行");
  const action = d.action;
  const arg = String(d.arg ?? "").trim();

  if (action === "pause") {
    const r = writePauseFile(root, `面板指令 ${d.id}`, "supervisor-direct");
    return { ok: true, reason: "", detail: r.written ? "已暂停调度；在途进程下一轮停止，恢复后按原状态继续" : "当前没有需要暂停的派单，未写暂停文件" };
  }

  if (action === "resume") {
    /*
     * 恢复派单是用户动作：监工对话层（via: "capitalist"）下发的请求会被拒绝。
     * 看板“恢复调度”按钮走 via: "user"，不受此限制。
     */
    if (d.via === "capitalist") {
      return reject("恢复派单要由用户操作：监工不能自行解除暂停，请在看板点“恢复调度”。");
    }
    const had = readPause(root) !== null;
    const cleared = clearPauseFile(root, "supervisor-direct");
    if (!cleared.ok) {
      return reject(
        `暂停状态未清除（${cleared.error ?? "文件被占用"}）：派单仍会被拒。稍后重试，或手动删除 .capitalist/pause.json。`,
      );
    }
    return { ok: true, reason: "", detail: had ? "已恢复派单" : "未处于暂停状态，已置为恢复态" };
  }

  /*
   * 单张恢复：用户点名，或工作进程在申报里明确要求继续某一张单。
   * 只解这一张，不解除全局暂停；全局暂停期间它仍不参与调度。
   */
  if (action === "wake") {
    if (!arg) return reject("wake 缺少单号：写成 wake #12");
    const hit = resolveDispatchRef(root, readDispatches(root), arg);
    if (!hit) return reject(`未找到派单“${arg}”：确认任务编号后重试`);
    const r = wakeDispatch(root, hit.id);
    if (!r) return reject(`派单 ${hit.id} 无法唤醒：已完成、已关闭或不在暂停状态`);
    recordEvent(root, "dispatch_wake", {
      dispatch: r.id,
      from: r.from,
      to: r.to,
      by: "supervisor-direct",
    });
    return { ok: true, reason: "", detail: `${r.from} 改为 ${r.to}，下一轮参与调度` };
  }

  if (action === "set-next") {
    if (!arg) return reject("set-next 缺少内容：写成 set-next <一句话>");
    if (arg.length > 500) return reject("set-next 内容过长（上限 500 字）");
    if (updateState(root, (s) => { s.next_action = arg; }) === null) {
      return reject("状态写入冲突，指令未生效，请重发一次");
    }
    return { ok: true, reason: "", detail: `下一步：${arg}` };
  }

  /* 复用 `closeTask`：closed 为终态，结束后不再重派。 */
  if (action === "cancel") {
    const m = /^\s*#?\s*(\d{1,4})\b/.exec(arg);
    if (!m) return reject("cancel 要写编号：`DO: cancel #<编号>`");
    const no = Number(m[1]);
    const hit = dispatchOfThreadNo(root, no, readDispatches(root));
    if (!hit) return reject(`没有 #${no} 这一单（编号看【任务编号表】）`);
    const r = closeTask(root, String(hit.id), { reason: "监工作废", by: "supervisor" });
    if (!r) return reject(`#${no} 已经结束（${String(hit.status)}），无需取消`);
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
    /*
     * 线程内追加只作用于当前单：`target` 表示会话归属，正文编号指向别的单即越界（典型情形是监工顺带给同批另一单改口径）。按 `target` 拒绝，不静默改到当前单，否则针对另一单的正文会落到本单上，语义错位更难排查。
     */
    if (byId && noM && Number(noM[1]) !== taskNoOfDispatchId(byId.id)) {
      return reject(
        `这条追加指向 #${Number(noM[1])}，不属本次对话的单 #${taskNoOfDispatchId(byId.id)}；线程内追加只能改当前单`,
      );
    }
    /* 按编号定位链上的单：在途优先，全部已终结时取最近一张终态单，由下方重开分支处理。 */
    const byNo = noM ? amendTargetOf(root, Number(noM[1]), rows) : undefined;
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
      byNo && live(String(byNo.status ?? ""))
        ? byNo
        : byId && live(String(byId.status ?? ""))
          ? byId
          : undefined;
    const pick = livePick ?? settledPin;
    if (!pick) {
      /* 两种情形分开报：写给编号但该任务没有派单，与完全没写编号，处置不同。 */
      return reject(
        noM
          ? `#${Number(noM[1])} 没有派单记录：确认编号后重试，或新开一单`
          : "这条追加缺少单号：正文前写 #编号（如 #1）",
      );
    }
    const rec = appendDirective(root, {
      text,
      target: String(pick.id),
      shard: pick.shard ?? null,
      lineage: String((pick as DispatchEx).lineage ?? pick.id),
      lane: laneKeyOf(pick as { shard?: string | null; lineage?: string; id?: string }),
      /* via 标记为 capitalist：追加来自监工对话层，回显按监工侧处理。 */
      via: "capitalist",
      ...(bound.msgId ? { msgId: bound.msgId } : {}),
      ...(bound.atts.length ? { atts: bound.atts } : {}),
    });
    if (!rec) return reject("追加内容写入失败：.capitalist 不可写");
    /*
     * 目标单已终结时开一张新单，由同一 prompt 带上追加重新拉起。
     * 新单是新的一次派单，派单号 +1；旧单保持原终态，不再原地翻回 open 沿用旧号。
     */
    let reopened = "";
    if (settledPin) {
      const why = `用户在这条线程追加了新内容（${String(settledPin.status)} -> 重开）`;
      const fresh = reopenSettledDispatch(root, settledPin.id, why);
      if (!fresh) {
        return reject(
          `追加已写入，但重开派单失败（该单已在执行，或取号锁被占用）。稍后重试即可，追加内容不会丢。`,
        );
      }
      reopened = fresh.id;
      recordEvent(root, "directive_reopen", {
        dispatch: fresh.id,
        from: String(settledPin.status),
        source: settledPin.id,
        text: text.slice(0, 200),
      });
      detail(
        `[监工] 追加的目标单 ${settledPin.id} 已终结（${settledPin.status}），已开新单 ${fresh.id} 让这条追加有进程执行`,
      );
    }
    recordEvent(root, "directive_amended", {
      dispatch: pick.id,
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
    const pickLabel = dispatchNoLabel(root, reopened || pick.id);
    return {
      ok: true,
      reason: "",
      detail: reopened
        ? `已追加到派单${pickLabel ? ` ${pickLabel}` : ""}（原单已终结，已开新单，下一轮携带原上下文重新拉起）`
        : `已追加到在途派单${pickLabel ? ` ${pickLabel}` : ""}（${pick.status === "open" ? "尚未拉起，启动时带入" : "执行中的进程会在下一个动作间隙收到"}）` +
          "；该进程收尾时用 --added 说明改动，复审按新口径验收",
      /* dispatch 供回执卡片查任务编号（见 direct.ts 的 SupervisorResult.dispatch）。 */
      dispatch: reopened || pick.id,
    };
  }

  /*
   * 立即落一张 urgent 单，fillSlots 当轮即会派发；与 set-next 只登记文字不同。
   * shard 留空：临时单自占一条并发线，不并入任何既有线程。
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
     * `--now` 表示新建即抢占：建单时带上立即执行语义，避免补发 promote 之前该单被排到后面。
     * 与 `queue` 的区别保留：queue 只插队到队首，不抢占。
     */
    const nowM = /^\s*--now\s+/i.exec(boundArg.text);
    /* `INSERT: before #G1 now` 与 `--now` 同义：建单后立即执行，由同一处 promote 处理。 */
    const insDecl = (d as SupervisorDirective).insert;
    const wantNow = Boolean(nowM) || insDecl?.now === true;
    const argClean = nowM ? boundArg.text.slice(nowM[0].length).trim() : boundArg.text;
    /*
     * 分类标签写在正文最前的方括号内，作为会话键：同类共用一个键以复用上下文，
     * 无标签归入 `misc`。标签由派单时给出，不是固定枚举。拆标签的规则统一在
     * `splitDirectiveTag`，展示侧沿用同一份，避免界面把标签当正文一起显示。
     */
    const { tag, body } = splitDirectiveTag(argClean);
    /* 暂停期间不派单，插入执行的单也在内；拒绝并说明原因。 */
    if (readPause(root) !== null) {
      return reject(
        "监工处于暂停派单状态：该指令不执行。先恢复派单（看板指标条的“恢复调度”按钮，或 capitalist resume），再重新下发。",
      );
    }
    /*
     * 同一件事已在途时不新派，避免两个进程执行同一任务并互相覆盖。
     * 判据与阈值在 `loop/dedupe.ts`，本处只按结果回执。
     */
    const dupe = findBusyDuplicate(root, body, tag);
    if (dupe?.kind === "dup") {
      const label = dispatchNoLabel(root, dupe.id);
      return reject(
        `已有在途单${label ? ` ${label}` : ""}覆盖同一件事，本条未新建。需要重跑时对该单执行 capitalist retry。`,
      );
    }
    if (dupe?.kind === "twin") {
      const label = dispatchNoLabel(root, dupe.id);
      return reject(
        `已有在途单${label ? ` ${label}` : ""}覆盖同一件事，本条未新建。补充或更正用 amend${label ? ` ${label}` : ""}；重跑需先结束该单。`,
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
          `AFTER 里的前置单“${tok}”不在台账中：依赖关系不落数据就不生效。先派前面的单，或核对编号后重发。`,
        );
      }
      afterIds.push(String(hit.id));
    }
    /* 父节点可以是编号、派单 id、`@N`（同批第 N 单）或组号；三种语义的拒绝文案在 refs 里分开。 */
    const pr = resolveParentTokens(root, {
      msgId: String((d as SupervisorDirective).msg_id ?? ""),
      tok: parentTok,
      why: parentWhy,
      rows: afterRows,
    });
    if (!pr.ok) return reject(pr.error);
    const parentId = pr.id;
    const parentAsGroup = pr.asGroup ? pr.id : "";
    /*
     * 分组声明：`new` 新建、`join` 加入既有组。成员归属只落在派单的 `group` 字段上，
     * 组记录不存成员表。两处保存同一事实会产生不一致。
     * 校验（取号、组是否存在、成员父一致）在 `applyGroupDecl` 里，本处只处理拒绝。
     */
    const groupDecl = (d as SupervisorDirective).group;
    /* 落盘与判定统一用“父节点”：派单 id 或组号，两者不会互相误认（派单 id 不以 G 开头）。 */
    const parentNode = parentId || parentAsGroup;
    let groupId = "";
    if (groupDecl) {
      const applied = applyGroupDecl(root, groupDecl, {
        parentId: parentNode,
        rows: afterRows.length ? afterRows : readDispatches(root),
      });
      if (!applied.ok) return reject(applied.error);
      groupId = applied.id;
    }
    /* 接替声明：换台账 id 并校验同组、目标已了结；拒绝时不取号，队列不变。 */
    const supDecl = String((d as SupervisorDirective).supersede ?? "").trim();
    const supRows = afterRows.length ? afterRows : readDispatches(root);
    const sup = supDecl ? resolveSupersede(root, supDecl, { rows: supRows, groupId }) : null;
    if (sup && !sup.ok) return reject(sup.error);
    /* 同标签且内容相似的需求合并到同一 open 单，action 超过 `MERGE_MAX_CHARS` 时改为新建。 */
    const MERGE_MAX_CHARS = 6000;
    /*
     * 带依赖的单不合并：并入他单后依赖边不随记录保存，重启会丢失执行顺序。
     * 组成员同样不合并：并入别的单会让组少一名成员，而组的完成条件是“全体完成”，少算一名成员就可能提前放行下游。
     */
    if (tag && afterIds.length === 0 && !parentNode && !groupId) {
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
          tag,
          chars: merged.length,
          text: body.slice(0, 160),
          atts: mergedAtts,
        });
        /*
         * 回执须写明并入的目标单编号，取自 thread-no.json，与守卫同源；
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
            `再加会超过 ${MERGE_MAX_CHARS} 字上限（上下文过长），另建一单。`,
        };
      }
    }
    const issued = issueDispatchId(root);
    if (!issued.id) {
      return reject(`${issued.error?.message ?? "取号锁被占用"}。未建单，队列未改动，稍后重试即可。`);
    }
    const id = issued.id;
    const taken = claimDirectives(root, {
      shard: "",
      dispatchId: id,
      lineage: id,
      lane: laneKeyOf({ shard: "", lineage: id }),
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
    const actionText = spliceDirectives(body, taken);
    /* 验收判据随单落盘：审查侧按本单口径判报告，执行侧也按它自检。 */
    const accDecl = String((d as SupervisorDirective).acceptance ?? "").trim();
    /*
     * 派单模型：面板设定的 next_model 优先，其次使用宿主默认档。
     * 插入执行的单没有既有线程可继承模型设定，不在这里确定就只能使用启动参数，面板上选择的模型会失效。
     */
    const adhocModel = defaultDispatchModel(root, undefined);
    const adhoc = composeDispatch({
      id,
      shard: "",
      /* 标题优先取派单方的 `TITLE:` 行；未写时才按正文摘要兜底。 */
      title: declaredTitle(d) || taskTitle({ shard: "", action: body }),
      action: actionText,
      source: "adhoc",
      attempt: 1,
      urgent: true,
      /* `atts` 在建单时固化，重派按此字段重建附件行。 */
      atts: ownAtts,
      srcMsg: bound.msgId,
      srcMsgs,
      ...(tag ? { tags: [tag] } : {}),
      /* `after` 落库供 fillSlots 每轮重算，重启与重派后执行顺序保持不变。 */
      ...(afterIds.length ? { after: afterIds } : {}),
      /* `parent` 与 `parent_reason` 一起落盘，缺理由时重启后无法判定该依赖是否为必需。 */
      ...(parentNode ? { parent: parentNode, parentReason: parentWhy } : {}),
      /* 组成员归属只落这一处；重派由建单工厂的 `tree` 继承键自动带上。 */
      ...(groupId ? { group: groupId } : {}),
      /* 接替关系随单落盘，组判定按它把补单与原事项合并。 */
      ...(sup?.ok && sup.id ? { supersedes: sup.id } : {}),
      ...(accDecl ? { acceptance: accDecl } : {}),
      ...(adhocModel ? { model: adhocModel } : {}),
    });
    commitDispatch(root, adhoc);
    /* 结构插入：细节在 `loop/restructure.ts`（台账先改、进程后停，失败不回滚建单）。 */
    if (insDecl) {
      const resolve = (rows: Dispatch[], tok: string) => resolveDispatchRef(root, rows, tok);
      applyInsertNow(root, id, insDecl, (d as SupervisorDirective).insert_mode, resolve, detail);
    }
    /* `--now` 建单当轮由 `promoteTask` 写 `promoted_at` 触发抢占；失败不阻断建单，降级为排队优先。 */
    const nowPrompted = wantNow ? promoteTask(root, id, { by: "supervisor" }) : null;
    if (wantNow && !nowPrompted?.ok) {
      detail(`[监工] 立即执行标记未生效：${nowPrompted?.reason ?? "未知原因"}（单已创建，按排队优先处理）`);
    }
    recordEvent(root, "dispatch_open", {
      dispatch: id,
      shard: "",
      action: actionText,
      source: "adhoc",
      attempt: 1,
      model: adhocModel ?? "",
      directives: taken.length,
      urgent: true,
      tag,
      atts: ownAtts,
      src_msg: bound.msgId,
      after: afterIds,
      parent: parentNode,
      parent_reason: parentWhy,
      group: groupId,
      acceptance: accDecl,
    });
    /* 回执按槽位占用如实标注是否会立即执行。 */
    const cap = Math.max(1, Number(loadSupervisor(root)?.max_workers ?? 1) || 1);
    const busy = liveWorkers(root).length;
    const when = wantNow && nowPrompted?.ok
      ? "已立即执行：抢占槽位，运行中的派单退回队首"
      : parentNode
      ? `已挂到父节点 ${parentNode} 下（${parentWhy}）：父节点完成前不会启动，不占并行槽位`
      : afterIds.length
        ? `已登记依赖 ${afterIds.join("、")}：前置单全部完成前不会启动，不占并行槽位`
        : busy < cap
          ? "本轮拉起进程"
          : `当前 ${busy}/${cap} 个并行槽位已占用，待槽位释放后立即拉起（已置于队首）`;
    return {
      ok: true,
      reason: "",
      detail: `已插入队列优先执行 ${dispatchNoLabel(root, id) || id}：${argClean.slice(0, 80)}｜${when}`,
      /* urgent 标识插队单，回显前缀据此显示。 */
      urgent: true,
      /* dispatch 供执行回执卡查任务编号。 */
      dispatch: id,
    };
  }

  /*
   * diagnose 只查不改，fix 查完即修。两者不受暂停与阻塞限制，且不占业务槽位。
   * fix 使用带派单 id 后缀的全新会话，不复用既有上下文；diagnose 允许同类复用。
   */
  if (action === "diagnose" || action === "fix") {
    if (!arg) return reject(`${action} 缺少内容：写成 ${action} <卡在哪>`);
    if (arg.length > 4000) return reject(`${action} 内容过长（上限 4000 字）`);
    const bound = directiveAttachments(root, d, arg);
    const boundArg = bindAttachments(arg, bound.atts);
    const issued = issueDispatchId(root);
    if (!issued.id) {
      return reject(`${issued.error?.message ?? "取号锁被占用"}。未建单，稍后重试即可。`);
    }
    const id = issued.id;
    const tag = action === "fix" ? `fix-${id.slice(-6)}` : "diagnose";
    const rec = composeDispatch({
      id,
      shard: "",
      title: `${action === "fix" ? "修复" : "诊断"}：${boundArg.text.slice(0, 56)}`,
      action: boundArg.text,
      source: "adhoc",
      attempt: 1,
      urgent: true,
      role: action,
      tags: [tag],
      atts: boundArg.kept,
      srcMsg: bound.msgId,
    });
    commitDispatch(root, rec);
    recordEvent(root, "dispatch_open", {
      dispatch: id,
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
        `已建${action === "fix" ? "修复" : "诊断"}单 ${id}（使用全新会话 ${`capitalist-${tag}`}，不占用并发名额）` +
        `：${boundArg.text.slice(0, 80)}`,
    };
  }

  /*
   * 重载落 snapshot 与 resume.json 并更换会话，不重启进程：进程重启由外部拉起。
   */
  if (action === "reload") {
    try {
      const summary = await beginReload(root, policy, { holdSec: 0, out });
      const bits = [
        `已落盘快照 gen ${summary.gen}`,
        `上下文 ${summary.before_chars} -> ${summary.after_chars} 字`,
        `待复验 ${summary.reverify} 片、继续做 ${summary.pending} 片`,
      ];
      return { ok: true, reason: "", detail: bits.join("｜") };
    } catch (err) {
      return reject(`重载失败：${String((err as Error).message ?? err)}`);
    }
  }

  if (action === "concurrency") {
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1) return reject(`concurrency 需要正整数，收到“${arg || "（空）"}”`);
    /* 并行度上限由用户设定。 */
    return { ok: true, reason: "", detail: `并行度：${n}` };
  }

  /*
   * promote 把排队中的单置顶并腾出并发槽立即执行；只接受排队中的单。
   * preempt 为真表示下一轮挂起一张运行中的任务腾槽。
   */
  /* queue 把单插到排队队首，不抢占正运行中的进程；抢占用 promote。 */
  if (action === "queue") {
    if (!arg) return reject("queue 缺少派单编号（`DO: queue #03` 或直接写派单 id）");
    const qNo = /^\s*#\s*(\d{1,4})\b/.exec(arg);
    const qByNo = qNo ? dispatchOfThreadNo(root, Number(qNo[1])) : undefined;
    if (qNo && !qByNo) {
      return reject(`未找到 #${qNo[1]} 对应的在途派单：可能已结束或尚未建单`);
    }
    const qTarget = qByNo ? String(qByNo.id) : arg;
    const q = frontDispatch(root, qTarget, "supervisor");
    if (!q) {
      return reject(
        `派单 ${arg} 不在排队队列中：插队仅对未开始的派单有效。抢占运行中的派单用 promote。`,
      );
    }
    return { ok: true, reason: "", detail: "已插到队首：空出槽位后优先执行，运行中的进程不受影响" };
  }

  if (action === "promote") {
    if (!arg) return reject("promote 缺少派单编号（`DO: promote #03` 或直接写派单 id）");
    /* #NN 是任务号，与派单 id 分属不同命名空间，先经 dispatchOfThreadNo 转成派单 id。 */
    const noM = /^\s*#\s*(\d{1,4})\b/.exec(arg);
    const byNo = noM ? dispatchOfThreadNo(root, Number(noM[1])) : undefined;
    if (noM && !byNo) {
      return reject(
        `未找到 #${noM[1]} 对应的在途派单：可能已结束或尚未建单`,
      );
    }
    const target = byNo ? String(byNo.id) : arg;
    const r = promoteTask(root, target, { by: "supervisor" });
    if (!r) return reject(`未找到排队中的派单“${arg}”：确认它在【任务编号表】中且尚未开始`);
    if (!r.ok) return reject(r.reason);
    const bits = [r.preempt ? "已腾槽，下一轮立即执行" : "已置顶，下一轮拉起"];
    if (r.behind) bits.push(`立即执行派单 ${r.behind} 仍在运行，本单排在其后`);
    else if (r.ahead > 0) bits.push(`越过 ${r.ahead} 张排队单`);
    if (r.already) bits.push("重复置顶，已刷新到队首");
    return { ok: true, reason: "", detail: bits.join("｜") };
  }

  if (action === "retry") {
    if (!arg) return reject("retry 缺少单号或派单 id");
    /* 按单号或派单 id 重开：额度、凭证恢复后，用户需要一个把该单放回队列的入口。 */
    const ref = reopenOneByRef(root, arg, d.id);
    if (!ref) return reject(`未找到可重开的单“${arg}”：确认它在任务编号表中。返工整单用 DO: redo #编号`);
    return ref.ok
      ? { ok: true, reason: "", detail: "已重开这一单，下一轮接着执行", dispatch: ref.id }
      : reject(ref.reason);
  }

  /*
   * redo：把已经结束的一单重开。
   *
   * 每重开一次就是新派一次单：发一张新单、派单号 +1，内容沿用原单。
   * 重开不是“让两张单并行”：同一任务已有在途单时直接拒绝，改口径用 amend、
   * 放弃用 cancel。两张单并行会让后拉起的那张因会话被占而换新会话，从零重做。
   */
  if (action === "redo") {
    const m = /^\s*#?\s*(\d{1,4})\b/.exec(arg || "");
    const rows = readDispatches(root);
    const want = String(d.target ?? "").trim();
    const target = m || !want ? undefined : rows.find((x) => String(x.id) === want);
    const no = m ? Number(m[1]) : target ? taskNoOfDispatchId(String(target.id)) : 0;
    if (!m && !target) return reject("redo 要写编号：`DO: redo #<编号>`");
    /*
     * 同一任务只允许一张在途单。`open` 也算在途：它已占住任务与会话，再开一张就是两单做同一件事。
     * 旧格式单反解不出任务号（`no` 为 0）时跳过这一判定，按单 id 继续。
     */
    const live =
      no > 0
        ? rows.find(
            (x) => taskNoOfDispatchId(String(x.id)) === no && !isTerminal(String(x.status ?? "")),
          )
        : undefined;
    if (live) {
      return reject(
        `#${no} 正在执行（派单 ${live.id}），不重开。改口径用 amend #${no} <内容>；放弃这一单用 cancel #${no}`,
      );
    }
    /*
     * 目标只取已终结的单。取“派发序最大的单”会命中同批 amend 刚开出的替代单，
     * 重开它就是让两张单同时做同一件事。
     */
    const hit = m
      ? dispatchOfThreadNo(root, no, rows, { settledOnly: true })
      : target && isTerminal(String(target.status ?? ""))
        ? target
        : undefined;
    if (!hit) return reject(`没有可重开的 #${no}：该任务没有已结束的派单`);
    const next = reopenSettledDispatch(root, String(hit.id), "用户要求重派");
    if (!next) {
      /* 与 amend 共用同一入口：在途、取号锁被占用都走这条，不猜状态。 */
      return reject("重开未执行：原单状态已变化或取号锁被占用。请稍后重试。原单状态未改动。");
    }
    recordEvent(root, "dispatch_reopened", {
      dispatch: next.id,
      from: String(hit.id),
      by: "supervisor-direct",
      directive: d.id,
    });
    return {
      ok: true,
      reason: "",
      detail: `已重开 ${dispatchNoLabel(root, String(hit.id)) || `#${no}`}：新派单 ${next.id}，下一轮调度拉起`,
      dispatch: next.id,
    };
  }

  if (action === "ask") {
    if (!arg) return reject("ask 缺少问题：写成 ask <一句话>");
    if (arg.length > 500) return reject("问题过长（上限 500 字）");
    /* ask 只读，不写状态；回答记为 supervisor_answer 事件，与派单节奏解耦。 */
    const answer = answerSupervisorQuestion(root, state, arg);
    recordEvent(root, "supervisor_answer", {
      id: d.id,
      question: arg,
      answer,
      tick: loadSupervisor(root)?.ticks ?? 0,
    });
    return { ok: true, reason: "", detail: "已回答，见监工流" };
  }

  return reject(`未知动作“${action || d.text || "（空）"}”：指令未执行，正确写法见帮助。`);
}

/**
 * 逐条执行通道指令并记 supervisor_cmd 事件。拒绝也标记已消费。
 * 标记失败由 executedDirectiveIds 保证下一轮调度只补标记、不重复执行。
 */
async function applySupervisorDirectives(args: {
  root: string;
  policy: Policy;
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

    const before = args.policy;
    let res: SupervisorResult;
    try {
      res = await applyOneDirective({ root: args.root, policy: before, wopts: args.wopts, out: args.out }, d);
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
      args.out(`[监工] 指令 ${d.id} 结果未能落盘（锁被占用），下一轮只补标记，不重复执行`);
    }
    /*
     * 回执发自己的号。
     *
     * `d.id` 是触发这条回执的插话记录身份：用户来源的记录它就是用户消息编号，
     * 直接拿来当回执的编号，界面上一张用户原话与一张执行回执会共用一个编号，
     * 引用回执时引用条显示的还是用户方向号。回执由监工产生，记 `S`；
     * 触发它的用户消息号记在 `msg_id`，与 `direct.jsonl` 的字段语义一致。
     */
    const triggerNo =
      [String(d.msg_id ?? ""), String(d.id ?? "")].find((x) => isUserMsgDirection(msgDirection(x))) || "";
    recordEvent(args.root, "supervisor_cmd", {
      id: msgId(taskNoOfDispatchId(String(d.target ?? "")) || "S0", "S2U"),
      ...(triggerNo ? { msg_id: triggerNo } : {}),
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
    /* 指令正文与结论只入事件台账，不打印到控制台：控制台只留状态行。 */
  }
  return { concurrency: next };
}

/**
 * 启动时把上次退出时未完成的派单标记为暂停。
 *
 * 覆盖全部未结状态：`claimed` / `reported` 在重启后没有进程接续，判定失败回收时不该自动重跑。
 * 标记落在派单上而不只在内存里，判定失败后的重派闸据此继续拦住该单，直到用户唤醒。
 *
 * @returns 新写入标记的张数。
 */
export function holdLegacyDispatches(root: string): number {
  return pauseLiveDispatches(root, "startup", "监工启动：调度暂停，恢复后按原状态继续").marked;
}

/**
 * 任务根是否还有待办。
 *
 * “没有任务”只有一种：没有未了结的派单、没有待裁决的问题、没有阻塞登记。其余情形均视为
 * 有待办。待命分支据此决定是否执行调度轮询。
 *
 * 与 `step` 的差别：这里只判定是否存在待办，不派单、不写台账。
 */
export function hasPendingWork(root: string, state: TaskState): boolean {
  if (hasLiveWork(root)) return true;

  /* 待裁决问题与阻塞均需用户回复，归入待处理状态。 */
  if (openAsks(root).length > 0) return true;
  if ((Array.isArray(state.blockers) ? state.blockers.length : 0) > 0) return true;

  return false;
}

/**
 * 是否有需要冻结的现场：存活的工作进程，或未结（含带暂停标记）的派单。
 *
 * 启动时要不要落暂停文件取决于这里：空任务根没有单可冻结，写成暂停会让刚建好的根一启动
 * 就停在 paused。
 */
export function hasLiveWork(root: string): boolean {
  const live = listWorkers(root).filter((w) => w.status === "running" || w.status === "starting");
  if (live.length > 0) return true;

  return readDispatches(root).some(
    (d) =>
      d.status === "open" ||
      d.status === "claimed" ||
      d.status === "reported" ||
      d.status === "review" ||
      /* 存在暂停单时不派单，监工也不转入待命状态，否则队列显示为空。 */
      (dispatchPaused(d) && d.status !== "done" && d.status !== "closed"),
  );
}

/** 通道不可用提示的节流窗口。 */
const CHANNEL_NOTICE_MS = 60_000;
/** 任务根 -> 上次提示时刻。 */
const channelNoticeAt = new Map<string, number>();

/** 单个调度轮次的派发与结算。paused 时只结算不开新单。 */
function step(
  root: string,
  policy: Policy,
  host: WorkerHost,
  capacity: number,
  wopts: WorkerSpawnOpts,
  out: (s: string) => void,
  paused = false,
): "continue" | "done" {
  const state = loadState(root);
  if (!state) return "continue";

  /*
   * 登录态不可用时整根待命：不派单、不重派。
   *
   * 没有这道闸时，每轮都会派单并失败。记录带有效期，恢复登录态后自行放行。
   */
  const down = readChannelDown(root);
  if (down) {
    /* 每轮调度都会走到这里，提示按分钟节流，避免刷满日志与事件窗口。 */
    const last = channelNoticeAt.get(root) ?? 0;
    if (Date.now() - last > CHANNEL_NOTICE_MS) {
      channelNoticeAt.set(root, Date.now());
      detail(
        `[监工] 通道不可用（${down.reason}），已待命：不派单、不重派。` +
          "恢复登录态后五分钟内自动继续，或重新启动监工。",
      );
    }
    return "continue";
  }

  drainSettledDirectives(root, detail, policy);

  /*
   * 先拉起已建单：待裁决问题、阻塞登记与暂停只影响新建单。
   */
  if (!paused) {
    /* 失败待重派的单先补，再填槽。 */
    requeueFailed(root, detail);
    /* 悬空追加先于 fillSlots 翻回 open，同一轮可被 claim 拉起。 */
    rescueOrphanDirectives(root, detail);
    fillSlots(root, policy, state, host, capacity, wopts, detail);
  }

  /* 新建单受待裁决问题与阻塞登记影响。 */
  const asks = openAsks(root);
  if (asks.length > 0) {
    const fresh = asks.filter((a) => {
      const at = Date.parse(String(a.at ?? ""));
      return !Number.isFinite(at) || Date.now() - at < ASK_BLOCK_MS;
    });
    /* 只有不带对象（分片、会话、进程）的问题才停整个任务根。 */
    const globalFresh = fresh.filter(
      (a) =>
        String(a.shard ?? "") === "" &&
        String(a.session ?? "") === "" &&
        String(a.worker ?? "") === "",
    );
    if (globalFresh.length > 0) {
      /* 停派原因由每轮的状态行统一说明（describeStatusLine），这里不再逐轮重复。 */
      return "continue";
    }
  }

  // 阻塞登记同样只暂停新建单，与 capitalist block 的“不重派”承诺一致。
  const blockers = Array.isArray(state.blockers) ? state.blockers.length : 0;
  if (blockers > 0) {
    /* 条数与原因由状态行统一说明，这里不再逐轮重复。 */
    return "continue";
  }

  // 有在途（claimed / open / 待裁决）就不结算；失效的 claimed 已在 reap 结束。
  if (activeDispatches(root).length > 0) return "continue";

  /*
   * 失败待补派的链还没补出去：退避窗口里也算未完成。
   * 补派发生在下一拍，若此处判完成，监工就此转待命，失败单永久卡在队列里。
   */
  if (pendingRetryChains(root).some((c) => !c.exhausted)) return "continue";

  /* 队列已清：记一次完成时刻并转待命，等用户派入新单。 */
  recordDoneOnce(root, state);
  return "done";
}

/** 队列清空只记一次：以 state.done_at 为判据，已有值则不重复写事件与日志。 */
function recordDoneOnce(root: string, state: TaskState): void {
  const first = updateState(root, (s) => {
    if (String(s.done_at ?? "").trim()) return false;
    s.done_at = new Date().toISOString();
    return true;
  });
  if (first !== true) return;
  recordEvent(root, "supervisor_done", { target: state.target });
}

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
    laneKeyOf(d as { shard?: string | null; lineage?: string; id?: string });

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
    /*
     * 只有失败的能由监工重开。用户手动结束的单是明确意图，done 的单已经交付，
     * 两者都不应因“有追加未读”被静默放回队列；要继续，须由用户明确重开。
     */
    if (last.status !== "failed") {
      recordEvent(root, "directive_rescue_skipped", {
        dispatch: last.id,
        status: last.status,
        count: want.count,
      });
      detail(
        `[监工] ${last.id} 已${last.status === "closed" ? "被用户结束" : "完成"}，` +
          `${want.count} 条追加未投递；如需继续执行，请明确重开该单`,
      );
      continue;
    }
    /* 同一张单十分钟内只回收一次，避免追加领不走时反复重开与拉起进程。 */
    const lastRescue = Date.parse(String((last as { rescued_at?: string }).rescued_at ?? "")) || 0;
    if (lastRescue && now - lastRescue < 10 * 60_000) continue;
    /* 追加早于失败时刻的不回收：那批内容在失败前就已被读过。 */
    const endedAt = Date.parse(String((last as { done_at?: string }).done_at ?? last.at ?? "")) || 0;
    if (want.latest && endedAt && want.latest <= endedAt) continue;

    const why = `有 ${want.count} 条未读的用户追加`;
    const fresh = reopenSettledDispatch(root, last.id, why);
    if (!fresh) continue;
    /* 写 rescued_at，防止重开后立即再次结束的循环。 */
    patchDispatch(root, fresh.id, { rescued_at: new Date().toISOString() } as Partial<Dispatch>);
    recordEvent(root, "directive_rescue", {
      dispatch: fresh.id,
      source: last.id,
      from: String(last.status),
      count: want.count,
    });
    detail(`[监工] 派单 ${last.id} ${why}，已开新单 ${fresh.id}`);
    return; // 每轮只处理一条链
  }
}

/** 一条等待补派的失败链。 */
interface RetryCandidate {
  /** 派生链键（链首单 id）。 */
  chainId: string;
  chain: Dispatch[];
  /** 链上最后一张失败单，补派以它为模板。 */
  last: Dispatch;
  /** 链上累计失败次数。 */
  failures: number;
  /** 最近一次失败时刻（epoch 毫秒）。 */
  lastAt: number;
  /** 已达重派硬上限：不再自动补派，需要用户改写要求或介入。 */
  exhausted: boolean;
}

/**
 * 等待补派的失败链。
 *
 * 判据：链上有失败单、链上无活单、没有被判过放弃或暂停、没有暂停标记。
 * 退避窗口内的链也算在内：补派确实要等退避到点，但对“任务是否已完成”来说它仍是未完成。
 * 少了这一条，监工会在退避窗口里判任务完成并转待命，失败单再也不会被重派。
 */
function pendingRetryChains(root: string): RetryCandidate[] {
  /* 复验单由重载流程按批次回填，不参与自动重派。 */
  const rows = readDispatches(root).filter((d) => d.source !== "reverify");
  if (rows.length === 0) return [];

  /*
   * 按 lineage 分组，不按 action：action 派发时会被重写，按文本去重不命中。
   * 链上只要有一张活单（含 closed）就不再补派。
   */
  const chains = new Map<string, Dispatch[]>();
  for (const d of rows) {
    const key = String((d as DispatchEx).lineage ?? d.id);
    const list = chains.get(key) ?? [];
    list.push(d);
    chains.set(key, list);
  }

  const out: RetryCandidate[] = [];
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

    const last = failed.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] as Dispatch;
    const lastAt = Math.max(...failed.map((x) => Date.parse(String(x.done_at ?? x.at ?? "")) || 0));
    out.push({
      chainId,
      chain,
      last,
      failures: failed.length,
      lastAt,
      exhausted: failed.length >= HARD_STOP_FAILURES,
    });
  }
  return out;
}

function requeueFailed(root: string, out: (s: string) => void): void {
  for (const { chainId, chain, last: d, failures, lastAt, exhausted } of pendingRetryChains(root)) {
    const de = d as DispatchEx;

    if (exhausted) {
      detail(`[监工] 派单“${String(de.title ?? d.action).slice(0, 30)}”已失败 ${failures} 次，停止重派（改写要求后重派，或执行 capitalist fix）`);
      continue;
    }
    /* 退避未到点：等下一拍，链仍是未完成状态，不判任务完成。 */
    if (Date.now() - lastAt < retryDelayMs(failures)) continue;

    const issued = issueDispatchId(root, d.id);
    if (!issued.id) {
      detail(`[监工] 补派未执行（${d.id}）：${issued.error?.message ?? "取号锁被占用"}`);
      continue;
    }
    const id = issued.id;
    const accept = retryAcceptOf(chain);
    /*
     * 卡点经 appendSection / BLOCKER_MARKER 写进 action 追加段：action 重启后必读，
     * 且会话指纹在 marker 之前截断，不计入该段。
     */
    const prevBlocker = failures > 0 ? findPreviousBlocker(root, { lineage: chainId }) : null;
    /* 重派剥离正文附件行并将 atts 清零，避免附件逐轮累积。 */
    const rec = deriveDispatch(d, {
      id,
      shard: "",
      action: prevBlocker
        ? appendSection(stripAttachments(String(d.action ?? "")), BLOCKER_MARKER, blockerLines(prevBlocker))
        : stripAttachments(String(d.action ?? "")),
      source: "adhoc",
      /* attempt 按整条链的失败次数计。 */
      attempt: failures + 1,
      urgent: true,
      atts: [],
      /* 继承 lineage，供下次重派识别同一件事。 */
      lineage: chainId,
      /* role=fix 的重派改用新会话，不复用上次修复的上下文。 */
      tags: d.tags ? (d.role === "fix" ? [`fix-${id.slice(-6)}`] : d.tags) : undefined,
      /* retry_accept 写入独立字段，不拼进 action：避免改变会话指纹导致上下文丢失。 */
      retryAccept: accept,
      /* 重派继承树边（含分组）、标题、标签、模型、角色与多前置。 */
      keys: ["tree", "title", "tags", "model", "role", "after"],
    });
    commitDispatch(root, rec);
    recordEvent(root, "dispatch_retry", {
      dispatch: id,
      shard: "",
      attempt: rec.attempt ?? 1,
      previous_failures: failures,
      source: "adhoc",
    });
    detail(
      `[监工] 重派 ${id}（第 ${rec.attempt} 次，上次 ${d.note ?? "失败"}）：` +
        `${String(de.title ?? d.action).slice(0, 40)}`,
    );
  }
}


/**
 * 读派单指定模型：只读不删，设定持续生效；清除由面板写空串删文件完成。
 * 空文件、坏文件或空 model 返回空串，调用方回落守卫与默认模型。
 */
export function readNextModel(root: string): string {
  const p = modelLoc.next(root);
  try {
    if (!existsSync(p)) return "";
    const j = readJson<{ model?: string }>(p, {});
    return String(j?.model ?? "").trim();
  } catch {
    return "";
  }
}


/** 派单被锁挡住超过该时长后照派，不让整批派单等待单个文件。 */
const LOCK_DEFER_MAX_MS = 300_000;
/** 同一张单“因锁延后”事件的记录间隔。 */
const LOCK_DEFER_LOG_MS = 60_000;
const lockDeferAt = new Map<string, { first: number; last: number }>();

/** 已上报的森林异常（成环 / 父节点缺失）。同一处只报一次；条件消失后摘除键，复发时再报。 */
const forestWarned = new Set<string>();

/** 上报成环与孤儿父节点：dependenciesSettled 对两者的处理是静默的。 */
function reportForestAnomalies(root: string, rows: Dispatch[], out: (s: string) => void): void {
  const f = dispatchForest(rows);
  const live = new Set<string>();
  /* 播报统一走调用方出口：直接调用 `detail` 会让传入的回调收不到。 */
  reportMultiPrereqOrphans(root, rows, f, live, out);
  for (const cyc of f.cycles) {
    const key = `cycle:${cyc.join(">")}`;
    live.add(key);
    if (forestWarned.has(key)) continue;
    recordEvent(root, "dispatch_cycle", { nodes: cyc, size: cyc.length });
    detail(`[监工] 派单依赖成环（${cyc.join("、")}）：这几单互相等待，没有一张会启动，需人工改树边`);
  }
  for (const id of f.orphans) {
    const row = rows.find((x) => String(x.id) === id);
    /*
     * 父节点是组号时不是孤儿：组没有自己的派单行，位置由成员合成（见森林视图）。
     * 若不跳过，每张挂组的派单每轮都会记一条“父节点不在台账里”，掩盖真正的孤儿。
     */
    if (row && isGroupRef(String(row.parent ?? ""))) continue;
    const key = `orphan:${id}`;
    live.add(key);
    if (forestWarned.has(key)) continue;
    recordEvent(root, "dispatch_parent_missing", { dispatch: id, parent: String(row?.parent ?? "") });
    detail(`[监工] ${id} 的父节点不在台账里：按已满足处理并放行，顺序可能比原计划靠前`);
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
      missing,
    });
    out(`[监工] ${r.id} 挂的前置 ${missing.join("、")} 不在台账里（可能已归档或台账被改）：依赖按已满足放行，顺序可能比原计划靠前`);
  }
}

/**
 * 这一单会读写的文件：从 action 抽取任务根内路径。取不到返回空，不参与锁预检。
 */
function targetFilesOf(root: string, d: Dispatch): string[] {
  return [...new Set(extractLocalPaths(String(d.action ?? ""), root))];
}

/** 返回第一处写锁冲突，供“在等谁”提示。 */
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
      detail(`[监工] 立即执行单 ${by} 的租约已丢失，按台账标记恢复 ${restored.length} 张让位单`);
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
    reason: "立即执行单已不运行中",
  });
  if (restored.length > 0) {
    detail(
      `[监工] 立即执行单 ${lease.dispatch} 已结束，按原顺序恢复 ${restored.length} 张让位单：` +
        restored.map((d) => d.id).join(" -> "),
    );
  }
}

/**
 * 立即执行真插队：挂起运行中进程腾出并发槽；promoteDispatch 只写台账排到队首。
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
  /* 只挑记录在且 pid 存活的进程；心跳过期未回收的仍算运行中。 */
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

  /* 顺序固定为先改台账、再改工作进程记录、最后结束进程；否则退出回调会按 failed 结束。 */
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
    shard: d.shard ?? "",
    victim: victim.id,
    victim_dispatch: victim.dispatch ?? "",
    victim_pid: victim.pid,
    how,
    locks,
    yielded: changed,
  });
  detail(
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
  policy: Policy,
  state: TaskState,
  host: WorkerHost,
  capacity: number,
  wopts: WorkerSpawnOpts,
  out: (s: string) => void,
): void {
  const hold = activeTakeover(root);
  /* 填槽前清理上一轮租约，让位标记会带偏排序。 */
  releasePreemptLease(root, detail);
  /* 森林异常每轮只检查一次：循环内重复检查会变成平方级开销。 */
  let forestChecked = false;
  for (;;) {
    /* 业务单受 capacity 约束；诊断/修复单多占一个槽（capacity + 1）。 */
    /*
     * 顺序只认台账 after，每轮从磁盘重算、不缓存；判定在 core 的 dependenciesSettled。
     * after 为 "*" 时等所有其它单到终态。
     */
    const allRows = readDispatches(root);
    /*
     * 组索引每轮按当前台账重算一次。挂组的派单必须靠它判定“整组是否做完”：缺索引时组号会被当成不存在的前置，按孤儿规则放行，成员还在排队时下游就已启动。
     */
    const gidx = groupIndexFrom(root, allRows);
    if (!forestChecked) {
      reportForestAnomalies(root, allRows, detail);
      forestChecked = true;
    }
    const open = allRows.filter(
      (x) =>
        x.status === "open" &&
        /* 暂停单不参与派发：用户的意图优先于队列顺序，只有唤醒后才重新进入候选。 */
        !dispatchPaused(x) &&
        isReady(x, allRows, gidx) &&
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
      const files = targetFilesOf(root, cand);
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
          shard: cand.shard ?? "",
          file: blocked.path,
          holder: blocked.holder,
          waited_sec: Math.round(waited / 1000),
        });
        detail(
          `[监工] ${cand.id} 的目标文件 ${blocked.path} 被 ${blocked.holder} 占用已 ${Math.round(waited / 1000)}s，` +
            "不等待：照常派发，由工作进程自行竞争文件锁（未取得锁会收到处理指引）",
        );
        d = cand;
        break;
      }
      if (!seen || nowMs - seen.last >= LOCK_DEFER_LOG_MS) {
        recordEvent(root, "dispatch_deferred_lock", {
          dispatch: cand.id,
          shard: cand.shard ?? "",
          file: blocked.path,
          holder: blocked.holder,
        });
        detail(`[监工] ${cand.id} 暂不派：${blocked.path} 正被 ${blocked.holder} 写入，等待释放`);
      }
    }
    if (!d) return;
    const special = d.role === "fix" || d.role === "diagnose";
    const cap = special ? capacity + 1 : capacity;
    /* 占槽按活进程数与待裁决单数之和计算；待裁决单最多占 VERDICT_HOLD_MS。 */
    const taken = () => liveWorkers(root).length + awaitingVerdict(allRows);
    if (taken() >= cap) {
      if (!preemptForImmediate(root, d, detail)) return;
    }
    if (taken() >= cap) return;
    if (!launch(root, policy, state, d, host, wopts, detail)) break;
    lockDeferAt.delete(d.id);
  }
}

/**
 * 派单方声明的标题（`TITLE:` 行）：有就照用，没有返回空串让调用方走摘要。
 *
 * 这里只做三件清理：合并换行与多余空白、丢掉不含汉字的值、拦住异常长文。
 * 不按建议字数截断：31 字与 30 字是同一件事，按字数砍会砍掉读者需要的那半句。
 */
function declaredTitle(d: SupervisorDirective | undefined): string {
  const t = String(d?.title ?? "").replace(/\s+/g, " ").trim();
  if (!t || !/[\u4e00-\u9fa5]/.test(t)) return "";
  const chars = Array.from(t);
  return chars.length > TITLE_MAX_CHARS ? `${chars.slice(0, TITLE_MAX_CHARS).join("")}…` : t;
}

/**
 * 取这张单第一次登记时的标题：标题只在建单时定一次，重派按同分片、同来源找回。
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
 * 派单模型：分片 model -> 契 default_model -> --worker-model 任一指定即固定使用；
 * 全未指定时在宿主声明的快速档模型间轮换。候选取自宿主 CLI 输出的 `--model` 取值，
 * 宿主升级模型后无需改代码；清单不可用时按静态常量作默认值，取不到交集则交给宿主默认。
 */
function defaultDispatchModel(root: string, resolved: string | undefined): string | undefined {
  /* 面板选过的派单模型常驻且优先于启动参数。 */
  const pinned = readNextModel(root);
  if (pinned) return pinned;
  if (resolved) return resolved;
  let host = "";
  try {
    host = String(loadSupervisor(root)?.worker_host ?? "").trim();
  } catch {
    host = "";
  }
  if (!host) return nextRotatingDefaultModel(root, DEFAULT_MODEL_ROTATION);
  /*
   * 宿主清单里的快速档包含档位别名（`fast-model`），其中多项在禁用名单内。
   * 这类值选出后仍会被换成默认档，并每次写一条回退记录，因此在筛选时先剔除。
   */
  const allowed = (list: string[]): string[] =>
    list.filter((m) => !resolveModel({ root, host, wanted: m }).denied);
  const live = allowed(rotationCandidates(host));
  if (live.length > 0) return nextRotatingDefaultModel(root, live);
  /* 默认只取宿主自述支持的模型，避免把其它宿主的模型名派过去。 */
  const known = byId(host)?.knownModels ?? [];
  const fallback = allowed(DEFAULT_MODEL_ROTATION.filter((m) => known.includes(m)));
  return fallback.length > 0 ? nextRotatingDefaultModel(root, fallback) : undefined;
}

/** 领单先于拉起工作进程：启动失败的单不留成 open 被重复领取。 */
function launch(
  root: string,
  policy: Policy,
  state: TaskState,
  d: Dispatch,
  host: WorkerHost,
  wopts: WorkerSpawnOpts,
  out: (s: string) => void,
): boolean {
  /* 暂停单不启动。fillSlots 已过滤，此处拦截其它入口：重派、补投递、看板指令均经过 launch。 */
  if (dispatchPaused(d)) return false;
  // 同一分片已有存活进程时拒绝再拉。返回 false 使本轮不再找下一张 open 单，该单留到下一轮调度。
  /* 有分片按分片判重；无分片按派单 id 判重。 */
  const dup = listWorkers(root).find(
    (w) =>
      (w.status === "running" || w.status === "starting") &&
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
        shard: d.shard ?? "",
        existing_worker: dup.id,
        existing_pid: dup.pid,
      },
      { key: d.id, windowMs: 5 * 60_000 },
    );
    detail(`[监工] 拒绝启动：${d.shard || "整单"} 已有存活 worker ${dup.id}（pid ${dup.pid}）`);
    return false;
  }

/* 文件冲突由会话规避：同类任务共用一条会话，同一会话内串行持有文件。 */

  /*
   * 进程号与领单在同一临界区内完成：号一旦算出就先落到派单的 worker 字段上，
   * 后来者读到的已占号集合必然包含它，不会两个进程同时拿到 `2-P1`。
   * 锁键带任务号（`worker-2`），不同任务的拉起互不排队。
   */
  const taskNo = taskNoOfDispatchId(String(d.id ?? ""));
  const alloc = (): { id: string; claimed: Dispatch | null } => {
    const wid = newWorkerId(root, d.id);
    /*
     * 领号即占位；只有“领走了这张单”才算真正用掉该号。领不到或中途抛错都立即释放，
     * 保证拉起失败的号下次还能用（进程号不因失败而 +1）。
     */
    try {
      const c = claimDispatch(root, d.id, wid, wid);
      if (!c) releaseWorkerNo(root, wid);
      return { id: wid, claimed: c };
    } catch (e) {
      releaseWorkerNo(root, wid);
      throw e;
    }
  };
  let alloced: { id: string; claimed: Dispatch | null };
  try {
    alloced = taskNo > 0 ? withNoLock(root, `worker-${taskNo}`, alloc) : alloc();
  } catch (e) {
    if (e instanceof NoLockTimeoutError) {
      out(`[监工] 取进程号失败，本轮不拉起：${e.message}`);
      return false;
    }
    throw e;
  }
  const id = alloced.id;
  const claimed = alloced.claimed;
  if (!claimed) {
    /* 单已被别的入口领走：本次没拉起进程，号释放，下次仍可用同一个（失败不消耗进程号）。 */
    releaseWorkerNo(root, id);
    return true;
  }

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
    detail(`[监工] ${modelPick.why}`);
  }

  try {
    /*
     * 拉起进程前领一次插话：工作进程启动后追加的内容只进 direct 队列，不自动进入派单。
     * 验收清单只拼 done=false 的条目。
     */
    const takenNow = claimDirectives(root, {
      shard: claimed.shard ?? "",
      dispatchId: claimed.id,
      /* 按派生链领取：对 A 的追加只归 A 链；无分片插队单不传 lineage 会误归到别的单。 */
      lineage: String((claimed as DispatchEx).lineage ?? claimed.id),
      /* 按线程键认领追加，键与看板显示的编号同源。 */
      lane: laneKeyOf(claimed as { shard?: string | null; lineage?: string; id?: string }),
    });
    /*
     * action 以守卫当前值为准，不用派单快照：复用旧 open 单重派时快照仍是旧文字。
     * 分片已不在守卫时回落快照，且不再叠验收清单，避免清单重复。
     */
    /*
     * 附件按声明重建，不从正文解析：派单 atts 优先（空数组表示明确不带），其次 src_msg 回查，
     * 再按本轮插话的 atts 或 msg_id 补入；顺序为固化附件 -> 本轮插话，不设张数上限。
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

    const composed = withCopyStandard(root, spliceDirectives(claimed.action, takenNow));
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
      /* 令牌优先取启动时传入的令牌；未传入时取当前可用的令牌，取不到按沿用宿主登录态处理。 */
      token: wopts.token ?? officialAccessToken(),
    };
    // 可见窗口依赖 cmd.exe 与 .cmd，仅 Windows 可用；其它平台回落后台模式。
    const wantVisible = wopts.visible && process.platform === "win32";
    if (wopts.visible && !wantVisible) {
      detail(t("[supervisor] visible windows are Windows-only; starting in the background instead", "[监工] 可见窗口只在 Windows 可用，本次按后台模式启动。"));
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
      shard: claimed.shard ?? "",
      model: model ?? "",
      mode: record.mode ?? "background",
    });
    detail(
      `[监工] 拉起 worker ${record.id}（pid ${record.pid}，${host}${
        record.mode === "visible" ? "，可见窗口" : ""
      }）-> ${claimed.id}${model ? ` 模型=${model}` : ""}`,
    );

    // 可见窗口模式不持有 child 句柄，退出状态由工作进程自行上报。
    child?.on("exit", (code) => {
      const rec = loadWorker(root, id);
      if (rec) {
        /* suspended 是让位而非退出，不按退出码改写状态，否则与失败混淆。 */
        if (rec.status !== "suspended") {
          saveWorker(root, { ...rec, status: code === 0 ? "exited" : "failed", exit_code: code ?? -1 });
        }
        /* 上下文占用写回会话，供下次判定续接或换代；读数取日志 result 行，不估算。 */
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
      // 退出立即结束：等下一轮收割期间该单仍算在途，会挡住完成判定与重派。
      const cur = readDispatches(root).find((x) => x.id === claimed.id);
      if (cur?.status === "claimed") {
        const why = workerExitReason(root, id, code);
        if (isQuotaText(why)) markQuotaExhausted(root, why);
        failDispatchAndJudge(root, claimed, why, detail);
        recordEvent(root, "dispatch_reaped", {
          dispatch: claimed.id,
          shard: claimed.shard ?? "",
          worker: id,
          exit_code: code ?? -1,
          reason: why,
        });
        /* 登录态不可用时 failDispatchAndJudge 已判定失败，此处不提示等待重派。 */
        const tail = why === AUTH_REQUIRED_TEXT ? "已判定失败" : "已结束，等待重派";
        detail(`[监工] worker ${id} 退出（code ${code ?? "?"}），派单 ${claimed.id} ${tail}`);
      }
    });
  } catch (err) {
    /* 拉起失败：该进程号作废可再用，派单号已 +1 的语义不变。 */
    releaseWorkerNo(root, id);
    failDispatchAndJudge(root, claimed, `worker 启动失败：${String((err as Error).message ?? err)}`, detail);
    recordEvent(root, "worker_launch_failed", { dispatch: claimed.id, error: String((err as Error).message ?? err) });
    detail(`[监工] 启动 worker 失败：${String((err as Error).message ?? err)}`);
  }
  return true;
}



/**
 * 把目标单已终结的未消费追加翻回队列：判据为插话未消费、明确指向某张单、该单不在途。
 * 无 target 的老记录不推断归属。
 *
 * 只有失败的单会重开新单；完成与被用户关掉的单保持终态，这类追加标记为不再投递并写明原因，
 * 否则它们会一直挂在队列里每拍重试一次。
 */
export function drainSettledDirectives(
  root: string,
  out: (s: string) => void = () => {},
  policy?: Policy,
): string[] {
  const live = new Set(["open", "claimed", "reported", "review"]);
  const rows = readDispatches(root);
  const byId = new Map(rows.map((d) => [String(d.id), d]));
  const reopened: string[] = [];
  const dropped = new Set<string>();

  /*
   * 派生链上已有在途单时不再重开。
   *
   * 重开是发新单、旧单保持终态，所以指令的 target 仍指着旧单；没有这条判据，同一条未消费
   * 追加会在每一拍都开一张新单。追加本身会由新单在启动时按 lineage 领走。
   */
  const chainOf = (d: Dispatch): string => String((d as Dispatch & { lineage?: string }).lineage ?? d.id);
  const liveChains = new Set(
    rows.filter((d) => live.has(String(d.status ?? ""))).map((d) => chainOf(d)),
  );
  for (const r of listDirectives(root)) {
    if (r.consumed) continue;
    const target = String((r as { target?: unknown }).target ?? "");
    if (!target) continue;
    if (dropped.has(target)) continue;
    const d = byId.get(target);
    if (!d) continue;
    const st = String(d.status ?? "");
    if (live.has(st)) continue;
    if (reopened.includes(target)) continue;
    /* 同一派生链已有在途单：这条追加等它启动时领走，不再重复开单。 */
    if (liveChains.has(chainOf(d))) continue;

    /*
     * 补投递只救失败的单：完成、关闭、被接替都是终态。终态单不再复活，但追加不能一直
     * 挂在队列里每拍重试一次，必须标记为未投递并写明原因。
     */
    if (st !== "failed") {
      const why = `目标单 ${target} 已终结（${st}），追加无处投递`;
      const marked = dropDirectivesFor(root, target, why);
      dropped.add(target);
      if (marked.length > 0) {
        recordEvent(root, "directive_dropped", {
          dispatch: target,
          from: st,
          count: marked.length,
          reason: why,
        });
        detail(`[监工] 追加内容无法投递：目标单 ${target} 已终结（${st}），${marked.length} 条已标记不再重投`);
      }
      continue;
    }
    const why = `追加内容补投递（${st} -> 重开）`;
    const fresh = reopenSettledDispatch(root, target, why);
    if (!fresh) {
      detail(`[监工] 追加补投递未执行：${target} 重开失败（该单已在执行，或取号锁被占用）`);
      continue;
    }
    recordEvent(root, "directive_reopen", {
      dispatch: fresh.id,
      source: target,
      from: st,
      text: String(r.text ?? "").slice(0, 200),
    });
    detail(`[监工] 追加的目标单 ${target} 已终结（${st}），已开新单 ${fresh.id} 补投递`);
    reopened.push(fresh.id);
    /* 同一轮里该链后续的追加都归这张新单，不再各开一张。 */
    liveChains.add(chainOf(fresh));
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
 * 重派计数起算点取 retry_resets 两档最大值：`*` 全局、分片名 单分片。
 * 两档都没有时返回 0，统计全部历史。
 */
function retryResetMs(state: TaskState, shard: string): number {
  const map = (state.retry_resets ?? {}) as Record<string, string>;
  const pick = (k: string): number => {
    const t = Date.parse(map[k] ?? "");
    return Number.isFinite(t) ? t : 0;
  };
  return Math.max(pick("*"), pick(String(shard ?? "")));
}

/**
 * 第 n 次失败后的等待时长：第 n 级阶梯值叠加 ±{@link retryJitterRatio} 的随机抖动，封顶到阶梯末级。
 * `rand` 供测试注入，缺省用 Math.random。
 */
function retryDelayMs(failures: number, rand: () => number = Math.random): number {
  if (failures <= 0) return 0;
  const delays = retryDelaysMs();
  const index = Math.min(failures - 1, delays.length - 1);
  const base = delays[index] ?? 0;
  if (!(base > 0)) return 0;
  const ratio = retryJitterRatio();
  const jittered = ratio > 0 ? base * (1 + (rand() * 2 - 1) * ratio) : base;
  const ceiling = delays[delays.length - 1] ?? base;
  return Math.max(0, Math.min(Math.round(jittered), Math.round(ceiling)));
}

function terminateWorkers(root: string, out: (s: string) => void): void {
  for (const w of listWorkers(root)) {
    if (w.status !== "running" && w.status !== "starting") continue;
    // 可见窗口属用户会话，监工退出时不关闭。
    if (w.mode === "visible") {
      detail(`[监工] 可见窗口 worker ${w.id} 保留运行（pid ${w.pid}），需要时手动关闭`);
      continue;
    }
    // 先软后强并确认退出，避免残留进程。
    const how = killWorkerPid(w.pid);
    if (how === "unconfirmed") {
      detail(`[监工] worker ${w.id}（pid ${w.pid}）终止后仍未确认退出，可能有残留进程`);
    }
    saveWorker(root, { ...w, status: "exited" });
    detail(`[监工] 已停 worker ${w.id}（pid ${w.pid}）`);
  }
}

/**
 * 停掉全部存活工作进程。只停进程，不改派单：派单状态由 `pauseLiveDispatches` 统一改写，
 * 两处都改会让“运行中退回排队”的 note 与 `paused_from` 出现两种口径。
 *
 * 两处调用：暂停每轮补停，启动接管时清理上次退出留下的进程。可见窗口模式不代关；
 * 无 running/starting 进程时直接返回。
 */
function stopLiveWorkers(root: string, out: (s: string) => void): void {
  const live = listWorkers(root).filter((w) => w.status === "running" || w.status === "starting");
  if (live.length === 0) return;
  for (const w of live) {
    if (w.mode === "visible") {
      detail(`[监工] 暂停：可见窗口工作进程 ${w.id}（pid ${w.pid}）保留，窗口由人工管理`);
      continue;
    }
    const how = killWorkerPid(w.pid);
    saveWorker(root, { ...w, status: "exited" });
    recordEvent(root, "worker_paused", {
      worker: w.id,
      dispatch: w.dispatch ?? "",
      pid: w.pid,
      how,
    });
    detail(`[监工] 已暂停 worker ${w.id}（pid ${w.pid}）${how === "unconfirmed" ? "，终止后未确认退出，可能有残留" : ""}`);
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
  detail(
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

/** 判定层重做预算：同一派生链上 requeue/reject 最多 2 次，与调度层的失败次数分开计数。 */
const TRIAGE_REDO_LIMIT = 2;
const triageRedo = new Map<string, number>();
/** 已转人工裁决的派生链：同一件事只登记一次。 */
const triageEscalated = new Set<string>();

/** 判定池并发上限 2；判定在调度轮次外异步执行，池子只决定后台消化速度。 */
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
 * 无结论的记为“未给结论”，验收按未完成处理。
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
    const ref = directiveShortRef(r);
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
  policy: Policy;
  state: TaskState;
  out: (s: string) => void;
}): Promise<void> {
  const { root, policy, state, out } = args;
  const { messages, nextOffset, skipped } = readPendingMq(root);
  if (skipped > 0) {
    detail(`[监工] 申报队列有 ${skipped} 行无法解析，已跳过（不影响后续消息）`);
  }
  if (messages.length === 0) {
    commitCursor(root, nextOffset);
    return;
  }

  for (const msg of messages) {
    /* 申报跳转要用派单记录的派生链（lineage）构造线程键，不能用派单号（`2-1` 与 lineage `1-1` 不同）。 */
    const src = msg.dispatch ? readDispatches(root).find((x) => x.id === msg.dispatch) : undefined;
    const srcLineage = String((src as (Dispatch & { lineage?: string }) | undefined)?.lineage ?? "");
    recordEvent(root, "mq_message", {
      id: msg.id,
      from: msg.from,
      dispatch: msg.dispatch,
      shard: msg.shard,
      ...(srcLineage ? { lineage: srcLineage } : {}),
      kind: msg.kind,
      severity: msg.severity,
      needs: msg.needs,
      text: String(msg.text ?? "").slice(0, 400),
      evidence: msg.evidence ? String(msg.evidence).slice(0, 600) : "",
    });
    detail(
      `[监工] 申报 ${msg.from || "?"} - ${msg.kind}（${msg.severity}）：` +
        `${String(msg.text ?? "").slice(0, 70)}`,
    );

    if (!worthTriaging(msg)) continue;
    /*
     * 去重分两道：消息 id 挡游标回退导致的重读；from|kind 时间窗挡同类连发。
     * done 只受 id 约束：打回后重报是新事实，用时间窗合并会丢失。
     */
    if (msg.id) {
      if (triagedIds.has(msg.id)) {
        detail(`[监工] 这条申报已经判过（${msg.id}），只记录不重复判`);
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
        detail(`[监工] 同类申报刚判过（${key}），这条只记录不重复判`);
        continue;
      }
      triagedAt.set(key, Date.now());
    }

    const dispatches = readDispatches(root);
    const d = dispatches.find((x) => x.id === msg.dispatch);
    const same = dispatches.filter(
      (x) => (x.shard ?? "") === (msg.shard ?? "") && x.status === "failed",
    );
    /*
     * 同一轮调度内只做同步读盘，判定异步入池：同步等待会拖住收割与派单。
     * 并发由 TRIAGE_POOL_MAX 限制。
     */
    enqueueTriage(root, async () => {
      /* 判定层同时接收 added_reqs 与定向到该单（或该链）的插话，避免按旧口径审新增要求。 */
      const addedReqs = d && Array.isArray(d.added_reqs) ? d.added_reqs.map(String) : [];
      /*
       * 工作区变动在异步池内采集：git 调用走外部进程，放在调度轮次内会拖住调度。
       * 非版本控制目录返回空数组。
       */
      const workspace = await workspaceFacts(root);
      const verdict = await triage({
        root,
        msg,
        action: String(d?.action ?? ""),
        failures: same.length,
        live: liveWorkers(root).length,
        capacity: Math.max(1, Number(loadSupervisor(root)?.max_workers ?? 1) || 1),
        acceptance: String(d?.acceptance ?? ""),
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
      detail(`[监工] 判定 ${msg.kind}：${verdict.decision}。${verdict.why.slice(0, 90)}`);
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
     * 判定通道不可用时，done 申报按现状结束并在 note 注明未经复核；失败申报仍走 retry。
     */
    const target = msg.dispatch ? readDispatches(root).find((x) => x.id === msg.dispatch) : undefined;
    const kind = String(msg.kind ?? "");
    if (kind === "done" && target && target.status === "reported") {
      const rawNote = String((target as Dispatch & { review_note?: string }).review_note ?? "").trim();
      const why = verdict.error
        ? `判定通道不可用（${verdict.error.slice(0, 160)}），未经 AI 复核，按现状结束`
        : "判定通道不可用，未经 AI 复核，按现状结束";
      const merged = rawNote ? `${rawNote}\n\n（${why}）` : why;
      if (finishDispatch(root, target.id, "done", merged)) {
        recordEvent(root, "dispatch_done_unreviewed", {
          dispatch: target.id,
          shard: target.shard ?? "",
          worker: target.worker ?? "",
          msg: msg.id,
          error: verdict.error ?? "",
        });
        detail(`[监工] 判定通道异常，${target.id} 按现状结束（注明未经复核）：${String(verdict.error ?? "").slice(0, 90)}`);
        return;
      }
    }
    detail("[监工] 判定通道异常，本条不执行任何动作（只记录）");
    return;
  }

  /*
   * 防死循环三道闸，仅对有调度副作用的结论生效：同一派生链 requeue/reject 最多 2 次，超限降级 escalate；
   * 同种结论 5 分钟内只执行一次；同一派生链只登记一条 ask。
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
      detail(
        t(
          `[supervisor] verdict ${verdict.decision} repeated ${done - 1} times (chain ${chainKey}); downgraded to a user decision; redoing it would repeat the same failure`,
          `[监工] 判定 ${verdict.decision} 已重复 ${done - 1} 次（链 ${chainKey}），降级为人工裁决。继续重做只会重复同一个失败`,
        ),
      );
      if (!triageEscalated.has(chainKey)) {
        triageEscalated.add(chainKey);
        raiseAsk(
          root,
          `【反复重做无效】${String(msg.text ?? "").slice(0, 260)}`,
          `同一件事已重做 ${done - 1} 次仍不见效（链 ${chainKey}）。最后一次判定理由：${verdict.why}`,
          msg.shard,
        );
      }
      return;
    }
  }

  if (verdict.decision === "escalate" && triageEscalated.has(chainKey)) {
    detail(`[监工] 这条链（${chainKey}）已经转人工裁决过，不重复登记 ask`);
    return;
  }

  if (verdict.decision === "nudge") {
    const text = String(verdict.say ?? "").trim();
    if (!text) {
      detail("[监工] 判定 nudge 未附说明文字，跳过（不推断意图）");
      return;
    }
    /* nudge 定向写入 target 与 lineage：重派后的同派生链新单仍能领取，其它单领不到。 */
    const rec = appendDirective(root, {
      text,
      target: msg.dispatch,
      shard: msg.shard || null,
      ...(chainKey ? { lineage: chainKey } : {}),
      /* via 标为 capitalist：回显时按监工来源渲染。 */
      via: "capitalist",
      /* 分诊结论是监工发给工作进程的指令，正文面向执行，界面只显示转告内容。 */
      audience: "worker",
    });
    return;
  }

  if (verdict.decision === "requeue") {
    const d = readDispatches(root).find((x) => x.id === msg.dispatch);
    if (d && (d.status === "claimed" || d.status === "open")) {
      finishDispatch(root, d.id, "failed", `监工判定重开：${verdict.why}`.slice(0, 200));
      detail(t(`[supervisor] closed ${d.id} as failed per the verdict; re-dispatched with the new wording after backoff`, `[监工] 按判定把 ${d.id} 结为 failed，等退避后按新口径重派`));
    }
    return;
  }

  if (verdict.decision === "pause_shard") {
    if (!msg.shard) {
      detail(t("[supervisor] pause verdict has no shard to stop; handled as escalate", "[监工] 判定暂停但这条申报没有分片归属，无法只停一片，按 escalate 处理"));
      raiseAsk(root, `【${msg.kind}】${String(msg.text).slice(0, 300)}`, verdict.why, "");
      return;
    }
    takeoverShard(root, { shard: msg.shard, reason: `监工判定暂停：${verdict.why}`, by: "supervisor" });
    detail(t(`[supervisor] shard ${msg.shard} paused (manual takeover); reason: ${verdict.why}`, `[监工] 分片 ${msg.shard} 已暂停（人工接管态），原因：${verdict.why}`));
    return;
  }

  if (verdict.decision === "escalate") {
    raiseAsk(
      root,
      `【${msg.kind}】${String(msg.text ?? "").slice(0, 300)}`,
      `来自 ${msg.from || "?"}｜监工判断：${verdict.why}`,
      msg.shard,
    );
    /*
     * 报完成的单转人工时挂起，不再自动重派：继续跑同一件事只会重复同一个结论，
     * 而任务本身要求用户先决定（权限、口径、外部依赖）。挂起后占住所属分片，
     * 不会补出新单；用户答复后在看板唤醒，或 capitalist wake --user。
     */
    const d = readDispatches(root).find((x) => x.id === msg.dispatch);
    if (d && (d.status === "reported" || d.status === "review")) {
      const reason = `等用户决策：${verdict.why}`.slice(0, 160);
      patchDispatch(root, d.id, {
        status: "open",
        paused_at: new Date().toISOString(),
        paused_by: "supervisor",
        paused_reason: reason,
        note: reason,
      } as Partial<Dispatch>);
      detail(t(`[supervisor] escalated to the user: ${d.id}; ${verdict.why.slice(0, 120)}`, `[监工] ${d.id} 已转用户决策：${verdict.why.slice(0, 120)}`));
    }
    detail(`[监工] 已转人工裁决（${msg.kind}）`);
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
      writeJson(inboxLoc.reject(root, d.id), {
        at: new Date().toISOString(),
        why: String(verdict.why ?? ""),
        by: "supervisor",
      });
      recordEvent(root, "review_rejected_inline", {
        dispatch: d.id,
        worker: d.worker ?? "",
        why: String(verdict.why ?? "").slice(0, 200),
      });
      detail(`[监工] 报告打回 ${d.id}：原进程仍在，报告就地退回继续修改（不重派）`);
      return;
    }
    /*
     * 原进程已退出：开一张新单，让工作进程带着打回结论继续做未通过的部分。
     * 结为 failed 会让这张单停在终态；守卫外的单没人重派，报告里的问题就此无人跟进。
     * 新单是新的一次派单，派单号 +1，旧单保持原终态。
     */
    const why = `报告未通过审查：${verdict.why}`.slice(0, 200);
    const reopened = reopenSettledDispatch(root, d.id, why);
    if (!reopened) {
      detail(`[监工] 报告打回 ${d.id}，但重开失败：该单已在执行，或取号锁被占用`);
      return;
    }
    /* 打回结论写进卡点段：新单据此知道上一轮哪一处没通过。 */
    patchDispatch(root, reopened.id, {
      retry_context: buildSkipBlocker({ review_note: why }),
      review_note: why,
    } as Partial<Dispatch>);
    recordEvent(root, "review_rejected_reopened", {
      dispatch: reopened.id,
      source: d.id,
      shard: d.shard ?? "",
      worker: d.worker ?? "",
      why: String(verdict.why ?? "").slice(0, 200),
    });
    detail(`[监工] 报告打回 ${d.id}：已开新单 ${reopened.id}，下一轮继续做未通过的部分`);
    return;
  }

  if (verdict.decision === "accept") {
    const d = readDispatches(root).find((x) => x.id === msg.dispatch);
    if (!d) {
      detail(t("[supervisor] verdict accepted, but the dispatch no longer exists (it may have been closed manually)", "[监工] 裁决通过，但该派单已不存在（可能已被手动结束）"));
      return;
    }
    const done = finishDispatch(root, d.id, "done", `监工裁决通过：${verdict.why}`.slice(0, 200));
    detail(done ? t(`[supervisor] verdict accepted; ${d.id} closed`, `[监工] 裁决通过，${d.id} 已结束`) : t(`[supervisor] verdict accepted, but ${d.id} is already terminal; nothing changed`, `[监工] 裁决通过，但 ${d.id} 已是终态，未改动`));
  }
}


/** 暂停标记的类型、路径与读取实现在 `core/record/pause.ts`，此处仅对外转发。 */
export { type PauseFile, pausePath, readPause };


/** 在途派单：已派出但尚未结束。 */
const LIVE_DISPATCH_STATUS = new Set(["open", "claimed", "reported", "review"]);

function inFlightCount(root: string): number {
  return readDispatches(root).filter((d) => LIVE_DISPATCH_STATUS.has(String(d.status ?? ""))).length;
}

/** 结束状态词；台账状态到界面词只在这里转换一次。 */
function closedWord(d: Dispatch): string {
  const s = String(d.status ?? "");
  if (s === "done") return "已完成";
  if (s === "failed") return "失败";
  if (s === "superseded") return "已作废";
  if (s === "closed") return String(d.closed_by ?? "") === "user" ? "已取消" : "已结束";
  return "已结束";
}

/** 单张派单的耗时：认领到结束，未认领时按建单时刻起算。 */
function spentOf(d: Dispatch): string {
  const start = Date.parse(String(d.claimed_at ?? d.at ?? ""));
  const end = Date.parse(String(d.done_at ?? (d as { closed_at?: string }).closed_at ?? ""));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "";
  const min = Math.round((end - start) / 60_000);
  return min >= 1 ? `${min} 分钟` : "不足 1 分钟";
}

/**
 * 队列清空后的台账事实。
 *
 * 供模型写总结，也作模型不可用时的回落正文：只列结局、耗时与结束原因，不作评价。
 */
function runFacts(root: string): { facts: string; count: number } | null {
  const rows = readDispatches(root);
  if (rows.length === 0) return null;
  const done = rows.filter((d) => String(d.status ?? "") === "done").length;
  const failed = rows.filter((d) => String(d.status ?? "") === "failed").length;
  const closed = rows.filter((d) => {
    const s = String(d.status ?? "");
    return s === "closed" || s === "superseded";
  }).length;
  const parts = [`完成 ${done}`];
  if (failed) parts.push(`失败 ${failed}`);
  if (closed) parts.push(`结束或作废 ${closed}`);
  const lines: string[] = [`台账累计 ${rows.length} 张派单，全部结束：${parts.join("、")}。`];
  /* 只列最近 8 张：更早的单已在上轮总结里出现过，重复列出会把消息区撑长。 */
  for (const d of rows.slice(-8)) {
    const label = dispatchNoLabel(root, d.id);
    const body = String(d.action ?? "").replace(/\s+/g, " ").trim();
    const title = String((d as { title?: string }).title ?? "").trim() || body.slice(0, 24) || d.id;
    const spent = spentOf(d);
    const why =
      String(d.status ?? "") === "superseded" || String(d.status ?? "") === "closed"
        ? String(d.note ?? "").trim()
        : "";
    lines.push(
      `· ${label || d.id} ${title}${spent ? `（${spent}）` : ""}：${closedWord(d)}` +
        `${why ? `（${why}）` : ""}`,
    );
  }
  /*
   * 不写任务树坐标：用户看的是“单做完了没有”。
   * 写进 facts 会被总结照抄成“当前停在第一层的第二个节点”，读的人还得回头数树。
   */
  lines.push("没有在途单。");
  return { facts: lines.join("\n"), count: rows.length };
}

/** 总结正文交给监工模型写；通道不可用时回落台账事实，并说明原因。 */
async function summaryText(root: string, facts: string): Promise<string> {
  const prompt = [
    "【任务：写结束总结】",
    "下面这些派单已全部结束。把台账事实归纳成一段话，给用户看。",
    "",
    facts,
    "",
    "写法：",
    "  · 开头一句话交代整体：派单总数、成功数及失败数。",
    "  · 中间仅说明失败项；成功项不逐条复述。",
    "  · 结尾一句话确认台账中没有在途派单。",
    "  · 只写上面存在的内容。不推测原因，不作评价，不列改进建议。",
    "  · 不逐条抄编号与状态，不用列表符号，不用感叹号。",
    "  · 用与用户相同的语言。",
  ].join("\n");
  const r = await askModel({
    prompt,
    /* 每次单独起会话：总结不该把上一批的内容带进来。 */
    sessionId: brainSessionOf(root, `capitalist-summary-${Date.now()}`).id,
    cwd: root,
    timeoutMs: 120_000,
    effort: "high",
    model: supervisorModelOf(root),
  });
  if (!r.ok) {
    const why = String(r.text ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    return `总结通道不可用${why ? `：${why}` : ""}。以下为台账摘要。\n${facts}`;
  }
  const text = r.text.trim();
  if (!text) return `总结通道未返回内容。以下为台账摘要。\n${facts}`;
  return text;
}

/**
 * 队列清空后写一条结束总结。
 *
 * 正文由监工模型生成，模型不可用时退回台账事实并写明原因。
 */
async function summarizeRun(root: string, out: (s: string) => void): Promise<void> {
  const f = runFacts(root);
  if (!f) return;
  const text = await summaryText(root, f.facts);
  recordEvent(root, "supervisor_reply", { reply: text, thread: "", msg_id: msgId("S0", "S2U") });
  detail(`[监工] 队列已清空，已写结束总结（${f.count} 张派单）`);
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
    // 只读末尾 256KB：日志可能数百 MB，全量读取会拖住调度轮次。
    const want = Math.min(size, 256 * 1024);
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(want);
    try {
      readSync(fd, buf, 0, want, size - want);
    } finally {
      closeSync(fd);
    }
    /* 先过滤宿主周期性噪声再统计重复；噪声表复用 workerLog.ts，避免与看板各写一份规则。 */
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
 * 机械检测只作触发器，是否判定失败由模型复查日志末尾后决定。
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
    "判断工作进程是否陷入循环。",
    "",
    "【该工作进程本单任务】",
    String(args.action || "（未记录）").slice(0, 400),
    "",
    `【该进程日志末尾 ${args.tail.length} 行${clean.dropped ? `（其中 ${clean.dropped} 行思考过程已略去）` : ""}】`,
    shown,
    "（以上节选已去掉思考过程并按字符上限截断，展示行数可能少于标题行数。）",
    "判断标准：日志持续更新、任务推进、产出不同结果 -> 推进；反复输出相同内容、相同命令或",
    "相同报错且无新信息 -> 循环。",
    "",
    "只回答一个词：循环 / 推进。不要解释，不要加标点。",
  ].join("\n");

  const r = await askModel({
    prompt,
    /* sessionId 走判定脑的会话，同一进程复用同一条，换代判据与其它判定一致。 */
    sessionId: brainSessionOf(args.root, `capitalist-loopcheck-${args.worker}`).id,
    cwd: args.root,
    timeoutMs: 60_000,
    effort: "high",
    model: supervisorModelOf(args.root),
  });
  if (!r.ok) return { kill: false, why: `模型复查通道不可用（${r.text.slice(0, 80)}）`, reviewed: false };
  const t = r.text.trim();
  const saysLoop = /循环|loop/i.test(t);
  const saysProgress = /推进|progress|正常/i.test(t);
  if (saysLoop && !saysProgress) return { kill: true, why: t.slice(0, 120), reviewed: true };
  return { kill: false, why: t.slice(0, 120) || "（模型未说明理由）", reviewed: true };
}

/* 用关键词近似判定本单是否涉及用户可见文案；是否注入文案规范由项目记忆里有没有该条目决定。 */
const COPY_HINT_RE =
  /界面|页面|文案|提示语|提示文字|按钮|菜单|标题|标签|占位|placeholder|toast|弹窗|对话框|看板|文档|帮助|报错信息|错误提示|显示文字|措辞|\bui\b/i;

function involvesUserVisibleCopy(action: string): boolean {
  return COPY_HINT_RE.test(String(action ?? ""));
}

/**
 * 文案规范措辞存于 .capitalist/config/memory.json（识别词见 memory.ts 的 COPY_STANDARD_MARKER），记忆里有才追加。
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
  launch,
  handleModelFallback,
  shardRetry,
  retryDelayMs,
  retryDelaysMs,
  summarizeRun,
  killWorkerPid,
  pauseRun,
  killJudgedWorker,
  pausePath,
  readPause,
  applySupervisorDirectives,
  reportForestAnomalies,
  cascadeFailure,
  diagnoseFailure,
  failDispatchAndJudge,
  workerExitReason,
  REDISPATCH_LIMIT,
  requeueFailed,
  rescueOrphanDirectives,
  reopenSettledDispatch,
  writePauseFile,
  clearPauseFile,
  fillSlots,
  preemptForImmediate,
  releasePreemptLease,
  concurrencyLabel,
  workProgress,
  forceFinishHung,
  warnIgnoredInbox,
  withCopyStandard,
  STALL_TICKS,
  DEFAULT_WORKERS,
};
