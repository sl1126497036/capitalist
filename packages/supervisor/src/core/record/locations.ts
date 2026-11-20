/**
 * `.capitalist` 目录内所有文件的统一路径入口。
 *
 * 这是 `.capitalist` 下唯一的读写面：所有模块从这里取路径，不再各自拼 `join(supervisorDir, …)`。
 * 新增文件时只在这里加一条，读写方引用同一函数，保证路径定义不散落、不改漏。
 *
 * 结构约定：
 * - 根级只留 `.root` 标记（任务根定位锚点）。
 * - 运行时热状态进 `runtime/`，台账进 `ledger/`，模型进 `model/`，看板进 `board/`，
 *   配置进 `config/`，杂项进 `meta/`。
 * - `workers/` 按 worker id 一级目录归档，一个 worker 的全部产物（record/output/brief）收进一个目录。
 * - 会话代次映射在 `sessions/<base>.json`。
 */

import { join } from "node:path";
import { supervisorDir } from "./paths";

/** 任务根定位锚点目录：`.capitalist/.root`，`findRoot` 按它判定任务根，同时存放全局索引。 */
export function rootDir(root: string): string {
  return join(supervisorDir(root), ".root");
}

/** 全局索引（worker 索引等）落在 `.root/` 下，与各业务目录的明细分离。 */
export const rootIndex = {
  worker: (root: string) => join(supervisorDir(root), ".root", "index.jsonl"),
};

/** 运行时热状态（监工每轮读写）。 */
export const runtime = {
  dir: (root: string) => join(supervisorDir(root), "runtime"),
  state: (root: string) => join(supervisorDir(root), "runtime", "state.json"),
  supervisor: (root: string) => join(supervisorDir(root), "runtime", "supervisor.json"),
  stopFlag: (root: string) => join(supervisorDir(root), "runtime", "supervisor.stop"),
  pause: (root: string) => join(supervisorDir(root), "runtime", "pause.json"),
  guard: (root: string) => join(supervisorDir(root), "runtime", "guard.json"),
  guardLog: (root: string) => join(supervisorDir(root), "runtime", "guard.log"),
  /** 宿主登录态通道：工作进程因登录态失败时写 down，调度层据此停止派单。 */
  channel: (root: string) => join(supervisorDir(root), "runtime", "channel.json"),
};

/** 台账（追加式记录）。 */
export const ledger = {
  dir: (root: string) => join(supervisorDir(root), "ledger"),
  tasks: (root: string) => join(supervisorDir(root), "ledger", "tasks.jsonl"),
  events: (root: string) => join(supervisorDir(root), "ledger", "events.jsonl"),
  violations: (root: string) => join(supervisorDir(root), "ledger", "violations.jsonl"),
  review: (root: string) => join(supervisorDir(root), "ledger", "review.jsonl"),
  sessions: (root: string) => join(supervisorDir(root), "ledger", "sessions.json"),
  direct: (root: string) => join(supervisorDir(root), "ledger", "direct.jsonl"),
  supervisorDirect: (root: string) => join(supervisorDir(root), "ledger", "supervisor-direct.jsonl"),
  threadNo: (root: string) => join(supervisorDir(root), "ledger", "thread-no.json"),
  /** 派单号占位：号一旦发行就追加一行，作为“只增不复用”的权威依据。 */
  dispatchReserve: (root: string) => join(supervisorDir(root), "ledger", "dispatch-reserve.jsonl"),
  /** 进程号占位：领号时 held，拉起成功 committed，拉起失败 released（该号可再用）。 */
  workerReserve: (root: string) => join(supervisorDir(root), "ledger", "worker-reserve.jsonl"),
  credits: (root: string) => join(supervisorDir(root), "ledger", "credits.json"),
  ledger: (root: string) => join(supervisorDir(root), "ledger", "ledger.jsonl"),
  authz: (root: string) => join(supervisorDir(root), "ledger", "authz.jsonl"),
  justify: (root: string) => join(supervisorDir(root), "ledger", "justify.jsonl"),
};

/** 模型与额度。 */
export const model = {
  dir: (root: string) => join(supervisorDir(root), "model"),
  rotate: (root: string) => join(supervisorDir(root), "model", "rotate.json"),
  next: (root: string) => join(supervisorDir(root), "model", "next.json"),
  workerModel: (root: string) => join(supervisorDir(root), "model", "worker-model.json"),
  modelUsed: (root: string) => join(supervisorDir(root), "model", "model-used.json"),
  quota: (root: string) => join(supervisorDir(root), "model", "quota.json"),
};

/** 看板运行态。 */
export const board = {
  dir: (root: string) => join(supervisorDir(root), "board"),
  key: (root: string) => join(supervisorDir(root), "board", "key"),
  pid: (root: string) => join(supervisorDir(root), "board", "pid"),
  seen: (root: string) => join(supervisorDir(root), "board", "seen.json"),
  cleared: (root: string) => join(supervisorDir(root), "board", "cleared.json"),
};

/** 配置与诊断。 */
export const config = {
  dir: (root: string) => join(supervisorDir(root), "config"),
  contractPrev: (root: string) => join(supervisorDir(root), "config", "contract-prev.json"),
  authDiag: (root: string) => join(supervisorDir(root), "config", "auth-diag.json"),
  ctxWindow: (root: string) => join(supervisorDir(root), "config", "ctx-window.json"),
  idMap: (root: string) => join(supervisorDir(root), "config", "id-map.json"),
  scope: (root: string) => join(supervisorDir(root), "config", "scope.json"),
  memory: (root: string) => join(supervisorDir(root), "config", "memory.json"),
};

/** 杂项状态。 */
export const meta = {
  dir: (root: string) => join(supervisorDir(root), "meta"),
  preempt: (root: string) => join(supervisorDir(root), "meta", "preempt.json"),
  takeover: (root: string) => join(supervisorDir(root), "meta", "takeover.json"),
  workerNo: (root: string) => join(supervisorDir(root), "meta", "worker-no.json"),
  lastFire: (root: string) => join(supervisorDir(root), "meta", "last-fire.txt"),
};

/** 工作进程：per-worker 目录，一个 worker 的全部产物收进一个目录。索引归 `.root/index.jsonl`。 */
export const workers = {
  dir: (root: string) => join(supervisorDir(root), "workers"),
  /** 单个 worker 的目录，如 `workers/1-P1/`。 */
  of: (root: string, workerId: string) => join(supervisorDir(root), "workers", workerId),
  record: (root: string, workerId: string) => join(supervisorDir(root), "workers", workerId, "record.json"),
  output: (root: string, workerId: string) => join(supervisorDir(root), "workers", workerId, "output.log"),
  outputErr: (root: string, workerId: string) => join(supervisorDir(root), "workers", workerId, "output.log.err"),
  brief: (root: string, workerId: string) => join(supervisorDir(root), "workers", workerId, "brief.md"),
  /** 孤儿自检的漏检计数：与 worker 记录同目录，随任务根与 worker 目录一起回收。 */
  guard: (root: string, workerId: string) => join(supervisorDir(root), "workers", workerId, "guard.json"),
};

/** 附件（看板贴图）与索引。 */
export const attachments = {
  dir: (root: string) => join(supervisorDir(root), "attachments"),
  index: (root: string) => join(supervisorDir(root), "attachments", "index.jsonl"),
};

/** 会话代次映射表。 */
export const sessions = {
  dir: (root: string) => join(supervisorDir(root), "sessions"),
  lane: (root: string, base: string) => join(supervisorDir(root), "sessions", `${base}.json`),
};

/** 裁决收件箱与派单队列。 */
export const inbox = {
  dir: (root: string) => join(supervisorDir(root), "inbox"),
  qa: (root: string) => join(supervisorDir(root), "inbox", "qa.jsonl"),
  dispatch: (root: string) => join(supervisorDir(root), "inbox", "dispatch.jsonl"),
  /** 分组台账：一行一个组，只存组自身属性；成员归属由派单上的 `group` 字段表达。 */
  groups: (root: string) => join(supervisorDir(root), "inbox", "groups.jsonl"),
  reject: (root: string, id: string) => join(supervisorDir(root), "inbox", `reject-${id}.json`),
};

/** 申报队列。 */
export const mq = {
  dir: (root: string) => join(supervisorDir(root), "mq"),
  reports: (root: string) => join(supervisorDir(root), "mq", "reports.jsonl"),
  cursor: (root: string) => join(supervisorDir(root), "mq", "cursor.json"),
};

/** 越界申请台账。 */
export const guard = {
  dir: (root: string) => join(supervisorDir(root), "guard"),
  requests: (root: string) => join(supervisorDir(root), "guard", "requests.jsonl"),
};

/** 判定脑会话代次。 */
export const brain = {
  dir: (root: string) => join(supervisorDir(root), "brain"),
  lane: (root: string, base: string) => join(supervisorDir(root), "brain", `${base}.json`),
};

/** 上下文重载产物。 */
export const reload = {
  dir: (root: string) => join(supervisorDir(root), "reload"),
  active: (root: string) => join(supervisorDir(root), "reload", "active.json"),
  snapshot: (root: string) => join(supervisorDir(root), "reload", "snapshot.json"),
  context: (root: string) => join(supervisorDir(root), "reload", "context.md"),
  resume: (root: string) => join(supervisorDir(root), "reload", "resume.json"),
  session: (root: string) => join(supervisorDir(root), "reload", "session.json"),
  history: (root: string) => join(supervisorDir(root), "reload", "history"),
  contractSeen: (root: string) => join(supervisorDir(root), "reload", "contract-seen.json"),
  ctx: (root: string) => join(supervisorDir(root), "reload", "capitalist-ctx.json"),
};

/** 锁目录。 */
export const locks = {
  dir: (root: string) => join(supervisorDir(root), "locks"),
  table: (root: string) => join(supervisorDir(root), "locks", "files.json"),
  metaLock: (root: string) => join(supervisorDir(root), "locks", "files.lock"),
  reads: (root: string) => join(supervisorDir(root), "locks", "reads.jsonl"),
  lease: (root: string, task: string) => join(supervisorDir(root), "locks", `${task}.lock`),
};

/** 归档目录。 */
export const archive = {
  dir: (root: string) => join(supervisorDir(root), "archive"),
  cleared: (root: string, stamp: string) => join(supervisorDir(root), "archive", `cleared-${stamp}`),
  clear: (root: string, stamp: string) => join(supervisorDir(root), "archive", `clear-${stamp}`),
};

/**
 * `.capitalist` 下需要遍历的全部落点目录（含根级）。
 *
 * 供启动清理这类“按目录扫一遍”的场景使用：原子写的 `.tmp` 分散在各业务目录下，
 * 清理面必须与写入面一致。新增目录时在这里补一条，收集点不必各改一遍。
 * 根级保留在首位，用于清掉旧布局遗留的散落临时文件。
 */
export function allDirs(root: string): string[] {
  return [
    supervisorDir(root),
    rootDir(root),
    runtime.dir(root),
    ledger.dir(root),
    model.dir(root),
    board.dir(root),
    config.dir(root),
    meta.dir(root),
    workers.dir(root),
    sessions.dir(root),
    inbox.dir(root),
    mq.dir(root),
    guard.dir(root),
    brain.dir(root),
    reload.dir(root),
    locks.dir(root),
    archive.dir(root),
    attachments.dir(root),
  ];
}
