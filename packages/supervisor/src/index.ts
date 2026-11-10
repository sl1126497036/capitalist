/**
 * 库入口：重导出 `core` 层。
 *
 * `core` 不含顶层 I/O，导入不触发动作。
 *
 * `cli` / `host` / `supervisor` / `install` 不在导出范围内：导入它们会执行 main 或注册 hook，
 * 这些模块只能经 bin 入口调用。
 *
 * 看板页面不在库导出范围内：页面由 `web/` 的 Vue 产物提供，经 HTTP 托管。
 */
export * from "./core/autowatch";
export * from "./core/brief";
export * from "./core/checks";
export * from "./core/commands";
export * from "./core/contract";
export * from "./core/http";
export * from "./core/init";
export * from "./core/json";
export * from "./core/jwt";
export * from "./core/ledger";
export * from "./core/localGuard";
export * from "./core/paths";
export * from "./core/permission";
export * from "./core/preempt";
export * from "./core/state";
export * from "./core/supervisor";
export * from "./core/types";
