/**
 * 状态位与指示气泡的判定来源：工作进程取日志末条语义事件（见 `workerLog.ts` 的 `lastAction`），
 * 监工取正在处理的队列与请求，不按时间推断。未命中枚举时由调用方回退到运行中/思考中。
 */

/**
 * 工作进程当前动作。`report` 取自派单状态 `reported`，不来自日志事件。
 */
export type WorkerDoing = "report" | "test" | "build" | "command" | "reply" | "waiting";

/** 只认常见测试与构建入口；无法识别时归入 `command`，不推断更具体的动作。 */
export function isTestCommand(command: string): boolean {
  const c = String(command || "");
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bvitest\b|\bjest\b|\bmocha\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\bnode\s+--test\b|\bplaywright\s+test\b/i.test(
    c,
  );
}

export function isBuildCommand(command: string): boolean {
  const c = String(command || "");
  return /\b(?:npm|pnpm|yarn|bun)\s+run\s+build\b|\bvite\s+build\b|\btsc\b|\bcargo\s+build\b|\bgo\s+build\b|\bmake\b|\bmsbuild\b|\bdotnet\s+build\b|\bwebpack\b|\brollup\b/i.test(
    c,
  );
}

/** 日志动作 → 界面动作；`null` / `undefined` 表示判不出来，调用方回退。 */
export function doingOfAction(action: { phase?: string; command?: string } | null | undefined): WorkerDoing | "" {
  if (!action) return "";
  if (action.phase === "reply") return "reply";
  if (action.phase === "waiting") return "waiting";
  if (action.phase === "command") {
    const cmd = String(action.command || "");
    if (isTestCommand(cmd)) return "test";
    if (isBuildCommand(cmd)) return "build";
    return "command";
  }
  return "";
}

/**
 * 监工动作类型。
 *
 * - `triage`   处理工作进程的申报与回执
 * - `dispatch` 调度与派单
 * - `chat`     监工对话
 * - `board`    看板动作
 * - `reload`   上下文重载
 */
export type SupervisorAction = "triage" | "dispatch" | "chat" | "board" | "reload";

/** 指示气泡档位。`compacting` 独立成档，对应一次有明确起止的上下文重载。 */
export type SupervisorActivityKind = "receipt" | "supervising" | "thinking" | "compacting";
export const CAPITALIST_ACTIVITY_OF: Record<SupervisorAction, SupervisorActivityKind> = {
  triage: "receipt",
  dispatch: "supervising",
  chat: "supervising",
  board: "supervising",
  reload: "compacting",
};

/**
 * 正在进行的动作，按动作计数，归零才算结束。
 * 只在看板层登记：`/api/capitalist-chat` 标 `chat`，指令接口标 `board`；主循环的判定与派单
 * 由 {@link supervisorActivityOf} 读台账状态得出，不在此登记。
 */
const inflight = new Map<SupervisorAction, number>();

export function enterSupervisorAction(action: SupervisorAction): () => void {
  inflight.set(action, (inflight.get(action) ?? 0) + 1);
  let left = false;
  return () => {
    if (left) return;
    left = true;
    const n = (inflight.get(action) ?? 1) - 1;
    if (n > 0) inflight.set(action, n);
    else inflight.delete(action);
  };
}

/** 当前正在进行的动作；多个动作同时跑时取第一个登记的类型（稳定顺序见 {@link CAPITALIST_ACTION_ORDER}）。 */
const CAPITALIST_ACTION_ORDER: SupervisorAction[] = ["triage", "dispatch", "chat", "board"];

export function currentSupervisorAction(): SupervisorAction | "" {
  for (const a of CAPITALIST_ACTION_ORDER) if ((inflight.get(a) ?? 0) > 0) return a;
  return "";
}

/**
 * 监工指示档位。判定优先级：重载 → 在跑动作 → 待处理申报 → 在跑工作进程 → 回落 `thinking`。
 * 重载标记由监工进程或 CLI 写、看板进程读，故从磁盘状态取，不依赖进程内计数。
 */
export function supervisorActivityOf(args: {
  action?: SupervisorAction | "";
  hasPendingReceipt?: boolean;
  running?: number;
  reloading?: boolean;
}): { kind: SupervisorActivityKind; action: SupervisorAction | "" } {
  if (args.reloading) return { kind: "compacting", action: "reload" };
  const act = args.action ?? "";
  if (act) return { kind: CAPITALIST_ACTIVITY_OF[act], action: act };
  if (args.hasPendingReceipt) return { kind: "receipt", action: "triage" };
  if (Number(args.running ?? 0) > 0) return { kind: "supervising", action: "dispatch" };
  return { kind: "thinking", action: "" };
}
