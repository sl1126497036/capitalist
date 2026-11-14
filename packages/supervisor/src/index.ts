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
export * from "./core/platform/autowatch";
export * from "./core/message/brief";
export * from "./core/contract/checks";
export * from "./core/dispatch/commands";
export * from "./core/contract/contract";
export * from "./core/platform/http";
export * from "./core/contract/init";
export * from "./core/record/json";
export * from "./core/guard/jwt";
export * from "./core/record/ledger";
export * from "./core/guard/localGuard";
export * from "./core/record/paths";
export * from "./core/guard/permission";
export * from "./core/dispatch/preempt";
export * from "./core/record/state";
export * from "./core/record/supervisor";
export * from "./core/types";
