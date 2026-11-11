/** 状态位 / 指示气泡文案表，动作与后端 activity.ts 枚举对应。 */
import { t } from "./i18n.js";

/** 工作进程动作 -> 状态词。report 覆盖“已申报待回执”与“回执处理中”两阶段。 */
export const WORKER_DOING_TEXT = {
  report: "执行回执",
  test: "运行测试",
  build: "构建",
  command: "执行命令",
  reply: "正在生成回复",
  waiting: "等待外部结果",
};

/** 任务卡与工作进程指示气泡共用的回落词。 */
export const WORKER_DOING_FALLBACK = "运行中";

export const CAPITALIST_ACTIVITY_TEXT = {
  receipt: "回执中",
  supervising: "监管中",
  thinking: "思考中",
  /* 上下文重载期间（服务端 activity.action=reload）使用该状态。 */
  compacting: "压缩中",
};

export const CAPITALIST_ACTIVITY_FALLBACK = "思考中";

export function workerDoingText(doing) {
  const v = WORKER_DOING_TEXT[String(doing || "")];
  return t(v || WORKER_DOING_FALLBACK);
}

export function supervisorActivityText(activity) {
  const kind = String(activity?.kind || "");
  return t(CAPITALIST_ACTIVITY_TEXT[kind] || CAPITALIST_ACTIVITY_FALLBACK);
}
