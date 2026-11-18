/**
 * 终端输出语言。
 *
 * 默认英文。设置 `CAPITALIST_LANG=zh` 时使用中文，供本地调试与中文用户使用。
 * 只影响终端输出，不改变台账、契约与日志文件里的字段。
 */

const RAW = String(process.env.CAPITALIST_LANG ?? "en").trim().toLowerCase();

/** 是否使用中文输出。 */
export const useZh = RAW === "zh" || RAW.startsWith("zh-");

/** 按当前语言取一条文案。 */
export function t(en: string, zh: string): string {
  return useZh ? zh : en;
}
