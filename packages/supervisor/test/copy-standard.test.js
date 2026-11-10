
process.env.CAPITALIST_USAGE_BALANCE = "0";

const test = require("node:test");
const assert = require("node:assert");
const { mkdirSync, mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { __testing } = require(join(PKG, "dist/supervisor/loop.js"));
const { withCopyStandard } = __testing;
const memory = require(join(PKG, "dist/supervisor/memory.js"));

/* 措辞样本：真实使用时由人在看板/记忆里写入这一条，内容可改，代码不内置。 */
const NOTE =
  "【文案规范】本单涉及用户可见文案时用陈述语气：写明对象与结果，不用第二人称、口语化说法与拟人表达。";

function newRoot() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-copy-std-"));
  mkdirSync(join(root, ".capitalist"), { recursive: true });
  return root;
}

test("记忆里配置后，涉及用户可见文案的单子带上文案规范块", () => {
  const root = newRoot();
  assert.ok(memory.addMemory(root, NOTE, "habit"), "配置写入记忆");
  const action = "改看板顶部标题文案，去掉拟人说法";
  const out = withCopyStandard(root, action);
  assert.ok(out.startsWith(action));
  assert.ok(out.endsWith(NOTE), "追加的措辞来自记忆条目");
});

test("记忆里没有配置就不带（代码不再内置固定文案）", () => {
  const root = newRoot();
  const action = "改看板顶部标题文案，去掉拟人说法";
  const out = withCopyStandard(root, action);
  assert.equal(out, action);
  assert.ok(!out.includes("文案规范"));
});

test("删除记忆条目 = 关开关：之后不再带", () => {
  const root = newRoot();
  const added = memory.addMemory(root, NOTE, "habit");
  assert.ok(added);
  assert.ok(withCopyStandard(root, "调整界面提示语").endsWith(NOTE));
  assert.equal(memory.deleteMemory(root, added.id), true);
  assert.equal(withCopyStandard(root, "调整界面提示语"), "调整界面提示语");
});

test("按需判据保留：记忆有配置，纯逻辑单子仍不带", () => {
  const root = newRoot();
  memory.addMemory(root, NOTE, "habit");
  const out = withCopyStandard(root, "修接口层超时重试：失败后按指数退避重试三次");
  assert.equal(out, "修接口层超时重试：失败后按指数退避重试三次");
  assert.ok(!out.includes("文案规范"));
});

test("重复组单不叠加", () => {
  const root = newRoot();
  memory.addMemory(root, NOTE, "habit");
  const once = withCopyStandard(root, "调整界面文字排版");
  const twice = withCopyStandard(root, once);
  assert.equal(twice.split(NOTE).length - 1, 1);
});

test("文案规范条目不进通用记忆注入，避免与按需追加重复", () => {
  const root = newRoot();
  memory.addMemory(root, NOTE, "habit");
  const action = "改看板顶部标题文案，去掉拟人说法";
  const lessons = memory.withLessons(root, action);
  assert.ok(!lessons.includes("文案规范"), "通用记忆注入不带文案规范（追加只走 withCopyStandard）");
  assert.equal(memory.renderMemoryConstraints(memory.loadMemories(root)), "", "通用注入跳过文案规范条目");
});
