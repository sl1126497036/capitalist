/**
 * 命令行的切分与识别。
 *
 * 只回答一件事：这条 shell 命令里哪一段在调用本项目的 `justify`。判定紧邻越界拦截，
 * 但属于纯文本解析，与判定流程分开放。
 *
 * 识别宁严不宽：错认会让任意命令借 `justify` 字样绕过边界检查。
 */

import { join } from "node:path";

import { normLocal } from "./localGuard";

/**
 * 命令行入口名。`capitalist` 与 `cap` 是同一个 bin 的两个别名（见 package.json 的 `bin`）。
 */
const CLI_ENTRY = new Set(["capitalist", "capitalist.js", "capitalist.cjs", "cap", "cap.js", "cap.cjs"]);

/** 包管理器的临时执行前缀。`npx capitalist justify …` 与直接调用等价。 */
const RUNNER_ENTRY = new Set(["npx", "pnpx", "bunx"]);

/** `node` 一类解释器，其后第一个非开关参数是脚本路径。 */
const NODE_ENTRY = /^node(js)?(\.exe)?$/i;

/** 取路径最后一段，统一正斜杠并转小写。 */
function baseName(p: string): string {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return (i < 0 ? s : s.slice(i + 1)).toLowerCase();
}

/** 引号内的分隔符不参与切分。 */
function shellSegments(cmd: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote = "";
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i] as string;
    if (quote) {
      if (ch === "\\" && quote === '"') {
        buf += ch;
        const nx = cmd[i + 1];
        if (nx !== undefined) {
          buf += nx;
          i += 1;
        }
        continue;
      }
      if (ch === quote) quote = "";
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "&" || ch === "|") {
      out.push(buf);
      buf = "";
      const nx = cmd[i + 1];
      if ((ch === "&" || ch === "|") && nx === ch) i += 1;
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.filter((s) => s.trim() !== "");
}

/** 引号感知的分词：引号内的空白不切分，引号本身不进入结果。 */
function shellTokens(seg: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote = "";
  for (let i = 0; i < seg.length; i += 1) {
    const ch = seg[i] as string;
    if (quote) {
      if (ch === "\\" && quote === '"') {
        const nx = seg[i + 1];
        if (nx !== undefined) {
          buf += nx;
          i += 1;
        }
        continue;
      }
      if (ch === quote) {
        quote = "";
        continue;
      }
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf !== "") out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf !== "") out.push(buf);
  return out;
}

/**
 * 脚本路径是不是本项目的命令行入口。
 *
 * 认三种写法：直接是 bin 别名、路径里带 `cli` 的 `main.js`、与本 hook 同包的
 * `dist/cli/main.js` 绝对路径。第三种的判据是真实路径比对，避免把任意项目的
 * `main.js` 当成登记入口。
 */
function isProjectCli(script: string): boolean {
  const p = script.replace(/\\/g, "/");
  const base = baseName(p);
  if (CLI_ENTRY.has(base)) return true;
  if (!/^main\.(js|cjs|mjs)$/.test(base)) return false;
  if (/\/cli\//.test(p)) return true;
  const actual = normLocal(p, process.cwd());
  /* 本文件在 dist/core/guard 下，包入口在 dist/cli。 */
  const own = normLocal(join(__dirname, "..", "..", "cli", "main.js"));
  return actual !== "" && actual === own;
}

/** 单段命令是否在调用 `justify`。 */
function isJustifySegment(seg: string): boolean {
  const t = shellTokens(seg);
  let i = 0;
  while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i] as string)) i += 1;
  while (i < t.length && RUNNER_ENTRY.has(baseName(t[i] as string))) i += 1;

  const head = t[i];
  if (head === undefined) return false;

  let argAt = i + 1;
  if (NODE_ENTRY.test(baseName(head))) {
    let j = i + 1;
    while (j < t.length && (t[j] as string).startsWith("-")) {
      /* `-e` / `-p` 后面跟的是代码而不是脚本文件，这类调用不是登记动作。 */
      if (/^(--?e|--?p|--eval|--print)(=|$)/.test(t[j] as string)) return false;
      j += 1;
    }
    const script = t[j];
    if (script === undefined || !isProjectCli(script)) return false;
    argAt = j + 1;
  } else if (!CLI_ENTRY.has(baseName(head))) {
    return false;
  }

  return t[argAt] === "justify";
}

/**
 * 命令里是否有一次 `justify` 调用。
 *
 * 该命令免判本机边界：否则登记命令自身也要先通过边界检查，会出现无法解除的死锁，
 * 逐段识别：`rm -rf x && capitalist justify x "理由"` 只有第二段是登记动作。
 *
 * @param cmd shell 命令原文。
 */
export function isJustifyInvocation(cmd: string): boolean {
  return shellSegments(cmd).some(isJustifySegment);
}
