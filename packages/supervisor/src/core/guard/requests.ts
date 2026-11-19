/**
 * 越界与删除的申请台账（`.capitalist/guard/requests.jsonl`）。
 *
 * 一次申请由四类事件构成，全部追加，不改写已有行：
 *   request  工作进程尝试越界，或被删除拦截时写入
 *   reason   工作进程通过 `capitalist justify` 补充理由，可合并多个路径
 *   decision 监工或用户给出结论
 *   used     批准被实际使用一次
 *
 * 批准按“动作 + 路径集合”绑定，用一次即作废，不设时间窗。时间窗会让一次批准在
 * 有效期内覆盖同目录的其它写入，那正是越界的入口。
 */

import { join } from "node:path";

import { appendJsonl, readJsonl } from "../record/json";
import { guard as guardLoc } from "../record/locations";
import type { ActionKind } from "../types";
import { normLocal } from "./localGuard";

/** 申请类型：允许范围外的操作，或任意删除。 */
export type GuardKind = "outside" | "delete";

/** 裁决结果。`escalate` 表示监工判断不了，转给用户。 */
export type GuardVerdict = "allow" | "deny" | "escalate";

/** 申请的状态。 */
export type GuardStatus = "open" | "allowed" | "denied" | "escalated";

/** 折叠后的申请。 */
export interface GuardRequest {
  id: string;
  at: string;
  atTs: number;
  kind: GuardKind;
  action: ActionKind;
  tool: string;
  command: string;
  paths: string[];
  worker: string;
  dispatch: string;
  stage: string;
  /** 工作进程补充的理由；未补充时为空串。 */
  reason: string;
  status: GuardStatus;
  /** 批准是否已被使用。一次批准只使用一次。 */
  used: boolean;
  /** 裁决说明。 */
  why: string;
  /** 拒绝时给出的替代做法。 */
  alternative: string;
  /** 裁决方与时间。 */
  by: "supervisor" | "user" | "";
  decidedTs: number;
  /** 转用户裁决时登记的问题 id，用户裁决后按它关闭问题。 */
  ask: string;
}

/** 台账路径。 */
export function guardLedgerPath(root: string): string {
  return guardLoc.requests(root);
}

/** 生成申请号。 */
export function newGuardId(): string {
  return `G-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/**
 * 申请指纹：动作 + 路径集合。
 *
 * 不含命令原文：同一条路径用不同工具、不同写法访问属于同一件事。恢复命令行里只要
 * 路径与动作一致即命中，不必逐字照抄原命令。
 */
export function fingerprintOf(kind: GuardKind, action: ActionKind, paths: readonly string[]): string {
  const norm = [...new Set(paths.map((p) => normLocal(p)).filter(Boolean))].sort();
  return `${kind}|${action}|${norm.join("|")}`;
}

type Row =
  | {
      type: "request";
      id: string;
      at: string;
      at_ts: number;
      kind: GuardKind;
      action: ActionKind;
      tool: string;
      command: string;
      paths: string[];
      worker: string;
      dispatch: string;
      stage: string;
    }
  | { type: "reason"; id: string; at_ts: number; reason: string; paths?: string[] }
  | {
      type: "decision";
      id: string;
      at_ts: number;
      verdict: GuardVerdict;
      by: "supervisor" | "user";
      why: string;
      alternative: string;
      ask?: string;
    }
  | { type: "used"; id: string; at_ts: number };

/** 逐行折叠成申请列表，保持写入顺序。 */
export function readGuardRequests(root: string): GuardRequest[] {
  const out = new Map<string, GuardRequest>();
  for (const raw of readJsonl<Row>(guardLedgerPath(root))) {
    const id = String((raw as { id?: unknown }).id ?? "");
    if (!id) continue;

    if (raw.type === "request") {
      out.set(id, {
        id,
        at: String(raw.at ?? ""),
        atTs: Number(raw.at_ts ?? 0),
        kind: raw.kind === "delete" ? "delete" : "outside",
        action: raw.action === "delete" || raw.action === "write" ? raw.action : "read",
        tool: String(raw.tool ?? ""),
        command: String(raw.command ?? ""),
        paths: Array.isArray(raw.paths) ? raw.paths.map(String) : [],
        worker: String(raw.worker ?? ""),
        dispatch: String(raw.dispatch ?? ""),
        stage: String(raw.stage ?? ""),
        reason: "",
        status: "open",
        used: false,
        why: "",
        alternative: "",
        by: "",
        decidedTs: 0,
        ask: "",
      });
      continue;
    }

    const rec = out.get(id);
    if (!rec) continue;

    if (raw.type === "reason") {
      rec.reason = String(raw.reason ?? "").trim();
      if (Array.isArray(raw.paths) && raw.paths.length > 0) rec.paths = raw.paths.map(String);
      continue;
    }
    if (raw.type === "decision") {
      rec.status = raw.verdict === "allow" ? "allowed" : raw.verdict === "deny" ? "denied" : "escalated";
      rec.by = raw.by === "user" ? "user" : "supervisor";
      rec.why = String(raw.why ?? "");
      rec.alternative = String(raw.alternative ?? "");
      rec.decidedTs = Number(raw.at_ts ?? 0);
      if (raw.ask) rec.ask = String(raw.ask);
      continue;
    }
    if (raw.type === "used") rec.used = true;
  }
  return [...out.values()];
}

/** 仍在等裁决的申请。 */
export function openGuardRequests(root: string): GuardRequest[] {
  return readGuardRequests(root).filter((r) => r.status === "open");
}

/** 已提交理由、可以裁决的申请。 */
export function reasonedGuardRequests(root: string): GuardRequest[] {
  return openGuardRequests(root).filter((r) => r.reason.trim() !== "");
}

/** 追加一条申请。 */
export function appendRequest(
  root: string,
  req: Pick<
    GuardRequest,
    "id" | "at" | "atTs" | "kind" | "action" | "tool" | "command" | "paths" | "worker" | "dispatch" | "stage"
  >,
): void {
  appendJsonl(guardLedgerPath(root), {
    type: "request",
    id: req.id,
    at: req.at,
    at_ts: req.atTs,
    kind: req.kind,
    action: req.action,
    tool: req.tool,
    command: req.command,
    paths: req.paths,
    worker: req.worker,
    dispatch: req.dispatch,
    stage: req.stage,
  });
}

/** 追加理由。可同时扩充路径，用于合并提交。 */
export function appendReason(root: string, id: string, reason: string, paths?: readonly string[]): void {
  appendJsonl(guardLedgerPath(root), {
    type: "reason",
    id,
    at_ts: Date.now() / 1000,
    reason: reason.trim(),
    ...(paths && paths.length > 0 ? { paths: [...paths] } : {}),
  });
}

/** 追加裁决。`ask` 用于记下转用户裁决时的问题 id。 */
export function appendDecision(
  root: string,
  id: string,
  verdict: GuardVerdict,
  by: "supervisor" | "user",
  why: string,
  alternative = "",
  ask = "",
): void {
  appendJsonl(guardLedgerPath(root), {
    type: "decision",
    id,
    at_ts: Date.now() / 1000,
    verdict,
    by,
    why: why.trim(),
    alternative: alternative.trim(),
    ...(ask ? { ask } : {}),
  });
}

/** 标记批准已使用。 */
export function markGuardUsed(root: string, id: string): void {
  appendJsonl(guardLedgerPath(root), { type: "used", id, at_ts: Date.now() / 1000 });
}

/** 同指纹且仍在等待的申请，用于避免同一动作重复入队。 */
export function findOpenByFingerprint(root: string, fp: string): GuardRequest | null {
  /* 指纹不进记录，按记录现算，避免记录字段与判定口径漂移。 */
  for (const rec of readGuardRequests(root)) {
    if (rec.status !== "open") continue;
    if (fingerprintOf(rec.kind, rec.action, rec.paths) === fp) return rec;
  }
  return null;
}

/**
 * 同一问题反复出现时的追加提示。第 1 次不提示，第 3 次要求登记后再停。
 *
 * 拦截文案共用这一份：越界、删除、红线三类拦截都要在同一时刻升级到“停手等裁决”。
 */
export function escalation(nth: number): string {
  if (nth <= 1) return "";
  if (nth === 2) return "\n\n（同一问题第 2 次：更换做法，不要重试同一条命令。）";
  return '\n\n（同一问题第 3 次：停手，先 capitalist ask "<为什么反复失败>" 登记，等监工裁决。）';
}

/**
 * 该动作是否已被批准且尚未使用。
 *
 * @returns 命中的申请；没有时返回 null。
 */
export function approvedFor(
  root: string,
  kind: GuardKind,
  action: ActionKind,
  paths: readonly string[],
): GuardRequest | null {
  const fp = fingerprintOf(kind, action, paths);
  for (const rec of readGuardRequests(root)) {
    if (rec.status !== "allowed" || rec.used) continue;
    if (fingerprintOf(rec.kind, rec.action, rec.paths) === fp) return rec;
  }
  return null;
}
