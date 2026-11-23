/**
 * 指令正文的分类标签。
 *
 * 派单侧靠它决定使用哪条工作进程会话，展示侧靠它把标签从正文里去掉。两边必须用同一份规则：
  * 各写一份判断会导致“派单正文干净、界面仍显示 [supervisor-copy]”。
 */

const test = require("node:test");
const assert = require("node:assert");

const { splitDirectiveTag } = require("../dist/core/dispatch/commands");
const { cmdReceiptText } = require("../dist/supervisor/board/render");

test("带标签的正文被拆成标签与正文", () => {
  assert.deepStrictEqual(splitDirectiveTag("[supervisor-copy] 检查文案"), {
    tag: "supervisor-copy",
    body: "检查文案",
  });
});

test("多行正文与方括号后无空格都能拆", () => {
  assert.deepStrictEqual(splitDirectiveTag("[fix-abc123]\n第一行\n第二行"), {
    tag: "fix-abc123",
    body: "第一行\n第二行",
  });
});

test("没有标签时原样返回，正文一个字不动", () => {
  const text = "  直接把这段改掉  ";
  assert.deepStrictEqual(splitDirectiveTag(text), { tag: "", body: text });
});

test("超长方括号不算标签（上限 24 字）", () => {
  const text = `[${"x".repeat(30)}] 正文`;
  assert.deepStrictEqual(splitDirectiveTag(text), { tag: "", body: text });
});

test("方括号跨行不算标签", () => {
  const text = "[第一行\n第二行] 正文";
  assert.deepStrictEqual(splitDirectiveTag(text), { tag: "", body: text });
});

test("指令回执不把标签当正文显示", () => {
  const out = cmdReceiptText({
    action: "dispatch",
    urgent: true,
    arg: "[supervisor-copy] 检查工作区中文",
    ok: true,
    detail: "",
    reason: "",
  });
  assert.ok(!out.includes("[supervisor-copy]"), `回执里不该出现标签：${out}`);
  assert.ok(out.includes("检查工作区中文"), "正文要留下");
  assert.ok(out.includes("插队派单"), "动作名照旧翻译");
});
