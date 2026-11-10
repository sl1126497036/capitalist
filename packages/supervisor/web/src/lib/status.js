/** 任务状态判定与词条的单一来源：队列卡与详情面板共用，避免同一派单两处措辞不一致。 */
import { t as tr } from "./i18n.js";

/**
 * 只读取服务端的 `settled`，不在前端反查派单台账（接口只下发最近一批）。
 * 无该字段时按 done / finished 判定。
 */
export function settled(t) {
  if (typeof t?.settled === "boolean") return t.settled;
  const s = String(t?.status || "");
  return s === "done" || s === "finished";
}

/**
 * 结束态判定：done 为已完成（done / finished，或 exited 且台账已验收）；
 * wakeup 为进程已退出但派单未结（被打回重排、被重启打断，或唤醒后尚未启动）；
 * 空串为非结束态。
 */
export function endedKind(t) {
  const s = String(t?.status || "");
  if (s === "done" || s === "finished") return "done";
  if (s === "exited") return settled(t) ? "done" : "wakeup";
  return "";
}

/** 结束态词条：`已完成` 与 `待重派`。 */
export function endedWord(t) {
  const k = endedKind(t);
  if (k === "done") return tr("已完成");
  if (k === "wakeup") return tr("待重派");
  return "";
}
