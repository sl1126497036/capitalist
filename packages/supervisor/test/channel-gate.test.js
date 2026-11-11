/**
 * 通道闸与安装选择。
 *
 * 覆盖两处行为：登录态不可用时禁止推进，以及 install 在未指定宿主时不写入任何配置。
 * 这两条都是“用户环境才算数”的部分，因此按 CLI 与文件层验证，不依赖本机是否装了宿主。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const { channelFile, markChannelDown, markChannelUp, readChannelDown } = require("../dist/core/channel");

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-channel-"));
  mkdirSync(join(root, ".capitalist"), { recursive: true });
  return root;
}

function runCli(args, env = {}) {
  const r = spawnSync(process.execPath, [join(__dirname, "..", "dist", "cli", "main.js"), ...args], {
    encoding: "utf8",
    input: "",
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

test("通道不可用：写入后读到同一原因", () => {
  const root = sandbox();
  markChannelDown(root, "登录态不可用");
  const down = readChannelDown(root);
  assert.ok(down, "刚写入的记录应当可读");
  assert.equal(down.reason, "登录态不可用");
});

test("通道不可用：恢复后记录消失", () => {
  const root = sandbox();
  markChannelDown(root, "登录态不可用");
  markChannelUp(root);
  assert.equal(readChannelDown(root), null);
  assert.equal(existsSync(channelFile(root)), false, "恢复后不保留状态文件");
});

test("通道不可用：超过有效期按可用处理", () => {
  const root = sandbox();
  const stale = new Date(Date.now() - 6 * 60_000).toISOString();
  writeFileSync(channelFile(root), JSON.stringify({ ok: false, reason: "登录态不可用", at: stale }), "utf8");
  assert.equal(readChannelDown(root), null, "过期记录不应继续挡住恢复后的派单");
});

test("通道不可用：状态文件损坏时不阻断", () => {
  const root = sandbox();
  writeFileSync(channelFile(root), "{ not json", "utf8");
  assert.equal(readChannelDown(root), null);
});

test("install：未指定宿主时不写入，退出码非零", () => {
  const root = sandbox();
  /* 先用一条已知记录占位，再确认 install 没有改动任务根内的任何文件。 */
  markChannelDown(root, "占位");
  const before = readFileSync(channelFile(root), "utf8");
  const r = runCli(["install", "--dry-run", "--root", root]);
  assert.equal(r.code, 1, `未指定宿主应当失败：${r.out}`);
  assert.ok(r.out.includes("未指定宿主"), `提示要说明如何指定：${r.out}`);
  assert.equal(readFileSync(channelFile(root), "utf8"), before);
});

test("auth：命令已移除，不再读写令牌文件", () => {
  const home = mkdtempSync(join(tmpdir(), "capitalist-auth-home-"));
  const r = runCli(["auth", "status"], { HOME: home });
  assert.equal(r.code, 0, `说明性输出即返回 0：${r.out}`);
  assert.ok(r.out.includes("已移除"), `要直接说明现状：${r.out}`);
});
