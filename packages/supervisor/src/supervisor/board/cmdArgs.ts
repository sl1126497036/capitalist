import { ShotRef } from "../../core/messages";

/**
 * 命令入参校验：把界面传来的未知值收敛成命令层能直接用的字符串、ID 与结果。
 *
 * 只做校验与构造，不读盘、不写盘。
 */
export interface CommandResult {
  status: number;
  body: Record<string, unknown>;
}

export function cStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function cBad(msg: string): CommandResult {
  return { status: 400, body: { error: msg } };
}

export function cId(v: unknown, name: string): string | null {
  const s = cStr(v);
  if (!s) return null;
  if (s.length > 80) return null;
  if (/[\s\u0000-\u001f]/.test(s)) return null;
  return s;
}

export function pickShots(picks: number[] | undefined, own: string[], shots: readonly ShotRef[]): string[] {
  if (!picks) return own;
  if (picks.length === 0) return [];
  const byIndex = new Map(shots.map((s) => [s.index, s.path] as const));
  const hit = [...new Set(picks.map((n) => byIndex.get(n)).filter((p): p is string => Boolean(p)))];
  return hit.length ? hit : own;
}

