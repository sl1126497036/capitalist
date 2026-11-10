/** 附件路径的解析与拼装（唯一口径）。 */

import { copyFileSync, existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";

/** 独占一行的附件标记。行首方括号里是 `附件` 或 `图N`，后面是路径，路径里不含空白。 */
const ATT_LINE = /^\s*\[(?:附件|图\s*\d*)\][\s\u3000]*([^\s\u3000（(]+)/;

/** 行内出现的附件标记（派单正文会写成「这句话 [附件] x.png」，不在行首）。 */
const ATT_INLINE = /\[附件\][\s\u3000]*([^\s<>"')（(]+)/g;

/** 一张图算附件：路径要像文件，避免把「[附件] 已收到」这类话当成路径。 */
function looksLikePath(p: string): boolean {
  return /[\\/]/.test(p) && /\.[A-Za-z0-9]{2,5}$/.test(p);
}

/**
 * 一段话里提到的所有附件路径（去重，保留出现顺序）。
 *
 * 行首形式与行内形式都认；不像路径的（没有目录分隔符 / 没有扩展名）直接丢，
 * 避免把正文里随手写的「[附件] 见上」解析为文件名并写入工作进程提示词。
 */
export function attachmentsIn(text: string): string[] {
  const src = String(text ?? "");
  const out: string[] = [];
  const push = (raw: string): void => {
    const p = String(raw ?? "").trim();
    if (!p || !looksLikePath(p)) return;
    if (!out.includes(p)) out.push(p);
  };
  for (const line of src.split(/\r?\n/)) {
    const m = ATT_LINE.exec(line);
    if (m) {
      push(String(m[1] ?? ""));
      continue;
    }
    if (!line.includes("[附件]")) continue;
    for (const hit of line.matchAll(ATT_INLINE)) push(String(hit[1] ?? ""));
  }
  return out;
}

/** 把附件改成「消息 id + 序号」命名：`20261105111902-r2k92p.png` → `<msgId>-1.png`。 */
export function adoptAttachmentsForMessage(root: string, paths: readonly string[], msgId: string): string[] {
  const id = String(msgId ?? "").trim();
  if (!id) return [...paths];
  return paths.map((raw, i) => {
    const p = String(raw ?? "").trim();
    if (!p) return p;
    const ext = extname(p) || ".png";
    const dest = join(dirname(p), `${id}-${i + 1}${ext}`);
    try {
      if (p === dest) return dest;
      if (!existsSync(p)) return p;
      copyFileSync(p, dest);
      return dest;
    } catch {
      return p;
    }
  });
}

/**
 * 给用户消息里的附件行编号：`[附件] x.png` → `[图1] x.png`。
 *
 * 只在用户发言落账那一刻调用一次。从那以后，这条消息在监工上下文、派单正文、
 * worker 提示里都是同一套编号，谁都不再自己排一次，排号这个动作只发生一次，
 * 就不会出现「监工以为是特征 A、worker 以为是图 B」。
 *
 * 已经编号的不再动（只匹配 `[附件]`），重复调用也不会变。
 */
export function numberAttachmentLines(text: string): string {
  let i = 0;
  return String(text ?? "").replace(
    /^[ \t\u3000]*\[附件\][\s\u3000]*([^\s\u3000（(]+)(.*)$/gm,
    (_all, path: string, rest: string) => {
      i += 1;
      return `[图${i}] ${path}${rest ?? ""}`;
    },
  );
}

/** 把附件行从正文里摘掉，剩下的才是给人读的话。 */export function stripAttachments(text: string): string {
  const kept: string[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (ATT_LINE.test(line)) continue;
    if (!line.includes("[附件]")) {
      kept.push(line);
      continue;
    }
    const rest = line
      .replace(ATT_INLINE, "")
      .replace(/[ \t\u3000]{2,}/g, " ")
      .trim();
    if (rest) kept.push(rest);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 在话术末尾补上附件行，已有的不重复加。
 *
 * 一行一张：拼接方（spliceDirectives / 重派继承）都要求「一行一个路径」，
 * 压成一行会让第三张图之后的路径全挤在同一个字符串里，worker 按行读就只能读到第一张。
 *
 * @param text  原有话术
 * @param paths 需包含在其中的附件路径
 * @returns 补齐后的话术；一条都没补时原样返回（调用方据此判断「有没有变化」）
 */
export function withAttachmentLines(text: string, paths: string[]): string {
  const src = String(text ?? "");
  const have = attachmentsIn(src);
  const miss = paths.filter((p) => String(p ?? "").trim() !== "" && !have.includes(p));
  if (miss.length === 0) return src;
  const block = miss.map((p) => `[附件] ${p}`).join("\n");
  return src.trim() ? `${src.replace(/\s+$/, "")}\n\n${block}` : block;
}


/** 按「这一单的图」重建话术里的附件行。 */
export function bindAttachments(text: string, own: string[]): { text: string; kept: string[] } {
  const src = String(text ?? "");
  const kept = [...new Set(own.map((p) => String(p ?? "").trim()).filter(Boolean))];
  const seen: string[] = [];
  const out: string[] = [];
  for (const line of src.split(/\r?\n/)) {
    /*
     * 第 3 组连前导空白一起捕获：`path（现状）` 与 `path （现状）` 是两种写法，
     * 重建时原样还回去，不要替使用者调整空格（中文括号前多一个空格，读起来就是错的）。
     */
    const m = /^\s*\[((?:附件|图\s*\d*))\][\s\u3000]*([^\s\u3000（(]+)(\s*.*)$/.exec(line);
    if (!m) {
      /* 行内形式（「这句话 [附件] x.png」）：摘掉标记、留下文字，图按 kept 重新归位。 */
      if (line.includes("[附件]")) {
        const rest = stripAttachments(line);
        if (rest) out.push(rest);
      } else {
        out.push(line);
      }
      continue;
    }
    const prefix = String(m[1] ?? "附件").trim();
    const p = String(m[2] ?? "").trim();
    if (!kept.includes(p)) continue;
    if (seen.includes(p)) continue;
    seen.push(p);
    const rest = String(m[3] ?? "");
    out.push(`[${prefix}] ${p}${rest}`.trimEnd());
  }
  const miss = kept.filter((p) => !seen.includes(p));
  let body = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (miss.length) {
    const block = miss.map((p) => `[附件] ${p}`).join("\n");
    body = body ? `${body}\n\n${block}` : block;
  }
  return { text: body, kept };
}

/**
 * 解析话术里的附件行，原样保留。
 *
 * 过去这里还会把超出的部分裁掉并补一句「另有 N 张未带入」。上限取消后（见文件里
 * 「附件张数不设上限」那段），裁剪分支恒不触发，函数退化成「解析」，保留名字与返回
 * 形状，避免调用方跟着改；语义已变更：不丢弃任何附件。
 */
export function trimAttachmentLines(text: string): { text: string; kept: string[]; dropped: number } {
  const src = String(text ?? "");
  return { text: src, kept: attachmentsIn(src), dropped: 0 };
}
