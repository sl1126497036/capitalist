/**
 * 监工与工作进程之间的落盘协议。
 *
 * 三种角色，三种进程，互不同享上下文：
 *
 *   监工进程      长驻，独立进程。建根、定契约、派单、验收、判死重派。
 *   工作进程      监工拉起的独立宿主进程，一个 worker 一个上下文，互不可见。
 *   hook          宿主在 worker 进程内调用的判定层，不占 worker 上下文。
 *
 * 三者只通过 `.capitalist/` 下的文件交换状态：
 *
 *   supervisor.json          监工身份与心跳
 *   inbox/dispatch.jsonl     派单队列：监工写，worker 领
 *   workers/<id>.json        每个 worker 独立一条记录（心跳、派单、退出码）
 *   workers/<id>.log         worker 自己的输出，不与他人混写
 *
 * 每个 worker 独占一个文件。并发写同一文件会互相覆盖，而生命周期事件（启动、心跳、
 * 退出）不需要全局顺序；汇总在读取时完成。
 *
 * 心跳同时存 ISO 与 epoch 秒：ISO 用于展示，判活按 epoch 秒做差值。
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { attachmentsIn, withAttachmentLines } from "./attachments";
import { readJson, readJsonl, writeJson, writeJsonl } from "./json";
import { statCached } from "./fsCache";
import { supervisorDir } from "./paths";
import { syncTaskForDispatch } from "./tasks";

/** 监工进程状态。`done` 表示末阶段门槛已达标，监工据此退出。 */
export type SupervisorStatus = "running" | "stopped" | "done";

/** 监工记录。写入 `.capitalist/supervisor.json`，供监工判活与看板展示。 */
export interface SupervisorRecord {
  pid: number;
  status: SupervisorStatus;
  started_at: string;
  heartbeat_at: string;
  /** epoch 秒；判活用它，不解析 heartbeat_at */
  heartbeat_ts: number;
  target: string;
  contract: string;
  tick_sec: number;
  worker_timeout_sec: number;
  /**
   * 卡点观察窗口（秒）。心跳与日志都超过它没有更新才判为卡点；缺省 300。
   *
   * 老记录没有这个字段时按 {@link DEFAULT_LOG_STALL_SEC} 处理。
   */
  stuck_sec?: number;
  ticks: number;
  /** 并行度上限。实际能开几个由契约的分片决定。 */
  max_workers: number;
  worker_host: string;
  /**
   * 监工启动时声明的宿主（`supervise --agent`），决定对话通道用哪个 CLI、登录态取自哪一族。
   * 空 = 未声明，按环境特征推断。落盘是为了让重启后的看板与独立进程读到同一份声明。
   */
  host?: string;
  /**
   * 监工进程是否持有宿主令牌（`supervise` 启动时读到）。
   *
   * 只记有无，不记值。监工取不到登录态时该值为假，此后每一单均以登录失败结束。
   * 登录态检查按该字段区分“本次检查可通过”与“监工进程可通过”。
   */
  token_injected?: boolean;
  effort?: string;
  /**
   * 监工对话层的模型（`supervise --capitalist-model`）。
   *
   * 监工自己要跑模型：看板对话、申报判定、派单前检查。空 = 宿主默认。
   * 看板指标条回答“监工跑在什么模型上”、对话通道选参，都读这一份。
   */
  supervisor_model?: string;
  /** 默认模型（`supervise --default-model`）：没有显式指定时用它。 */
  default_model?: string;
  /**
   * 追加的禁用模型（`supervise --model-denylist "a,b"`）。
   *
   * 与平台名单取并集：只能加不能减，配置写错一个名字也不放行已知会偏离预期的模型。
   */
  model_denylist?: string[];
  /**
   * 监工对话上下文的配置上限（token，`supervise --capitalist-context`）。
   *
   * 与模型实际上限取小：看板显示“上下文 135.0k / 300k”里的 300k 就是这个生效值，
   * 超限重载的阈值也按它算。缺省见 `DEFAULT_SUPERVISOR_CONTEXT_LIMIT`；0 表示只按模型窗口。
   */
  supervisor_context_limit?: number;
  /** 失败熔断的重置点：只看这个时间之后的派单，`--force` 重试时写入 */
  retry_from?: string;
  /**
   * 随监工起的那份看板的地址（`--no-board` 或看板起不来时没有）。
   *
   * `capitalist status` 只判一次活就读得到，不必再去探测端口；监工已停时本字段不参与展示。
   */
  board_url?: string;
  note?: string;
}

/** 派单状态。`claimed` 表示已被某个 worker 领走且尚未结单。 */
/** 派单状态。 */
export type DispatchStatus = "open" | "claimed" | "reported" | "review" | "done" | "failed" | "closed";

/** 一张派单。写入 `.capitalist/inbox/dispatch.jsonl`。 */
export interface Dispatch {
  id: string;
  at: string;
  stage: string;
  /** 这一单要做什么。取自契约，监工不自行生成领域描述。 */
  action: string;
  status: DispatchStatus;
  /** 分片标识。空表示该阶段不可分片，一次只能派一个 worker。 */
  shard?: string;
  worker?: string;
  session?: string;
  claimed_at?: string;
  done_at?: string;
  note?: string;
  source?: "stage" | "requeue" | "reverify" | "adhoc";
  /** 插队标记。`fillSlots` 找下一张 open 单时先看它。 */
  urgent?: boolean;
  /**
   * 手动置顶的时刻（ISO）。只有用户在看板上点“立即执行”/`capitalist promote` 才写。
   *
   * 与 `urgent` 分开是因为两者语义不同：`urgent` 是“创建时就是插队单”，
   * 会在一批插队单里按台账顺序排队；`promoted_at` 是“用户刚刚把它拎到队首”，
   * 调度层按这个时间倒序取单，后点的那张先上。没有这个字段的旧单不受影响。
   */
  promoted_at?: string;
  front_at?: string;
  /** 谁把它插到队首的（`user` / `supervisor`），与 `promoted_by` 同口径。 */
  front_by?: string;
  /** 谁置顶的：`user`（命令行 / 看板按钮）或调用方自报的来源。 */
  promoted_by?: string;
  /**
   * 被让位的时刻（ISO）。
   *
   * “立即执行”会腾出并发槽：正运行中的那一单退回排队，排队中的单被越过。
   * 两类单都写这个字段，界面据此标“已让位”，它们既没失败也没被撤销，只是排在
   * 那张立即执行单后面。立即执行单结束后由 `core/preempt.ts` 统一清掉。
   */
  yielded_at?: string;
  /** 让位给哪张单（立即执行单的派单 id）。 */
  yielded_by?: string;
  /** 恢复顺序（从 0 起，小的先上）。 */
  yield_rank?: number;
  /**
   * 暂停时刻（ISO）。非空表示该派单处于暂停：不派发、不被 `capitalist next` 领取，
   * 但仍占用所属分片，避免被判定为“未派发”而重复建单。
   *
   * 与 `yielded_at` 的区别：让位是插队引起的临时排队，由调度自动恢复；
   * 暂停是用户的意图，只能由 `capitalist wake --user`（或看板唤醒）解除。
   */
  paused_at?: string;
  /** 暂停来源：`startup`（上次退出时未完成，启动时统一暂停）或 `user`。 */
  paused_by?: string;
  /** 暂停原因，供看板与命令行原样展示。 */
  paused_reason?: string;
  /**
   * 同一分片的第几次派发，从 1 起。失败重派时递增，调度层据此计算退避间隔。
   */
  attempt?: number;
  /**
   * 待确认截止时间（ISO）。只有 `status === "review"` 时有值：
   * 到点还没人确认就自动结单，对应“3 分钟没动静就当他没别的要说了”。
   */
  review_until?: string;
  /** worker 报完成时写的说明，确认后转成正式结单 note。 */
  /** 树边：父派单 id。做完父节点，本单才允许启动（多节点结构，见 {@link dispatchForest}）。 */
  parent?: string;
  parent_reason?: string;
  after?: string[];

  retry_accept?: string;

  retry_context?: string;

  /** 上报时刻（`markReported` 写）：监工据此判断“报了多久还没裁决”。 */
  reported_at?: string;
  review_note?: string;
  /** 手动结项的时刻（ISO）。只有 `status === "closed"` 时有值。 */
  closed_at?: string;
  /** 谁关的：`user`（命令行 / 看板按钮）或调用方自报的来源。 */
  closed_by?: string;
  atts_inherited?: string[];
  atts?: string[];
  /**
   * 这一单是从哪条用户消息派出来的（消息标识 `M-…`）。
   *
   * 附件归属的权威键：发车前按它回查那条消息自己的 `atts`，正文里别处抄来的路径
   * 会被摘掉。老记录没有这个字段时退回 `atts`，再没有才从正文解析。
   */
  src_msg?: string;
  /** 合并单累计的来源消息标识（每追加一条同类需求记一个）。 */
  src_msgs?: string[];
  added_reqs?: string[];
  /** 血缘：这一串重派单里第一张的 id。 */
  lineage?: string;
  retry_verdict?: "pending" | "retry" | "give_up" | "hold";
  retry_why?: string;
  /** 到这个决定为止，这条链已经重试过几次。 */
  retry_count?: number;
  cascade_from?: string;
  /** 级联判死的时刻（ISO）。与 `done_at` 分开：`done_at` 是这一单自己的生命周期终点。 */
  cascade_at?: string;
  cascade_resets?: number;
  role?: "work" | "diagnose" | "fix";
  /**
   * 分类标签，由 AI 在派单时打（不是固定枚举）。
   *
   * 两个用途：会话车道按第一个标签分组（同一类活共用一条上下文，才谈得上复用），
   * 看板按它分组显示。没有标签的插队单会落到 `misc` 车道，仍然能用，只是复用价值低。
   */
  tags?: string[];
  /** 绑定的任务池条目 id（见 `core/tasks.ts`）。缺省表示这单不属于任务池。 */
  task?: string;
}

/**
 * 工作进程状态。
 *
 * `suspended` 是“让位”：进程已经结束，但这一单没失败，它接着排回队列，下一次
 * 拉起时续接同一条 AI 会话（见 `worker.ts` 的 `resolveSession`）。它既不算运行中
 * （不占并发槽），也不算失败（不触发重派与退避）。
 *
 * `exited` 与 `failed` 都是终态，`done` 表示该单已成功结单。
 */
export type WorkerStatus = "starting" | "running" | "suspended" | "exited" | "failed" | "done";

/** 一个工作进程的记录。写入 `.capitalist/workers/<id>.json`。 */
/**
 * 卡点类型。
 *
 * 四类对应四种不同的跳出办法，混成一句“卡住了”对处理没有帮助：
 *
 *   idle       空闲等待：没有新的工具调用，也没有新的输出；在等一个不会出现的条件。
 *   retry      重复无效重试：同一条命令/同一个改动反复做，结果没有变化。
 *   external   等外部条件：登录、授权、验证码、配额、目录信任这类必须由人解除的门槛。
 *   error_loop 报错循环：同一段报错反复出现，没有换输入也没有换路径。
 */
export type StuckKind = "idle" | "retry" | "external" | "error_loop" | "unknown";

/** 监工对一次卡点的判定与干预记录（落 `workers/<id>.json` 的 `stuck` 字段）。 */
export interface WorkerStuckState {
  kind: StuckKind;
  /** 给用户看的中文类型名。 */
  label: string;
  /** 判据摘要：凭什么判成这一类。 */
  why: string;
  /** 给工作进程的跳出办法（已写成可直接执行的句子）。 */
  guidance: string;
  /** 第一次判为卡点的时刻（ISO）。 */
  since: string;
  /** 同类干预已尝试次数。第二次无效即按卡死处理。 */
  attempts: number;
  /** 最近一次干预的时刻（ISO）。两次干预之间至少隔一个观察窗口。 */
  last_at: string;
  /** 指导是否已被工作进程领取（`direct.jsonl` 的 consumed 置位）。写入不算送达。 */
  delivered: boolean;
  /** 送达通道：`hook` = 已写入、等待领取；`consumed` = 已被领取；`failed` = 写入失败。 */
  channel: "hook" | "consumed" | "failed";
  /** 写入的插话时刻（ISO），用于回查是否已被领取。 */
  directive_at?: string;
}

export interface WorkerRecord {
  id: string;
  host: string;
  pid: number;
  session: string;
  dispatch: string;
  shard?: string;
  stage: string;
  started_at: string;
  heartbeat_at: string;
  heartbeat_ts: number;
  status: WorkerStatus;
  exit_code?: number | undefined;
  log: string;
  /** 凭证来源的一句话描述（账号 uid 前缀 + 有效期）。刻意不含 token。 */
  credential?: string;
  /**
   * 启动方式。
   *
   * `visible` 表示 worker 跑在独立控制台窗口里，由人可见地执行；这类 worker 不写心跳，
   * 因此监工不按心跳判死（见 `supervisor/loop.ts` 的 `reap`），只认它写回的 report。
   */
  mode?: "background" | "visible";
  /** 拉起它的监工进程号。 */
  supervisor_pid?: number;
  stuck?: WorkerStuckState | undefined;
  stop_reason?: string | undefined;
  /**
   * 这个 worker 实际续接/新开的 AI 会话 id（例如 `capitalist-u6-main-g2`）。
   *
   * 与 `session` 字段必须分开看：`session` 是 worker 自己的记录 id（`W-xxxx`），
   * 由它自己续写心跳；`ai_session` 才是宿主那边的对话上下文标识，一个 ai_session
   * 可以被多个 worker 先后复用。看板“与这个进程说话”要送到 ai_session，
   * 调度层判断“这条车道还占着吗”也只认它。
   *
   * 老记录没有这一项：按“不知道”处理，不以 `session` 代入，两者语义不同。
   */
  ai_session?: string;
}


/** 监工记录文件的绝对路径：`<root>/.capitalist/supervisor.json`。 */
export function supervisorPath(root: string): string {
  return join(supervisorDir(root), "supervisor.json");
}

/**
 * 读监工记录。
 *
 * @returns 记录不存在、JSON 损坏、或缺 `heartbeat_ts` 时返回 null。调用方按“没有监工
 *   记录”处理，不要把它当成监工已停。
 */
export function loadSupervisor(root: string): SupervisorRecord | null {
  const rec = readJson<SupervisorRecord | null>(supervisorPath(root), null);
  if (!rec || typeof rec !== "object") return null;
  if (typeof rec.heartbeat_ts !== "number") return null;
  return rec;
}

/**
 * 写监工记录。整份覆盖写入，并发调用时后写者覆盖先写者。
 *
 * @throws 落盘失败时抛出，调用方需自行处理。
 */
export function saveSupervisor(root: string, rec: SupervisorRecord): void {
  writeJson(supervisorPath(root), rec);
}

/**
 * 判活窗口，单位秒。取 3 轮调度 且不低于 30 秒。
 *
 * 下限用于吸收 调度抖动：调度轮次 设得小时（调试常用 1 秒）窗口会短到把正常抖动读成死亡，
 * 于是 hook 在监工仍存活时误报“监工已停”。
 */
export function supervisorStaleSec(rec: SupervisorRecord): number {
  return Math.max(Math.floor(rec.tick_sec * 3), 30);
}

/**
 * 监工是否在线：状态为 `running`、记录的 pid 仍在、且心跳在判活窗口内。
 *
 * 被强杀（`taskkill /F`、后台任务管理器结束进程）的监工不写收尾，
 * `.capitalist/supervisor.json` 停在最后一次心跳，此后 30 秒内心跳仍显示新鲜。
 * pid 判活覆盖该窗口：pid 消失时按离线处理。
 *
 * @param nowSec 当前 epoch 秒，默认取系统时间。传入固定值可让判定可重现。
 */
export function isSupervisorAlive(root: string, nowSec = Date.now() / 1000): boolean {
  const rec = loadSupervisor(root);
  if (!rec || rec.status !== "running") return false;
  if (!pidAlive(rec.pid)) return false;
  return nowSec - rec.heartbeat_ts <= supervisorStaleSec(rec);
}

/**
 * 停止请求哨兵文件的绝对路径：`<root>/.capitalist/supervisor.stop`。
 *
 * 停止请求与心跳分文件存放。监工每轮调度 写心跳，写在同一文件里会被下一次心跳覆盖回
 * `running`，停止请求就丢了。哨兵只写不删，由下一次启动清除，这样多个监工都能在同一次
 * 请求后退出。
 */
export function stopFlagPath(root: string): string {
  return join(supervisorDir(root), "supervisor.stop");
}

/**
 * 请求监工停止：写哨兵文件，并把监工记录的状态置为 `stopped`。
 *
 * @param note 停止原因，写进哨兵文件与监工记录的 `note`。
 * @returns 恒为 true。哨兵写入失败时不会抛错，下一次 调度轮次 的 `stopRequested` 读不到哨兵，
 *   停止请求不生效。
 */
export function requestSupervisorStop(root: string, note = "stopped by user", force = false): boolean {
  const rec = loadSupervisor(root);
  writeJson(stopFlagPath(root), {
    at: new Date().toISOString(),
    note,
    by: process.pid,
    ...(force ? { force: true } : {}),
  });
  if (rec) {
    saveSupervisor(root, {
      ...rec,
      status: "stopped",
      note,
      heartbeat_at: new Date().toISOString(),
      heartbeat_ts: Date.now() / 1000,
    });
  }
  return true;
}

/** 是否存在停止请求哨兵。监工每轮调度 读一次，为真则退出。 */
export function stopRequested(root: string): boolean {
  return existsSync(stopFlagPath(root));
}

/** 停止请求是否为强制；强制停止会结束运行中的工作进程。 */
export function stopForced(root: string): boolean {
  const raw = readJson<{ force?: boolean } | null>(stopFlagPath(root), null);
  return raw?.force === true;
}

/**
 * 清除停止请求哨兵。新一次启动调用一次，取消上一次的停止请求。
 *
 * 文件不存在时按已清除处理，不报错。
 */
export function clearStopFlag(root: string): void {
  try {
    rmSync(stopFlagPath(root), { force: true });
  } catch {
    /* 文件不在就是已经取消了 */
  }
}


/** worker 目录的绝对路径：`<root>/.capitalist/workers`。 */
export function workersDir(root: string): string {
  return join(supervisorDir(root), "workers");
}

/**
 * worker id 会直接拼进文件名，因此必须是单段名字。
 *
 * 不做校验时，`capitalist stop-worker ../../x` 或看板转发来的非法 id 会把读 / 写引到 `.capitalist/workers`
 * 之外：读是越权，写更糟，`saveWorker` 会在任务根外落一个 json。id 由本模块生成，
 * 但入口（CLI 参数、HTTP 查询串）是外部输入，必须在拼路径之前挡住。
 */
function isSafeWorkerId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes("..");
}

/**
 * worker 记录文件的绝对路径。
 *
 * @param id worker id，须为单段名字（字母、数字、`-` `_` `.`），且不含 `..`。
 * @throws id 不合法时抛出。id 会被直接拼进文件名，放行非法值会把读写引到
 *   `.capitalist/workers` 之外。
 */
export function workerPath(root: string, id: string): string {
  if (!isSafeWorkerId(id)) {
    throw new Error(`worker id 非法：${JSON.stringify(id)}；只允许字母、数字与 - _ . ，且不得含 ..`);
  }
  return join(workersDir(root), `${id}.json`);
}

/**
 * worker 日志文件的绝对路径。
 *
 * @param id worker id，约束同 {@link workerPath}。
 * @throws id 不合法时抛出。
 */
export function workerLogPath(root: string, id: string): string {
  if (!isSafeWorkerId(id)) {
    throw new Error(`worker id 非法：${JSON.stringify(id)}；只允许字母、数字与 - _ . ，且不得含 ..`);
  }
  return join(workersDir(root), `${id}.log`);
}

export function newWorkerId(root: string): string {
  const file = join(supervisorDir(root), "worker-no.json");
  const data = readJson<{ next?: number }>(file, {});
  let n = Math.max(1, Number(data?.next ?? 1) || 1);
  for (let i = 0; i < 200; i += 1) {
    const id = String(n);
    if (!existsSync(workerPath(root, id))) {
      writeJson(file, { next: n + 1 });
      return id;
    }
    n += 1;
  }
  return `W-${Date.now().toString(36)}`;
}

/** 读 worker 记录；id 非法或记录缺失都返回 null，调用方按“没有这个 worker”处理。 */
export function loadWorker(root: string, id: string): WorkerRecord | null {
  if (!isSafeWorkerId(id)) return null;
  const rec = readJson<WorkerRecord | null>(workerPath(root, id), null);
  return rec && typeof rec.heartbeat_ts === "number" ? rec : null;
}

/**
 * 写 worker 记录。整份覆盖写入。
 *
 * @throws `rec.id` 不合法或落盘失败时抛出。
 */
export function saveWorker(root: string, rec: WorkerRecord): void {
  writeJson(workerPath(root, rec.id), rec);
  /* 记录一写，列表缓存立刻作废：下一秒读到的必须是刚写的这份。 */
  workersCache = null;
}

/**
 * 列出全部 worker 记录，按启动时间升序。
 *
 * 索引里的 id 若指向不存在的记录、或记录内容损坏，该条目被跳过，不影响其余记录。
 */
export function listWorkers(root: string): WorkerRecord[] {
  const now = Date.now();
  if (workersCache && workersCache.root === root && now - workersCache.at < WORKERS_CACHE_MS) {
    return workersCache.rows.slice();
  }
  const ids = readJsonl<{ id?: string }>(join(workersDir(root), "index.jsonl"))
    .map((r) => String(r.id ?? ""))
    .filter(Boolean);
  const out: WorkerRecord[] = [];
  for (const id of ids) {
    const rec = loadWorker(root, id);
    if (rec) out.push(rec);
  }
  const rows = out.sort((a, b) => a.started_at.localeCompare(b.started_at));
  workersCache = { root, at: now, rows };
  return rows.slice();
}

/** worker 记录的短缓存。 */
const WORKERS_CACHE_MS = 1000;
let workersCache: { root: string; at: number; rows: WorkerRecord[] } | null = null;

/**
 * 登记 worker：写 worker 记录，并把 id 登记进 `index.jsonl` 索引。同一 id 不重复登记。
 *
 * 索引是整份读改写，两个进程并发登记时后写者可能覆盖先写者的条目。
 */
export function registerWorker(root: string, rec: WorkerRecord): void {
  saveWorker(root, rec);
  const index = join(workersDir(root), "index.jsonl");
  const rows = readJsonl<{ id?: string }>(index);
  if (!rows.some((r) => r.id === rec.id)) writeJsonl(index, [...rows, { id: rec.id }]);
}

/**
 * 更新心跳时间，并按需覆盖指定字段。
 *
 * @param patch 要覆盖的字段。为空时只更新心跳时间。
 * @returns 更新后的记录；记录不存在时返回 null。
 */
export function touchWorker(root: string, id: string, patch: Partial<WorkerRecord> = {}): WorkerRecord | null {
  const cur = loadWorker(root, id);
  if (!cur) return null;
  const next: WorkerRecord = {
    ...cur,
    ...patch,
    heartbeat_at: new Date().toISOString(),
    heartbeat_ts: Date.now() / 1000,
  };
  saveWorker(root, next);
  return next;
}

/** 回收 `.capitalist/workers/` 里的历史记录。 */
export function pruneWorkers(
  root: string,
  opts: PruneWorkersOptions = {},
): { removed: number; kept: number } {
  const keepRecent = Math.max(0, opts.keepRecent ?? DEFAULT_KEEP_RECENT_WORKERS);
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_WORKER_RECORD_MAX_AGE_MS;
  const now = opts.now ?? Date.now();
  const dir = workersDir(root);

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { removed: 0, kept: 0 };
  }

  // 按 id 归并 json 与 log。`index.jsonl` 不匹配 `\.(json|log)$`，天然被排除。
  const files = new Map<string, { json: string | null; log: string | null }>();
  for (const name of names) {
    const m = /^(.+)\.(json|log)$/.exec(name);
    if (!m) continue;
    const id = m[1] ?? "";
    if (!isSafeWorkerId(id)) continue;
    const cur = files.get(id) ?? { json: null, log: null };
    if (m[2] === "json") cur.json = name;
    else cur.log = name;
    files.set(id, cur);
  }
  if (files.size === 0) return { removed: 0, kept: 0 };

  /** 候选条目：启动时刻、是否还运行中、对应文件名。 */
  const entries: {
    id: string;
    startedTs: number;
    alive: boolean;
    json: string | null;
    log: string | null;
  }[] = [];

  for (const [id, f] of files) {
    const rec = f.json ? loadWorker(root, id) : null;
    let startedTs = 0;
    if (rec) {
      const parsed = Date.parse(rec.started_at);
      startedTs = Number.isFinite(parsed) ? parsed : rec.heartbeat_ts * 1000;
    } else {
      // 记录缺失或损坏：退回文件时间。这种条目留着也没内容，一律按最老处理。
      try {
        startedTs = statSync(join(dir, (f.json ?? f.log) as string)).mtimeMs;
      } catch {
        startedTs = 0;
      }
    }
    const alive = rec?.status === "starting" || rec?.status === "running";
    entries.push({ id, startedTs, alive, json: f.json, log: f.log });
  }

  // 新的在前：只按启动时间排序，保留窗口取前 keepRecent 个。
  entries.sort((a, b) => b.startedTs - a.startedTs);

  const drop = new Set<string>();
  entries.forEach((e, i) => {
    if (e.alive) return;
    if (i < keepRecent) return;
    if (now - e.startedTs < maxAgeMs) return;
    drop.add(e.id);
  });
  if (drop.size === 0) return { removed: 0, kept: entries.length };

  for (const id of drop) {
    const f = files.get(id);
    if (!f) continue;
    for (const name of [f.json, f.log]) {
      if (!name) continue;
      try {
        unlinkSync(join(dir, name));
      } catch {
        /* 删不掉的留给下一次回收，不影响主流程 */
      }
    }
  }

  // 索引同步：只摘掉真正删掉的 id，其余原样保留。
  const index = join(dir, "index.jsonl");
  try {
    const rows = readJsonl<{ id?: string }>(index);
    const kept = rows.filter((r) => !drop.has(String(r.id ?? "")));
    if (kept.length !== rows.length) writeJsonl(index, kept);
  } catch {
    /* 索引读不了就下次再摘：文件已经删了，多出的空条目只会被 listWorkers 跳过 */
  }

  return { removed: drop.size, kept: entries.length - drop.size };
}

export function archiveFinished(
  root: string,
  bucket: "all" | "done" | "bad" | "run" | "queue" = "all",
): { dir: string; workers: number; dispatches: number } {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dir = join(supervisorDir(root), "archive", `cleared-${stamp}`);
  mkdirSync(join(dir, "workers"), { recursive: true });

  const ALIVE = new Set(["running", "starting", "claimed"]);
  const BAD = new Set(["failed", "orphan", "missing", "gone"]);

  /*
   * 分档与界面使用同一套口径。
   *
   * 手动取消的派单（`closed_by: "user"` 与固定 note）在看板归入“已完成”档，
   * 台账中的原始状态仍可能是 `failed`。后端的异常清理按同一分档过滤。
   */
  const rows0 = readDispatches(root);
  const canceledDispatch = new Set(
    rows0
      .filter((d) => d.status === "closed" && d.closed_by === "user" && d.note === "用户手动结项")
      .map((d) => d.id),
  );
  const failedDispatch = new Set(
    rows0.filter((d) => d.status === "failed").map((d) => String(d.id)),
  );

  const wantWorker = (w: WorkerRecord): boolean => {
    const s = String(w.status || "");
    const alive = ALIVE.has(s);
    if (bucket === "all") return true;
    if (bucket === "run") return alive;
    /* 排队单没有 worker 记录，那一档只动派单。 */
    if (bucket === "queue") return false;
    if (alive) return false;
    const isCanceled = Boolean(w.dispatch) && canceledDispatch.has(String(w.dispatch));
    const onFailedDispatch = Boolean(w.dispatch) && failedDispatch.has(String(w.dispatch));
    const bad = (BAD.has(s) || onFailedDispatch) && !isCanceled;
    if (bucket === "bad") return bad;
    return !bad;
  };

  const wdir = workersDir(root);
  const drop = new Set<string>();

  for (const w of listWorkers(root)) {
    if (!wantWorker(w)) continue;
    const id = String(w.id || "");
    if (!id || !isSafeWorkerId(id)) continue;
    for (const ext of [".json", ".log"]) {
      const from = join(wdir, `${id}${ext}`);
      if (!existsSync(from)) continue;
      try {
        renameSync(from, join(dir, "workers", `${id}${ext}`));
      } catch {
        /* 移不动的留着，下次再清 */
      }
    }
    if (!existsSync(join(wdir, `${id}.json`))) drop.add(id);
    const briefFrom = join(supervisorDir(root), "brief", `${id}.md`);
    if (existsSync(briefFrom)) {
      try {
        mkdirSync(join(dir, "brief"), { recursive: true });
        renameSync(briefFrom, join(dir, "brief", `${id}.md`));
      } catch {
      }
    }
  }

  if (drop.size) {
    const index = join(wdir, "index.jsonl");
    try {
      const rows = readJsonl<{ id?: string }>(index);
      const kept = rows.filter((r) => !drop.has(String(r.id ?? "")));
      if (kept.length !== rows.length) writeJsonl(index, kept);
    } catch {
      /* 索引读取失败时，多出的空条目会被 listWorkers 跳过。 */
    }
    workersCache = null;
  }

  let dispatches = 0;
  try {
    const rows = readDispatches(root);
    /* 派单侧同样按档走：`all` 连排队与已领取的一起撤，`queue` 只撤排队。 */
    const movesIn = (d: Dispatch): boolean => {
      const s = String(d.status);
      if (bucket === "all") return true;
      if (bucket === "queue") return s === "open";
      if (bucket === "run") return s === "claimed";
      if (s === "closed" || s === "done") return bucket === "done";
      if (s === "failed") return bucket === "bad";
      return false;
    };
    const keep = rows.filter((d) => !movesIn(d));
    const moved = rows.filter((d) => movesIn(d));
    if (moved.length) {
      writeJsonl(join(dir, "dispatch.jsonl"), moved);
      writeJsonl(dispatchPath(root), keep);
      dispatches = moved.length;
    }
  } catch {
    /* 台账读取失败时保留原样。 */
  }

  return { dir, workers: drop.size, dispatches };
}

/** 回收参数。 */
export interface PruneWorkersOptions {
  /** 按启动时间保留最近多少条（不论状态）。缺省 {@link DEFAULT_KEEP_RECENT_WORKERS}。 */
  keepRecent?: number | undefined;
  /** 启动时间早于“现在减这个毫秒数”才进入候选。缺省 24 小时。 */
  maxAgeMs?: number | undefined;
  /** 当前时刻，测试可注入。 */
  now?: number | undefined;
}

/** 回收时保留的近期 worker 条数。 */
const DEFAULT_KEEP_RECENT_WORKERS = 50;
/** worker 记录的保留时长：一天。超过它的终态记录才有资格被回收。 */
const DEFAULT_WORKER_RECORD_MAX_AGE_MS = 24 * 3600 * 1000;

/**
 * pid 是否还活着。只作辅助：pid 会被复用，最终判活仍看心跳。
 *
 * @param pid 进程号。非正整数按不存在处理。
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 日志“还在写”的默认阈值：五分钟。
 *
 * 这是卡点判定的默认观察窗口，不是判死阈值。两个信号（心跳、日志）任一在此窗口内
 * 更新就算存活；两个都过期才进入卡点判定。可由 `--stuck-sec` / `CAPITALIST_STUCK_SEC` 覆盖。
 */
export const DEFAULT_LOG_STALL_SEC = 300;

/** 日志距最后一次写入多少秒。读不到日志（没建、被删）按无穷大处理。 */
export function workerLogIdleSec(log: string, nowMs = Date.now()): number {
  const st = statCached(log);
  return st ? Math.max(0, (nowMs - st.mtimeMs) / 1000) : Number.POSITIVE_INFINITY;
}

/** 一个 worker 的存活读数。两个信号都保留，界面和判定各自取需要的那一部分。 */
export interface WorkerLiveness {
  /** 心跳或日志任一在阈值内更新。 */
  alive: boolean;
  heartbeat_age_sec: number;
  log_idle_sec: number;
  /** 哪个信号把它判成存活；两个都过期时是 `none`。 */
  via: "heartbeat" | "log" | "none";
}

/** 按“心跳或日志任一在阈值内”判活。 */
export function workerLivenessOf(
  rec: WorkerRecord,
  opts: { heartbeatSec: number; logStallSec?: number; nowMs?: number },
): WorkerLiveness {
  const nowMs = opts.nowMs ?? Date.now();
  const heartbeatAge = Math.max(0, nowMs / 1000 - rec.heartbeat_ts);
  const logIdle = rec.log ? workerLogIdleSec(rec.log, nowMs) : Number.POSITIVE_INFINITY;
  const heartbeatAlive = heartbeatAge <= opts.heartbeatSec;
  const logAlive = logIdle <= (opts.logStallSec ?? DEFAULT_LOG_STALL_SEC);
  const pidGone = Number.isInteger(rec.pid) && rec.pid > 0 && !pidAlive(rec.pid);
  return {
    alive: !pidGone && (heartbeatAlive || logAlive),
    heartbeat_age_sec: Math.round(heartbeatAge),
    log_idle_sec: Number.isFinite(logIdle) ? Math.round(logIdle) : -1,
    via: pidGone ? "none" : heartbeatAlive ? "heartbeat" : logAlive ? "log" : "none",
  };
}

/** 读盘版的 {@link workerLivenessOf}；记录不存在时返回 null。 */
export function workerLiveness(
  root: string,
  id: string,
  opts: { heartbeatSec: number; logStallSec?: number; nowMs?: number },
): WorkerLiveness | null {
  const rec = loadWorker(root, id);
  return rec ? workerLivenessOf(rec, opts) : null;
}

/**
 * worker 是否仍在运行。
 *
 * 状态为 `exited`、`failed`、`done` 时直接判定为不存活，不再看心跳/日志。
 * 其余状态下，心跳或日志任一在阈值内更新即视为存活（见 {@link workerLivenessOf}）。
 *
 * @param timeoutSec 心跳判活窗口，单位秒。
 * @param nowSec 当前 epoch 秒，默认取系统时间。
 * @param logStallSec 日志判活窗口，单位秒；缺省五分钟。
 */
export function isWorkerAlive(
  root: string,
  id: string,
  timeoutSec: number,
  nowSec = Date.now() / 1000,
  logStallSec = DEFAULT_LOG_STALL_SEC,
): boolean {
  const rec = loadWorker(root, id);
  if (!rec) return false;
  if (rec.status === "exited" || rec.status === "failed" || rec.status === "done") return false;
  return workerLivenessOf(rec, { heartbeatSec: timeoutSec, logStallSec, nowMs: nowSec * 1000 }).alive;
}


/** 派单队列文件的绝对路径：`<root>/.capitalist/inbox/dispatch.jsonl`。 */
export function dispatchPath(root: string): string {
  return join(supervisorDir(root), "inbox", "dispatch.jsonl");
}

/**
 * 读全部派单记录，按文件中的先后顺序返回。
 *
 * 坏行跳过，不影响其余记录。
 */
export function readDispatches(root: string): Dispatch[] {
  const file = dispatchPath(root);
  let key = "";
  try {
    const st = statSync(file);
    key = `${st.size}:${st.mtimeMs}`;
  } catch {
    /* 台账还没建：空队列，不写入缓存（建好后要能读到） */
    return [];
  }
  if (dispatchCache && dispatchCache.root === root && dispatchCache.key === key) {
    return dispatchCache.rows.slice();
  }
  const rows = readJsonl<Dispatch>(file);
  dispatchCache = { root, key, rows };
  return rows.slice();
}

/**
 * 派单台账的进程内缓存。
 *
 * 这是所有读取路径的底座：`/api/metrics`、`/api/threads`、`/api/thread`、`/api/capitalist-chat`、
 * 监工每拍的状态维护，每个请求都要读一次整份台账再逐行 parse。台账今天已经 1.4MB、
 * 一千多行，前端又按 2~5 秒轮询三四个接口，重复解析直接表现成“点哪儿都卡”，
 * 而监工是单线程，这些解析工作与调度竞争同一个线程。
 *
 * 台账只追加、不重写（改状态也是整份写回，size 会变），所以 `size + mtime` 一变就重读，
 * 不会给出旧数据。返回的是浅拷贝数组：调用方常常 `rows[idx] = next` 之后整份写回，
 * 共享同一个数组会把缓存改脏；元素本身只读使用（要改的地方都先 `{...cur}` 造新对象）。
 */
let dispatchCache: { root: string; key: string; rows: Dispatch[] } | null = null;

/**
 * 生成派单 id：`D-` 加时间戳与随机后缀的 base36。
 *
 * @param now 时间戳，默认取系统时间。传入固定值可让 id 可重现。
 */
export function newDispatchId(now = Date.now()): string {
  return `D-${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** 追加一张派单。 */
export function appendDispatch(root: string, d: Dispatch): void {
  const rows = readDispatches(root);
  rows.push(carryAttachments(rows, d));
  writeJsonl(dispatchPath(root), rows);
}

/** 这张单是否被暂停。只看标记，不看状态：暂停是用户的意图，不随执行状态迁移丢失。 */
export function dispatchPaused(d: Pick<Dispatch, "paused_at"> | null | undefined): boolean {
  return Boolean(d && String(d.paused_at ?? "").trim());
}

/**
 * 暂停一张派单。
 *
 * 幂等：已有标记时保留原时刻与来源。重复启动不改写暂停时间。看板上的
 * “暂停于”保留首次暂停的时刻。
 *
 * @returns 本次是否新写入标记。
 */
export function holdDispatch(root: string, id: string, by: string, reason: string): boolean {
  const rows = readDispatches(root);
  const idx = rows.findIndex((d) => d.id === id);
  if (idx < 0) return false;
  const cur = rows[idx] as Dispatch;
  if (dispatchPaused(cur)) return false;
  rows[idx] = {
    ...cur,
    paused_at: new Date().toISOString(),
    paused_by: by,
    paused_reason: reason,
  } as Dispatch;
  writeJsonl(dispatchPath(root), rows);
  return true;
}

/**
 * 批量暂停一组派单，一次写盘。
 *
 * 启动时可能有上百张遗留单，逐张调用 `holdDispatch` 会把整份台账重写上百次。
 *
 * @returns 本次新写入标记的张数。
 */
export function holdDispatches(
  root: string,
  ids: readonly string[],
  by: string,
  reason: string,
): number {
  const want = new Set(ids);
  if (want.size === 0) return 0;
  const rows = readDispatches(root);
  const at = new Date().toISOString();
  let changed = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const cur = rows[i] as Dispatch;
    if (!want.has(cur.id) || dispatchPaused(cur)) continue;
    rows[i] = { ...cur, paused_at: at, paused_by: by, paused_reason: reason } as Dispatch;
    changed += 1;
  }
  if (changed > 0) writeJsonl(dispatchPath(root), rows);
  return changed;
}

/** 唤醒结果：`from` 为唤醒前状态，`to` 为唤醒后状态。 */
export interface WakeResult {
  id: string;
  from: string;
  to: string;
}

/**
 * 唤醒一张暂停的派单。
 *
 * 只解除暂停标记。失败单退回 `open` 并清除终止字段：否则重派闸按 `retry_verdict` /
 * `done_at` 拦截该派单，唤醒后不会重新执行。`done` / `closed` 是终态，不唤醒。
 *
 * @returns 未找到、未暂停或已结项时返回 null。
 */
export function wakeDispatch(root: string, id: string): WakeResult | null {
  const rows = readDispatches(root);
  const idx = rows.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  const cur = rows[idx] as Dispatch;
  const from = String(cur.status ?? "");
  if (!dispatchPaused(cur)) return null;
  if (from === "done" || from === "closed") return null;

  const next: Dispatch = { ...cur };
  delete next.paused_at;
  delete next.paused_by;
  delete next.paused_reason;
  let to = from;
  if (from === "failed") {
    next.status = "open";
    to = "open";
    delete next.done_at;
    delete next.retry_verdict;
    delete next.retry_why;
    delete next.review_until;
    delete next.review_note;
    next.note = "已唤醒：退回排队";
  }
  rows[idx] = next;
  writeJsonl(dispatchPath(root), rows);
  return { id, from, to };
}

/** 全部处于暂停、且尚未结项的派单。 */
export function pausedDispatches(root: string): Dispatch[] {
  return readDispatches(root).filter(
    (d) => dispatchPaused(d) && d.status !== "done" && d.status !== "closed",
  );
}

/** 同片上一张未结单的派单带过的附件，补到本单 action 末尾。 */
function carryAttachments(rows: Dispatch[], d: Dispatch): Dispatch {
  /** 只有“重派”才继承：同一片的任务未完成，重发一单时不能丢失用户提供的图。 */
  if (d.source !== "requeue") return d;
  const stage = String(d.stage ?? "");
  const shard = String(d.shard ?? "");
  /* 还要是同一条血缘：同一片上的另一件事（另一次派单）不是这张单的前身。 */
  const chain = String((d as { lineage?: string }).lineage ?? "");
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const prev = rows[i];
    if (!prev || prev.id === d.id) continue;
    if (String(prev.stage ?? "") !== stage || String(prev.shard ?? "") !== shard) continue;
    const prevChain = String((prev as { lineage?: string }).lineage ?? "");
    if (chain && prevChain && chain !== prevChain) continue;
    /* 只看最近一张同片单：再往前的都被它继承过一次了，继续往前找会把陈年附件翻出来。 */
    if (prev.status === "done" || prev.status === "review") return d;
    /** 只接“用户亲手交的”那一手：上一单自己继承来的图不再往下传。 */
    const inheritedByPrev = new Set((prev.atts_inherited ?? []).map((p) => String(p)));
    const prevAtts = Array.isArray(prev.atts) ? prev.atts.map((p) => String(p)) : null;
    const source = prevAtts ?? attachmentsIn(String(prev.action ?? ""));
    const own = source.filter((p) => p.trim() !== "" && !inheritedByPrev.has(p));
    if (own.length === 0) return d;
    const action = withAttachmentLines(String(d.action ?? ""), own);
    if (action === d.action) return d;
    const already = new Set(d.atts_inherited ?? []);
    for (const p of own) already.add(p);
    const atts = [...new Set([...(d.atts ?? []).map((p) => String(p)), ...own])];
    return { ...d, action, atts, atts_inherited: [...already] } as Dispatch;
  }
  return d;
}

/** 全部还没了结的单：open（等着领）或 claimed（已领在干）。分片并行时会有多张。 */
export function activeDispatches(root: string): Dispatch[] {
  /*
   * `reported` 也算在途：工作进程说了“我完成了”，但关不关是监工裁决。
   * 裁决之前这一单不算完，也不能再派一张去做同一件事。
   */
  return readDispatches(root).filter(
    (d) => d.status === "open" || d.status === "claimed" || d.status === "reported",
  );
}

/** 工作进程上报完成：只写事实，不改结论。 */
/** 标记“已上报，等裁决”。 */
export function markReported(
  root: string,
  id: string,
  note: string,
  evidence = "",
): Dispatch | null {
  const rows = readDispatches(root);
  const idx = rows.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  const cur = rows[idx] as Dispatch;
  if (isSettled(cur.status)) return null;
  const ev = String(evidence ?? "").trim();
  const next: Dispatch = {
    ...cur,
    status: "reported",
    /* 记上报时刻：监工要靠它判断“报了多久还没人裁决”，见 sweepReported。 */
    reported_at: new Date().toISOString(),
    ...(note ? { review_note: note } : {}),
    ...(ev ? { report_evidence: ev.slice(0, 4000) } : {}),
  };
  rows[idx] = next;
  writeJsonl(dispatchPath(root), rows);
  syncTaskForDispatch(root, next);
  return next;
}

/** 上报后长期没人裁决的单：退回 `open`，交给下一轮重派。 */
export function sweepReported(root: string, maxAgeMs = 10 * 60_000): Dispatch[] {
  const rows = readDispatches(root);
  const now = Date.now();
  const hit: Dispatch[] = [];
  for (const d of rows) {
    if (d.status !== "reported") continue;
    const at = Date.parse(String(d.reported_at ?? ""));
    /* 没有上报时刻的老记录（本字段加上之前写的）：按已超时处理，一次清掉积压。 */
    const age = Number.isFinite(at) ? now - at : Number.POSITIVE_INFINITY;
    if (age < maxAgeMs) continue;
    d.status = "open";
    d.note = "上报后一直没人裁决，退回重派";
    hit.push(d);
  }
  if (hit.length > 0) writeJsonl(dispatchPath(root), rows);
  return hit;
}

/** 最后一张还没了结的单。只用于“有没有在途工作”这类整体判断，逐单处理请用 activeDispatches。 */
export function activeDispatch(root: string): Dispatch | undefined {
  return activeDispatches(root).pop();
}

/**
 * 领单。只有 `open` 状态的单可被领。
 *
 * 非原子读改写，不保证并发互斥：两个工作进程同时领同一张派单时，后写者可能覆盖
 * 先写者的记录。并发安全由监工单实例串行派单提供。
 *
 * @returns 领到的派单；单不存在或状态不是 `open` 时返回 null。
 */
export function claimDispatch(root: string, id: string, worker: string, session = ""): Dispatch | null {
  const rows = readDispatches(root);
  const idx = rows.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  const cur = rows[idx] as Dispatch;
  if (cur.status !== "open") return null;

  const next: Dispatch = {
    ...cur,
    status: "claimed",
    worker,
    session,
    claimed_at: new Date().toISOString(),
  };
  /*
   * 让位标记到此为止：这一单已经被领走，恢复顺序与“已让位”都不再是它的事。
   * 留着不清会让界面在它跑起来之后仍然标“已让位”，也会让下一次排队继续吃旧序号。
   */
  delete next.yielded_at;
  delete next.yielded_by;
  delete next.yield_rank;
  rows[idx] = next;
  writeJsonl(dispatchPath(root), rows);
  return next;
}

/**
 * 了这一单就再也没有下文的状态。
 *
 * `closed` 也在里面：结项是终态，`finishDispatch` 之类“改结论”的写入一律拒绝，
 * 否则一次晚到的 worker 上报能把人刚关掉的单重新打开。
 */
function isSettled(status: DispatchStatus): boolean {
  return status === "done" || status === "failed" || status === "closed";
}

/**
 * 了结一单，把状态置为 `done` 或 `failed`。
 *
 * @param note 结单说明。省略时不写入 `note` 字段。
 * @returns 结单后的派单；单不存在或已是终态时返回 null。
 */
export function finishDispatch(
  root: string,
  id: string,
  status: "done" | "failed",
  note?: string,
): Dispatch | null {
  const rows = readDispatches(root);
  const idx = rows.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  const cur = rows[idx] as Dispatch;
  if (isSettled(cur.status)) return null;

  const next: Dispatch = {
    ...cur,
    status,
    done_at: new Date().toISOString(),
    ...(note ? { note } : {}),
  };
  rows[idx] = next;
  writeJsonl(dispatchPath(root), rows);
  /** 派单状态是事实，任务池是它的投影，每次结单必须同步一次。 */
  syncTaskForDispatch(root, next);
  return next;
}

/** 队列顺序：谁先被拉起。 */
export function compareQueueOrder(a: Dispatch, b: Dispatch, ia = 0, ib = 0): number {
  const pa = Date.parse(String(a.promoted_at ?? "")) || 0;
  const pb = Date.parse(String(b.promoted_at ?? "")) || 0;
  const fa = Date.parse(String(a.front_at ?? "")) || 0;
  const fb = Date.parse(String(b.front_at ?? "")) || 0;
  const ya = yieldRankOf(a);
  const yb = yieldRankOf(b);
  /* yieldRankOf 拿字段缺失当 MAX_SAFE_INTEGER，这里用它判断“有没有恢复序号”。 */
  const hasRankA = ya < Number.MAX_SAFE_INTEGER;
  const hasRankB = yb < Number.MAX_SAFE_INTEGER;
  /*
   * 四档，语义各不相同：4 = 立即执行（promoted_at，会腾槽抢占）；
   * 3 = 让位恢复（yield_rank 在、yielded_at 已清，仅次于置顶）；2 = 插队到队首
   * （front_at，只调顺序）；1 = 建单自带立即语义（urgent，仍只是排队）；0 = 普通 FIFO。
   */
  const ra = pa > 0 ? 4 : hasRankA && !a.yielded_at ? 3 : fa > 0 ? 2 : a.urgent ? 1 : 0;
  const rb = pb > 0 ? 4 : hasRankB && !b.yielded_at ? 3 : fb > 0 ? 2 : b.urgent ? 1 : 0;
  if (ra !== rb) return rb - ra;
  /* 恢复档内部只认让位前的先后，不再看置顶/插队时间（恢复单不该有这些，有也以序号为准）。 */
  if (ra === 3) return ya - yb;
  if (pa !== pb) return pb - pa;
  if (fa !== fb) return fb - fa;
  if (ya !== yb) return ya - yb;
  return ia - ib;
}

/** 恢复顺序；没有这个字段（或写坏了）时排在所有带序号的单之后。 */
function yieldRankOf(d: Dispatch): number {
  const n = Number(d.yield_rank);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/** 按 {@link compareQueueOrder} 排好的 open 派单。 */
export function openQueue(root: string): Dispatch[] {
  return readDispatches(root)
    .map((d, i) => ({ d, i }))
    .filter((x) => x.d.status === "open")
    .sort((x, y) => compareQueueOrder(x.d, y.d, x.i, y.i))
    .map((x) => x.d);
}

/** 一张派单的父节点 id：`parent` 优先；老台账里只有一个 `after` 的记录按父节点处理。 */
export function parentOf(d: { id?: string; parent?: string; after?: string[] }): string {
  const p = String(d.parent ?? "").trim();
  if (p) return p;
  const after = Array.isArray(d.after) ? d.after.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
  if (after.length === 1 && after[0] !== "*") return after[0] as string;
  return "";
}

/** 前置集合：父节点 + 遗留 `after` 里的多前置。`barrier` 表示带 `"*"`（等所有其它单到终态）。 */
export function prerequisitesOf(d: {
  id?: string;
  parent?: string;
  after?: string[];
}): { ids: string[]; barrier: boolean } {
  const after = Array.isArray(d.after) ? d.after.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
  const ids = [...new Set([parentOf(d), ...after.filter((x) => x !== "*")].filter(Boolean))];
  return { ids, barrier: after.includes("*") };
}

/**
 * 这张单挂的前置里，哪些编号在台账里根本找不到（孤儿前置）。
 *
 * {@link dependenciesSettled} 对孤儿前置按“已满足”放行（等一个不存在的编号就是永久
 * 等待），但放行必须留痕：调度层每拍拿这个函数核对，有孤儿就记
 * `dispatch_parent_missing` 事件，否则台账被归档/重写之后，依赖静默失效，
 * 顺序错了却没人知道是哪张单、缺了哪个编号。
 */
export function missingPrerequisites(
  d: { id: string; parent?: string; after?: string[] },
  rows: Dispatch[],
): string[] {
  const { ids } = prerequisitesOf(d);
  if (ids.length === 0) return [];
  const byId = new Set(rows.map((x) => String(x.id)));
  return ids.filter((id) => !byId.has(id));
}

/** 一条链的身份：`lineage` 为空的单自成一链。 */
function lineageOf(x: Dispatch): string {
  return String(x.lineage ?? x.id);
}

/**
 * 一张单的“这是什么活”指纹：剥掉附件行、压平空白后的正文。
 *
 * 台账里同一件事会有多条记录（每次重派一条），它们只有 `action` 尾部可能被追加
 * 插话/验收清单。做归组（重建树）和认亲（血缘匹配）都靠这个指纹，口径必须同一份。
 *
 * 正文为空时退回 `stage/shard`，再为空退回标题。
 */
export function workKeyOf(d: { action?: string; title?: unknown; stage?: string; shard?: string }): string {
  const body = String(d.action ?? "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[附件]/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  if (body) return body;
  const shard = `${String(d.stage ?? "")}/${String(d.shard ?? "")}`;
  if (shard !== "/") return `shard:${shard}`;
  return `title:${String(d.title ?? "").trim()}`;
}

function sameWork(a: Dispatch, b: Dispatch): boolean {
  if (workKeyOf(a) === workKeyOf(b)) return true;
  /* 正文被模型微调过、但标题整条继承的情况：重派路径同样会带过来。 */
  const ta = String((a as { title?: unknown }).title ?? "").trim();
  const tb = String((b as { title?: unknown }).title ?? "").trim();
  return Boolean(ta) && ta === tb;
}

export function pendingPrerequisites(
  d: { id: string; parent?: string; after?: string[] },
  rows: Dispatch[],
): string[] {
  const { ids, barrier } = prerequisitesOf(d);
  const pending: string[] = [];

  if (barrier) {
    /* 除自己以外，还有没有活着的单：有就等，没有才轮到我。 */
    const alive = rows.some(
      (x) => x.id !== d.id && x.status !== "done" && x.status !== "closed" && x.status !== "failed",
    );
    if (alive) pending.push("*");
  }
  if (ids.length === 0) return pending;

  const settled = rows.filter((x) => x.status === "done" || x.status === "closed");
  const settledIds = new Set(settled.map((x) => String(x.id)));
  /* 血缘 -> 已完成的那些记录。判据是“同一件事的后续尝试”，不是“同一条链上任一张”。 */
  const settledByLineage = new Map<string, Dispatch[]>();
  for (const x of settled) {
    const k = lineageOf(x);
    const list = settledByLineage.get(k);
    if (list) list.push(x);
    else settledByLineage.set(k, [x]);
  }
  const settledShards = new Set(
    settled
      .filter((x) => String(x.shard ?? "").trim())
      .map((x) => `${String(x.stage ?? "")}/${String(x.shard)}`),
  );
  const byId = new Map(rows.map((x) => [String(x.id), x] as const));

  for (const id of ids) {
    if (settledIds.has(id)) continue;
    const ref = byId.get(id);
    if (!ref) continue; // 孤儿前置：放行并留痕，见上面的说明
    const refShard = String(ref.shard ?? "").trim();
    if (refShard !== "" && settledShards.has(`${String(ref.stage ?? "")}/${refShard}`)) continue;
    if (settledByLineage.get(lineageOf(ref))?.some((x) => sameWork(x, ref))) continue;
    pending.push(id);
  }
  return pending;
}

/**
 * 依赖判定：派单的前置是否都到终态。
 *
 * 判定逻辑在 {@link pendingPrerequisites}，此处为“无剩余前置”的简写；
 * 调度层与森林视图共用该判定。
 */
export function dependenciesSettled(
  d: { id: string; parent?: string; after?: string[] },
  rows: Dispatch[],
): boolean {
  return pendingPrerequisites(d, rows).length === 0;
}

/** 森林视图：一棵树一个根，`children` 是直接子节点，`depth` 是相对根的层数。 */
export interface DispatchForest {
  /** 没有父节点的节点（含父节点不在台账里的孤儿），按台账顺序。 */
  roots: string[];
  /** 父 id -> 直接子 id[]，按台账顺序。 */
  children: Record<string, string[]>;
  /** 节点 id -> 层数（根为 0）；落在环上的节点为 -1。 */
  depth: Record<string, number>;
  /** 成环的节点组，每组从回边指向的那个节点开始。 */
  cycles: string[][];
  /** 父节点在台账里找不到的节点。 */
  orphans: string[];
}

export function dispatchForest(rows: Dispatch[]): DispatchForest {
  const known = new Set(rows.map((r) => String(r.id)));
  const children: Record<string, string[]> = {};
  const parentEdge = new Map<string, string>();
  const roots: string[] = [];
  const orphans: string[] = [];

  for (const r of rows) {
    const id = String(r.id ?? "");
    if (!id) continue;
    const p = parentOf(r);
    if (!p) {
      roots.push(id);
      continue;
    }
    if (!known.has(p)) {
      orphans.push(id);
      roots.push(id);
      continue;
    }
    parentEdge.set(id, p);
    (children[p] ??= []).push(id);
  }

  /*
   * 成环检测：每个节点最多一个父，所以从任意节点一路上溯，要么到根，要么回到走过的节点。
   * 走完的节点标记为已处理，整体 O(n)，调度每拍都要跑，不能是平方级。
   */
  const seen = new Set<string>();
  const cycles: string[][] = [];
  for (const start of parentEdge.keys()) {
    if (seen.has(start)) continue;
    const path: string[] = [];
    const at = new Map<string, number>();
    let cur: string | undefined = start;
    while (cur && !seen.has(cur)) {
      const idx = at.get(cur);
      if (idx !== undefined) {
        cycles.push(path.slice(idx));
        break;
      }
      at.set(cur, path.length);
      path.push(cur);
      cur = parentEdge.get(cur);
    }
    for (const n of path) seen.add(n);
  }

  const inCycle = new Set(cycles.flat());
  const depth: Record<string, number> = {};
  const queue = roots.filter((id) => !inCycle.has(id));
  for (const id of queue) depth[id] = 0;
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i] as string;
    for (const c of children[id] ?? []) {
      if (inCycle.has(c) || depth[c] !== undefined) continue;
      depth[c] = (depth[id] ?? 0) + 1;
      queue.push(c);
    }
  }
  /* 挂在环下面的节点到不了根，标 -1：它们在树里没有位置，等人处理这个环。 */
  for (const id of parentEdge.keys()) if (depth[id] === undefined) depth[id] = -1;

  return { roots, children, depth, cycles, orphans };
}

/** 一棵子树里 `id` 的所有后代（不含自己），按层序、同层按台账顺序。 */
export function descendantsOf(rows: Dispatch[], id: string): string[] {
  const f = dispatchForest(rows);
  const seen = new Set<string>();
  const out: string[] = [];
  const queue = [...(f.children[String(id)] ?? [])];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i] as string;
    if (seen.has(n) || n === String(id)) continue;
    seen.add(n);
    out.push(n);
    for (const c of f.children[n] ?? []) queue.push(c);
  }
  return out;
}

/** 树边校验结果。`code` 给程序用，`reason` 给人看。 */
export interface TreeEdgeCheck {
  ok: boolean;
  code: "" | "missing_parent" | "closed_parent" | "dead_parent" | "self_parent" | "cycle" | "missing_reason";
  reason: string;
}

/** 建单前校验一条树边：父节点必须存在、没被结项、不成环，且理由必填。 */
export function checkTreeEdge(rows: Dispatch[], parentId: string, reason: string, childId = ""): TreeEdgeCheck {
  const p = String(parentId ?? "").trim();
  if (!p) return { ok: true, code: "", reason: "" };
  if (childId && p === childId) {
    return { ok: false, code: "self_parent", reason: `父节点不能是本单自己（${p}）` };
  }
  if (!String(reason ?? "").trim()) {
    return {
      ok: false,
      code: "missing_reason",
      reason: "声明了父节点但未写 PARENT_REASON：说明为何必须先完成父节点（一两句），否则无法判定该边是否成立",
    };
  }
  const byId = new Map(rows.map((r) => [String(r.id), r] as const));
  const parent = byId.get(p);
  if (!parent) {
    return {
      ok: false,
      code: "missing_parent",
      reason: `父派单“${p}”在台账里找不到：先派父节点，或核对编号后重发（依赖不落数据就不生效）`,
    };
  }
  if (parent.status === "closed") {
    return {
      ok: false,
      code: "closed_parent",
      reason: `父派单 ${p} 已被结项（closed），不会再有产出：本单不挂父节点重发，或改挂仍会产出的前置`,
    };
  }
  if (parent.status === "failed" && String((parent as { retry_verdict?: string }).retry_verdict ?? "") === "give_up") {
    return {
      ok: false,
      code: "dead_parent",
      reason:
        `父派单 ${p} 已判死且不再重试（${String(parent.note ?? "").slice(0, 60) || "无备注"}）：` +
        `挂上去只会永久等待。要么先 capitalist retry ${p} 让它重新可跑，要么本单不挂父节点`,
    };
  }
  /* 上溯：父节点自己已经挂在环里，或者（改挂时）绕回本单，都是成环。 */
  const walked = new Set<string>();
  let cur: string | undefined = p;
  while (cur) {
    if (childId && cur === childId) {
      return { ok: false, code: "cycle", reason: `成环：父节点 ${p} 的上溯链回到本单（${childId}）` };
    }
    if (walked.has(cur)) {
      return {
        ok: false,
        code: "cycle",
        reason: `成环：父节点 ${p} 的上溯链在 ${cur} 处重复（${[...walked].join("、")}），这条链上没有任何一单能启动`,
      };
    }
    walked.add(cur);
    const row = byId.get(cur);
    cur = row ? parentOf(row) || undefined : undefined;
  }
  return { ok: true, code: "", reason: "" };
}

/**
 * 手动插队：把一张排队中的单置顶。
 *
 * 只接受 `open`：`claimed` 的进程已经拿着启动 prompt 运行中，插队对它没有意义（也插不进去）；
 * 终态单更不该被叫醒，那是“重开”，走 `reopenDispatch` 或 `capitalist update … status open`。
 *
 * 置顶不改台账顺序，只写 `promoted_at`，由 {@link compareQueueOrder} 参与调度排序。
 *
 * @returns 置顶后的派单；单不存在、或不是排队态时返回 null（调用方按 409 处理）。
 */
export function promoteDispatch(root: string, id: string, by = "user", at = new Date().toISOString()): Dispatch | null {
  const rows = readDispatches(root);
  const idx = rows.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  const cur = rows[idx] as Dispatch;
  if (cur.status !== "open") return null;
  const next: Dispatch = { ...cur, urgent: true, promoted_at: at, promoted_by: by };
  rows[idx] = next;
  writeJsonl(dispatchPath(root), rows);
  return next;
}

/** 插队：把一张排队中的单放到排队队首，但不抢占正运行中的进程。 */
export function frontDispatch(root: string, id: string, by = "user", at = new Date().toISOString()): Dispatch | null {
  const rows = readDispatches(root);
  const idx = rows.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  const cur = rows[idx] as Dispatch;
  if (cur.status !== "open") return null;
  const next: Dispatch = { ...cur, front_at: at, front_by: by };
  rows[idx] = next;
  writeJsonl(dispatchPath(root), rows);
  return next;
}

/** 手动结项：把一单关成终态 `closed`。 */
export interface WorkerModelRequest {
  shard: string;
  model: string;
  at: string;
}

export function workerModelPath(root: string): string {
  return join(supervisorDir(root), "worker_model.json");
}

/** 登记一次换模型请求（覆盖上一条：只保留最近一次意图）。 */
export function setWorkerModel(root: string, shard: string, model: string): void {
  writeJson(workerModelPath(root), {
    shard: String(shard || ""),
    model: String(model || ""),
    at: new Date().toISOString(),
  });
}

/** 派单时取一次：分片匹配（或请求未限定分片）才消费并删除，不匹配就留着等下一单。 */
export function takeWorkerModel(root: string, shard: string): string {
  const p = workerModelPath(root);
  try {
    if (!existsSync(p)) return "";
    const rec = readJson<WorkerModelRequest>(p, { shard: "", model: "", at: "" });
    const want = String(rec?.shard ?? "");
    const model = String(rec?.model ?? "");
    if (!model) return "";
    if (want && want !== String(shard || "")) return "";
    unlinkSync(p);
    return model;
  } catch {
    return "";
  }
}


export const DEFAULT_MODEL_ROTATION: readonly string[] = ["deepseek-v4.1-flash", "glm-5.3-flash"];

function rotatePath(root: string): string {
  return join(supervisorDir(root), "model_rotate.json");
}

/** 取下一个轮换默认模型，并把计数推进一位。 */
export function nextRotatingDefaultModel(
  root: string,
  candidates: readonly string[] = DEFAULT_MODEL_ROTATION,
): string {
  if (candidates.length === 0) return "";
  if (candidates.length === 1) return String(candidates[0]);
  let index = 0;
  try {
    const prev = readJson<{ index?: number }>(rotatePath(root), {});
    const n = Number(prev?.index);
    if (Number.isFinite(n) && n >= 0) index = Math.floor(n);
  } catch {
    index = 0;
  }
  const model = String(candidates[index % candidates.length] ?? candidates[0]);
  try {
    writeJson(rotatePath(root), { index: index + 1, at: new Date().toISOString() });
  } catch {
    /* 计数写不进去就不推进：下一单还会拿到同一个模型，可接受。 */
  }
  return model;
}

export function closeDispatch(root: string, id: string, note?: string, by = "user"): Dispatch | null {
  const rows = readDispatches(root);
  const idx = rows.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  const cur = rows[idx] as Dispatch;
  /** `failed` 必须能关。 */
  if (isSettled(cur.status) && cur.status !== "failed") return null;

  const now = new Date().toISOString();
  const next: Dispatch = {
    ...cur,
    status: "closed",
    done_at: now,
    closed_at: now,
    closed_by: by,
    ...(note ? { note } : {}),
  };
  rows[idx] = next;
  writeJsonl(dispatchPath(root), rows);
  syncTaskForDispatch(root, next);
  return next;
}

export function requeueDispatch(root: string, id: string, note?: string): Dispatch | null {
  const rows = readDispatches(root);
  const idx = rows.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  const cur = rows[idx] as Dispatch;
  /* 已经在排队了：重复点一次切换不该把队列顺序再洗一遍。 */
  if (cur.status === "open") return cur;

  const now = new Date().toISOString();
  const next = {
    ...cur,
    status: "open",
    wake_at: now,
    ...(note ? { note } : {}),
  } as Dispatch & { wake_at?: string; closed_at?: string; closed_by?: string };
  delete next.done_at;
  delete next.closed_at;
  delete next.closed_by;
  rows[idx] = next;
  writeJsonl(dispatchPath(root), rows);
  syncTaskForDispatch(root, next);
  return next;
}

/** 把一张单挂成“待确认”。 */
export function openReviewDispatch(
  root: string,
  id: string,
  note: string,
  windowMs: number,
): Dispatch | null {
  const rows = readDispatches(root);
  const idx = rows.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  const cur = rows[idx] as Dispatch;
  if (isSettled(cur.status)) return null;
  const next: Dispatch = {
    ...cur,
    status: "review",
    review_until: new Date(Date.now() + windowMs).toISOString(),
    ...(note ? { review_note: note } : {}),
  };
  rows[idx] = next;
  writeJsonl(dispatchPath(root), rows);
  syncTaskForDispatch(root, next);
  return next;
}

/** 扫一遍到点的待确认单，自动结单。每轮调度 调一次。 */
export function sweepReviews(root: string): Dispatch[] {
  const rows = readDispatches(root);
  const now = Date.now();
  const out: Dispatch[] = [];
  let changed = false;
  for (let i = 0; i < rows.length; i += 1) {
    const d = rows[i] as Dispatch;
    if (d.status !== "review") continue;
    const until = Date.parse(String(d.review_until ?? ""));
    if (!Number.isFinite(until) || until > now) continue;
    const next: Dispatch = {
      ...d,
      status: "done",
      done_at: new Date().toISOString(),
      ...(d.review_note ? { note: d.review_note } : {}),
    };
    delete next.review_until;
    delete next.review_note;
    rows[i] = next;
    out.push(next);
    changed = true;
  }
  if (changed) {
    writeJsonl(dispatchPath(root), rows);
    // 自动结单也是结单：任务池必须跟着走，否则“已验收”永远差这一批。
    for (const d of out) syncTaskForDispatch(root, d);
  }
  return out;
}

/**
 * 队列中第一张状态为 `open` 且未暂停的派单。没有则返回 undefined。
 *
 * 暂停单不参与领取：外部会话通过 `capitalist next` 领单时，即使绕过监工调度也需检查该标记。
 */
export function firstOpenDispatch(root: string): Dispatch | undefined {
  return readDispatches(root).find((d) => d.status === "open" && !dispatchPaused(d));
}
