import { createApp } from "vue";
import App from "./App.vue";
import "ant-design-vue/dist/reset.css";
import "./styles/tokens.css";
import "./styles/themes.css";
import "./styles/app.css";
import { initTheme } from "./lib/theme.js";
import { installTooltip } from "./lib/tooltip.js";
import { fadeclip } from "./lib/fadeclip.js";

/* 先应用主题再挂载，避免首帧使用默认色。 */
initTheme();

/*
 * 同源 fetch 统一加 `x-capitalist-client: board`（后端按此头名校验）。跨源请求带自定义头会触发
 * OPTIONS 预检，预检同样需要鉴权，故本机其他端口的页面无法 CSRF 到看板；SSE 不加该头。
 * 头名必须与服务端完全一致，写成 `X-Supervisor-Client` 会被判为缺少标识头而返回 403。
 */
const origFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const opts = { ...(init || {}) };
  let href = "";
  try {
    href = typeof input === "string" ? input : String(input?.url || "");
  } catch {
    href = "";
  }
  const sameOrigin =
    href.startsWith("./") || href.startsWith("../") || href.startsWith("/") || href.startsWith(location.origin);
  if (sameOrigin) {
    const headers = new Headers(opts.headers || {});
    headers.set("x-capitalist-client", "board");
    opts.headers = headers;
  }
  return origFetch(input, opts);
};

/* 超宽标题渐隐指令，任务卡标题与工作进程消息面板标题共用。 */
createApp(App).directive("fadeclip", fadeclip).mount("#app");

/* 挂载后安装统一浮层提示，避开首帧。 */
installTooltip();
