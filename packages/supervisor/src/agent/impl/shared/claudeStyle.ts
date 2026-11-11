/**
 * Claude 风格 hook 协议的共用实现。
 *
 * 这一类宿主（Claude Code / CodeBuddy / WorkBuddy / Generic）用同一套
 * 事件名、同一份 stdin JSON、同一个 `permissionDecision` 输出结构。各 impl 只声明差异。
 *
 * 差异的三种表达方式：
 * - 额外事件名：覆写 `extraPoints()`
 * - payload 字段名：覆写 `parse()`
 * - 决策形态：覆写 `deny()` / `inject()`，或改走 impl/shared/posixExit
 */

import type {
  HookDecision,
  HookFacet,
  LifecyclePoint,
  NativePayload,
  UnifiedEvent,
} from "../../contract";
import { POINT_ALIASES, obj, str } from "../../contract";

/**
 * 参照协议的事件表。
 *
 * 不映射动作后事件：工具已执行，判定无法阻止该动作，且会给同一条命令重复记违规。
 */
const SHARED_POINTS: Record<string, LifecyclePoint> = {
  PreToolUse: "on_action",
  UserPromptSubmit: "on_idle",
  SessionStart: "on_start",
  SessionEnd: "on_start",
  Stop: "on_stop",
  SubagentStop: "on_stop",
  PreCompact: "on_compact",
  PostCompact: "on_compact",
  Notification: "on_start",
};

/** 参照协议下，生命周期点回填到原生事件名时用的名字（用于组装返回结构）。 */
const NATIVE_NAMES: Record<LifecyclePoint, string> = {
  on_action: "PreToolUse",
  on_idle: "UserPromptSubmit",
  on_start: "SessionStart",
  on_compact: "PreCompact",
  on_stop: "Stop",
};

/**
 * 构造参照协议 hook facet 时的选项。
 *
 * `guessPriority` 只影响手工配置（`--agent` 缺失）时的猜测顺序，不影响工作进程探测。
 */
export interface ClaudeStyleOptions {
  /** 手工配置时被猜中的优先级，见 HookFacet.guessPriority */
  guessPriority?: number;
}

/**
 * 参照协议的 hook facet 实现。
 *
 * 全部方法都不抛：字段缺失给空值，无法映射的事件返回 null。
 */
export class ClaudeStyleHook implements HookFacet {
  /** 声明注入能到达模型上下文。 */
  readonly injects: boolean = true;
  /** 声明拒绝带结构化输出。 */
  readonly structuredDeny: boolean = true;
  readonly guessPriority?: number;

  constructor(opts: ClaudeStyleOptions = {}) {
    if (opts.guessPriority !== undefined) this.guessPriority = opts.guessPriority;
  }

  /** 平台额外认的事件名，与共用表合并；同名时平台优先。 */
  protected extraPoints(): Record<string, LifecyclePoint> {
    return {};
  }

  /**
   * 原生事件名到生命周期点的映射。
   *
   * 返回 null 表示该事件不参与监督。
   */
  pointFor(native: string): LifecyclePoint | null {
    const extra = this.extraPoints();
    if (Object.prototype.hasOwnProperty.call(extra, native)) return extra[native] ?? null;
    if (Object.prototype.hasOwnProperty.call(SHARED_POINTS, native)) {
      return SHARED_POINTS[native] ?? null;
    }
    // 同时认中性名（action / idle / stop），手写配置不必先查事件表
    if (Object.prototype.hasOwnProperty.call(POINT_ALIASES, native)) {
      return POINT_ALIASES[native] ?? null;
    }
    return null;
  }

  /**
   * 解析 payload。
   *
   * 字段名按参照协议读取，缺失时回落到 cwd 或空值，不抛。hook 抛异常在多数宿主体内
   * 表现为 hook 失败。
   */
  parse(payload: NativePayload, native: string): UnifiedEvent {
    const toolInput = obj(payload.tool_input ?? payload.toolInput);
    return {
      point: this.pointFor(native) ?? "on_idle",
      native,
      sessionId: str(payload.session_id ?? payload.sessionId),
      cwd: str(payload.cwd) || process.cwd(),
      tool: str(payload.tool_name ?? payload.toolName),
      toolInput,
      transcript: str(payload.transcript_path ?? payload.transcriptPath),
      prompt: str(payload.prompt ?? payload.user_prompt ?? payload.message),
    };
  }

  /**
   * 放行。退出码 0，无输出。
   */
  passthrough(): HookDecision {
    return { code: 0 };
  }

  /**
   * 拒绝。
   *
   * 输出结构化 JSON，同时带 `permissionDecision` 与 `permissionDecisionReason`。
   * `on_stop` 不接受 `permissionDecision`，改用通用的 block 形式。
   */
  deny(reason: string, point: LifecyclePoint, _sessionId: string): HookDecision {
    if (point === "on_stop") {
      return { code: 0, stdout: JSON.stringify({ decision: "block", reason }) };
    }
    return {
      code: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: NATIVE_NAMES[point],
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }),
    };
  }

  /**
   * 注入上下文。
   *
   * 提交输入类事件认 `additionalContext`，其余事件用 systemMessage。
   */
  inject(context: string, point: LifecyclePoint, _sessionId: string): HookDecision {
    if (point === "on_idle" || point === "on_start") {
      return {
        code: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: NATIVE_NAMES[point],
            additionalContext: context,
          },
        }),
      };
    }
    return { code: 0, stdout: JSON.stringify({ systemMessage: context }) };
  }
}
