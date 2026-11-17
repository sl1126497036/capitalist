/** 腾讯系宿主（CodeBuddy / WorkBuddy）的模型策略。 */
export const TENCENT_MODEL_POLICY = {
  /** 默认档：没有显式指定、或指定了禁用模型时用它。 */
  default: "deepseek-v4.1-flash",
  /**
   * 禁用名单。
   *
   * 禁止名单曾硬编码一批档位名（glm-5.3 系列、hy 系列、xiaomi、minimax 别名等），
   * 与宿主 `--model` 清单冲突，面板选定后会被静默换回默认档。
   * 判定改由宿主承担：传过去能用就使用，不能用时由 `model_fallback` 的回退链路处理。
   *
   * `fast-model` 一类路由别名不在此处拦截：它本意就是让宿主自行决定档位。
   */
  deny: [] as string[],
} as const;
