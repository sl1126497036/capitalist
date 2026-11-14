/**
 * 登录态不可用的识别与结单。
 *
 * 覆盖 worker 日志识别、give_up 落盘且不进入重试裁决、额度文案仍走原有重试路径。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const loop = require(join(PKG, "dist/supervisor/loop.js"));
const { AUTH_REQUIRED_TEXT, QUOTA_EXHAUSTED_TEXT, looksLikeAuth } = require(
  join(PKG, "dist/supervisor/channel/llm.js"),
);

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-authblocked-"));
  mkdirSync(join(root, ".capitalist", "inbox"), { recursive: true });
  mkdirSync(join(root, ".capitalist", "workers"), { recursive: true });
  return root;
}

function seedDispatch(root, row) {
  writeFileSync(
    join(root, ".capitalist", "inbox", "dispatch.jsonl"),
    `${JSON.stringify({ status: "claimed", stage: "S0", ...row })}\n`,
  );
}

function readDispatch(root) {
  const text = readFileSync(join(root, ".capitalist", "inbox", "dispatch.jsonl"), "utf8").trim();
  return JSON.parse(text.split("\n")[0]);
}

test("登录态文案命中识别，额度文案不误判", () => {
  assert.equal(looksLikeAuth("Authentication required. Please use /login command"), true);
  assert.equal(looksLikeAuth("未登录"), true);
  assert.equal(looksLikeAuth("额度已耗尽"), false, "额度与登录态分开识别");
});

test("worker 日志含登录态文案时给出结论，不含时仍按退出码描述", () => {
  const root = scratch();
  writeFileSync(
    join(root, ".capitalist", "workers", "1.log"),
    [
      "[launch] host=codebuddy dispatch=D-1",
      '{"type":"assistant","message":{"content":[{"text":"Authentication required. Please use /login command to sign in to your account"}]}}',
      '{"type":"result","subtype":"error_during_execution","is_error":true}',
    ].join("\n"),
  );
  assert.equal(loop.__testing.workerExitReason(root, "1", 0), AUTH_REQUIRED_TEXT);

  writeFileSync(join(root, ".capitalist", "workers", "2.log"), "[launch] host=codebuddy\n正常结束");
  assert.equal(loop.__testing.workerExitReason(root, "2", 0), "worker 进程退出（code 0）");
});

test("登录态不可用写 give_up，不写 pending 重试", () => {
  const root = scratch();
  seedDispatch(root, { id: "D-1", shard: "" });

  const lines = [];
  const ok = loop.__testing.failDispatchAndJudge(root, readDispatch(root), AUTH_REQUIRED_TEXT, (s) =>
    lines.push(s),
  );

  assert.equal(ok, true);
  const after = readDispatch(root);
  assert.equal(after.status, "failed");
  assert.equal(after.retry_verdict, "give_up", "登录态不可用不进重试裁决");
  assert.equal(after.retry_why, AUTH_REQUIRED_TEXT);
  assert.ok(
    lines.some((s) => s.includes("不重派")),
    `输出应说明不重派：${lines.join(" / ")}`,
  );

  /* 未进入重试裁决的表现：没有产生 pending，也没有裁决请求落盘。 */
  const files = readdirSync(join(root, ".capitalist")).join(",");
  assert.ok(!files.includes("verdict"), `不应产生裁决文件：${files}`);
});

test("额度耗尽仍走原有重试路径，不被登录态分支截走", () => {
  const root = scratch();
  seedDispatch(root, { id: "D-2", shard: "" });

  loop.__testing.failDispatchAndJudge(root, readDispatch(root), QUOTA_EXHAUSTED_TEXT, () => {});

  const after = readDispatch(root);
  assert.equal(after.status, "failed");
  assert.equal(after.retry_verdict, "pending", "额度文案交裁决层处理");
});
