/**
 * 任务标题取值链：接口 `title` → 分片映射 → 正文摘要，不回落到分片 id。
 * 映射表与服务端 supervisor/taskTitle.ts 同源；前端独立打包不引后端模块，改表需两处同步。
 */

/** 短标题上限：10 个汉字。 */
const MAX_TITLE_CHARS = 10;

export const SHARD_TITLES = Object.freeze({
  "api-latency": "首屏提速",
  "api-trim": "接口限长",
  "arch-split": "看板模块拆分",
  "audit-gate": "视觉验收门",
  "board-autostart": "看板自启",
  "chat-fix": "对话修复",
  "chat-stream": "消息流与输入区",
  "chat-wire": "对话区接线",
  "cleanup-artifacts": "产物清理",
  "cleanup-dead-config": "死配置清理",
  cli: "命令行整改",
  "collapse-ux": "折叠交互",
  "comments-core": "核心层注释",
  "comments-hostcli": "宿主层注释",
  community: "社区文件",
  "composer-resize": "输入区拖高",
  "controls-api": "指标与命令接口",
  "controls-engine": "暂停引擎",
  core: "核心层整改",
  "cost-data": "成本数据",
  "data-path-r2": "数据通路",
  "docs-dir": "文档与手册",
  "docs-root": "根文档",
  "drop-notify": "去掉通知铃",
  "engine-api": "线程消息接口",
  "engine-cli": "指令中断命令",
  "engine-core": "任务列表热加载",
  "engine-guard": "进程回收",
  "engine-stream": "输出流式落盘",
  "final-cleanup": "兼容层清除",
  "fix-ask-scope": "提问按片停派",
  "fix-credential-visibility": "凭证可见",
  "fix-redispatch": "重派取任务列表",
  "fix-task-title": "任务标题中文化",
  host: "宿主层整改",
  "icon-polish": "图标统一化",
  "image-preview": "图片预览",
  "incremental-poll-r3": "增量轮询",
  "independent-reviewer": "独立只读复查",
  "instance-paths": "实例路径隔离",
  "instance-switch": "实例切换",
  integrate: "脚本接线验收",
  main: "主流程",
  meta: "包元数据",
  "msg-attach-binding": "附件串消息",
  "msg-color-semantics": "消息配色分级",
  "msg-noise": "消息降噪",
  "orphan-fix": "孤儿进程回收",
  "parity-audit-b": "旧版功能对账",
  "pixel-restore": "像素级还原",
  "prompt-precision": "提示词精准",
  "queue-fix": "左栏补齐",
  "queue-list": "左栏队列",
  "queue-rework": "左栏筛选",
  "queue-shell": "左栏外壳",
  redesign: "布局与视觉",
  "refactor-log-pipeline": "日志管道合并",
  "release-notes": "变更日志",
  "render-fix": "进程列表修复",
  "revert-icon-overreach": "回退图标滥用",
  reviewer: "独立验收",
  scheduler: "调度健壮性",
  "scroll-base": "滚动条常驻",
  "scrollbar-fixed": "滚动条不抖",
  "shell-fix": "顶栏补齐",
  "shell-top": "顶栏与指标区",
  "stream-client": "前端推流",
  "stream-server": "服务端推流",
  "capitalist-reload": "监工上下文重载",
  "capitalist-task-list": "任务列表整理",
  "capitalist-term-rename": "术语统一",
  "supervisor-entry": "监工条目",
  "tab-panel-layout": "选项卡联动",
  "theme-switch": "配色切换",
  themes: "主题配色",
  "titles-i18n": "标题与中英切换",
  "usage-source": "用量数据源补齐",
  "user-p0-fixes": "卡顿与遮挡",
  "ux-chat": "对话修复",
  "ux-chat-u2": "对话修复二轮",
  "ux-layout": "左栏布局",
  "ux-layout-u2": "左栏布局二轮",
  "ux-status": "状态显示",
  "ux-status-u2": "状态显示二轮",
  verify: "实测验收",
  "verify-precision": "验收门槛",
  visual: "视觉重做",
  "visual-chat": "右栏视觉",
  "visual-queue": "左栏视觉",
  "visual-shell": "顶栏视觉",
});

const CJK = /[\u4e00-\u9fa5]/;

export function cjkCount(text) {
  let n = 0;
  for (const ch of String(text || "")) if (CJK.test(ch)) n += 1;
  return n;
}

/** 分片 id → 中文短名；查不到返回空串。 */
export function shardTitle(shard) {
  const id = String(shard || "").trim();
  if (!id) return "";
  return SHARD_TITLES[id] || SHARD_TITLES[id.toLowerCase()] || "";
}

export function summarizeTitle(text, max = MAX_TITLE_CHARS) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const plain = raw
    .replace(/[（(][^）)]*[）)]/g, " ")
    .replace(/[`*#>|]/g, " ");
  for (const part of plain.split(/[。；;！!？?\n，,、：:]/)) {
    const seg = part.replace(/[\s\S]/gu, (ch) => (CJK.test(ch) ? ch : ""));
    if (cjkCount(seg) >= 2) return seg.slice(0, max);
  }
  return "";
}

/** `fallback` 仅在无标题来源时由调用方给定；取不到标题时留空，不使用占位文案。 */
export function taskTitle(t, fallback = "") {
  const stored = String(t?.title || "").trim();
  if (cjkCount(stored) > 0) return stored;
  const mapped = shardTitle(t?.shard);
  if (mapped) return mapped;
  const summarized = summarizeTitle(t?.action);
  if (summarized) return summarized;
  return fallback;
}
