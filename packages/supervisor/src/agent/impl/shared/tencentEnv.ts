/**
 * 腾讯系宿主（CodeBuddy / WorkBuddy）共用的环境变量剔除表。
 *
 * 两家共用同一套 CLI 与登录态，宿主拉起的子进程会带上会话与工具调用标识变量；
 * CLI 读到这些变量就按“宿主会话内的一次工具调用”运行，表现为不产出自己的会话内容，
 * 最终被心跳超时判定为已退出。这类变量按名剔除，名单来自宿主注入，不随版本变化。
 *
 * 各自独有的项留在各自的 impl 里：codebuddy 剔除 `CODEBUDDY_HOST`（桌面端身份会把 CLI
 * 的认证指向宿主持久化凭据），workbuddy 额外剔除 `WORKBUDDY_SESSION_ID`。
 */
export const TENCENT_SESSION_ENV_DROP_NAMES: readonly string[] = [
  "CODEBUDDY_SESSION_ID",
  "CODEBUDDY_CONVERSATION_MESSAGE_ID",
  "CODEBUDDY_CONVERSATION_REQUEST_ID",
  "CODEBUDDY_TOOL_CALL_ID",
  "CODEBUDDY_MCP_CONFIG",
  "CODEBUDDY_DOCUMENT_IPC_ADDRESS",
];
