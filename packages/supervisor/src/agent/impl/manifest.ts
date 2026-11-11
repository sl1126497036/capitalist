/**
 * impl 清单：目录名到加载器的映射。
 *
 * 宿主集合由本文件定义。注册表按这里的键取加载器，能力、探测顺序、配置目录
 * 一律从 impl 读；新增宿主只加 `impl/<id>/` 目录与本文件一行。
 *
 * 显式清单在编译期绑定：缺文件时编译报错，打包压缩后也不依赖 dist 的目录结构。
 * 加载器用 `require`，只在真正取用时发生，hook 冷启动只加载被选中的那一个。
 * `test/layering.test.js` 断言清单与目录一一对应、且每个 impl 的 id 等于目录名。
 */

import type { HostImpl } from "../contract";

/**
 * 加载器：延迟取用某个宿主的 impl。
 *
 * 返回值不做校验，调用方按 `HostImpl` 使用。加载失败（文件缺失、模块抛错）时抛异常，
 * 由取用方决定怎么处理。
 */
export type ImplLoader = () => HostImpl;

/**
 * 宿主 id 到加载器的映射。
 *
 * 键即目录名，也是 impl 自报的 `id`；注册表按这里的键取用。取值顺序固定，不随探测优先级
 * 变化。
 */
export const IMPL_LOADERS: Readonly<Record<string, ImplLoader>> = {
  // 顺序即 `all()` / `dirs()` 的输出顺序，也是文档里的列举顺序。稳定，不随探测优先级变化。
  "claude-code": () => require("./claude-code").default as HostImpl,
  codebuddy: () => require("./codebuddy").default as HostImpl,
  workbuddy: () => require("./workbuddy").default as HostImpl,
  generic: () => require("./generic").default as HostImpl,
};

/** 清单里的 id，按声明顺序。 */
export function implIds(): string[] {
  return Object.keys(IMPL_LOADERS);
}
