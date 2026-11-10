/**
 * 版本号的两处来源必须一致，`--version` 必须只输出版本号。
 *
 * 版本号在 `src/cli/help.ts` 与 `package.json` 各有一份，发版时只改一处就会漂移：
 * `npm view capitalist version` 与 `capitalist --version` 给出不同答案，使用者无从判断
 * 装的是哪一版。这类漂移不会被编译发现，也没有类型系统约束，只能在测试里比对。
 */

const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const CLI = join(PKG, "dist", "cli", "main.js");

function run(args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("--version 只输出一行版本号，不夹带帮助正文", () => {
  const out = run(["--version"]);
  assert.equal(out.split("\n").length, 1, `输出了 ${out.split("\n").length} 行`);
  assert.match(out, /^capitalist \d+\.\d+\.\d+$/, `实际输出：${out}`);
});

test("-v 与 -V 是 --version 的等价写法", () => {
  const expected = run(["--version"]);
  assert.equal(run(["-v"]), expected);
  assert.equal(run(["-V"]), expected);
});

test("--version 报的版本号与 package.json 一致", () => {
  const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
  assert.equal(run(["--version"]), `capitalist ${pkg.version}`);
});

test("-h 与 --help 输出相同，且首个非空行含版本号", () => {
  const help = run(["--help"]);
  assert.equal(run(["-h"]), help);
  const first = help.split("\n").find((l) => l.trim());
  assert.ok(first.includes(`capitalist ${run(["--version"]).replace("capitalist ", "")}`), `首行：${first}`);
});
