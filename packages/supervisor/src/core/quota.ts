/** 模型额度耗尽的状态。 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { supervisorDir } from "./paths";

export interface QuotaState {
  /** 是否处于“额度耗尽”判定中 */
  exhausted: boolean;
  /** 判定时间（ISO）；未知为空串 */
  at: string;
  text: string;
}

const EMPTY: QuotaState = { exhausted: false, at: "", text: "" };

function statePath(root: string): string {
  return join(supervisorDir(root), "quota.json");
}

/**
 * 读当前额度状态；没写过或读坏了返回“未耗尽”。
 *
 * 不按时间过期。额度是否恢复，唯一可信的证据是一次成功的模型调用（成功路径会
 * 调 clearQuotaExhausted）。用“多久以前记的”推断恢复，等于拿时间冒充证据：
 * 中间什么都没跑过，就没有任何理由认为额度回来了。
 */
export function readQuotaState(root: string): QuotaState {
  let raw: string;
  try {
    raw = readFileSync(statePath(root), "utf8");
  } catch {
    return EMPTY;
  }
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return EMPTY;
  }
  if (j.exhausted !== true) return EMPTY;
  return { exhausted: true, at: String(j.at ?? ""), text: String(j.text ?? "") };
}

/** 记下“额度耗尽”。同一秒内重复调用只写一次，避免看板每轮失败都刷盘。 */
export function markQuotaExhausted(root: string, text: string): void {
  const cur = readQuotaState(root);
  if (cur.exhausted) {
    /* 已经标过：只更新说明，不动 at（时间代表“什么时候开始耗尽的”）。 */
    try {
      writeFileSync(statePath(root), JSON.stringify({ ...cur, text: text || cur.text }), "utf8");
    } catch {
      /* 写不进去不影响主流程：状态位只服务界面 */
    }
    return;
  }
  try {
    writeFileSync(
      statePath(root),
      JSON.stringify({ exhausted: true, at: new Date().toISOString(), text: String(text ?? "") }),
      "utf8",
    );
  } catch {
    /* 同上 */
  }
}

/** 跑通一次就清掉。文件不存在时不写盘（绝大多数调用都会走到这里，别做无意义 IO）。 */
export function clearQuotaExhausted(root: string): void {
  if (!readQuotaState(root).exhausted) return;
  try {
    writeFileSync(statePath(root), JSON.stringify(EMPTY), "utf8");
  } catch {
    /* 同上 */
  }
}
