/**
 * 卡点识别：按日志尾部把进程停滞分成 error_loop、external、retry、idle 四类，判据不依赖模型。
 *
 * 本模块只分类，判定与干预在 loop 的 `checkStuckWorkers`；分类只影响建议措辞，判死由干预次数决定。
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

import type { StuckKind, WorkerStuckState } from "../../core/record/supervisor";
import { isLogNoise } from "./workerLog";

/** 卡点阈值默认值：日志五分钟无新增且心跳过期即判定进程未推进。 */
export const DEFAULT_STUCK_SEC = 300;

/** 两次同类干预的最小间隔；间隔内不重复计数。 */
export function stuckGapSec(stuckSec: number): number {
  return Math.max(30, Math.min(stuckSec, 300));
}

/** 从环境变量读卡点阈值（`CAPITALIST_STUCK_SEC`），非法值回落默认。 */
export function stuckSecFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CAPITALIST_STUCK_SEC);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_STUCK_SEC;
}

export interface StuckEvidence {
  kind: StuckKind;
  /** 中文类型名，直接进任务卡与事件。 */
  label: string;
  /** 判据摘要，说明分类依据。 */
  why: string;
}

/** 卡点类型名，与判据一并写入任务卡与事件。 */
export const STUCK_LABEL: Record<StuckKind, string> = {
  idle: "空转等待",
  retry: "重复无效重试",
  external: "等外部条件",
  error_loop: "报错循环",
  unknown: "无法归类",
};

/** 只读日志尾部固定字节；文件缺失或读取失败时返回空数组，由调用方按 `idle` 处理。 */
export function readLogTail(file: string, lines = 200): string[] {
  if (!file || !existsSync(file)) return [];
  try {
    const size = statSync(file).size;
    if (size <= 0) return [];
    const want = Math.min(size, 128 * 1024);
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(want);
    try {
      readSync(fd, buf, 0, want, size - want);
    } finally {
      closeSync(fd);
    }
    return buf.toString("utf8").split("\n").slice(-lines);
  } catch {
    return [];
  }
}

/** 归一化一行：去掉时间戳、十六进制 id 与数字，用于判定重复行。 */
function shape(line: string): string {
  return line
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "")
    .replace(/\b[0-9a-f]{8,}\b/gi, "")
    .replace(/\d+/g, "")
    .trim();
}

/** 报错行的判据。只用于分类，不用于判死。 */
const RE_ERROR = /error|exception|traceback|panic|fatal|\bfailed\b|\bfailure\b|错误|失败|报错|异常|堆栈/i;

/** 需要人解除的外部条件。 */
const RE_EXTERNAL =
  /验证码|captcha|登录|登陆|login|sign\s*in|授权|authori[sz]|oauth|permission|approval|审批|确认|信任|are\s+you\s+sure|password|密码|凭证|token\s*(?:expired|invalid|失效)|rate\s*limit|too\s+many\s+requests|\b429\b|quota|额度|余额不足|等待(?:用户|人工|审批|确认)/i;

/** 重试动词；单独出现不判为 retry，须与重复行同时成立。 */
const RE_RETRY = /retry|retrying|again|重试|再试|重新跑|再跑一次|再来一次/i;

/** 分类用的重复度读数；缺省时由本模块从日志尾部计算。 */
export interface RepeatSignal {
  /** 最高频那一行出现了多少次。 */
  times: number;
  /** 最高频行占有效行的比例。 */
  ratio: number;
  /** 最高频行的内容（归一化后）。 */
  sample: string;
}

/** 与 `looksLooping` 共用噪声表与归一化，阈值更低：此处只决定分类，不决定是否交由模型复查。 */
export function repeatSignal(lines: readonly string[]): RepeatSignal {
  const shaped = lines
    .map((l) => shape(l))
    .filter((l) => l.length >= 20 && !isLogNoise(l) && !l.startsWith("fetch config failed") && !l.startsWith("{"));
  /* 至少 4 条有效行才计算重复度。 */
  if (shaped.length < 4) return { times: 0, ratio: 0, sample: "" };
  const count = new Map<string, number>();
  for (const l of shaped) count.set(l, (count.get(l) ?? 0) + 1);
  let sample = "";
  let times = 0;
  for (const [k, v] of count) {
    if (v > times) {
      times = v;
      sample = k;
    }
  }
  return { times, ratio: times / shaped.length, sample };
}

/**
 * @param lines 日志最后若干行，正序，最早在前。
 * @param repeat 可传入调用方已算好的重复度，避免重复计算。
 */
export function classifyStuck(lines: readonly string[], repeat?: RepeatSignal): StuckEvidence {
  const meaningful = lines.map((l) => l.trim()).filter((l) => l.length > 0 && !isLogNoise(l));
  const sig = repeat ?? repeatSignal(meaningful);
  const tail = meaningful.slice(-80);
  const joined = tail.join("\n");
  const errorHits = tail.filter((l) => RE_ERROR.test(l)).length;
  const externalHits = tail.filter((l) => RE_EXTERNAL.test(l)).length;
  const retryHits = tail.filter((l) => RE_RETRY.test(l)).length;

  /* 外部条件优先判定：重复重试无法解除授权类条件，此类给出停手等待的建议。 */
  if (externalHits >= 2) {
    return {
      kind: "external",
      label: STUCK_LABEL.external,
      why: `日志末尾 ${tail.length} 行里有 ${externalHits} 行在提示登录/授权/验证码/配额/确认类条件：${firstMatch(tail, RE_EXTERNAL)}`,
    };
  }

  const repeated = sig.times >= 3 && sig.ratio >= 0.25;
  if (repeated && (RE_ERROR.test(sig.sample) || errorHits >= Math.max(3, Math.ceil(tail.length * 0.2)))) {
    return {
      kind: "error_loop",
      label: STUCK_LABEL.error_loop,
      why: `同一段报错重复 ${sig.times} 次（占 ${Math.round(sig.ratio * 100)}%）：${sig.sample.slice(0, 100)}`,
    };
  }

  if (repeated || retryHits >= 3) {
    return {
      kind: "retry",
      label: STUCK_LABEL.retry,
      why: repeated
        ? `同一行重复 ${sig.times} 次（占 ${Math.round(sig.ratio * 100)}%），内容没有变化：${sig.sample.slice(0, 100)}`
        : `日志末尾有 ${retryHits} 行在重试同一件事：${firstMatch(tail, RE_RETRY)}`,
    };
  }

  if (joined.trim() === "") {
    return { kind: "idle", label: STUCK_LABEL.idle, why: "日志在阈值内没有新增内容" };
  }
  const last = tail[tail.length - 1] ?? "";
  return {
    kind: "idle",
    label: STUCK_LABEL.idle,
    why: `日志在阈值内没有新增内容，最后一行没有推进迹象：${last.slice(0, 100)}`,
  };
}

function firstMatch(lines: readonly string[], re: RegExp): string {
  const hit = [...lines].reverse().find((l) => re.test(l));
  return (hit ?? "").slice(0, 100);
}

/**
 * 给工作进程的跳出办法：文字经 hook 送达并显示在任务卡，不用第二人称，只写对象与结果。
 *
 * @param idleSec 日志距最后一次写入的秒数；未知时传 -1。
 */
export function stuckGuidance(ev: StuckEvidence, idleSec: number): string {
  const silent = idleSec >= 0 ? `日志已 ${idleSec} 秒没有新增。` : "日志没有新增。";
  switch (ev.kind) {
    case "external":
      return (
        "跳出办法：当前卡在需要人解除的外部条件，重复同一请求不会通过。" +
        "停止重试该操作，用 `capitalist block <类型> \"<卡在哪>\"` 上报后停手；" +
        "其余不依赖该条件的工作先做完，并把已经做过的改动留在任务根内。"
      );
    case "retry":
      return (
        "跳出办法：同一操作已经重复多次且结果没有变化，继续重复不会得到不同结果。" +
        "停止重复该操作；把失败点、已经试过的路径写进 `capitalist notify stuck`，" +
        "换一条能走通的路径或改用更小的验证步骤，再继续原任务。"
      );
    case "error_loop":
      return (
        "跳出办法：同一段报错在反复出现。先停下重复调用，读报错原文定位根因（输入、路径、权限、参数）；" +
        "只改一处再验证，不要整段重跑；两轮后仍相同，用 `capitalist notify stuck` 写清报错与已试手段。"
      );
    default:
      return (
        `跳出办法：${silent}先确认是不是在等一个不会来的输入（交互确认、权限弹窗、目录信任）。` +
        "若在等，改为用 `capitalist block` 上报并停手；若不是，先做下一个不依赖它的步骤，并在 `capitalist notify progress` 里写清当前进度。"
      );
  }
}

/** 组装可直接写入送达通道的干预正文：标题、判据、办法。 */
export function buildIntervention(ev: StuckEvidence, idleSec: number, attempts: number): string {
  const head = `【监工干预 · ${ev.label} · 第 ${attempts} 次】`;
  const why = `判据：${ev.why}`.replace(/\s+/g, " ").slice(0, 400);
  return `${head}\n${why}\n${stuckGuidance(ev, idleSec)}`;
}

/** 由一次判定生成待落盘的卡点状态；送达结果由调用方补齐。 */
export function stuckStateOf(args: {
  ev: StuckEvidence;
  guidance: string;
  attempts: number;
  since?: string;
  now?: number;
  delivered: boolean;
  channel: "hook" | "consumed" | "failed";
  directiveAt?: string;
}): WorkerStuckState {
  const nowIso = new Date(args.now ?? Date.now()).toISOString();
  return {
    kind: args.ev.kind,
    label: args.ev.label,
    why: args.ev.why,
    guidance: args.guidance,
    since: args.since ?? nowIso,
    attempts: args.attempts,
    last_at: nowIso,
    delivered: args.delivered,
    channel: args.channel,
    ...(args.directiveAt ? { directive_at: args.directiveAt } : {}),
  };
}

/** 校验卡点阈值；非法值回落到默认。 */
export function normalizeStuckSec(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_STUCK_SEC;
}
