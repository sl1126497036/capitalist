
const test = require("node:test");
const assert = require("node:assert");
const { existsSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { readNextModel } = require(join(PKG, "dist/supervisor/loop.js"));
const board = require(join(PKG, "dist/supervisor/board"));
const { createTaskRoot } = require(join(PKG, "dist/core/policy/init.js"));

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-next-model-"));
  createTaskRoot({ target: "派单模型", policySpec: "generic", root, supervisor: false });
  return root;
}

test("readNextModel 只读不删：派单消费后设定仍在", () => {
  const root = sandbox();
  writeFileSync(
    join(root, ".capitalist", "model", "next.json"),
    JSON.stringify({ model: "deepseek-v4.1-flash", at: new Date().toISOString(), by: "user" }),
  );

  assert.equal(readNextModel(root), "deepseek-v4.1-flash");
  assert.ok(existsSync(join(root, ".capitalist", "model", "next.json")), "读一次不能把设定删掉");
  assert.equal(readNextModel(root), "deepseek-v4.1-flash", "再读一次仍要拿得到");
  assert.ok(existsSync(join(root, ".capitalist", "model", "next.json")), "读两次也不能删");
});

test("无设定或文件损坏时均返回空串，不报错", () => {
  const root = sandbox();
  assert.equal(readNextModel(root), "");
  writeFileSync(join(root, ".capitalist", "model", "next.json"), "{ 不是 json");
  assert.equal(readNextModel(root), "");
});

test("/api/supervisor 载荷带 next_model：刷新后按钮能回填", () => {
  const root = sandbox();
  const view = board.buildSupervisorStatus(root);
  assert.equal(view.next_model, "", "没有设定时为空串（按钮回到“派单模型”）");

  writeFileSync(
    join(root, ".capitalist", "model", "next.json"),
    JSON.stringify({ model: "glm-5.3-flash", at: new Date().toISOString(), by: "user" }),
  );
  assert.equal(board.buildSupervisorStatus(root).next_model, "glm-5.3-flash");
});
