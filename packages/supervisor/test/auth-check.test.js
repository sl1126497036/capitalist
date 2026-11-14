
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const { createTaskRoot } = require("../dist/core/contract/init");

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-auth-"));
  createTaskRoot({ target: "登录态检查测试", contractSpec: "minimal", root: base });
  return base;
}

function runAuth(args, env = {}) {
  const r = spawnSync(process.execPath, [join(__dirname, "..", "dist", "cli", "main.js"), "auth-check", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

test("登录态检查：不探测时只报未判定，不输出任何凭据文件信息", () => {
  const root = sandbox();
  const r = runAuth(["--agent", "codebuddy", "--no-probe", "--json", "--root", root]);
  const data = JSON.parse(r.out);

  assert.equal(data.host, "codebuddy", "显式声明的宿主优先");
  assert.equal(data.probe, "skipped", "给了 --no-probe 就不该发起探测");
  assert.equal(data.ok, false, "未探测时不能判定为可用");
  assert.equal(data.credential, undefined, "不输出凭据文件路径");
  assert.equal(r.code, 1, "未判定时退出码为 1");
});

test("登录态检查：任何宿主都不输出凭据文件信息", () => {
  const root = sandbox();
  const r = runAuth(["--agent", "claude-code", "--no-probe", "--json", "--root", root]);
  const data = JSON.parse(r.out);

  assert.equal(data.host, "claude-code");
  assert.equal(data.credential, undefined, "不输出凭据文件路径");
  assert.ok(String(data.verdict).includes("未判定"), "结论要说明没有判定");
});

test("登录态检查：缺宿主时给出可操作的提示", () => {
  const empty = mkdtempSync(join(tmpdir(), "capitalist-auth-empty-"));
  /*
   * 清空 PATH 以模拟“本机未安装宿主 CLI”。不清空时，开发机上装了 codebuddy，探测会真实
   * 调用模型并成功，测试结论随机器而变。
   */
  const r = runAuth(["--root", empty], { PATH: "" });
  assert.equal(r.code, 1);
  assert.ok(r.out.includes("--agent"), `提示里要写清如何指定宿主：${r.out}`);
});
