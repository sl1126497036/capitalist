/** 监工自身少量仍需宿主具体值的点。 */

/** 监工自己调模型时，未指定宿主的缺省值。 */
export const DEFAULT_SUPERVISOR_CHAT_HOST = "codebuddy";

/**
 * 历史验收报告目录。
 *
 * 早期只在一个宿主上跑，路径写成了它的配置目录名；台账里的旧单仍指向这里，
 * 换名字会让已完成单据的证据对不上，所以保留原值，只集中到 impl 层。
 */
export const LEGACY_ACCEPTANCE_DIR = ".workbuddy";
