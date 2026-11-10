
const test = require("node:test");
const assert = require("node:assert");

const { bindAttachments } = require("../dist/core/attachments");

const A = ".capitalist/attachments/M-1-1.png";
const B = ".capitalist/attachments/M-1-2.png";
const OLD = ".capitalist/attachments/2026-11-03-old.png";

test("附件行原地保留：位置与角色标注都不动", () => {
  const text = [
    "1. 首屏：改成骨架屏",
    `[图1] ${A}（现状：白屏两秒）`,
    "2. 列宽：按内容自适应",
    `[图2] ${B}（参照：那张表）`,
  ].join("\n");
  const r = bindAttachments(text, [A, B]);
  const lines = r.text.split("\n");
  assert.equal(lines[1], `[图1] ${A}（现状：白屏两秒）`, "角色标注必须跟着行走");
  assert.equal(lines[3], `[图2] ${B}（参照：那张表）`);
  assert.ok(lines[0].startsWith("1. 首屏"), "图还在第一段后面，没有被挪到末尾");
  assert.equal(r.kept.length, 2);
});

test("不属于本单的附件行整行删掉，不补「丢弃了哪些」", () => {
  const text = ["正文一段", `[附件] ${A}（现状）`, `[附件] ${OLD}（上一单的图）`].join("\n");
  const r = bindAttachments(text, [A]);
  assert.ok(!r.text.includes(OLD), "别的单的图不能跟着走");
  assert.ok(r.text.includes(A));
  assert.ok(!r.text.includes("丢弃"), "没选中的从源头就不进这一单，不生成提示");
});

test("正文漏写、但这一单确实有的图：补到末尾兜底", () => {
  const r = bindAttachments("正文一段", [A]);
  assert.equal(r.text, `正文一段\n\n[附件] ${A}`);
});

test("同一张图重复列只留第一处", () => {
  const text = [`[附件] ${A}（现状）`, "中间的话", `[附件] ${A}（又写了一遍）`].join("\n");
  const r = bindAttachments(text, [A]);
  const hits = r.text.split("\n").filter((l) => l.includes(A));
  assert.equal(hits.length, 1);
});

test("行内附件标记：摘掉标记留文字，图按本单归位", () => {
  const r = bindAttachments(`这句话里带了 [附件] ${A} 一个路径`, [A]);
  assert.ok(!r.text.includes("这句话里带了 [附件]"), "行内标记不能原样留在正文里");
  assert.ok(r.text.includes("这句话里带了"));
  assert.ok(r.text.trim().endsWith(`[附件] ${A}`));
});

test("空附件清单：附件行全删，文字留着", () => {
  const r = bindAttachments(["正文一段", `[附件] ${A}（现状）`].join("\n"), []);
  assert.equal(r.text, "正文一段");
  assert.deepEqual(r.kept, []);
});
