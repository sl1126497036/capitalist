/**
 * 受控 Markdown 子集：只解析看板消息里真正需要的块级与行内语法，其余按字面显示。
 *
 * 为什么不用通用解析器：
 *
 * 1. 消息正文里混有日志、路径、JSON 等非 Markdown 文本，通用解析器的缩进代码块、
 *    `_` 斜体、表格、原始 HTML 规则会改变其原样。
 * 2. 任务编号写作 `#12`，与标题的 `#` 同字符。标题要求 `#` 后有空格，
 *    `#12`、`#07` 因此不匹配，无需转义。
 * 3. 单号（`D-…`、`W-…`）与技能路径保留原文，由渲染层生成点击态；行内解析只处理 Markdown 语法。
 *
 * 刻意不支持：缩进代码块、`_斜体_`、表格、原始 HTML、任务列表、脚注、自动链接、脚注引用。
 * 需要代码块时写三个反引号的围栏。
 */

/** 围栏：三个以上反引号或波浪号，可带语言标记。 */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+.#-]*)\s*$/;
/** 分隔线：同一符号三个以上。 */
const HR_RE = /^\s{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/** 标题：`#` 与正文之间必须有空格，`#12` 不匹配。 */
const HEAD_RE = /^\s{0,3}(#{1,6})[ \t]+(.*)$/;
/** 无序列表项。 */
const UL_RE = /^\s{0,3}[-*+][ \t]+(.*)$/;
/** 有序列表项。 */
const OL_RE = /^\s{0,3}(\d{1,9})[.)][ \t]+(.*)$/;
/** 引用块。 */
const QUOTE_RE = /^\s{0,3}>[ \t]?(.*)$/;

/** 反斜杠可转义的字符：只认 ASCII 标点。 */
const ESCAPABLE = /[!-/:-@[-`{-~]/;

/** 链接目标只接受这三种协议，其余按正文显示。 */
const SAFE_HREF = /^(?:https?:\/\/|mailto:)[^\s<>"']+$/i;

/** 成对标记内侧不留空白：`3 * 4` 不解析为斜体。 */
function spansText(inner) {
  return inner.length > 0 && !/^\s/.test(inner) && !/\s$/.test(inner);
}

/**
 * 行内解析：粗体、斜体、删除线、行内代码、链接、硬换行。
 *
 * 文本片段原样保留，交由渲染层再切单号与技能路径。
 */
export function parseInline(src) {
  const out = [];
  let buf = "";
  let i = 0;
  const s = String(src ?? "");

  const flush = () => {
    if (buf) {
      out.push({ t: "text", text: buf });
      buf = "";
    }
  };

  while (i < s.length) {
    const ch = s[i];

    /* 反斜杠转义：让 `\*` 显示星号本身。 */
    if (ch === "\\" && i + 1 < s.length && ESCAPABLE.test(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }

    /* 行内代码：内容原样保留，不解析内部语法。 */
    if (ch === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: "code", text: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    /* 链接：[文字](目标)。目标协议不在允许范围时整段按正文处理。 */
    if (ch === "[") {
      const m = /^\[([^\]\n]{1,200})\]\(([^()\s]{1,500})\)/.exec(s.slice(i));
      if (m && SAFE_HREF.test(m[2])) {
        flush();
        out.push({ t: "link", href: m[2], c: parseInline(m[1]) });
        i += m[0].length;
        continue;
      }
    }

    /* 粗体：**文字**。 */
    if (ch === "*" && s[i + 1] === "*") {
      const end = s.indexOf("**", i + 2);
      if (end > i + 2) {
        const inner = s.slice(i + 2, end);
        if (spansText(inner)) {
          flush();
          out.push({ t: "strong", c: parseInline(inner) });
          i = end + 2;
          continue;
        }
      }
    }

    /* 斜体：*文字*。只认星号，`_` 留给 snake_case 与路径。 */
    if (ch === "*") {
      const end = s.indexOf("*", i + 1);
      if (end > i + 1 && s[end + 1] !== "*") {
        const inner = s.slice(i + 1, end);
        if (spansText(inner)) {
          flush();
          out.push({ t: "em", c: parseInline(inner) });
          i = end + 1;
          continue;
        }
      }
    }

    /* 删除线：~~文字~~。 */
    if (ch === "~" && s[i + 1] === "~") {
      const end = s.indexOf("~~", i + 2);
      if (end > i + 2) {
        const inner = s.slice(i + 2, end);
        if (spansText(inner)) {
          flush();
          out.push({ t: "del", c: parseInline(inner) });
          i = end + 2;
          continue;
        }
      }
    }

    buf += ch;
    i += 1;
  }

  flush();
  return out;
}

/**
 * 只去掉行尾空白。
 *
 * 行首缩进承载日志层级，去掉后层级丢失；本解析器不支持缩进代码块，段落缩进原样保留。
 */
function rstrip(line) {
  return String(line ?? "").replace(/[ \t]+$/, "");
}

/** 多行合并为一条行内序列，行间插入换行标记。 */
function joinLines(lines) {
  const out = [];
  lines.forEach((line, idx) => {
    if (idx > 0) out.push({ t: "br" });
    out.push(...parseInline(line));
  });
  return out;
}

/**
 * 块级解析。
 *
 * @returns {Array<object>} 块序列：p / h / ul / ol / quote / code / hr。
 */
export function parseMarkdown(text) {
  const src = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  const blocks = [];

  let i = 0;
  /** 块级解析主循环：按行首标记分派到各块级分支。 */
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const mark = fence[1][0];
      const width = fence[1].length;
      const body = [];
      i += 1;
      while (i < lines.length) {
        const close = FENCE_RE.exec(lines[i]);
        /* 收尾围栏须同符号且长度不短于起始；未闭合时保留到正文结尾，流式输出中途不丢失整段。 */
        if (close && close[1][0] === mark && close[1].length >= width) {
          i += 1;
          break;
        }
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ t: "code", lang: fence[2] || "", text: body.join("\n") });
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ t: "hr" });
      i += 1;
      continue;
    }

    const head = HEAD_RE.exec(line);
    if (head) {
      blocks.push({ t: "h", level: head[1].length, inlines: parseInline(head[2]) });
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const body = [];
      while (i < lines.length) {
        const m = QUOTE_RE.exec(lines[i]);
        if (!m) break;
        body.push(m[1]);
        i += 1;
      }
      blocks.push({ t: "quote", inlines: joinLines(body) });
      continue;
    }

    const ul = UL_RE.exec(line);
    const ol = ul ? null : OL_RE.exec(line);
    if (ul || ol) {
      const ordered = Boolean(ol);
      const items = [];
      const start = ordered ? Number(ol[1]) : 1;
      while (i < lines.length) {
        const cur = lines[i];
        const m = ordered ? OL_RE.exec(cur) : UL_RE.exec(cur);
        if (m) {
          items.push({ lines: [ordered ? m[2] : m[1]] });
          i += 1;
          continue;
        }
        /* 续行：缩进两格以上并入上一项，排除空行与新的块级标记。 */
        if (
          items.length > 0 &&
          /^\s{2,}\S/.test(cur) &&
          !HR_RE.test(cur) &&
          !FENCE_RE.test(cur) &&
          !HEAD_RE.test(cur) &&
          !QUOTE_RE.test(cur)
        ) {
          items[items.length - 1].lines.push(cur.trim());
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({
        t: ordered ? "ol" : "ul",
        start,
        items: items.map((it) => ({ inlines: joinLines(it.lines) })),
      });
      continue;
    }

    /* 段落：连续普通行；遇到空行或新的块级标记结束。 */
    const para = [rstrip(line)];
    i += 1;
    while (i < lines.length) {
      const cur = lines[i];
      if (
        /^\s*$/.test(cur) ||
        FENCE_RE.test(cur) ||
        HR_RE.test(cur) ||
        HEAD_RE.test(cur) ||
        QUOTE_RE.test(cur) ||
        UL_RE.test(cur) ||
        OL_RE.test(cur)
      ) {
        break;
      }
      para.push(rstrip(cur));
      i += 1;
    }
    blocks.push({ t: "p", inlines: joinLines(para) });
  }

  return blocks;
}
