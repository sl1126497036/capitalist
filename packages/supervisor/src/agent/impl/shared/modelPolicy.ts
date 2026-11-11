/** 腾讯系宿主（CodeBuddy / WorkBuddy）的模型策略。 */
export const TENCENT_MODEL_POLICY = {
  /** 默认档：没有显式指定、或指定了禁用模型时用它。 */
  default: "deepseek-v4.1-flash",
  /**
   * 禁用名单（含宿主内部别名）。
   *
   * `fast-model` 是宿主的路由别名，传入后由宿主决定模型。
   */
  deny: [
    "fast-model",
    "glm-5.3-flash",
    "glm-5.3-flashx",
    "glm-5.3",
    "minimax-m3.1-flash",
    "mimimax-m3.1-flash",
    "xiaomi",
    "hy3",
    "hy3-x",
    "hy4",
    "hy4-free",
    "deepseek-v4-pro",
    "deepseek-v4.1-pro",
    "deepseek v4 pro",
  ],
} as const;
