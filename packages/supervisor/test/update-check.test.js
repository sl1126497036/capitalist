/**
 * 版本检查的纯逻辑部分：比较、缓存、缓存提示。
 *
 * 联网分支不在此覆盖：向 npm 注册表发真实请求会让测试依赖外部服务与网络，
 * 失败原因无法与代码缺陷区分。`checkUpdate` 的联网路径由手工 `capitalist check-update` 验证。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { compareVersions, cachedUpdateNotice } = require("../dist/supervisor/updateCheck");

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "capitalist-upd-"));
  const file = join(dir, "update-check.json");
  process.env.CAPITALIST_UPDATE_CACHE = file;
  return file;
}

test("版本比较：按数字段比，不做字符串比较", () => {
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
  assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
  assert.equal(compareVersions("0.2.0", "0.1.0"), 1);
  /* 字符串比较会把 0.10.0 判成小于 0.9.0，这是要防的那类错。 */
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
});

test("版本比较：段数不同时缺位按 0 处理", () => {
  assert.equal(compareVersions("0.1", "0.1.0"), 0);
  assert.equal(compareVersions("0.1", "0.1.1"), -1);
});

test("缓存命中：同版本且标为落后时给出升级提示", () => {
  const file = sandbox();
  writeFileSync(
    file,
    JSON.stringify({ local: "0.1.0", latest: "0.2.0", outdated: true, checkedAt: new Date().toISOString() }),
    "utf8",
  );
  const hint = cachedUpdateNotice("0.1.0");
  assert.ok(hint, "应给出提示");
  assert.match(hint, /0\.2\.0/);
  assert.match(hint, /npm i -g capitalist/);
});

test("缓存不适用：本地版本变了就不再沿用旧结论", () => {
  const file = sandbox();
  writeFileSync(
    file,
    JSON.stringify({ local: "0.1.0", latest: "0.2.0", outdated: true, checkedAt: new Date().toISOString() }),
    "utf8",
  );
  assert.equal(cachedUpdateNotice("0.1.1"), null, "升级后旧结论不再成立");
});

test("缓存不适用：已是最新与缓存损坏都不产生提示", () => {
  const file = sandbox();
  writeFileSync(
    file,
    JSON.stringify({ local: "0.2.0", latest: "0.2.0", outdated: false, checkedAt: new Date().toISOString() }),
    "utf8",
  );
  assert.equal(cachedUpdateNotice("0.2.0"), null);

  writeFileSync(file, "{ 不是 JSON", "utf8");
  assert.equal(cachedUpdateNotice("0.2.0"), null, "缓存损坏按没有处理，不能抛");
});

test("缓存不适用：文件不存在时静默返回 null", () => {
  sandbox();
  assert.equal(cachedUpdateNotice("0.1.0"), null);
});
