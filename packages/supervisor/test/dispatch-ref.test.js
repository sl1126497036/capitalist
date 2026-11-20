/** 引用解析与编号显示的唯一入口：形态判定、规范化、显示三者互不串味。 */

const test = require("node:test");
const assert = require("node:assert");

const { parseRef, label, isGroupRef, normalizeNo } = require("../dist/core/record/nodeRef");

test("组号：带 # 与不带 # 都认，统一成 G<n>，大小写不敏感", () => {
  for (const raw of ["#G1", "G1", "g1", " #G01 "]) {
    const r = parseRef(raw);
    assert.strictEqual(r.kind, "group", raw);
    assert.strictEqual(r.id, "G1", raw);
  }
  const big = parseRef("#G12");
  assert.strictEqual(big.id, "G12");
  assert.strictEqual(isGroupRef("#g7"), true);
  assert.strictEqual(isGroupRef("G"), false);
  assert.strictEqual(isGroupRef("2-3"), false);
});

test("任务号：纯数字按任务号处理，前导零去掉", () => {
  for (const raw of ["#01", "01", "#1"]) {
    const r = parseRef(raw);
    assert.strictEqual(r.kind, "task-no", raw);
    assert.strictEqual(r.id, "1", raw);
  }
  assert.strictEqual(parseRef("#007").id, "7");
});

test("派单 id：任务号-派单序，前导零去掉", () => {
  const r = parseRef("02-3");
  assert.strictEqual(r.kind, "dispatch-id");
  assert.strictEqual(r.id, "2-3");
  assert.strictEqual(parseRef("2-3").id, "2-3");
  /* 纯数字不可能是派单 id：派单 id 恒为"任务号-派单序"。 */
  assert.strictEqual(parseRef("2").kind, "task-no");
});

test("进程号：认 P 序，前导零去掉", () => {
  const r = parseRef("02-P1");
  assert.strictEqual(r.kind, "worker-no");
  assert.strictEqual(r.id, "2-P1");
  assert.strictEqual(parseRef("2-P12").id, "2-P12");
});

test("其它形态不猜：历史 D- 号、分片名原样保留", () => {
  for (const raw of ["D-abc", "S0/x3", "shard:ui", ""]) {
    const r = parseRef(raw);
    assert.strictEqual(r.kind, "other", raw);
  }
  assert.strictEqual(parseRef("D-abc").id, "D-abc");
});

test("normalizeNo：只动编号，不动历史形态", () => {
  assert.strictEqual(normalizeNo("02-3"), "2-3");
  assert.strictEqual(normalizeNo("#02-P1"), "2-P1");
  assert.strictEqual(normalizeNo("002"), "2");
  assert.strictEqual(normalizeNo("0"), "0");
  assert.strictEqual(normalizeNo("D-02"), "D-02");
});

test("label：四类号各自补零加 #，认不出的原样返回", () => {
  assert.strictEqual(label("2"), "#02");
  assert.strictEqual(label("2-3"), "#02-3");
  assert.strictEqual(label("12-3"), "#12-3");
  assert.strictEqual(label("2-P1"), "#02-P1");
  assert.strictEqual(label("G1"), "#G01");
  assert.strictEqual(label("G12"), "#G12");
  assert.strictEqual(label("D-abc"), "D-abc");
  assert.strictEqual(label(""), "");
  assert.strictEqual(label(undefined), "");
});

test("解析与显示互逆：编号类经 normalize 后再 label，与直接 label 一致", () => {
  const samples = ["#01", "2", "02-3", "2-P1", "#G1", "G12"];
  for (const raw of samples) {
    const r = parseRef(raw);
    assert.strictEqual(label(r.id), label(normalizeNo(r.id)), raw);
  }
});
