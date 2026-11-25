/**
 * 会话：按派单派生会话基名，决定工作进程续接哪条 AI 会话。
 *
 * 一条派单一条会话：不同派单互不共享上下文，同一单的重开、追加与重派续接原会话。
 * 上下文占用超过窗口比例时换代；同一会话同时只允许一个进程续接；action 指纹只作记录，不参与换代判定。
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { existingDirs } from "../../agent/registry";
import { recordEvent } from "../../core/record/ledger";
import { sessions } from "../../core/record/locations";
import { resolveContextWindow } from "../../core/guard/limits";
import type { Dispatch, WorkerRecord } from "../../core/record/supervisor";
import type { WorkerSession } from "../../agent/contract";

/** 会话记录：一条会话一代，更换只改 `current`。 */
export interface LaneState {
  /** 会话基名，例如 `capitalist-u6-main`、`capitalist-u6-ui`。 */
  base: string;
  /** 当前使用的会话 id（宿主会话 UUID）。 */
  current: string;
  /** 第几代，从 0 起（0 表示基名本身）。 */
  gen: number;
  /** 上一次写下这一代的 action 指纹。 */
  sig: string;
  /** 上一次观测到的上下文占用（token）。 */
  ctx_used: number | null;
  /** 该模型的上下文窗口（写入时已按默认表校正）。 */
  ctx_window: number | null;
  /** 上一次读数对应的模型名，用于校正占位窗口值。 */
  ctx_model?: string;
  /** 当前代已续接次数；`ctx_used` 为 null 时按 {@link CTX_UNKNOWN_MAX_RESUME} 上限换代。 */
  resumes?: number;
  /** 上一次更新的时刻。 */
  at: string;
  /**
   * 上一代的会话 id。
   *
   * 换代后旧会话仍留在宿主侧，用于排查本代上下文丢失问题；
   * 仅记录，不参与续接判定。
   */
  previous?: string;
  /** 实际跑这一代的宿主（`codebuddy` / `claude-code`）；记录用，不参与判定。 */
  host?: string;
  /** 宿主会话文件的落盘路径；宿主决定位置，capitalist 只记录不写。 */
  path?: string;
}

/** 上下文的更换会话阈值：占窗口的比例。 */
const CTX_RATIO = 0.5;
/** 拿不到窗口时的回落上限（常见窗口 300k，取一半）。 */
const CTX_FALLBACK_LIMIT = 150_000;
/** 占用未知时同一代最多续接几次，再多就换代。 */
const CTX_UNKNOWN_MAX_RESUME = 2;
/** 会话可复用的最长时间窗：距上次更新超过它即换代，避免久置会话续接时重发大段历史。 */
const CTX_MAX_AGE_MS = 3600_000;
/** `.capitalist/sessions` 目录。 */
export function sessionsDir(root: string): string {
  return sessions.dir(root);
}

function basePath(root: string, base: string): string {
  return sessions.lane(root, base);
}

/** 会话基名的字符集归一化：只留小写字母、数字与连字符。 */
function slug(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * 会话基名：一条派单一条会话。
 *
 * 主键取派单 id，因此不同派单必定落在不同会话，同分片、同分类标签的多张单也不会并成一条；
 * 同一张单的重开、追加与重派沿用同一 id，续接的仍是它自己的上下文，不会丢已做过的部分。
 *
 * 派单 id 缺失时（历史记录、看板只带分片）退回分片与分类标签派生，仅用于兼容旧档。
 */
export function laneBaseId(shard: string, tags: readonly string[] = [], dispatchId = ""): string {
  const fromDispatch = String(dispatchId ?? "").trim().replace(/^d-/i, "");
  /*
   * 派单号形如 `任务号-派发序`（`4-1`）。会话基名只取任务号 `4`，不取派发序：
   * 同一任务的重派（`4-2`、`4-3`）应续接同一条会话，而不是各自开新文件。
   * 历史 `D-<随机串>` 派单号整体取用，随机串本身保证唯一。
   */
  const taskNo = /^\d+/.exec(fromDispatch)?.[0] ?? "";
  const pick =
    slug(taskNo || fromDispatch) || String(shard ?? "").trim() || String(tags[0] ?? "").trim() || "misc";
  /* 从尾部截断会把派单标识切掉，退化成共用会话，因此截断只发生在标识左侧。 */
  const tail = (slug(pick) || "misc").slice(0, 24);
  return `capitalist-${tail}`;
}

/** 生成唯一会话 id 时查重冲突的重试上限；UUID 撞名概率极低，仍撞则抛错，不静默复用。 */
const ID_RETRY_MAX = 5;

/** 扫 `.capitalist/sessions` 下已登记映射，返回已占用的 current 集合。 */
function usedLaneIds(root: string): Set<string> {
  const out = new Set<string>();
  const dir = sessionsDir(root);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const st = JSON.parse(readFileSync(join(dir, name), "utf8")) as LaneState;
      if (st && typeof st.current === "string" && st.current) out.add(st.current);
    } catch {
      /* 损坏的记录跳过 */
    }
  }
  return out;
}

/**
 * 宿主项目目录：会话文件落在 `<项目目录>/<会话 id>.jsonl`。
 *
 * 默认取已安装宿主的 `projects` 目录。环境变量 `CAPITALIST_HOST_PROJECTS`（冒号分隔）
 * 覆盖默认值，供测试与非常规布局使用。判定存在性要扫这些目录，不猜具体的项目子目录名。
 */
function hostProjectRoots(): string[] {
  const custom = String(process.env.CAPITALIST_HOST_PROJECTS ?? "")
    .split(":")
    .map((x) => x.trim())
    .filter(Boolean);
  if (custom.length > 0) return custom;
  return existingDirs().map((d) => join(homedir(), d.dir, "projects"));
}

/** 查 codebuddy / claude 等宿主配置目录下是否已有该会话文件（防清理 .capitalist 后残留文件撞名）。 */
function hostSessionExists(sessionId: string): boolean {
  const id = String(sessionId ?? "").trim();
  if (!id) return false;
  for (const base of hostProjectRoots()) {
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
      try {
        if (statSync(join(base, p, `${id}.jsonl`)).isFile()) return true;
      } catch {
        /* 该目录没有这一代会话：继续找 */
      }
    }
  }
  return false;
}

/**
 * 生成一条全局唯一的会话 id：v4 UUID。
 *
 * 会话 id 统一用 UUID，兼容 Claude Code（`--session-id` 强制 UUID）与 CodeBuddy（接受
 * 字母数字连字符）。UUID 128 位撞名概率趋近于零，仍做双查兜底：既查 `.capitalist/sessions`
 * 映射表，也查宿主配置目录下的残留会话文件；撞了重新生成，超过上限抛错而非静默复用。
 */
function uniqueLaneId(root: string, base: string): string {
  for (let i = 0; i < ID_RETRY_MAX; i += 1) {
    const cand = randomUUID();
    if (!usedLaneIds(root).has(cand) && !hostSessionExists(cand)) return cand;
  }
  throw new Error(`生成唯一会话 id 失败（base=${base}）：连续 ${ID_RETRY_MAX} 次 UUID 冲突`);
}

/** 读会话记录；没有或损坏时返回 null（按首次处理）。 */
export function readLane(root: string, base: string): LaneState | null {
  try {
    const st = JSON.parse(readFileSync(basePath(root, base), "utf8")) as LaneState;
    if (!st || typeof st.base !== "string" || typeof st.current !== "string") return null;
    return st;
  } catch {
    return null;
  }
}

function writeLane(root: string, st: LaneState): void {
  try {
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(basePath(root, st.base), JSON.stringify(st, null, 1));
  } catch {
    /* 写盘失败时按无记录处理，下一次按首次处理。 */
  }
}

/** 追加段起始标记；按前缀匹配，且须与 worker.ts 的 `BLOCKER_MARKER`、`spliceDirectives` 的插话标记保持一致。 */
const APPEND_SECTION_MARKS = ["【用户插话", "【上一轮卡点"] as const;

/** 取 action 正文在首个追加段标记之前的部分计算指纹，追加段不计入。 */
function fingerprintOf(action: string): string {
  let base = String(action ?? "");
  for (const mark of APPEND_SECTION_MARKS) {
    const at = base.indexOf(mark);
    if (at >= 0) base = base.slice(0, at);
  }
  return createHash("sha1").update(base.trim()).digest("hex").slice(0, 12);
}

/** 与看板、监工超限判定共用 {@link resolveContextWindow}；会话文件中的占位窗口按 `ctx_model` 校正。 */
export function laneContextWindow(st: LaneState | null): number {
  if (!st) return 0;
  const w = resolveContextWindow(String(st.ctx_model ?? ""), st.ctx_window);
  return w !== null && w > 0 ? w : 0;
}

/** 这一代会话的更换会话阈值（token）：窗口的一半，拿不到窗口时取默认值。 */
export function laneLimit(st: LaneState | null): number {
  if (!st) return CTX_FALLBACK_LIMIT;
  const win = laneContextWindow(st);
  return win > 0 ? Math.floor(win * CTX_RATIO) : CTX_FALLBACK_LIMIT;
}

/** 上下文是否已经太满：满了就换代，不续接。 */
export function laneTooFull(st: LaneState | null): boolean {
  if (!st || st.ctx_used === null) return false;
  return st.ctx_used >= laneLimit(st);
}

/** `ctx_used` 为 null 时按续接次数判定是否达到上限。 */
export function laneUnknownSpent(st: LaneState | null): boolean {
  if (!st || st.ctx_used !== null) return false;
  return (st.resumes ?? 0) >= CTX_UNKNOWN_MAX_RESUME;
}

/** 会话是否已闲置过久：距上次更新超过时间窗即换代，避免续接时把大段陈旧历史重发进上下文。 */
export function laneStale(st: LaneState | null, nowMs = Date.now()): boolean {
  if (!st || !st.at) return false;
  const at = Date.parse(st.at);
  return Number.isFinite(at) && nowMs - at > CTX_MAX_AGE_MS;
}

/**
 * 会话是否仍可用：宿主侧是否已有这一代会话的文件。
 *
 * 只在“从未产出用量读数、且已经续接过一次”时校验。首次续接不查：会话刚分配，
 * 宿主可能还没来得及落盘。已经续接过一次仍然没有文件，说明宿主从未创建这条会话，
 * 再续接必然失败。有读数的会话说明宿主确实跑过，文件暂缺可能只是布局差异，不换。
 *
 * 事故：首派被额度挡住，宿主从未创建会话文件，此后每次重派都续接一条不存在的会话，
 * 进程立即退出，失败被诊断为不可识别原因，重派一直被压住。
 */
export function laneUsable(st: LaneState | null): boolean {
  if (!st) return false;
  if (st.ctx_used !== null) return true;
  if ((st.resumes ?? 0) < 1) return true;
  return hostSessionExists(st.current);
}

/** `busy` 由调用方提供；本模块不读工作进程台账，`worker.ts` 与看板各自判定会话占用。 */
export function pickLane(
  root: string,
  dispatch: Dispatch,
  busy: (sessionId: string) => boolean = () => false,
): WorkerSession {
  const tags = Array.isArray((dispatch as { tags?: string[] }).tags)
    ? ((dispatch as { tags?: string[] }).tags as string[])
    : [];
  const base = laneBaseId(String(dispatch.shard ?? ""), tags, String(dispatch.id ?? ""));
  const sig = fingerprintOf(String(dispatch.action ?? ""));
  const st = readLane(root, base);

  // 首次：新开一条会话，id 带唯一后缀，不续接。
  if (!st) {
    const current = uniqueLaneId(root, base);
    writeLane(root, {
      base,
      current,
      gen: 0,
      sig,
      ctx_used: null,
      ctx_window: null,
      at: new Date().toISOString(),
    });
    return { id: current, resume: false };
  }

  /*
   * 占用未满、未知续接次数未达上限、未闲置过久、无进程占用、宿主会话仍在，五道闸门全通过才续接，
   * 否则换代。最后一道只对从未产出读数的会话生效，判定见 `laneUsable`。
   * 占用判定读取会话文件的实时读数：`loop.ts` 的 `refreshLaneUsage` 每轮按日志增量刷新，不等进程退出。
   */
  const tooFull = laneTooFull(st);
  const unknownSpent = laneUnknownSpent(st);
  const stale = laneStale(st);
  const occupied = busy(st.current);
  const missing = !laneUsable(st);
  if (!tooFull && !unknownSpent && !stale && !occupied && !missing) {
    writeLane(root, {
      ...st,
      sig,
      // 读数已知时清零；未知续接上限只约束 `ctx_used` 为 null 的代。
      resumes: st.ctx_used === null ? (st.resumes ?? 0) + 1 : 0,
      at: new Date().toISOString(),
    });
    return { id: st.current, resume: true };
  }
  const why = tooFull
    ? "ctx_full"
    : unknownSpent
      ? "ctx_unknown"
      : stale
        ? "ctx_stale"
        : occupied
          ? "occupied"
          : "session_missing";
  const next = rotateLane(root, st, why, sig);
  return { id: next.current, resume: false };
}

/**
 * 把一条派单会话换到下一代。
 *
 * 自动换代（上下文满、占用未知续接到上限、闲置过久、被占用）与用户手动新建会话共用本函数，
 * 换代口径只有一份：代次 +1、重新生成会话 id、占用读数清零、续接计数归零。
 *
 * `sig` 由调用方给：自动换代写入最新 action 指纹，手动换代沿用原指纹，不改派单记录。
 */
function rotateLane(root: string, st: LaneState, why: string, sig = st.sig): LaneState {
  const gen = st.gen + 1;
  const current = uniqueLaneId(root, `${st.base}-g${gen}`);
  recordEvent(root, "lane_rotated", {
    base: st.base,
    from_gen: st.gen,
    to_gen: gen,
    ctx_used: st.ctx_used,
    limit: laneLimit(st),
    why,
  });
  const next: LaneState = {
    base: st.base,
    current,
    gen,
    sig,
    previous: st.current,
    // 换代时清零占用读数：新一代从零开始。
    ctx_used: null,
    ctx_window: st.ctx_window,
    ctx_model: st.ctx_model ?? "",
    resumes: 0,
    at: new Date().toISOString(),
  };
  writeLane(root, next);
  return next;
}

/**
 * 把该任务根下已登记的派单会话整体换到下一代。
 *
 * 用户新建会话时调用：任务卡不动，此后的续接一律走新会话，不再带旧上下文。
 * 在途进程仍持有旧会话；`recordLaneUsage` 只写当前代，旧代的读数不会覆盖新代。
 */
export function rotateAllLanes(root: string, why = "user_new_session"): number {
  const dir = sessionsDir(root);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    /* 目录不存在表示还没有派单会话，无事可做。 */
    return 0;
  }
  let rotated = 0;
  for (const name of names) {
    const st = readLane(root, name.slice(0, -".json".length));
    if (!st) continue;
    rotateLane(root, st, why);
    rotated += 1;
  }
  return rotated;
}

/**
 * 把工作进程的上下文占用写回其会话：运行中由 `loop.ts` 的 `refreshLaneUsage` 每轮刷新，退出时由 exit 回调与 `reap` 补写终值。
 *
 * 只写当前代，老代读数晚到时不覆盖新代。
 */
export function recordLaneUsage(
  root: string,
  laneId: string,
  figures: { context_used: number | null; context_window: number | null; context_model?: string },
): void {
  if (!laneId) return;
  const base = laneBaseOf(root, laneId);
  const st = readLane(root, base);
  if (!st) return;
  // 老代的退出回调晚到，不覆盖新代读数。
  if (st.current !== laneId) return;
  writeLane(root, {
    ...st,
    ctx_used: figures.context_used ?? st.ctx_used,
    ctx_window: figures.context_window ?? st.ctx_window,
    ctx_model: figures.context_model || st.ctx_model || "",
    at: new Date().toISOString(),
  });
}

/** 会话文件是否存在（调试/看板用）。 */
export function laneExists(root: string, base: string): boolean {
  return existsSync(basePath(root, base));
}

/**
 * 由会话 id 反推其 base。
 *
 * 会话 id 是 v4 UUID，与 base 无字符串上的包含关系，无法用正则剥离。这里遍历
 * `.capitalist/sessions` 下的映射记录匹配 `current`，返回记录的 `base`：映射表是唯一事实
 * 来源。找不到映射时返回空串（不猜）。
 */
export function laneBaseOf(root: string, laneId: string): string {
  const id = String(laneId ?? "").trim();
  if (!id) return "";
  const dir = sessionsDir(root);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return "";
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const st = JSON.parse(readFileSync(join(dir, name), "utf8")) as LaneState;
      if (st && st.current === id && typeof st.base === "string") return st.base;
    } catch {
      /* 损坏记录跳过 */
    }
  }
  return "";
}

/** 从工作进程记录取会话 id；老记录没有该字段时返回空串。 */
export function laneOfWorker(w: WorkerRecord | null | undefined): string {
  return String((w as unknown as { ai_session?: string } | null)?.ai_session ?? "");
}
