/**
 * Automatic adoption.
 *
 * Covers the path that makes a single chat sentence sufficient in WorkBuddy:
 * a directory matching a user rule gets a task root on the first prompt event,
 * and directories excluded by the rule never do.
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { loadWatchRules, matchWatchDir, autoAdopt } = require("../dist/core/platform/autowatch");

const RULES = [
  { match: ["cases", "targets"], contract: "dev", exclude: ["tools", "tmp"] },
];

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-aw-"));
  for (const d of ["cases/targets/alpha/docs", "cases/targets/beta", "cases/targets/tools", "cases/other"]) {
    mkdirSync(join(base, d), { recursive: true });
  }
  return base;
}

test("匹配规则时，匹配段之后的第一级即任务根", () => {
  const base = sandbox();
  const hit = matchWatchDir(join(base, "cases", "targets", "alpha", "docs"), RULES);
  assert.ok(hit, "应当命中");
  assert.equal(hit.contract, "dev");
  assert.equal(
    hit.root.toLowerCase(),
    join(base, "cases", "targets", "alpha").replace(/\\/g, "/").toLowerCase(),
  );
});

test("分类层本身不构成任务根", () => {
  const base = sandbox();
  assert.equal(matchWatchDir(join(base, "cases", "targets"), RULES), null);
  assert.equal(matchWatchDir(join(base, "cases"), RULES), null);
});

test("排除名单里的目录不纳管", () => {
  const base = sandbox();
  assert.equal(matchWatchDir(join(base, "cases", "targets", "tools"), RULES), null);
});

test("规则之外的路径不纳管", () => {
  const base = sandbox();
  assert.equal(matchWatchDir(join(base, "cases", "other"), RULES), null);
});

test("Git Bash 风格路径在 Windows 上也能匹配", { skip: process.platform !== "win32" && "仅 Windows 需要还原 /d/ 写法" }, () => {
  const base = sandbox();
  const native = join(base, "cases", "targets", "alpha").replace(/\\/g, "/"); // C:/...
  const gitBash = `/${native[0].toLowerCase()}${native.slice(2)}`; // /c/...
  const hit = matchWatchDir(gitBash, RULES);
  assert.ok(hit, `应当命中：${gitBash}`);
  assert.equal(hit.contract, "dev");
});

test("autoAdopt 建根，重复调用不报错", () => {
  const base = sandbox();
  const proj = join(base, "cases", "targets", "alpha");
  const first = autoAdopt(proj, RULES);
  assert.ok(first, "应当建根");
  assert.ok(existsSync(join(proj, ".capitalist", "state.json")), "state.json 应存在");

  const state = JSON.parse(
    require("node:fs").readFileSync(join(proj, ".capitalist", "state.json"), "utf8"),
  );
  assert.equal(state.target, "alpha");
  assert.equal(state.contract, "dev");
  assert.equal(state.contract_fallback, false);

  const second = autoAdopt(proj, RULES);
  assert.ok(second, "已存在的根也应返回路径，而不是报错");
});

test("配置文件解析：非法条目被跳过而不是整体失败", () => {
  const base = sandbox();
  const cfg = join(base, "watch.json");
  writeFileSync(
    cfg,
    JSON.stringify({
      rules: [
        { match: ["bad"] }, // 缺 contract
        { contract: "dev" }, // 缺 match
        { match: ["cases", "targets"], contract: "dev" },
      ],
    }),
    "utf8",
  );
  const rules = loadWatchRules(cfg);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].contract, "dev");
});

test("配置文件缺失时返回空规则，不抛异常", () => {
  assert.deepEqual(loadWatchRules(join(tmpdir(), "definitely-not-here-12345.json")), []);
});
