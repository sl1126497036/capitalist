/**
 * 前端编号显示：组号与派单号必须与后端同一口径。
 *
 * 后端 `nodeRef.label("G1")` 给 `#G01`，前端 `noLabel("G1")` 若给 `#G1`，同一张卡在
 * 命令行与看板上就是两个号，用户照着念会对不上。这里直接调后端函数比对，不各自断言字面量。
 */

const test = require("node:test");
const assert = require("node:assert");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const NO = pathToFileURL(join(__dirname, "..", "web", "src", "lib", "no.js")).href;
const { label } = require("../dist/core/record/nodeRef");
const { groupNoLabel } = require("../dist/core/record/idMap");

test("前端 noLabel：组号补零补 #，与后端 label 一致", async () => {
  const { noLabel } = await import(NO);
  for (const raw of ["G1", "G01", "#G1", "#G01"]) {
    assert.strictEqual(noLabel(raw), "#G01", raw);
    assert.strictEqual(noLabel(raw), label(raw), `前后端口径必须一致：${raw}`);
  }
  assert.strictEqual(noLabel("G12"), groupNoLabel("G12"));
  assert.strictEqual(noLabel("G12"), "#G12");
});

test("前端 noLabel：派单号与任务号沿用原规则", async () => {
  const { noLabel, bareNoLabel } = await import(NO);
  assert.strictEqual(noLabel("2"), "#02");
  assert.strictEqual(noLabel("2-2"), "#02-2");
  assert.strictEqual(noLabel("2-P1"), "#02-P1");
  assert.strictEqual(noLabel(""), "");
  assert.strictEqual(bareNoLabel("G1"), "G01");
  assert.strictEqual(bareNoLabel("2-2"), "02-2");
});

test("前端 noLabel：不是编号的串原样带 #，不猜", async () => {
  const { noLabel } = await import(NO);
  assert.strictEqual(noLabel("user"), "#user");
  assert.strictEqual(noLabel("S0-S-1712"), "#S0-S-1712");
});
