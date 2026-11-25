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

/** 一件事的合并状态。 */
export type AttemptState = "done" | "closed" | "dead" | "pending";

/** 判定一件事的状态所需的字段。 */
type Attempt = { status?: unknown; retry_verdict?: unknown; cascade_at?: unknown };

/**
 * 一件事的最后一次尝试。
 *
 * 台账按追加顺序落盘，同一件事（同一派生链、或接替过来的链）后写的那张就是最近一次派单：
 * 重派、重开、监工打回都只在链尾追加，不改旧行。因此“这件事现在是什么状态”必须看最后一张，
 * 不能按“任一单完成即完成”判定：用户重派一张已验收的任务后，旧单的 `done` 继续
 * 顶着整条链的完成状态，新单还在跑，下游已经放行。
 *
 * @param rows 同一件事的全部派单，按台账顺序。
 */
export function lastAttemptOf<T extends Attempt>(rows: readonly T[]): T | undefined {
  return rows.length > 0 ? rows[rows.length - 1] : undefined;
}

/**
 * 一件事的合并状态，以最后一次尝试为准。
 *
 * `dead` 只认“失败且不再重试”：`retry_verdict === "give_up"`，或该单被级联判定失败。
 * 可重试的失败不算终态，它还在等重派。旧单的状态不再参与判定：重派成功后这件事就是
 * `done`，重派失败后它才回到 `dead`。
 */
export function attemptsStateOf(rows: readonly Attempt[]): AttemptState {
  const head = lastAttemptOf(rows);
  if (!head) return "pending";
  const status = String(head.status ?? "");
  if (status === "done") return "done";
  if (status === "closed") return "closed";
  if (!isFailed(status)) return "pending";
  const verdict = String(head.retry_verdict ?? "");
  const cascaded = Boolean(String(head.cascade_at ?? ""));
  return verdict === "give_up" || cascaded ? "dead" : "pending";
}
