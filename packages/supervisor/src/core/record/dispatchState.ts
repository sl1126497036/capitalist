/**
 * 派单状态口径的唯一来源。
 *
 * 状态判定曾分散在多处，口径逐渐分叉：重建认 `done | closed`，森林视图另有一份
 * `lineageDone`，重建的“未完工”集合又漏了 `reported`。新增一个状态时，需要修改的地方
 * 难以穷举，漏一处就会产生两套口径。
 *
 * 本模块只回答“这个状态属于哪一档”，不回答“这张单能不能跑”。后者要看前置与组，
 * 属于 `core/dispatch/deps.ts`。两者分开，避免把结构判定又搅回状态判定里。
 */

/** 派单状态的取值范围。与 `DispatchStatus` 同源，此处以字符串声明，供不引入类型的调用方使用。 */
export type DispatchStatusLike = string;

/**
 * 已收尾：这件事不再产生新的产出，且属于正常结束。
 *
 * `done` 是做完，`closed` 是人工结束。两者对下游的语义相同：不再等它。
 */
export function isSettled(status: DispatchStatusLike): boolean {
  const s = String(status ?? "");
  return s === "done" || s === "closed";
}

/** 失败。与 `closed` 分开：失败可以重试，`closed` 不会自行恢复。 */
export function isFailed(status: DispatchStatusLike): boolean {
  return String(status ?? "") === "failed";
}

/** 在途：已经有人认领，或已经上报、正在等裁决。 */
export function isInFlight(status: DispatchStatusLike): boolean {
  const s = String(status ?? "");
  return s === "claimed" || s === "reported" || s === "review";
}

/** 可派发：等待拉起。 */
export function isRunnable(status: DispatchStatusLike): boolean {
  return String(status ?? "") === "open";
}

/** 未到终态：还会变化。终态只有 `done` / `closed` / `failed`。 */
export function isOpen(status: DispatchStatusLike): boolean {
  return !isSettled(status) && !isFailed(status);
}

/** 终态：不会再变化。 */
export function isTerminal(status: DispatchStatusLike): boolean {
  return isSettled(status) || isFailed(status);
}

/**
 * 判定“台账是平的”时使用的未完工集合。
 *
 * 刻意不含 `reported`：`looksFlat` 只在监工启动时跑一次，改变它的集合会改变
 * `autoRebuild` 的触发条件，那是行为变更而不是口径收口。待专门评估后再合并到
 * {@link isOpen}，现在保留原样并在此标注。
 */
export function isStructureLive(status: DispatchStatusLike): boolean {
  const s = String(status ?? "");
  return s === "open" || s === "claimed" || s === "review";
}

/**
 * 这一行是否算“这件事做完了”。
 *
 * 重建自己关掉的残留（带 `rebuilt_at`）不算：它们是被重建关掉的，不是被做完的。
 * 不排除它们的后果是第二次重建把待办也关掉：第一轮把 A 并进 A2（A 记 closed），
 * 第二轮就会把 A 当成“同一件事已完成”，于是 A2 这个待办也被关，最终没有待办留下。
 */
export function isCompletionOf(d: { status?: unknown; rebuilt_at?: unknown }): boolean {
  return isSettled(String(d.status ?? "")) && !String(d.rebuilt_at ?? "");
}
