/**
 * 令牌只留在内存，不落盘。
 *
 * 三条断言锁定这一点：`auth` 命令不再提供磁盘入口；令牌模块不引用任何落盘实现；
 * 落盘实现文件本身已从产物中消失。
 */

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const CLI = join(__dirname, "..", "dist", "cli", "main.js");

function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

test("auth：已移除，不再提供磁盘令牌入口", () => {
  const r = runCli(["auth"]);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes("已移除"), `要直接说明现状：${r.out}`);
  assert.ok(!r.out.includes("host-token.json"), `不得再出现令牌文件位置：${r.out}`);
});

test("令牌模块：不引用落盘实现", () => {
  const src = readFileSync(join(__dirname, "..", "dist", "supervisor", "officialToken.js"), "utf8");
  assert.ok(!src.includes("hostToken.js"), "令牌模块不得引用落盘的令牌文件模块");
});

test("落盘实现已删除", () => {
  assert.equal(existsSync(join(__dirname, "..", "dist", "core", "hostToken.js")), false);
});

test("令牌只由插件自己读取：不提供外部传入通道", () => {
  const src = readFileSync(join(__dirname, "..", "dist", "cli", "main.js"), "utf8");
  assert.ok(!src.includes("token-stdin"), "不得保留从外部接收令牌的参数");
});

test("令牌模块：不提供导出入口", () => {
  const src = readFileSync(join(__dirname, "..", "dist", "supervisor", "officialToken.js"), "utf8");
  assert.ok(!src.includes("auth export"), "不得保留导出令牌的命令");
});
