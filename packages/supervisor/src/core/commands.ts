
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { attachmentsIn, stripAttachments } from "./attachments";
import { appendJsonl, readJson, readJsonl, writeJson, writeJsonl } from "./json";
import { recordEvent } from "./ledger";
import { supervisorDir } from "./paths";
import { closeDispatch, compareQueueOrder, finishDispatch, loadWorker, pidAlive, promoteDispatch, readDispatches, requeueDispatch, saveWorker } from "./supervisor";
import { leaseEnded, readPreemptLease } from "./preempt";
import type { Dispatch, WorkerRecord } from "./supervisor";

/** 同步睡眠用的共享缓冲：`Atomics.wait` 是 Node 里唯一不依赖定时器的阻塞睡眠原语。 */
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

/** 同步睡眠指定毫秒。锁重试之间用它，避免引入异步调用链。 */
function sleepSync(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

/** 延迟回收整棵进程树（不阻塞调用方）。 */
function reapTreeLater(pid: number, delayMs = 2500): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const t = setTimeout(() => {
    const win = process.platform === "win32";
    try {
      const c = spawn(win ? "taskkill" : "pkill", win ? ["/T", "/F", "/PID", String(pid)] : ["-9", "-P", String(pid)], {
        windowsHide: true,
        stdio: "ignore",
      });
      c.on("error", () => {
        /* 命令没有就算了，交给下次启动的孤儿清理 */
      });
    } catch {
      /* 同上 */
    }
  }, delayMs);
  /* 定时器不持有进程，调用方可能是短生命周期的 CLI。 */
  t.unref?.();
}

/** 锁目录超过这个年龄即视为持锁进程已崩溃留下的残留。 */
const LOCK_STALE_MS = 10_000;

/** 锁目录的年龄是否已超过可判定残留的阈值；stat 失败按“不旧”处理，不去删别人的锁。 */
function lockIsStale(lock: string): boolean {
  try {
    return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** 跨进程小锁。 */
export function withFileLock<T>(file: string, fn: () => T): { ok: true; value: T } | { ok: false } {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 1500;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return { ok: false };
      if (Date.now() > deadline) {
        if (!lockIsStale(lock)) return { ok: false };
        try {
          rmSync(lock, { recursive: true, force: true });
        } catch {
          return { ok: false };
        }
        continue;
      }
      sleepSync(20);
    }
  }
  try {
    return { ok: true, value: fn() };
  } finally {
    try {
      rmSync(lock, { recursive: true, force: true });
    } catch {
      /* 锁目录已被清掉不影响结果 */
    }
  }
}


export interface Directive {
  at: string;
  at_ts: number;
  type: "direct";
  /**
   * 在 `direct.jsonl` 中的行号（从 1 开始）。
   *
   * 对外一律用 `#行号` 指代一条插话：`M-` 开头的消息号是内部标识，既长又无法口头复述，
   * 让 worker 在派单正文里看到它、再原样抄进回报，只会制造对不上号的错误。行号在文件里
   * 稳定（只追加不重排），注入正文与回报解析用它即可对上同一条记录。
   */
  no?: number;
  /** 发起这条话的进程（`W-…`）。 */
  thread?: string;
  /**
   * 发起这条话的线程（`阶段/分片`，无分片是 `阶段/x血缘尾号`，见 {@link laneKeyOf}）。
   *
   * 线程比分派单长寿：同一线程重派出来的新进程、新单都还认这条话。用户在某条线程里
   * 追加的内容天然属于那条线程，不因为中途换过一次进程就失效。
   */
  lane?: string;
  /** 目标分片。空 = 下一次任意派单 */
  shard?: string | null;
  /** 目标血缘（派单链的首单 id）。 */
  lineage?: string;
  /** 目标：这句话是说给哪一单的（派单 id `D-…` 或 worker id `W-…`）。 */
  target?: string;
  text: string;
  via?: "user" | "capitalist";
  /**
   * 这句话自带的附件路径（一行一个的 `[附件]` 行解析出来的）。
   *
   * 落库时就把归属钉死在这里：看板读消息时按这条记录自己的 atts 画图，
   * 不再靠“正文里恰好有一行 [附件]”去猜，更不碰上一条消息或全局暂存。
   */
  atts?: string[];
  /**
   * 这句话来自哪条用户消息（`M-…`）。
   *
   * 附件归属靠它回查：派单建单时按这个标识去 `supervisor_chat_ask` 事件里取那条消息自己的
   * `atts`，而不是从 action 正文里重新解析。老记录没有这个字段，读侧按“只认自己的
   * 正文”兼容。
   */
  msg_id?: string;
  /**
   * 被引消息的标识（线程消息 ref，`D-…` / `S-…` 等，与界面 `#编号` 同一份）。
   *
   * 只做留痕与拼装素材：匹配规则不看它。落盘时同步取回的原文摘录落在
   * {@link Directive.quote_text}，消费端拼派单说明时直接用，不再回头查线程。
   */
  quote?: string;
  /**
   * 被引消息的原文摘录（落盘时按 {@link Directive.quote} 取回并截断）。
   * 老记录或取回失败时没有这个字段，拼装时只显示编号。
   */
  quote_text?: string;
  stage?: string;
  /** 是否已被某次派单取走。缺省按未消费处理（兼容旧记录） */
  consumed?: boolean;
  consumed_at?: string;
  consumed_by?: string;
  consumed_via?: string;
  /**
   * `consumed_via = "dropped"` 时的原因：说明这条追加为什么没有投递出去。
   * 与 `consumed_by` 分开记录，避免把“没有任何进程领走”显示成“已并入派单”。
   */
  dropped_reason?: string;
  delivered?: boolean;
  delivered_at?: string;
  /** 送达它的派单 id（与 consumed_by 同值，单独立名以便按“本单送过哪些”批量取） */
  delivered_by?: string;
  /**
   * 落实结论，由执行侧（worker）在 `capitalist report --outcome` 里逐条回报。
   *
   * - `done`     已按这条改完（要说清改在哪）
   * - `not_mine` 判定不属本单（必须说清该归哪一单，否则等于丢弃）
   * - `blocked`  做不了（说清卡在哪；不许拿来做“懒得做”的出口）
   */
  outcome?: DirectiveOutcome;
  outcome_note?: string;
  outcome_at?: string;
}

/** 一条插话的落实结论。含义见 {@link Directive.outcome}。 */
export type DirectiveOutcome = "done" | "not_mine" | "blocked";

/** 结论的合法取值，解析命令行时用。 */
export const DIRECTIVE_OUTCOMES: readonly DirectiveOutcome[] = ["done", "not_mine", "blocked"];

export function isDirectiveOpen(r: Directive): boolean {
  if (r.outcome) return false;
  if (r.delivered) return true;
  return r.consumed !== true;
}

/**
 * 一条插话的对外编号：回报结论、拼进派单、界面回显都用它。
 *
 * 优先 `msg_id`（与看板消息号同一份，人能对着聊天记录核对）；老记录没有它时退回落盘
 * 时间，时间在台账里唯一，且 worker 从派单正文里抄得下来。
 */
export function directiveRef(r: Directive): string {
  return String(r.msg_id ?? "") || String(r.at ?? "");
}

/**
 * 对外的短号：`#行号`。老记录没有行号时回落到 {@link directiveRef}。
 *
 * 派单正文与回报都用它，worker 不必抄一串 `M-…`。
 */
export function directiveShortRef(r: Directive): string {
  return r.no ? `#${r.no}` : directiveRef(r);
}

/**
 * 按编号找插话。`ref` 可以是 `msg_id`，也可以是落盘时间（见 {@link directiveRef}）。
 */
export function directiveByRef(root: string, ref: string): Directive | undefined {
  const key = String(ref ?? "").trim();
  if (!key) return undefined;
  return listDirectives(root).find((r) => directiveRef(r) === key);
}

/** 插话队列的绝对路径：`<root>/.capitalist/direct.jsonl`。 */
export function directPath(root: string): string {
  return join(supervisorDir(root), "direct.jsonl");
}

/**
 * 把指向同一张派单的未消费追加标记为不再投递。
 *
 * 用于目标单已终结、且其所属阶段已推进的情形：这类追加无法随任何派单带入执行，
 * 保持未消费会让每轮调度重复尝试投递。记录保留在队列文件内，只置消费位并写明原因，
 * 供看板与会话流回溯。
 *
 * 与 {@link claimDirectives} 的差别：这里不设 delivered，也不写 consumed_by，
 * 因为内容没有送达任何进程。
 */
export function dropDirectivesFor(root: string, target: string, reason: string): Directive[] {
  const id = String(target ?? "").trim();
  if (!id) return [];
  const file = directPath(root);
  const got = withFileLock(file, () => {
    const fresh = readJsonl<Directive>(file);
    const dropped: Directive[] = [];
    for (const r of fresh) {
      if (r.consumed === true) continue;
      if (String(r.target ?? "").trim() !== id) continue;
      r.consumed = true;
      r.consumed_at = new Date().toISOString();
      r.consumed_via = "dropped";
      r.dropped_reason = reason;
      dropped.push(r);
    }
    if (dropped.length > 0) writeJsonl(file, fresh);
    return dropped;
  });
  return got.ok ? got.value : [];
}

export function isWorkerRef(v: string): boolean {
  const s = String(v ?? "").trim();
  return /^W-/i.test(s) || /^\d+$/.test(s);
}

/**
 * 派单 -> 它所属线程的键（`阶段/分片`；无分片时 `阶段/x血缘尾号`）。
 *
 * 线程键是任务的身份，比分单和进程都长寿：同一任务重派出来的几张单、拉起的几个
 * 进程共用同一个键，编号表（thread-no.json）也按它发行号。所以“用户在哪条线程里说
 * 的这句话”必须落到这个键上，落到派单 id 或进程 id 上，一次重派就换一代身份，
 * 这句话跟着那代一起作废。
 *
 * 规则与看板的 `taskKeyOf` 逐字一致（那边已改为调用本函数）。两处各写一遍必然漂，
 * 漂了之后界面上显示的线程和插话归的线程就不是同一条了。
 */
export function laneKeyOf(d: {
  stage?: string | undefined;
  shard?: string | null | undefined;
  lineage?: string | undefined;
  id?: string | undefined;
}): string {
  const st = String(d.stage ?? "").trim().toLowerCase();
  const sh = String(d.shard ?? "").trim().toLowerCase();
  if (sh) return `${st}/${sh}`;
  /** 用 `||` 不用 `??`：空串也要回退到 id。 */
  const l = String(d.lineage || d.id || "").trim();
  /* x 前缀：避免和真正的分片名撞（分片名不会以 x 开头）。 */
  return l ? `${st}/x${l.slice(-6)}` : `${st}/main`;
}

/**
 * 追加一条用户指令。
 *
 * 只写不读：能不能生效由调度层决定。写成功后返回落盘记录，调用方据此回显。
 * `text` 已在调用方按字段校验过（非空、限长），此处再校验一次空串。
 *
 * @returns 落盘后的记录；`text` 为空或写入失败时返回 null。
 */
export function appendDirective(
  root: string,
  input: {
    text: string;
    shard?: string | null;
    thread?: string | undefined;
    /** 线程键（{@link laneKeyOf} 的取值）。看板按线程发话时落这里，不落 thread。 */
    lane?: string | undefined;
    stage?: string;
    atts?: string[];
    /** 这条插话对应的用户消息标识（看板发送时生成）。 */
    msgId?: string;
    /** 目标血缘：无分片单靠它认领，防止别的一条链把话领走。 */
    lineage?: string;
    /** 目标单：这条话是说给哪一单的（派单 id 或 worker id）。 */
    target?: string;
    /** 说话人来源：`capitalist` = 对话层（监工）落的指令，缺省按用户处理。 */
    via?: "user" | "capitalist";
  },
): Directive | null {
  const text = input.text.trim();
  if (!text) return null;
  const rec: Directive = {
    at: new Date().toISOString(),
    at_ts: Date.now() / 1000,
    type: "direct",
    text,
    shard: input.shard ? input.shard : null,
    consumed: false,
  };
  /* 附件按“这条记录自己的”落盘：调用方给了就用它，没给就从自己的正文里解一次。 */
  const atts = input.atts?.length ? input.atts.map(String) : attachmentsIn(text);
  if (atts.length) rec.atts = [...new Set(atts)];
  if (input.msgId) rec.msg_id = input.msgId;
  if (input.thread) rec.thread = input.thread;
  if (input.lane) rec.lane = input.lane;
  if (input.stage) rec.stage = input.stage;
  if (input.lineage) rec.lineage = input.lineage;
  if (input.target) rec.target = input.target;
  if (input.via === "capitalist" || input.via === "user") rec.via = input.via;
  /*
   * 时间戳精度到毫秒：同一毫秒内连发两条时，`directiveRef` 会指向同一行，结项落到相邻记录上。
   * 与前一条相同或更早（时钟回拨）则顺延 1ms，保证引用唯一，落盘格式不变。
   */
  const file = directPath(root);
  const prev = readJsonl<Directive>(file);
  const lastAt = String(prev[prev.length - 1]?.at ?? "");
  if (lastAt && lastAt >= rec.at) {
    const next = new Date(new Date(lastAt).getTime() + 1);
    if (Number.isFinite(next.getTime())) {
      rec.at = next.toISOString();
      rec.at_ts = next.getTime() / 1000;
    }
  }
  if (!appendJsonl(file, rec)) return null;
  recordEvent(root, "direct_inject", {
    thread: input.thread ?? "",
    shard: input.shard ?? "",
    target: input.target ?? "",
    text: text.slice(0, 120),
  });
  return rec;
}

/**
 * 读全部插话记录。
 *
 * `text` 不是字符串的记录被跳过。
 */
export function listDirectives(root: string): Directive[] {
  return readJsonl<Directive>(directPath(root)).filter((r) => typeof r.text === "string");
}

/**
 * 一条插话的目标范围：谁在问“这行话是不是给我的”。
 *
 * 四个字段就是判定所需的全部事实：这一单是哪个阶段、哪个分片、哪张单、哪条链，
 * 以及问话的是哪个进程（执行中的送达只有它有值）。
 */
export interface DirectiveScope {
  shard: string;
  stage?: string;
  /** 这一单的派单 id。 */
  dispatchId?: string;
  /** 这一单的血缘（重派链首单 id）。 */
  lineage?: string;
  /** 问话的 worker id（hook 送达时才有）。 */
  workerId?: string;
  /**
   * 这一单所属的线程键（{@link laneKeyOf}）。
   *
   * `thread` 里存的若是线程键（老记录，看板落的），靠它认领；不给就只能按 workerId 比，
   * 那类话永远匹配不上。
   */
  lane?: string;
  /** 派单 id -> 它所属链的链首 id。给了才做链归并。 */
  lineageOf?: (dispatchId: string) => string;
}

export function directiveMatches(r: Directive, scope: DirectiveScope): boolean {
  const rs = String((r as { stage?: string }).stage ?? "");
  const stage = String(scope.stage ?? "");
  if (rs && stage && rs !== stage) return false;

  const target = String((r as { target?: string }).target ?? "");
  if (target) {
    if (target === String(scope.dispatchId ?? "")) return true;
    if (target === String(scope.lineage ?? "")) return true;
    if (target === String(scope.workerId ?? "")) return true;
    /** 说给某一个进程的话，绝不转手给别人。 */
    if (isWorkerRef(target)) return false;
    /** 链归并：target 指向的是同一条链上的另一张单，也算这一单的。 */
    const chain = scope.lineageOf?.(target) ?? "";
    if (chain && chain === String(scope.lineage ?? "")) return true;
    /** 目标那一单没了（失败重派生成新 id、新血缘）时，同分片的下一次补派仍然归这一片。 */
    return Boolean(r.shard) && r.shard === String(scope.shard ?? "");
  }

  const rl = String(r.lineage ?? "");
  if (rl) return rl === String(scope.lineage ?? "");

  const rt = String((r as { thread?: string }).thread ?? "");
  if (rt) {
    /*
     * 两种形状，两套判定。
     *
     * `W-…` 是进程 id：这是一台进程的私话，只认它本人，进程退出即作废。
     * 其它形状（`s1/x00ns0z`、`u1/main`）是线程键：用户是在某条线程里说的话，
     * 该线程重派出的新进程需要读取该值。
     *
     * 早先这里只有一条 `rt === scope.workerId`。线程键永远不等于任何 worker id，
     * 于是看板发的那批话 100% 失配，而且失配得毫无声响。
     */
    if (isWorkerRef(rt)) return rt === String(scope.workerId ?? "");
    const lane = String((r as { lane?: string }).lane ?? "") || rt;
    return Boolean(scope.lane) && lane === String(scope.lane);
  }

  const rlane = String((r as { lane?: string }).lane ?? "");
  if (rlane) return Boolean(scope.lane) && rlane === String(scope.lane);

  return !r.shard || r.shard === String(scope.shard ?? "");
}

/** 一次派单最多领几条插话。 */
const CLAIM_MAX_ITEMS = 5;

const CLAIM_MAX_CHARS = 4000;

/** 领取优先级：明确写给这一单的排最前，其次是本线程的，最后才是没有归属的。 */
function claimRank(r: Directive, scope: DirectiveScope): number {
  const t = String((r as { target?: string }).target ?? "");
  if (t && (t === String(scope.dispatchId ?? "") || t === String(scope.lineage ?? ""))) return 0;
  const lane = String((r as { lane?: string }).lane ?? "") || String((r as { thread?: string }).thread ?? "");
  if (lane && scope.lane && lane === String(scope.lane)) return 1;
  return 2;
}

/** 取走适用于该分片的未消费指令，并标记已用。 */
export function claimDirectives(
  root: string,
  input: {
    shard: string;
    stage?: string;
    dispatchId: string;
    lineage?: string;
    workerId?: string;
    /** 这一单所属的线程键（{@link laneKeyOf}）。不传时线程键形状的插话一律领不到。 */
    lane?: string;
    via?: string;
    limit?: number;
    maxChars?: number;
  },
): Directive[] {
  const file = directPath(root);
  let chainOf: Map<string, string> | null = null;
  const scope: DirectiveScope = {
    shard: String(input.shard ?? ""),
    stage: String(input.stage ?? ""),
    ...(input.dispatchId ? { dispatchId: String(input.dispatchId) } : {}),
    ...(input.lineage ? { lineage: String(input.lineage) } : {}),
    ...(input.workerId ? { workerId: String(input.workerId) } : {}),
    ...(input.lane ? { lane: String(input.lane) } : {}),
    lineageOf: (id: string): string => {
      if (!chainOf) {
        chainOf = new Map();
        for (const d of readDispatches(root)) {
          chainOf.set(String(d.id), String((d as { lineage?: string }).lineage ?? d.id));
        }
      }
      return chainOf.get(String(id)) ?? "";
    },
  };
  /* 取走途径落盘：launch（随派单启动带入）与 hook（执行中送达）分得清，见 Directive.consumed_via。 */
  const via = String(input.via ?? "launch");
  const limit = Math.max(1, Number(input.limit ?? CLAIM_MAX_ITEMS) || CLAIM_MAX_ITEMS);
  const maxChars = input.maxChars === 0 ? 0 : Math.max(0, Number(input.maxChars ?? CLAIM_MAX_CHARS) || CLAIM_MAX_CHARS);
  const probe = listDirectives(root).filter((r) => !r.consumed && directiveMatches(r, scope));
  if (probe.length === 0) return [];

  const got = withFileLock(file, () => {
    const fresh = readJsonl<Directive>(file);
    const taken: Directive[] = [];
    let chars = 0;
    const candidates = fresh
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => !r.consumed && typeof r.text === "string" && directiveMatches(r, scope));
    candidates.sort((a, b) => claimRank(a.r, scope) - claimRank(b.r, scope) || a.i - b.i);
    for (const { r, i } of candidates) {
      if (taken.length >= limit) break;
      /* 字数上限只约束“第二条起”：单条自己超长也得送，否则它会永远卡在队首。 */
      if (taken.length > 0 && maxChars > 0 && chars + r.text.length > maxChars) continue;
      /* 行号随记录一起带走：注入正文与回报都用它，见 `Directive.no`。 */
      r.no = i + 1;
      r.consumed = true;
      r.consumed_at = new Date().toISOString();
      r.consumed_by = input.dispatchId;
      r.consumed_via = via;
      r.delivered = true;
      r.delivered_at = String(r.consumed_at);
      r.delivered_by = input.dispatchId;
      taken.push(r);
      chars += r.text.length;
    }
    writeJsonl(file, fresh);
    return taken;
  });
  return got.ok ? got.value : [];
}

/** 把指令拼进 action。空指令原样返回，不产生空段落。 */
export function spliceDirectives(action: string, directives: Directive[]): string {
  if (directives.length === 0) return action;
  const lines = directives.map((d) => {
    const body = stripAttachments(d.text).replace(/\s*\n\s*/g, " ").trim();
    /*
     * 附件只认这条插话自己的字段。字段缺失（老记录）才从正文解析，正文是拼接产物，
     * 里面可能混着别处抄来的路径。
     */
    const files = Array.isArray(d.atts) ? d.atts.map((p) => String(p)) : attachmentsIn(d.text);
    /*
     * 每条前置编号：收工闸要求工作进程逐条回报结论，回报时按这个编号指认是哪一条
     * （见 `capitalist report --outcome`）。编号优先取消息号，老记录退回落盘时间。
     */
    const head = body ? `- [${directiveShortRef(d)}] ${body}` : `- [${directiveShortRef(d)}]`;
    const quoteLine = d.quote
      ? `  [引用 #${d.quote}] ${d.quote_text || "（原文未取回，仅编号）"}`
      : "";
    return [head, ...(quoteLine ? [quoteLine] : []), ...files.map((p) => `  [附件] ${p}`)].join("\n");
  });
  /** 先让它判断，再让它做；判断的结论必须逐条回报。 */
  const hint =
    "（逐条处理，每条都要给结论，收尾时用 capitalist report 的 --outcome 逐条回报：" +
    "本单做完写 `<编号>=done`；判定不属于本单写 `<编号>=not_mine` 并说明该归哪一单；" +
    "做不了写 `<编号>=blocked` 并说明卡在哪。有哪条没给结论，收工闸会挡回并列出缺哪几条。）";
  return appendSection(action, "【用户插话 · 只对本次派单生效】", [hint, ...lines]);
}

/**
 * 给一条插话写落实结论。
 *
 * 这是“送达”与“落实”之间的那一笔：`claimDirectives` 只记送到了哪一单，做没做由执行侧
 * 在这里回报。没有这一步，队列里只剩一个 consumed 布尔值，做没做永远无从查证。
 *
 * 只管一个编号，不做批量解析（调用方按 `capitalist report --outcome` 的格式拆好再逐条调）。
 * 写之前校验送达方：只有把这句话送到手的那张单能给它下结论，别的单改不了别人的账。
 *
 * @returns 命中并写入返回记录；编号查不到 / 不是这一单送出的 / 拿不到锁返回原因。
 */
export function markDirectiveOutcome(
  root: string,
  ref: string,
  outcome: DirectiveOutcome,
  opts?: { note?: string; by?: string },
): { ok: true; rec: Directive } | { ok: false; reason: string } {
  const key = String(ref ?? "").trim();
  if (!key) return { ok: false, reason: "缺少插话编号" };
  if (!DIRECTIVE_OUTCOMES.includes(outcome)) {
    return { ok: false, reason: `结论只能是 ${DIRECTIVE_OUTCOMES.join(" / ")}` };
  }
  const file = directPath(root);
  const by = String(opts?.by ?? "");
  const note = String(opts?.note ?? "").trim();
  /** not_mine / blocked 必须带说明。 */
  if ((outcome === "not_mine" || outcome === "blocked") && !note) {
    return {
      ok: false,
      reason:
        outcome === "not_mine"
          ? "not_mine 必须说明该归哪一单：--outcome \"<编号>=not_mine:该归 #30\""
          : "blocked 必须说明卡在哪：--outcome \"<编号>=blocked:等接口权限\"",
    };
  }
  const got = withFileLock(file, () => {
    const rows = readJsonl<Directive>(file);
    let hit = -1;
    const byNo = /^#(\d+)$/.exec(key);
    if (byNo) {
      /* 短号：行号（从 1 开始）直接定位，与注入正文里的 [#N] 同一口径。 */
      const idx = Number(byNo[1]) - 1;
      const row = rows[idx];
      if (row && typeof row.text === "string") hit = idx;
    } else {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const r = rows[i];
        if (!r || typeof r.text !== "string") continue;
        if (directiveRef(r) !== key) continue;
        hit = i;
        break;
      }
    }
    if (hit < 0) return { ok: false as const, reason: `找不到编号 ${key} 的插话（编号见派单正文里的 [方括号]）` };
    const rec = rows[hit] as Directive;
    const owner = String(rec.delivered_by ?? rec.consumed_by ?? "");
    if (by && owner && owner !== by) {
      return { ok: false as const, reason: `这条插话是送达给 ${owner} 的，不是这一单，改不了它的结论` };
    }
    rec.outcome = outcome;
    rec.outcome_at = new Date().toISOString();
    if (note) rec.outcome_note = note.slice(0, 400);
    writeJsonl(file, rows);
    return { ok: true as const, rec };
  });
  if (!got.ok) return { ok: false, reason: "插话台账被占用，稍后重试" };
  if (got.value.ok) {
    recordEvent(root, "directive_outcome", {
      ref: key,
      outcome,
      note: String(opts?.note ?? "").slice(0, 200),
      by,
    });
  }
  return got.value;
}

/**
 * 某张单送出、但还没有结论的插话。
 *
 * 收工闸与验收判定共用这一份：一处回答“还差哪几项未完成”，一处回答“这些要求是否落实”。
 * 两处各算一遍必然产生偏差，偏差会导致收工闸放行而验收判定未完成，且无法判断以哪一处为准。
 */
export function openDirectivesOf(root: string, dispatchId: string): Directive[] {
  const id = String(dispatchId ?? "");
  if (!id) return [];
  return listDirectives(root).filter((r) => String(r.delivered_by ?? "") === id && isDirectiveOpen(r));
}

/** 往派单正文末尾追加一段带标题的说明。 */
export function appendSection(action: string, header: string, lines: string[]): string {
  const body = lines.filter((l) => String(l ?? "").trim() !== "").join("\n");
  if (!body) return action;
  return `${action}\n\n${header}\n${body}`;
}


/**
 * 接管文件结构。
 *
 * 一个任务根可以同时有多片被接管，所以 `items` 是数组；整个文件仍是一个对象，便于
 * 别的读者（brief / 手工排查）一眼看清 root 与更新时间。早期版本把根对象直接写成数组，
 * {@link readTakeover} 仍然兼容那种形状，读进来后归一化。
 */
export interface TakeoverItem {
  /** null = 整个任务根（所有分片） */
  shard: string | null;
  at: string;
  reason: string;
  by: string;
  active: boolean;
  released_at: string | null;
}

/** 接管文件内容。 */
export interface TakeoverFile {
  root: string;
  updated_at: string;
  items: TakeoverItem[];
}

/** 接管文件的绝对路径：`<root>/.capitalist/takeover.json`。 */
export function takeoverPath(root: string): string {
  return join(supervisorDir(root), "takeover.json");
}

function normalizeItems(raw: unknown): TakeoverItem[] {
  if (!raw || typeof raw !== "object") return [];
  // 旧形状兼容：整份文件是数组（早期看板写的），或整份就是单条记录（早期 CLI 写的）。
  const rows: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { items?: unknown }).items)
      ? ((raw as { items: unknown[] }).items ?? [])
      : [raw];
  const out: TakeoverItem[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const shard = typeof o.shard === "string" && o.shard ? o.shard : null;
    const at = String(o.at ?? "");
    if (!at && o.active !== true) continue;
    out.push({
      shard,
      at,
      reason: String(o.reason ?? ""),
      by: String(o.by ?? "user"),
      active: o.active === true,
      released_at: typeof o.released_at === "string" ? o.released_at : null,
    });
  }
  return out;
}

/**
 * 读接管文件。
 *
 * @returns 接管文件内容。文件缺失或内容损坏时 `items` 为空数组。
 */
export function readTakeover(root: string): TakeoverFile {
  const raw = readJson<unknown>(takeoverPath(root), null);
  return {
    root,
    updated_at:
      raw && typeof raw === "object" && !Array.isArray(raw) ? String((raw as { updated_at?: unknown }).updated_at ?? "") : "",
    items: normalizeItems(raw),
  };
}

function writeTakeover(root: string, items: TakeoverItem[]): void {
  writeJson(takeoverPath(root), { root, updated_at: new Date().toISOString(), items });
}

/**
 * 接管某片（`shard` 为空 = 整个任务根）。
 *
 * 接管只改变监工行为：下次 轮调度起该片不再自动重派、也不再自动验收。它不终止已运行中的
 * 进程，要停进程用 {@link stopWorker}。重复接管同一片时更新原因与时间，不叠加条目，
 * 否则 release 一次会留下一条仍在生效的残留。
 *
 * @returns 写入的接管条目。
 */
export function takeoverShard(
  root: string,
  input: { shard?: string | null; reason: string; by?: string },
): TakeoverItem {
  const shard = input.shard && input.shard !== "all" ? input.shard : null;
  const items = readTakeover(root).items.filter((i) => i.active && i.shard !== shard);
  const rec: TakeoverItem = {
    shard,
    at: new Date().toISOString(),
    reason: input.reason || "用户手动接管",
    by: input.by ?? "user",
    active: true,
    released_at: null,
  };
  items.push(rec);
  writeTakeover(root, items);
  recordEvent(root, "takeover", { shard: shard ?? "*", reason: rec.reason, by: rec.by });
  return rec;
}

/** 交还。 */
export function releaseShard(root: string, shard?: string | null): { released: string[] } {
  const want = shard && shard !== "all" ? shard : null;
  const t = readTakeover(root).items;
  const hit: string[] = [];
  for (const i of t) {
    if (!i.active) continue;
    if (want !== null && i.shard !== want) continue;
    i.active = false;
    i.released_at = new Date().toISOString();
    hit.push(i.shard ?? "*");
  }
  writeTakeover(root, t);
  if (hit.length > 0) recordEvent(root, "release", { shard: hit.join(",") });
  return { released: hit };
}

/** 当前生效的接管范围。`all` 为真表示整个任务根被接管。 */
export interface TakeoverView {
  all: boolean;
  shards: string[];
  reason: string;
  at: string;
}

/**
 * 当前生效的接管范围。
 *
 * @returns 接管视图。没有生效接管时 `all` 为 false、`shards` 为空数组。
 */
export function activeTakeover(root: string): TakeoverView {
  const items = readTakeover(root).items.filter((i) => i.active);
  const all = items.find((i) => i.shard === null);
  const shards = items.filter((i) => i.shard !== null).map((i) => String(i.shard));
  return {
    all: Boolean(all),
    shards,
    reason: (all ?? items[0])?.reason ?? "",
    at: (all ?? items[0])?.at ?? "",
  };
}

/**
 * 该片是否被接管。传空分片时只看“整根接管”。
 */
export function isHeld(root: string, shard?: string | null): boolean {
  const v = activeTakeover(root);
  if (v.all) return true;
  return Boolean(shard) && v.shards.includes(String(shard));
}


export interface StopWorkerResult {
  id: string;
  pid: number;
  killed: boolean;
  alreadyTerminal: boolean;
  dispatch: string | null;
}

export interface StopWorkerOptions {
  requeue?: boolean;
  reason?: string;
}

/** 中断指定工作进程。 */
export function stopWorker(root: string, id: string, opts: StopWorkerOptions = {}): StopWorkerResult | null {
  const rec = loadWorker(root, id);
  if (!rec) return null;

  const requeue = opts.requeue === true;
  const alreadyTerminal = rec.status === "exited" || rec.status === "failed" || rec.status === "done";
  let killed = false;
  if (!alreadyTerminal && rec.pid > 0 && pidAlive(rec.pid)) {
    try {
      process.kill(rec.pid, "SIGTERM");
      killed = true;
    } catch {
      /* 进程刚好退出：仍按失败结单，效果一致 */
    }
  }
  if (requeue && killed) reapTreeLater(rec.pid);

  /*
   * 状态要分两种：换模型重启时这一单没失败，记 `failed` 会让它进异常档、
   * 计入失败次数，看板上还多一条红账。记 `exited`，进程正常退出，调度层
   * 只把它当“这个进程不在了”，单还在队列里。
   */
  saveWorker(root, {
    ...rec,
    status: requeue ? "exited" : "failed",
    exit_code: rec.exit_code ?? -1,
    ...(requeue ? { stop_reason: opts.reason || "换模型重启" } : {}),
  });
  const d = rec.dispatch
    ? requeue
      ? requeueDispatch(root, rec.dispatch, opts.reason || "换模型重启")
      : closeDispatch(root, rec.dispatch, `被 user 中断（worker ${id}）`, "user")
    : null;
  recordEvent(root, requeue ? "worker_requeued" : "worker_stopped", {
    worker: id,
    pid: rec.pid,
    dispatch: rec.dispatch ?? "",
    killed,
    already_terminal: alreadyTerminal,
    source: "user",
    ...(requeue ? { reason: opts.reason || "换模型重启" } : {}),
  });

  return { id, pid: rec.pid, killed, alreadyTerminal, dispatch: d ? d.id : null };
}


export interface CloseTaskResult {
  dispatch: string;
  stage: string;
  shard: string;
  worker: string | null;
  pid: number;
  /** 是否真的发出了 SIGTERM（排队中的单为 false） */
  killed: boolean;
  from: string;
  note: string;
  /** 结项后是否把这一片一起冻住了（不再自动重派） */
  held: boolean;
}

/**
 * 找一张“还开着”的单：结项只对没结论的单有意义。
 *
 * 目标可能是三种写法，按顺序试：
 *   1. 派单 id（`D-…`）；
 *   2. worker id（`W-…`），取它手上的那张单；
 *   3. 分片名或线程 id（`shard:xxx`），取该片最近一张还开着的单。
 *
 * 第三种是看板排队行的 id：排队中的单没有 worker，界面只能靠分片指认。
 */
function openDispatchOf(
  root: string,
  target: string,
): { d: Dispatch; worker: WorkerRecord | null } | null {
  const rows = readDispatches(root);
  const byId = rows.find((d) => d.id === target);
  if (byId) return { d: byId, worker: byId.worker ? loadWorker(root, byId.worker) : null };

  const w = loadWorker(root, target);
  if (w && w.dispatch) {
    const d = rows.find((x) => x.id === w.dispatch);
    if (d) return { d, worker: w };
  }

  const shard = target.startsWith("shard:") ? target.slice(6) : target;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const d = rows[i];
    if (!d || (d.shard ?? "") !== shard) continue;
    if (d.status !== "open" && d.status !== "claimed" && d.status !== "review" && d.status !== "failed") continue;
    return { d, worker: d.worker ? loadWorker(root, d.worker) : null };
  }
  return null;
}

/** 手动结项：把一张单关掉，并且不再重派。 */
export function closeTask(
  root: string,
  target: string,
  opts: { reason?: string; by?: string } = {},
): CloseTaskResult | null {
  const hit = openDispatchOf(root, target);
  if (!hit) return null;
  const { d, worker } = hit;
  const reason = (opts.reason ?? "").trim();

  const closed = closeDispatch(root, d.id, reason || "用户手动结项", opts.by ?? "user");
  if (!closed) return null;

  let killed = false;
  let pid = 0;
  if (worker) {
    pid = worker.pid;
    const alreadyTerminal = worker.status === "exited" || worker.status === "failed" || worker.status === "done";
    if (!alreadyTerminal && pid > 0 && pidAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        killed = true;
      } catch {
        /* 进程刚好退出：结单已经落了，结果一致 */
      }
    }
    saveWorker(root, { ...worker, status: "exited", exit_code: worker.exit_code ?? (killed ? 0 : undefined) });
  }

  /*
   * 结项后冻住这一片。
   *
   * 只把这一张单改成 closed 不够：阶段门槛仍未达标，监工下一轮调度 会重新建一张单派出去，
   * 用户看到的就是“说了停，它还在派”。接管态是现成的抑制开关，loop 的 held() 会跳过
   * 该片的派单与自动验收。要恢复自动调度，用户执行 `capitalist release <片>`。
   *
   * 只在“这一片已经没有别的活单”时冻：一片上还有别的运行中，冻住会误伤那些单。
   */
  let held = false;
  if (d.shard) {
    const live = readDispatches(root).some(
      (x) =>
        (x.shard ?? "") === d.shard && (x.status === "open" || x.status === "claimed" || x.status === "review"),
    );
    if (!live) {
      takeoverShard(root, { shard: d.shard, reason: reason || "用户手动结项", by: opts.by ?? "user" });
      held = true;
    }
  }

  recordEvent(root, "dispatch_closed", {
    dispatch: d.id,
    stage: d.stage,
    shard: d.shard ?? "",
    worker: worker?.id ?? "",
    from: d.status,
    killed,
    reason: reason || "用户手动结项",
    by: opts.by ?? "user",
  });

  return {
    dispatch: d.id,
    stage: d.stage,
    shard: d.shard ?? "",
    worker: worker?.id ?? null,
    pid,
    killed,
    from: d.status,
    note: reason,
    held,
  };
}

/** 手动插队的结果。 */
export interface PromoteTaskResult {
  dispatch: string;
  stage: string;
  shard: string;
  ahead: number;
  already: boolean;
  /**
   * 这一单会不会真的插队（挂起一个运行中的进程腾槽）。
   *
   * 只有“当前没有别的立即执行运行中”才是 true。回执要按它说话：说“腾槽”却没腾，
   * 用户下一眼看队列就会发现它还在等，比不置顶更伤信任。
   */
  preempt: boolean;
  /** 已经有立即执行运行中时，挡在前面的那张派单 id；否则为空串。 */
  behind: string;
}

/** 手动插队：`capitalist promote <派单id|worker-id|分片>`，把排队中的单提到队首。 */
export function promoteTask(
  root: string,
  target: string,
  opts: { by?: string } = {},
): (PromoteTaskResult & { ok: true }) | { ok: false; reason: string } | null {
  const rows = readDispatches(root);
  const hit = openDispatchOf(root, target);
  if (!hit) return null;
  const { d } = hit;
  if (d.status !== "open") {
    const why =
      d.status === "claimed"
        ? "该派单已在执行（进程已领单），无需置顶"
        : d.status === "review"
          ? "该派单正在等待结项确认，不在排队中"
          : `该派单已处于终态 ${d.status}，重跑请使用 capitalist retry 或发送消息唤醒`;
    return { ok: false, reason: why };
  }
  const self = rows.findIndex((x) => x.id === d.id);
  const ahead = rows.filter(
    (x, i) =>
      x.status === "open" && x.id !== d.id && compareQueueOrder(x, d, i, self < 0 ? 0 : self) < 0,
  ).length;
  const already = Boolean(d.promoted_at);
  /** 能不能真插队：看有没有另一张立即执行还占着租约。 */
  const lease = readPreemptLease(root);
  const behind = lease && lease.dispatch !== d.id && !leaseEnded(lease, rows) ? lease.dispatch : "";
  const next = promoteDispatch(root, d.id, opts.by ?? "user");
  if (!next) return { ok: false, reason: "置顶写入失败，台账没变" };
  recordEvent(root, "dispatch_promoted", {
    dispatch: d.id,
    stage: d.stage,
    shard: d.shard ?? "",
    ahead,
    by: opts.by ?? "user",
    preempt: !behind,
    ...(behind ? { behind } : {}),
  });
  return {
    ok: true,
    dispatch: d.id,
    stage: d.stage,
    shard: d.shard ?? "",
    ahead,
    already,
    preempt: !behind,
    behind,
  };
}
