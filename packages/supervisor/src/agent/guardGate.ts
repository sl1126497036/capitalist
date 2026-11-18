/**
 * 越界与删除的拦截编排。
 *
 * 判定层只负责“这次动作有没有超出允许范围”，本模块负责越界之后的三件事：查批准、
 * 判断监工是否在线、入队并给出回执。两者分开是因为拦截编排有独立的产物（申请台账、
 * 待复核项），混在判定流程里会让 dispatch 一路膨胀。
 *
 * 批准按“动作 + 路径集合”绑定，用一次即作废；监工不在线时不批准。
 */

import type { Contract } from "../core/contract/contract";
import { extractDeleteArgs, localCheck } from "../core/guard/localGuard";
import {
  appendRequest,
  approvedFor,
  escalation,
  findOpenByFingerprint,
  fingerprintOf,
  markGuardUsed,
  newGuardId,
  type GuardKind,
} from "../core/guard/requests";
import { recordReview, recordToolEvent } from "../core/record/ledger";
import type { ActionKind } from "../core/types";
import type { HookDecision, HookFacet, UnifiedEvent } from "./contract";

/** 记违规时的入参；由判定层写入违规台账，本模块只转交。 */
export interface ViolationArgs {
  rule: string;
  label: string;
  evidence: string;
  decision: string;
}

/** 拦截所需的环境。 */
export interface GuardBase {
  hook: HookFacet;
  event: UnifiedEvent;
  root: string;
  contract: Contract;
  stage: string;
  /** 监工不在线：只拦不放，且不给申请通道。 */
  offline: boolean;
  /** 记一条违规并返回同类第几次，用于重复提醒。 */
  violate: (args: ViolationArgs) => { nth: number };
}

/** 记一条动作事件。台账写失败不影响判定。 */
function note(root: string, event: UnifiedEvent, extra: Record<string, unknown>, kind = "tool"): void {
  try {
    recordToolEvent(
      root,
      {
        point: event.point,
        tool: event.tool,
        session: event.sessionId,
        desc: String(event.toolInput?.description ?? event.toolInput?.intent ?? ""),
      },
      extra,
      kind,
    );
  } catch {
    /* 见上 */
  }
}

/**
 * 提交一次申请，同指纹已存在时复用。
 *
 * 复用是“合并提交”的实现：同一批路径重复触发不会产生多条申请，监工也不会被重复询问
 * 同一件事。工作进程补理由后可扩充路径集合，覆盖本次的整批操作。
 */
function enqueue(
  base: GuardBase,
  args: { kind: GuardKind; action: ActionKind; tool: string; command: string; paths: string[] },
): { id: string; paths: string[] } {
  const fp = fingerprintOf(args.kind, args.action, args.paths);
  const open = findOpenByFingerprint(base.root, fp);
  if (open) return { id: open.id, paths: open.paths.length > 0 ? open.paths : args.paths };
  const id = newGuardId();
  appendRequest(base.root, {
    id,
    at: new Date().toISOString(),
    atTs: Date.now() / 1000,
    kind: args.kind,
    action: args.action,
    tool: args.tool,
    command: args.command.slice(0, 400),
    paths: args.paths,
    worker: process.env.CAPITALIST_WORKER_ID ?? "",
    dispatch: process.env.CAPITALIST_DISPATCH_ID ?? "",
    stage: base.stage,
  });
  note(base.root, base.event, { request: id, kind: args.kind, paths: args.paths.join(" ") }, "guard_request");
  return { id, paths: args.paths };
}

/** 申请回执：编号、补理由的写法、合并提交与一次一批准。 */
function receipt(kind: GuardKind, id: string, paths: string[]): string {
  const head =
    kind === "delete"
      ? "删除需要先说明理由，交由监工裁决。"
      : "任务根与允许范围之外的操作需要先说明理由，交由监工裁决。";
  const sample = paths[0] ?? "<路径>";
  return [
    `【待监工裁决】${head}`,
    `已登记申请 ${id}，目标：${paths.join("、")}`,
    `补充理由：capitalist justify "${sample}" "<为什么必须做这次操作>"`,
    "多处访问合并成一次申请：多个路径用逗号分隔，写进同一条命令。",
    "批准只对这一次动作有效，按原命令重试一次即可；未批准的命令不要反复重试。",
    "理由只写用途与影响，不要把凭据内容贴进来。",
  ].join("\n");
}

/** 监工不在线时的统一回执。 */
function offlineNotice(action: string, paths: string[]): string {
  return (
    `【监工不在线】${action}一律拒绝：${paths.join("、")}\n` +
    "监工未运行。告知用户在终端执行 capitalist supervise 启动监工，再重试。"
  );
}

/** 越界申请的统一出口：先看批准记录，再判断监工是否在线，最后入队并拒绝本次调用。 */
export function outsideGate(base: GuardBase, paths: string[], act: ActionKind, tool: string): HookDecision {
  const { hook, event } = base;
  const approved = approvedFor(base.root, "outside", act, paths);
  if (approved) {
    markGuardUsed(base.root, approved.id);
    recordReview(base.root, {
      rule: "LOCAL-OUTSIDE",
      label: `越界批准（${tool}）`,
      why: approved.why || "监工已批准",
      evidence: paths.join(" "),
      session: event.sessionId,
    });
    return hook.passthrough();
  }

  if (base.offline) {
    note(base.root, event, { decision: "BLOCK", reason: "supervisor_offline", paths: paths.join(" ") });
    return hook.deny(offlineNotice("越界操作", paths), event.point, event.sessionId);
  }

  const cmd = String(event.toolInput.command ?? event.toolInput.file_path ?? event.toolInput.path ?? "");
  const req = enqueue(base, { kind: "outside", action: act, tool, command: cmd, paths });
  return hook.deny(receipt("outside", req.id, req.paths), event.point, event.sessionId);
}

/**
 * 删除的申请出口。
 *
 * 与越界共用一套申请台账，差别在目标提取：删除必须能点出具体路径。通配符、变量、
 * 未给目标都拒绝，因为无法核对影响面。敏感区（`~/.ssh` 一类）不在可申请范围。
 */
export function deleteGate(base: GuardBase, cmd: string): HookDecision {
  const { hook, event } = base;
  const { targets, unsafe } = extractDeleteArgs(cmd);
  if (unsafe || targets.length === 0) {
    note(base.root, event, { cmd: cmd.slice(0, 400), decision: "BLOCK", reason: "delete_unclear" });
    return hook.deny(
      "【删除未执行】删除目标不是具体路径，无法核对影响。\n" +
        "把要删的路径逐个写出来，不要用通配符或变量；否则改用不删的做法。",
      event.point,
      event.sessionId,
    );
  }

  /* 敏感路径与根外凭据不进入申请：这类位置没有可判断的空间。 */
  const sens = localCheck(base.contract, base.root, targets, "delete");
  if (sens.decision === "deny") {
    const why = sens.hits.map((h) => `${h.path}（${h.why}）`).join("；");
    const v = base.violate({ rule: "LOCAL-DELETE", label: "删除敏感区", evidence: why, decision: "BLOCK" });
    return hook.deny(
      `【删除拦截】这些位置不允许删：${why}\n凭据与系统目录不提供申请通道。` + escalation(v.nth),
      event.point,
      event.sessionId,
    );
  }

  const approved = approvedFor(base.root, "delete", "delete", targets);
  if (approved) {
    markGuardUsed(base.root, approved.id);
    recordReview(base.root, {
      rule: "LOCAL-DELETE",
      label: "删除批准",
      why: approved.why || "监工已批准",
      evidence: targets.join(" "),
      decision: "ALLOW",
      session: event.sessionId,
    });
    return hook.passthrough();
  }

  if (base.offline) {
    note(base.root, event, { decision: "BLOCK", reason: "supervisor_offline", paths: targets.join(" ") });
    return hook.deny(offlineNotice("删除", targets), event.point, event.sessionId);
  }

  const req = enqueue(base, {
    kind: "delete",
    action: "delete",
    tool: event.tool,
    command: cmd,
    paths: targets,
  });
  return hook.deny(receipt("delete", req.id, req.paths), event.point, event.sessionId);
}
