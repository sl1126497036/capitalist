/**
 * 宿主会话标识的判定。
 *
 * 宿主只在执行单条命令时注入会话与工具调用标识变量；用户在终端直接执行时不存在。
 * 两者据此区分：会话内不启动常驻进程，终端内允许常驻。
 */

/** 会话与工具调用标识变量。名单来自宿主注入，不随版本变化。 */
export const SESSION_ENV_NAMES: readonly string[] = [
  "CODEBUDDY_SESSION_ID",
  "CODEBUDDY_CONVERSATION_MESSAGE_ID",
  "CODEBUDDY_CONVERSATION_REQUEST_ID",
  "CODEBUDDY_TOOL_CALL_ID",
  "CODEBUDDY_MCP_CONFIG",
  "CODEBUDDY_DOCUMENT_IPC_ADDRESS",
  "CLAUDE_SESSION_ID",
];

/** 当前进程是否由宿主会话派生。 */
export function inHostSession(): boolean {
  return SESSION_ENV_NAMES.some((name) => Boolean(process.env[name]));
}
