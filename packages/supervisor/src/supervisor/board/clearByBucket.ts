/**
 * 按档清空与台账重置：看板“清空”动作的唯一实现。
 *
 * 清空范围由档内线程决定（`removeScope`），搬移由 `archiveRecords` 完成。
 * 本模块只做档名校验、范围取数与回执拼装，命令层不再重复这段判断。
 */

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";

import { archiveRecords } from "../../core/record/archive";
import { readJson } from "../../core/record/json";
import { archive, inbox as inboxLoc, ledger as ledgerLoc, rootIndex as rootIndexLoc } from "../../core/record/locations";
import { loadState, updateState } from "../../core/record/state";

import { removeScopeOfBucket } from "./removeScope";
import { TASK_BUCKETS, TASK_BUCKET_WORD, type TaskBucket } from "./threads";

export interface ClearResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * 清空任务台账：任务池、派单收件箱、进程索引三份。
 *
 * 三份都是任务侧的记录，清空任务卡时一并移出。监工对话台账（插话记录、调度指令、事件流）
 * 不属于任务卡，由“新会话”单独处理；在此归档会使监工对话从界面上消失。
 */
export function clearRuntimeLedger(root: string): { dir: string; moved: number; stage: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = archive.clear(root, stamp);
  let moved = 0;
  try {
    mkdirSync(dir, { recursive: true });
    const targets = [ledgerLoc.tasks(root), inboxLoc.dispatch(root), rootIndexLoc.worker(root)];
    for (const f of targets) {
      try {
        if (!existsSync(f)) continue;
        renameSync(f, join(dir, basename(f)));
        moved += 1;
      } catch {
      }
    }
  } catch {
  }

  let stage = "";
  try {
    const st = loadState(root);
    const specPath = String((st as unknown as { contract_path?: string } | null)?.contract_path ?? "");
    const spec = specPath ? readJson<{ stages?: { id?: string }[] } | null>(specPath, null) : null;
    stage = String(spec?.stages?.[0]?.id ?? "");
    if (st && stage) {
      updateState(root, (s) =>
        Object.assign(s, {
          stage,
          stage_entered_at: new Date().toISOString(),
          counters: {},
          next_action: "",
          blockers: [],
        }),
      );
    }
  } catch {
  }
  return { dir, moved, stage };
}

/**
 * 按界面筛选档清空任务卡。
 *
 * 档名逐个校验，不认识的直接拒：回落 `all` 会把整块台账当成本档清掉。
 * 清空范围只由这一档的线程决定，档外的派单与进程记录一律不动。
 */
export function clearThreadsByBucket(root: string, rawBucket: unknown): ClearResult {
  const raw = String(rawBucket ?? "all");
  if (raw !== "all" && !TASK_BUCKETS.includes(raw as TaskBucket)) {
    return {
      status: 400,
      body: { error: `bucket 取值非法：用 ${["all", ...TASK_BUCKETS].join(" / ")}` },
    };
  }
  /* 暂停单的处置是唤醒或关闭：归档会让该派单离开待办队列，与“清空列表”不是一回事。 */
  if (raw === "paused") {
    return { status: 409, body: { error: "暂停中的单请先唤醒或关闭，不提供按档清空" } };
  }

  const bucket = raw as TaskBucket | "all";
  const scope = removeScopeOfBucket(root, bucket);
  if (!scope.keys.length) {
    return {
      status: 200,
      body: { ok: true, bucket, keys: 0, workers: 0, dispatches: 0, effective: "该分类没有任务卡" },
    };
  }

  const r = archiveRecords(root, { dispatchIds: scope.dispatches, workerIds: scope.workers });

  /** bucket=all 才整根重置任务台账与阶段进度；监工对话由“新会话”单独处理，此处不动。 */
  let wiped: { dir: string; moved: number; stage: string } | null = null;
  if (bucket === "all") {
    try {
      wiped = clearRuntimeLedger(root);
    } catch {
      wiped = null;
    }
  }

  const label = bucket === "all" ? "全部" : TASK_BUCKET_WORD[bucket];
  const bits: string[] = [`已清空“${label}”${scope.keys.length} 个任务卡`];
  if (r.workers || r.dispatches) {
    bits.push(`进程记录 ${r.workers} 个、派单 ${r.dispatches} 张移进归档目录`);
  }
  if (wiped && wiped.moved > 0) bits.push(`任务台账 ${wiped.moved} 份一并归档`);
  if (wiped?.stage) bits.push(`阶段进度回到 ${wiped.stage}`);

  return {
    status: 200,
    body: {
      ok: true,
      bucket,
      keys: scope.keys.length,
      workers: r.workers,
      dispatches: r.dispatches,
      dir: r.dir,
      effective: bits.join("，"),
    },
  };
}
