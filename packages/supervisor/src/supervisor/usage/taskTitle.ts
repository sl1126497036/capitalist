/**
 * 任务标题中文化：按守卫 title、分片映射、正文摘要的顺序取中文名，均不可用时返回空串。
 *
 * 守卫 title 原样保留不截断，标题写入台账后截掉的部分无法补回；显示宽度由前端渐隐省略处理。
 */

import { stripListMark } from "../../core/text";

/** 分片 id -> 中文短名；覆盖历史分片，用于老记录没有 `title` 时回落补名。 */
export const SHARD_TITLES: Readonly<Record<string, string>> = Object.freeze({
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
  "engine-core": "守卫热加载",
  "engine-guard": "进程回收",
  "engine-stream": "输出流式落盘",
  "final-cleanup": "兼容层清除",
  "fix-ask-scope": "提问按片停派",
  "fix-credential-visibility": "凭证可见",
  "fix-redispatch": "重派取守卫",
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
  "capitalist-task-list": "守卫整理",
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

/**
 * 标题落盘上限：60 个字符。
 *
 * 提示词建议标题约 30 字，这是阅读舒适长度，不作硬性限制：31 字、35 字同样可用，按字数截断会丢失读者需要的内容。60 字上限只拦截异常长文（将整段正文写入标题），正常标题不会触及。
 */
export const TITLE_MAX_CHARS = 60;

/** 统计汉字数，非汉字字符不计入。 */
export function cjkCount(text: string): number {
  let n = 0;
  for (const ch of String(text ?? "")) if (CJK.test(ch)) n += 1;
  return n;
}

/** 分片 id -> 中文短名；查不到时返回空串。 */
export function shardTitle(shard: unknown): string {
  const id = String(shard ?? "").trim();
  if (!id) return "";
  return SHARD_TITLES[id] ?? SHARD_TITLES[id.toLowerCase()] ?? "";
}

/**
 * 句读边界：句号、分号、问叹号、换行、逗号、冒号。
 *
 * 顿号不在其中。顿号连接并列词（`test、scripts、.github`），按顿号切会把标题切在
 * 并列项之前，只剩开头的动词。
 */
const CLAUSE_BREAK = /[。；;！!？?\n，,：:]/;

/**
 * 标题兜底：正文中第一个含中文的句读段。
 *
 * 只在派单方没写 `TITLE:` 行时使用，正常路径不经过这里。两件事刻意不做：
 *
 * 1. 不按字符白名单过滤。只留汉字与数字会把 `加载 code-craft 技能` 截成 `加载技能`、删掉 `packages/supervisor/src/cli` 的路径，使多张单标题同名且看不出差异。
 * 2. 不判断哪一段是任务本体。判断依据只有词面，`按…` `依据…` 这类从句既可能是前提，
 *    也可能是本体，猜错的代价高于标题多带几个字。
 */
export function summarizeTitle(text: string): string {
  const raw = stripListMark(String(text ?? "").trim());
  if (!raw) return "";
  const plain = raw
    .replace(/[（(][^）)]*[）)]/g, " ")
    .replace(/[`*|]/g, " ")
    .replace(/(^|\s)#{1,6}(?=\s)/g, " ");
  const clause = plain
    .split(CLAUSE_BREAK)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .find((s) => cjkCount(s) >= 2);
  /* 整段没有汉字时返回空串：英文正文的标题交给调用方的占位处理，不把英文当标题。 */
  return clause ? clipTitle(clause) : "";
}

/** 合并空白并限长；超长时留省略号，读者能看出这不是原文结尾。 */
function clipTitle(text: string): string {
  const plain = String(text ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(plain);
  return chars.length > TITLE_MAX_CHARS ? `${chars.slice(0, TITLE_MAX_CHARS).join("")}…` : plain;
}

export interface TitleInput {
  /** 分片 id，用来查映射表。 */
  shard?: string | undefined;
  /** 派单正文，最后一级回落。 */
  action?: string | undefined;
}

export function taskTitle(input: TitleInput): string {
  const mapped = shardTitle(input.shard);
  if (mapped) return mapped;

  const summarized = summarizeTitle(String(input.action ?? ""));
  if (summarized) return summarized;

  return "";
}
