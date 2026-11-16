/**
 * 看板 Markdown 解析：覆盖与消息正文里非 Markdown 文本的边界。
 *
 * 这些用例对应通用解析器会破坏的具体形态：任务编号 `#12`、日志缩进、
 * 路径里的下划线、单号 `D-…`、未闭合的围栏。断言写在解析层，渲染层只做映射。
 */

const test = require("node:test");
const assert = require("node:assert");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const PKG = resolve(__dirname, "..");
const MOD = pathToFileURL(join(PKG, "web/src/lib/markdown.js")).href;

let md;
test.before(async () => {
  md = await import(MOD);
});

/** 取片段里的纯文字，忽略标记，便于整段比对。 */
function flat(tokens) {
  return (tokens || [])
    .map((t) => {
      if (t.t === "text") return t.text;
      if (t.t === "br") return "\n";
      if (t.t === "code") return `\`${t.text}\``;
      if (t.t === "link") return `[${flat(t.c)}](${t.href})`;
      return flat(t.c);
    })
    .join("");
}

test("任务编号 #12 与 #07 不变成标题", () => {
  const blocks = md.parseMarkdown("#12 修一下派单\n#07 也要看");
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].t, "p");
  assert.strictEqual(flat(blocks[0].inlines), "#12 修一下派单\n#07 也要看");
});

test("井号后带空格的才认标题，级别随井号数", () => {
  const blocks = md.parseMarkdown("## 卡点\n正文");
  assert.strictEqual(blocks[0].t, "h");
  assert.strictEqual(blocks[0].level, 2);
  assert.strictEqual(flat(blocks[0].inlines), "卡点");
});

test("缩进四格的日志仍是段落，不变成代码块", () => {
  const blocks = md.parseMarkdown("执行记录：\n    第一层\n        第二层");
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].t, "p");
  /* 缩进原样保留，日志层级靠它对齐。 */
  assert.strictEqual(flat(blocks[0].inlines), "执行记录：\n    第一层\n        第二层");
});

test("下划线不解析斜体：snake_case 与路径原样", () => {
  const blocks = md.parseMarkdown("调用 src/core/record/file_lock.ts 里的 pid_alive");
  const [p] = blocks;
  assert.strictEqual(p.t, "p");
  assert.strictEqual(p.inlines.length, 1);
  assert.strictEqual(p.inlines[0].t, "text");
  assert.strictEqual(flat(p.inlines), "调用 src/core/record/file_lock.ts 里的 pid_alive");
});

test("星号两侧是空白时不配对成斜体", () => {
  const blocks = md.parseMarkdown("3 * 4 * 5");
  assert.strictEqual(flat(blocks[0].inlines), "3 * 4 * 5");
});

test("加粗、斜体、删除线、行内代码按语法解析", () => {
  const blocks = md.parseMarkdown("**已完成** *待确认* ~~作废~~ `capitalist status`");
  const kinds = blocks[0].inlines.filter((t) => t.t !== "text").map((t) => t.t);
  assert.deepStrictEqual(kinds, ["strong", "em", "del", "code"]);
  assert.strictEqual(flat(blocks[0].inlines), "已完成 待确认 作废 `capitalist status`");
});

test("行内代码里的星号与井号原样保留", () => {
  const blocks = md.parseMarkdown("配置写 `*.json`，编号 `#12`");
  const code = blocks[0].inlines.filter((t) => t.t === "code").map((t) => t.text);
  assert.deepStrictEqual(code, ["*.json", "#12"]);
});

test("单号与技能路径留在文本片段里，交给渲染层切色块", () => {
  const blocks = md.parseMarkdown("看 **D-000123** 与 /Users/x/.workbuddy/skills/src-hunting/SKILL.md");
  const strong = blocks[0].inlines.find((t) => t.t === "strong");
  assert.strictEqual(flat(strong.c), "D-000123");
  assert.strictEqual(blocks[0].inlines.filter((t) => t.t === "code").length, 0);
});

test("列表按行首符号收集，续行并入上一项", () => {
  const blocks = md.parseMarkdown("- 第一条\n  补充说明\n- 第二条\n1. 有序\n2. 有序二");
  const ul = blocks[0];
  assert.strictEqual(ul.t, "ul");
  assert.strictEqual(ul.items.length, 2);
  assert.strictEqual(flat(ul.items[0].inlines), "第一条\n补充说明");
  const ol = blocks[1];
  assert.strictEqual(ol.t, "ol");
  assert.strictEqual(ol.start, 1);
  assert.strictEqual(ol.items.length, 2);
});

test("围栏代码块原样保留，未闭合时吃到结尾", () => {
  const closed = md.parseMarkdown("```bash\nls -la\n```\n尾巴");
  assert.strictEqual(closed[0].t, "code");
  assert.strictEqual(closed[0].lang, "bash");
  assert.strictEqual(closed[0].text, "ls -la");
  assert.strictEqual(flat(closed[1].inlines), "尾巴");

  const open = md.parseMarkdown("```\n**未闭合**");
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].t, "code");
  assert.strictEqual(open[0].text, "**未闭合**");
});

test("链接只认 http/https/mailto，其余按正文", () => {
  const ok = md.parseMarkdown("[日志](https://example.com/a)");
  assert.strictEqual(ok[0].inlines[0].t, "link");
  assert.strictEqual(ok[0].inlines[0].href, "https://example.com/a");

  const bad = md.parseMarkdown("[点我](javascript:alert(1))");
  assert.strictEqual(bad[0].inlines.filter((t) => t.t === "link").length, 0);
});

test("反斜杠可转义星号与井号", () => {
  const blocks = md.parseMarkdown("\\*不是斜体\\* 与 \\#12");
  assert.strictEqual(flat(blocks[0].inlines), "*不是斜体* 与 #12");
});

test("表格与管道符不解析，保持原文", () => {
  const blocks = md.parseMarkdown("| a | b |\n| - | - |");
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].t, "p");
  assert.strictEqual(flat(blocks[0].inlines), "| a | b |\n| - | - |");
});

test("行首井号加数字仍不认标题，井号后带空格才认", () => {
  const blocks = md.parseMarkdown("#7 单\n# 7 是标题");
  assert.strictEqual(blocks[0].t, "p");
  assert.strictEqual(blocks[1].t, "h");
  assert.strictEqual(blocks[1].level, 1);
});

test("空正文与纯空白不产生块", () => {
  assert.deepStrictEqual(md.parseMarkdown(""), []);
  assert.deepStrictEqual(md.parseMarkdown("  \n\n "), []);
});
