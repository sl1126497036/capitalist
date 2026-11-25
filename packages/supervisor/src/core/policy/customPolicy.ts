/**
 * 守卫名的语义判定：区分用户自己写的守卫与引擎自带的默认档。
 *
 * 入参仅用守卫名，不需要守卫对象：调用方手里常常只有 `state.policy` 这个字符串
 * （历史状态、事件载荷），为一次判定回读守卫文件不值得。故本判定独立成模块，
 * 不必依赖 `policy.ts` 的加载与编译流程。
 */

/** 引擎自带的默认守卫名：未指定守卫时用它，只含通用红线与本机边界。 */
const DEFAULT_POLICY_NAME = "minimal";

/** 调度层的容器键：不对应具体任务，只有台账，没有用户声明的边界。 */
const CONTAINER_POLICY_NAME = "generic";

/**
 * 用户是否自己写了守卫。
 *
 * `minimal` 是引擎自带的默认档，`generic` 是调度层的容器键，两者都不含用户声明的
 * 领域判据。界面据此决定是否展开边界细节：默认档的红线是通用条款，逐条列出只是噪声。
 */
export function hasCustomPolicy(name: unknown): boolean {
  const n = String(name ?? "").trim();
  return Boolean(n) && n !== DEFAULT_POLICY_NAME && n !== CONTAINER_POLICY_NAME;
}
