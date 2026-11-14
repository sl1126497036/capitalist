/**
 * 工作进程日志的唯一解析入口：调用方按 text / tools / thinking 取通道，噪声规则只在此处定义一次。
 *
 * 判定顺序：`LOG_KEEP` 优先；stream 模式只认 JSON 事件，其余按宿主诊断过滤；纯文本模式按 `LOG_NOISE` 过滤。模式由日志内容判定，不依赖配置，使同一份日志在两处判定一致。
 */

import { clipText } from "../core/text";

/**
 * 工作进程当前动作的枚举，仅取日志可直接读出的 reply / command / waiting；界面按它出状态词。
 *
 * 本地读写工具不进枚举，调用方按无法判定回退。
 */
export type WorkerPhase = "reply" | "command" | "waiting";

/** 日志里最后一条可判定当前动作的事件。 */
export interface WorkerAction {
  phase: WorkerPhase;
  /** 工具名（phase=command / waiting 时有值）。 */
  tool: string;
  /** 命令原文（phase=command 时有值），供上层区分测试、构建等具体命令。 */
  command: string;
}

export interface WorkerLogParts {
  /** 工作进程输出的正文；不含工具调用与思考过程。 */
  text: string[];
  /** `▸ 读取 x` 这样的工具调用摘要，给标题下的活动条用。 */
  tools: string[];
  /** 模型的思考过程。 */
  thinking: string[];
  /** 被过滤的宿主调试行数，供页面显示隐藏行数。 */
  hidden: number;
  /** 被过滤的宿主调试行原文，默认不上屏，供折叠展开与复制使用。 */
  debug: string[];
  /** 日志是否为 stream-json 模式。 */
  stream: boolean;
  /** 最后一条可判定当前动作的语义事件：对象表示动作进行中；`null` 表示明确无动作，界面不沿用旧动作；`undefined` 表示该段无可判定事件，增量合并时沿用上一段。 */
  lastAction?: WorkerAction | null;
}

/**
 * 宿主运维噪声，仅用于非 stream 模式；stream 模式按事件白名单判定，不依赖本表。
 *
 * `fetch config failed` 与缩进堆栈行保留；`[launch error]` 归入 `LOG_KEEP`；被过滤行由调用方计数挂到同一次输出。
 */
const LOG_NOISE: readonly RegExp[] = [
  /^\[CliMemWatch\]/,
  /^\[WB-Policy\]/,
  /^serve \d+$/,
  /^\[launch\]/,
  /^\[silent\]/,
];

/** 无论 stream 与否都要保留的启动错误。 */
const LOG_KEEP: readonly RegExp[] = [/^\[launch error/, /^fetch config failed\b/];

/** 依次匹配，命中即判为噪声；仅用于非 stream 模式。 */
export function isLogNoise(line: string): boolean {
  return LOG_NOISE.some((re) => re.test(line));
}

/** 判定整条事件是否只含思考片段；带正文或工具调用的事件不属于此类。判定层读取日志尾部前需剥离此类行。 */
export function isThinkingOnlyLine(line: string): boolean {
  const s = String(line ?? "").trim();
  if (!s) return false;
  if (s.startsWith("[thinking]")) return true;
  if (!s.startsWith("{")) return false;
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(s) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (!ev || typeof ev !== "object") return false;
  if (String(ev.type ?? "") !== "assistant") return false;
  const msg = ev.message as Record<string, unknown> | undefined;
  const content = msg?.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  const kinds = content.map((c) => String((c as Record<string, unknown>)?.type ?? ""));
  return kinds.every((k) => k === "thinking" || k === "redacted_thinking");
}

/** 逐行剥离纯思考行，保留原文与顺序，不重新序列化；返回被删行数。 */
export function withoutThinking(lines: readonly string[]): { lines: string[]; dropped: number } {
  const kept: string[] = [];
  let dropped = 0;
  for (const line of lines) {
    if (isThinkingOnlyLine(line)) {
      dropped += 1;
      continue;
    }
    kept.push(line);
  }
  return { lines: kept, dropped };
}

/**
 * 按字符预算从后往前累加整行，使预算内每行完整。
 *
 * @param maxChars 预算（字符），至少容纳一行。
 * @returns 拼好的文本；单行超出预算时保留其末尾并标明截断。
 */
export function tailWithinChars(lines: readonly string[], maxChars: number): string {
  const budget = Math.max(120, Math.floor(maxChars));
  const picked: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = String(lines[i] ?? "");
    /* 只判空行，缩进照原样保留，堆栈依赖缩进读取。 */
    if (!line.trim()) continue;
    if (used + line.length + 1 > budget) {
      /* 单行超出预算时保留其末尾；已收入其它行则不再追加。 */
      if (picked.length === 0) {
        const keep = Math.max(60, budget - 24);
        return `…（该行共 ${line.length} 字，只留末尾）\n${line.slice(-keep)}`;
      }
      break;
    }
    picked.push(line);
    used += line.length + 1;
  }
  return picked.reverse().join("\n");
}

/** 日志中出现任一可解析且带 `type` 的 JSON 对象即判为 stream-json 模式，不限定事件类型白名单。 */
function detectStream(lines: readonly string[]): boolean {
  let inspected = 0;
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      if (String(ev.type ?? "") !== "") return true;
    } catch {
      /* 坏行不影响判定 */
    }
    inspected += 1;
    if (inspected > 60) break;
  }
  return false;
}

/** 命令类工具名列表，摘要与动作判定共用；覆盖各宿主的不同命令入口。 */
const SHELL_TOOL = /^(bash|shell|powershell|pwsh|terminal|cmd|exec|execute|run_command|run_shell_command)\b/;

/** 判定命令类工具，大小写不敏感。 */
export function isShellTool(toolName: string): boolean {
  return SHELL_TOOL.test(String(toolName ?? "").trim().toLowerCase());
}

/** 纯等待命令，不代表本次调用意图。 */
const WAIT_CMD = /^(sleep|wait)\b/;

/** 目录切换、变量准备与输出段，取命令意图时跳过。 */
const IDLE_CMD = new Set(["cd", "pushd", "popd", "echo", "export", "set", "unset", "true", ":"]);

/** 剥离 `timeout` 外壳；无法识别参数形态时原样返回。 */
function unwrapTimeout(seg: string): string {
  const m = /^timeout\s+(?:-{1,2}\S+\s+)*[0-9]+(?:\.[0-9]+)?[smhd]?\s+(.+)$/.exec(seg);
  return m && m[1] ? m[1].trim() : seg;
}

/**
 * 取 shell 命令的首段有效命令：跳过 `cd`、变量准备与等待段，并剥离 `timeout` 外壳。
 *
 * `waiting` 为真表示整条命令仅含等待或空闲段，调用方按“等待”显示。
 */
export function summarizeCommand(cmd: string): { intent: string; waiting: boolean } {
  const flat = String(cmd ?? "").split(/\r?\n/).join(" ").replace(/\s+/g, " ").trim();
  if (flat === "") return { intent: "", waiting: false };
  let waiting = false;
  for (const raw of flat.split(/&&|\|\||;|\|/)) {
    const seg = unwrapTimeout(raw.trim());
    if (seg === "") continue;
    const head = (seg.split(" ")[0] ?? "").replace(/^[("']+/, "").replace(/[)"']+$/, "");
    if (head === "") continue;
    if (IDLE_CMD.has(head)) continue;
    if (WAIT_CMD.test(seg)) {
      waiting = true;
      continue;
    }
    return { intent: seg, waiting: false };
  }
  return { intent: "", waiting };
}

/** 取工具入参的 `description` / `intent` / `purpose`，优先于命令原文作为摘要。 */
function inputDescription(o: Record<string, unknown>): string {
  for (const key of ["description", "intent", "purpose"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim().replace(/\s+/g, " ");
  }
  return "";
}

/** 按工具类型取关键字段生成摘要，只留文件名与命令首段；无法识别类型时回落为 JSON 截断。 */
export function toolArgBrief(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const o = input as Record<string, unknown>;
  /* 按工具类型给出读取 / 修改 / 执行 / 搜索等语义词，不拼接原始参数。 */
  const verb = ((): string => {
    const n = toolName.toLowerCase();
    if (n.startsWith("read")) return "读取";
    if (n.startsWith("write") || n.includes("edit")) return "修改";
    if (SHELL_TOOL.test(n)) return "执行";
    if (n.startsWith("grep") || n.startsWith("glob")) return "搜索";
    if (n.startsWith("web") || n.includes("fetch")) return "联网";
    if (n.startsWith("task") || n.includes("todo")) return "任务";
    if (n.startsWith("agent")) return "派子任务";
    return "";
  })();

  const file = o.file_path ?? o.path ?? o.notebook_path;
  if (typeof file === "string" && file !== "") {
    const parts = file.replace(/\\/g, "/").split("/");
    return `${verb || "打开"} ${parts.slice(-2).join("/")}`;
  }
  const cmd = o.command ?? o.cmd;
  if (typeof cmd === "string" && cmd !== "") {
    const flat = cmd.split(String.fromCharCode(10)).join(" ").replace(/[ ]+/g, " ").trim();
    /* 描述文字优先于命令原文。 */
    const described = inputDescription(o);
    if (described !== "") return clipText(described, 72);
    if (!SHELL_TOOL.test(toolName.toLowerCase())) return clipText(flat, 72);
    /* 命令含源码或文档路径时，摘要直接给出该路径。 */
    const fileHit = flat.match(/[A-Za-z0-9_./-]+\.(?:md|ts|tsx|js|mjs|cjs|json|html|css|yml|yaml|txt)/);
    const bare = flat.replace(/^cd\s+\S+\s*&&\s*/, "").replace(/^cd\s+\S+\s*;\s*/, "");
    if (fileHit && /^(sed|cat|head|tail|less|grep|rg|wc|nl|awk|diff)\b/.test(bare)) {
      const parts = fileHit[0].split("/");
      return `读取 ${parts.slice(-2).join("/")}`;
    }

    /* 取首段有效命令，跳过 cd、变量准备与等待段并剥离 timeout；整条仅等待时显示“等待”。 */
    const { intent, waiting } = summarizeCommand(flat);
    if (intent !== "") return `执行 ${clipText(intent, 32)}`;
    return waiting ? "等待" : "执行命令";
  }
  const pattern = o.pattern;
  if (typeof pattern === "string" && pattern !== "") return `搜索 ${clipText(pattern, 48)}`;
  const url = o.url;
  if (typeof url === "string" && url !== "") return `联网 ${clipText(url, 60)}`;
  const query = o.query;
  if (typeof query === "string" && query !== "") return `检索 ${clipText(query, 48)}`;
  return verb || clipText(JSON.stringify(input), 60);
}

/** 截断长文本并标明截断。 */
/** 仅命令类与外部类工具映射为动作；本地读写工具返回 null，界面按无法判定处理。 */
function toolAction(name: string, input: unknown): WorkerAction | null {
  const n = String(name || "").trim();
  const low = n.toLowerCase();
  if (!low) return null;
  const cmd = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>).command ?? (input as Record<string, unknown>).cmd
    : "";
  if (isShellTool(low)) {
    return { phase: "command", tool: n, command: typeof cmd === "string" ? cmd : "" };
  }
  if (low.startsWith("mcp__") || /^(web|fetch|search|browser|http|agent|task|skill)/.test(low)) {
    return { phase: "waiting", tool: n, command: "" };
  }
  return null;
}

/**
 * `assistant` / `user` 取 content 数组，`result` 取收尾文本，其余事件类型不进流。
 *
 * 同一事件中最后出现的语义片段决定动作；无语义片段时返回 `undefined`，调用方沿用上一条动作。
 */
function eventParts(ev: Record<string, unknown>): {
  text: string[];
  tools: string[];
  thinking: string[];
  action: WorkerAction | null | undefined;
} {
  const text: string[] = [];
  const tools: string[] = [];
  const thinking: string[] = [];
  const type = String(ev.type ?? "");
  let touched = false;
  let action: WorkerAction | null = null;
  const touch = (a: WorkerAction | null): void => {
    touched = true;
    action = a;
  };

  const contentParts = (content: unknown): void => {
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const part = item as Record<string, unknown>;
      if (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
        text.push(part.text.trim());
        touch({ phase: "reply", tool: "", command: "" });
      } else if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim() !== "") {
        /* 思考过程单独成一路，不混入正文；思考不表示动作进行中，按无法判定处理。 */
        thinking.push(part.thinking.trim());
        touch(null);
      } else if (part.type === "tool_use") {
        const name = String(part.name ?? "tool");
        /* 摘要已含语义词，不再前置工具名。 */
        const brief = toolArgBrief(name, part.input);
        tools.push(`▸ ${brief || name}`);
        touch(toolAction(name, part.input));
      } else if (part.type === "tool_result") {
        /* 工具结果已返回，当前无动作进行中。 */
        touch(null);
      }
    }
  };

  if (type === "assistant" || type === "user") {
    const message = (ev.message && typeof ev.message === "object" ? ev.message : {}) as Record<string, unknown>;
    contentParts(message.content);
    return { text, tools, thinking, action: touched ? action : undefined };
  }
  if (type === "result") {
    /* `result` 行表示本回合收尾，当前无动作进行中。 */
    const out = typeof ev.result === "string" ? ev.result.trim() : "";
    if (out !== "") text.push(out);
    return { text, tools, thinking, action: null };
  }
  return { text, tools, thinking, action: undefined };
}

/**
 * `stream` 可显式传入：增量推流在开头判定一次，后续分片沿用同一模式，避免无事件分片被误判为纯文本。
 *
 * 过滤仅作用于展示层，日志原文保留；隐藏行数返回调用方挂到同一次输出。
 */
export function parseWorkerLog(
  rawLines: readonly string[],
  opts: { stream?: boolean } = {},
): WorkerLogParts {
  const stream = opts.stream ?? detectStream(rawLines);
  const text: string[] = [];
  const tools: string[] = [];
  const thinking: string[] = [];
  const debug: string[] = [];
  let hidden = 0;
  let lastAction: WorkerAction | null | undefined;

  /** 计数被过滤行；宿主运维噪声不保留原文，其余调试行保留供折叠展开。原文仍留在 .log 文件。 */
  const hide = (line: string): void => {
    hidden += 1;
    if (!isLogNoise(line)) debug.push(line);
  };

  for (const raw of rawLines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;

    if (LOG_KEEP.some((re) => re.test(line))) {
      text.push(line);
      continue;
    }

    if (stream) {
      if (!line.startsWith("{")) {
        /* stream 模式下非事件行按宿主诊断计数后过滤。 */
        hide(line);
        continue;
      }
      let ev: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ev = parsed as Record<string, unknown>;
      } catch {
        /* 半截事件残片按调试输出过滤。 */
      }
      if (!ev) {
        hide(line);
        continue;
      }
      const parts = eventParts(ev);
      text.push(...parts.text);
      tools.push(...parts.tools);
      thinking.push(...parts.thinking);
      /* 仅本事件带语义片段时更新动作，宿主诊断与未知事件不覆盖已有动作。 */
      if (parts.action !== undefined) lastAction = parts.action;
      continue;
    }

    if (isLogNoise(line)) {
      hide(line);
      continue;
    }
    /* 非 stream 模式下同样过滤可解析且带 `type` 的 JSON 事件行：推流路径开头可能误判模式并缓存，使事件行被当作正文。 */
    if (line.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && String((parsed as Record<string, unknown>).type ?? "") !== "") {
          hide(line);
          continue;
        }
      } catch {
        /* 不是完整 JSON：按普通文本行处理 */
      }
    }
    const m = /^\[thinking\]\s?(.*)$/.exec(line);
    if (m) {
      if ((m[1] ?? "").trim() !== "") thinking.push((m[1] ?? "").trim());
      continue;
    }
    text.push(line);
  }

  return {
    text,
    tools,
    thinking,
    hidden,
    debug,
    stream,
    ...(lastAction !== undefined ? { lastAction } : {}),
  };
}
