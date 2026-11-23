/**
 * 暂停调度：`.capitalist/runtime/pause.json` 的唯一读写入口，以及暂停标记的批量收口。
 *
 * 暂停有两种表现，必须同时成立：文件存在（阻止派新单）与派单带标记（界面显示暂停中、
 * 调度跳过）。早先只有文件由本模块管理，标记散在监工循环、看板与命令行各写一份，
 * 于是出现“全局已恢复、单张仍暂停”与“重启后一部分显示待重派、一部分显示已暂停”。
 *
 * 现在写入只此一处：
 *
 *   pauseAll    写文件 + 给全部未结派单打标记
 *   resumeAll   删文件 + 清除全部标记
 *
 * 停进程不属于本模块：进程控制在监工层（`supervisor/loop.ts`）。本模块只改台账，
 * 命令行与看板都不必为了暂停去加载整条调度链路。
 */

import { existsSync, renameSync, unlinkSync } from "node:fs";

import { forgetJson, readJson, writeJson, writeJsonl } from "./json";
import { runtime } from "./locations";
import { recordEvent } from "./ledger";
import { pidAlive } from "./process";
import {
  clearStopFlag,
  dispatchPath,
  dispatchPaused,
  loadWorker,
  pausedDispatches,
  readDispatches,
  type Dispatch,
} from "./supervisor";

/** `.capitalist/runtime/pause.json` 的内容。 */
export interface PauseFile {
  at: string;
  reason: string;
  by?: string;
  /**
   * 排空式停止写的门闩：只挡新派单，不冻结在途。
   *
   * 与用户暂停分开：用户暂停要停进程、给未结派单打标记；排空停止要等在途跑完再退出，
   * 冻住它们就等于把“排空”变成“中断”。监工退出时这个门闩一并清除。
   */
  drain?: boolean;
}

/** 暂停文件的绝对路径：`<root>/.capitalist/runtime/pause.json`。 */
export function pausePath(root: string): string {
  return runtime.pause(root);
}

/**
 * 读暂停文件；缺失或损坏都视为未暂停，不因一次写入损坏而使状态无法恢复。
 *
 * @returns 归一化后的暂停记录；文件不存在、内容非对象或无法解析时返回 null。
 */
export function readPause(root: string): PauseFile | null {
  const raw = readJson<Partial<PauseFile> | null>(pausePath(root), null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    at: String(raw.at ?? ""),
    reason: String(raw.reason ?? ""),
    ...(raw.by === undefined ? {} : { by: String(raw.by) }),
    ...(raw.drain === true ? { drain: true } : {}),
  };
}

/** 暂停前所处的执行态。 */
export type PauseOrigin = NonNullable<Dispatch["paused_from"]>;

/** 暂停标记覆盖的状态：还会变化，暂停时要一起冻结。 */
const PAUSABLE_STATUS = new Set(["open", "claimed", "reported", "review"]);

/**
 * 推导一张派单在暂停前的执行态。
 *
 * `claimed` 是运行中；`reported` / `review` 在等裁决；`open` 且最近一个进程已经退出的是
 * 待重派；其余是排队。判定只看台账与进程记录，不接受调用方自报，避免两处口径。
 */
export function pauseOriginOf(root: string, d: Dispatch): PauseOrigin {
  const st = String(d.status ?? "");
  if (st === "claimed") return "running";
  if (st === "reported" || st === "review") return "review";
  const w = d.worker ? loadWorker(root, String(d.worker)) : null;
  if (w && (w.status === "exited" || w.status === "failed" || w.status === "done")) return "retry";
  return "queued";
}

/**
 * 给一行写暂停标记。
 *
 * `claimed` 必须退回 `open`：进程已经停掉，留着 `claimed` 会在下一轮回收里被判成
 * “无人认领”并记一次失败，重试计数与退避都被带偏。原状态改由 `paused_from` 记住。
 */
function markPausedRow(root: string, cur: Dispatch, at: string, by: string, reason: string): Dispatch {
  const origin = pauseOriginOf(root, cur);
  const next: Dispatch = {
    ...cur,
    paused_at: at,
    paused_by: by,
    paused_reason: reason,
    paused_from: origin,
  };
  if (String(cur.status ?? "") === "claimed") {
    next.status = "open";
    next.note = "调度暂停：进程已停止，恢复后继续执行";
  }
  return next;
}

/** 一次暂停覆盖到的张数，按执行态分列，供日志与事件核对。 */
export interface PauseMarks {
  marked: number;
  origins: Record<PauseOrigin, number>;
}

/**
 * 给全部未结派单写暂停标记，一次写盘。
 *
 * 已带标记的单保持原时刻与来源：重复暂停不该把“用户失去控制的那一刻”刷成现在。
 * 暂停之后被用户点名唤醒的单跳过：`wake_at` 不早于 `since`，说明用户已单独解除，
 * 再标回去会让唤醒回执与界面互相矛盾。`failed` 与终态不在范围内。
 *
 * @param since 本次暂停写入文件的时刻，只用于判断谁在暂停之后被唤醒；缺省不跳过任何单。
 */
export function pauseLiveDispatches(
  root: string,
  by: string,
  reason: string,
  since = "",
): PauseMarks {
  const rows = readDispatches(root);
  const at = new Date().toISOString();
  const origins: Record<PauseOrigin, number> = { running: 0, retry: 0, queued: 0, review: 0 };
  let marked = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const cur = rows[i] as Dispatch;
    if (!PAUSABLE_STATUS.has(String(cur.status ?? "")) || dispatchPaused(cur)) continue;
    /* 同毫秒按“暂停之后唤醒”处理：wakeDispatch 只在已暂停的单上调用，它必然在后。 */
    if (since && String(cur.wake_at ?? "") >= since) continue;
    const next = markPausedRow(root, cur, at, by, reason);
    rows[i] = next;
    origins[next.paused_from ?? "queued"] += 1;
    marked += 1;
  }
  if (marked > 0) writeJsonl(dispatchPath(root), rows);
  return { marked, origins };
}

/** 恢复调度时保留暂停的单，附保留原因。 */
export interface KeptPaused {
  id: string;
  reason: string;
}

/** 清除暂停标记的结果。 */
export interface ClearPauseMarks {
  cleared: number;
  kept: KeptPaused[];
}

/**
 * 清除派单上的暂停标记，一次写盘。
 *
 * 覆盖终态单：取消、关闭时不保证清过标记，残留会让“已取消”看起来仍在暂停。
 * 唯一例外是进程仍未退出的运行中单：此时放它回调度会与残留进程双跑，保留标记并写明原因，
 * 由用户先中断进程再恢复。
 */
export function clearPauseMarks(root: string): ClearPauseMarks {
  const rows = readDispatches(root);
  const kept: KeptPaused[] = [];
  let cleared = 0;
  let changed = false;
  for (let i = 0; i < rows.length; i += 1) {
    const cur = rows[i] as Dispatch;
    if (!dispatchPaused(cur)) continue;
    const block = keepPausedReason(root, cur);
    if (block) {
      kept.push({ id: cur.id, reason: block });
      if (cur.paused_reason !== block) {
        rows[i] = { ...cur, paused_reason: block };
        changed = true;
      }
      continue;
    }
    const next: Dispatch = { ...cur };
    /* 等确认的单：暂停期间计时冻结，恢复时把暂停时长补回去，不然一恢复就被判超时。 */
    if (next.paused_from === "review" && next.review_until) {
      const pausedMs = Date.now() - Date.parse(String(next.paused_at ?? ""));
      const until = Date.parse(String(next.review_until));
      if (Number.isFinite(pausedMs) && Number.isFinite(until)) {
        next.review_until = new Date(until + Math.max(0, pausedMs)).toISOString();
      }
    }
    delete next.paused_at;
    delete next.paused_by;
    delete next.paused_reason;
    delete next.paused_from;
    rows[i] = next;
    cleared += 1;
    changed = true;
  }
  if (changed) writeJsonl(dispatchPath(root), rows);
  return { cleared, kept };
}

/** 保留暂停的原因；空串表示可以恢复。 */
function keepPausedReason(root: string, d: Dispatch): string {
  if (d.paused_from !== "running") return "";
  const w = d.worker ? loadWorker(root, String(d.worker)) : null;
  /* 进程记录为 exited 但 pid 仍活是终止未确认的残留，同样不能放回调度。 */
  if (w && w.pid > 0 && pidAlive(w.pid)) return "进程未退出，先中断再恢复";
  return "";
}

/** 暂停动作的结果：文件写入时刻与派单标记的覆盖情况。 */
export interface PauseOutcome extends PauseMarks {
  at: string;
  reason: string;
  /** 是否真的写了暂停文件。没有未结派单时不写，见 {@link pauseAll}。 */
  written: boolean;
}

/** 是否存在未结派单。没有单就没有可暂停的对象，暂停文件也不该落盘。 */
export function hasUnfinishedDispatches(root: string): boolean {
  return readDispatches(root).some((d) => PAUSABLE_STATUS.has(String(d.status ?? "")));
}

/**
 * 只写暂停文件，不给派单打标记。
 *
 * 用于排空式停止：要停掉新派单，但在途任务继续跑完再退出。与 {@link pauseAll} 的区别
 * 是后者连在途一起冻结。写入入口仍只有本模块一处。
 */
export function setPauseGate(
  root: string,
  by: string,
  reason: string,
  drain = false,
): { at: string; reason: string; drain: boolean } {
  const at = new Date().toISOString();
  const text = reason || "未填写原因";
  writeJson(pausePath(root), { at, reason: text, by, ...(drain ? { drain: true } : {}) });
  recordEvent(root, "pause_set", { reason: text, by, ...(drain ? { drain: true } : {}) });
  return { at, reason: text, drain };
}

/**
 * 暂停调度：写暂停文件，并给全部未结派单打标记。
 *
 * 幂等：重复调用不刷新已暂停单的时刻，只补上尚未标记的单。先写文件再写标记，
 * 顺序反了会有一瞬“单已暂停、调度仍在派新单”的窗口。
 *
 * 没有未结派单时不写文件：新任务根一启动就落 paused，控制台与看板都看不出它已经在跑，
 * 用户也没有可暂停的对象。此时返回 `written: false`，由调用方如实回执。
 */
export function pauseAll(root: string, by: string, reason: string): PauseOutcome {
  const text = reason || "未填写原因";
  if (!hasUnfinishedDispatches(root)) {
    /* 已处于暂停态时，不要因本轮无单而删除文件或误报未写入。 */
    const existing = readPause(root);
    return {
      marked: 0,
      origins: { running: 0, retry: 0, queued: 0, review: 0 },
      at: existing?.at ?? "",
      reason: existing?.reason ?? text,
      written: existing !== null,
    };
  }
  const gate = setPauseGate(root, by, reason);
  const marks = pauseLiveDispatches(root, by, gate.reason, gate.at);
  return { ...marks, at: gate.at, reason: gate.reason, written: true };
}

/** 恢复调度的结果：清除张数与保留张数。 */
export interface ResumeOutcome extends ClearPauseMarks {
  /** 删除暂停文件是否成功；文件本就不存在时也为 true。 */
  ok: boolean;
  error?: string;
}

/**
 * 恢复调度：删除暂停文件并清除全部暂停标记。
 *
 * 进程仍未退出的运行中单保留暂停并在 `kept` 中给出原因，由用户先中断再恢复：
 * 直接放回调度会与残留进程同时改同一份产出。
 */
export function resumeAll(root: string, by: string): ResumeOutcome {
  const removed = removePauseFile(root);
  if (!removed.ok) {
    return { ok: false, ...(removed.error === undefined ? {} : { error: removed.error }), cleared: 0, kept: [] };
  }
  clearStopFlag(root);
  recordEvent(root, "pause_cleared", { by });
  const marks = clearPauseMarks(root);
  if (marks.kept.length > 0) {
    recordEvent(root, "pause_kept", {
      by,
      kept: marks.kept.map((k) => ({ dispatch: k.id, reason: k.reason })),
    });
  }
  return { ok: true, ...marks };
}

/**
 * 删除暂停文件。删除失败先重试，再回落到改名：Windows 上文件被 hook 或轮询短暂持有时
 * unlink 返回 EPERM/EBUSY，同卷 rename 通常可用，改名后读取侧即视为已解除。
 */
function removePauseFile(root: string): { ok: boolean; error?: string } {
  const p = pausePath(root);
  let lastErr: unknown = null;
  for (let i = 0; i < 6; i += 1) {
    try {
      /* 直接删除不经过 writeJson，需同时清除读缓存，否则 300ms 内仍读到“暂停中”。 */
      if (!existsSync(p)) {
        forgetJson(p);
        return { ok: true };
      }
      unlinkSync(p);
      forgetJson(p);
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
        forgetJson(p);
        return { ok: true };
      } catch {
        /* 改名失败时继续重试。 */
      }
    }
  }
  return { ok: false, error: lastErr instanceof Error ? lastErr.message : String(lastErr ?? "") };
}

/**
 * 主循环每轮的兜底：没有暂停文件但仍有带标记的派单时清除标记。
 *
 * 用户手工删除 `pause.json` 属于既有恢复方式，不经过 resumeAll；这条兜底让手工恢复也能
 * 回到调度。只有存在标记时才写盘，常态零开销。
 *
 * @returns 本次清除的张数。
 */
export function resumeDanglingMarks(root: string, by: string): number {
  if (readPause(root)) return 0;
  if (pausedDispatches(root).length === 0) return 0;
  const marks = clearPauseMarks(root);
  if (marks.cleared > 0) {
    recordEvent(root, "pause_cleared", { by, via: "dangling" });
  }
  return marks.cleared;
}
