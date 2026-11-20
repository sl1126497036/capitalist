/**
 * 契约名的语义判定：区分用户自己写的任务列表与引擎自带的流程壳子。
 *
 * 入参只需契约名，不需要契约对象：调用方手里常常只有 `state.contract` 这个字符串
 * （历史状态、事件载荷），为一次判定回读契约文件不值得。故本判定独立成模块，
 * 不必依赖 `contract.ts` 的加载与编译流程。
 */

/** 引擎自带的默认任务列表名：未指定契约时用它，阶段只是流程壳子。 */
const DEFAULT_CONTRACT_NAME = "minimal";

/** 调度层的容器键：不对应工序，只有台账，没有用户定义的过程。 */
const CONTAINER_CONTRACT_NAME = "generic";

/**
 * 用户是否自己写了任务列表。
 *
 * `minimal` 是引擎自带的默认工序，`generic` 是调度层的容器键，两者都不是用户定义的过程。
 * 这两种情况不在界面描述契约：用户没有“S0”这个概念，一张单落在哪一步也不影响他要看的结果，
 * 写出来只会让人以为漏了别的步骤。只有用户自己写了任务列表，阶段名与门槛才是他关心的信息。
 */
export function hasCustomContract(name: unknown): boolean {
  const n = String(name ?? "").trim();
  return Boolean(n) && n !== DEFAULT_CONTRACT_NAME && n !== CONTAINER_CONTRACT_NAME;
}
