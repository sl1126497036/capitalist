/** 前置判定：派单前置沿用原规则，组前置整组完成才放行。 */

const test = require("node:test");
const assert = require("node:assert");

const cap = require("../dist/core/record/supervisor");
const { groupIndexOf } = require("../dist/core/record/groups");
const { pendingOf, isReady, firstBlocker, splitPrerequisites } = require("../dist/core/dispatch/deps");

function d(id, status, extra = {}) {
  return { id, at: "2026-11-20T00:00:00.000Z", stage: "S0", action: `做 ${id}`, status, lineage: id, ...extra };
}
function g(id) {
  return { id, title: `组 ${id}`, at: "2026-11-20T00:00:00.000Z", state: "open" };
}

test("没有前置：直接可跑", () => {
  const rows = [d("1-1", "open")];
  assert.deepStrictEqual(pendingOf(rows[0], rows), []);
  assert.strictEqual(isReady(rows[0], rows), true);
  assert.strictEqual(firstBlocker(rows[0], rows), "");
});

test("派单前置未完成：与原有判定一致", () => {
  const rows = [d("1-1", "claimed"), d("2-1", "open", { parent: "1-1" })];
  assert.deepStrictEqual(pendingOf(rows[1], rows), cap.pendingPrerequisites(rows[1], rows));
  assert.strictEqual(isReady(rows[1], rows), false);
});

test("派单前置已完成：可跑", () => {
  const rows = [d("1-1", "done"), d("2-1", "open", { parent: "1-1" })];
  assert.deepStrictEqual(pendingOf(rows[1], rows), []);
});

test("组前置：成员没全完成就不放行，返回组号而不是成员号", () => {
  const rows = [
    d("1-1", "done", { group: "G1" }),
    d("2-1", "claimed", { group: "G1" }),
    d("3-1", "open", { parent: "G1" }),
  ];
  const idx = groupIndexOf(rows, [g("G1")]);
  assert.deepStrictEqual(pendingOf(rows[2], rows, idx), ["G1"]);
  assert.strictEqual(isReady(rows[2], rows, idx), false);
});

test("组前置：整组完成即放行", () => {
  const rows = [
    d("1-1", "done", { group: "G1" }),
    d("2-1", "done", { group: "G1" }),
    d("3-1", "open", { parent: "G1" }),
  ];
  const idx = groupIndexOf(rows, [g("G1")]);
  assert.deepStrictEqual(pendingOf(rows[2], rows, idx), []);
  assert.strictEqual(isReady(rows[2], rows, idx), true);
});

test("组前置：组断链同样不放行，且给出的是组号", () => {
  const rows = [
    d("1-1", "done", { group: "G1" }),
    d("2-1", "failed", { group: "G1", retry_verdict: "give_up" }),
    d("3-1", "open", { parent: "G1" }),
  ];
  const idx = groupIndexOf(rows, [g("G1")]);
  assert.deepStrictEqual(pendingOf(rows[2], rows, idx), ["G1"]);
});

test("同时挂组与组外派单：两类都查，顺序为组在前、派单在后", () => {
  const rows = [
    d("1-1", "claimed"),
    d("2-1", "claimed", { group: "G1" }),
    d("3-1", "open", { parent: "G1", after: ["1-1"] }),
  ];
  const idx = groupIndexOf(rows, [g("G1")]);
  const pending = pendingOf(rows[2], rows, idx);
  assert.strictEqual(pending[0], "G1");
  assert.strictEqual(pending[1], "1-1");
});

test("组边覆盖组内成员边：同一批前置只计一次", () => {
  const rows = [
    d("1-1", "claimed", { group: "G1" }),
    d("2-1", "open", { group: "G1" }),
    d("3-1", "open", { parent: "G1", after: ["1-1", "2-1"] }),
  ];
  const idx = groupIndexOf(rows, [g("G1")]);
  assert.deepStrictEqual(pendingOf(rows[2], rows, idx), ["G1"]);
  assert.strictEqual(isReady(rows[2], rows, idx), false);
});

test("解散组后按已收尾放行：残留的成员边不再挡住", () => {
  const rows = [
    d("1-1", "open", { group: "G1" }),
    d("2-1", "open", { parent: "G1", after: ["1-1"] }),
  ];
  const idx = groupIndexOf(rows, [{ ...g("G1"), state: "closed" }]);
  assert.deepStrictEqual(pendingOf(rows[1], rows, idx), []);
  assert.strictEqual(isReady(rows[1], rows, idx), true);
});

test("组前置已完成、派单前置未完成：仍不放行", () => {
  const rows = [
    d("1-1", "claimed"),
    d("2-1", "done", { group: "G1" }),
    d("3-1", "open", { parent: "G1", after: ["1-1"] }),
  ];
  const idx = groupIndexOf(rows, [g("G1")]);
  assert.deepStrictEqual(pendingOf(rows[2], rows, idx), ["1-1"]);
});

test("屏障 * 保留：还有别的单在跑就继续等", () => {
  const rows = [d("1-1", "open"), d("9-9", "open", { after: ["*"] })];
  assert.deepStrictEqual(pendingOf(rows[1], rows), ["*"]);
  assert.strictEqual(firstBlocker(rows[1], rows), "", "屏障不是具体卡点");
});

test("缺少组索引时不静默放行：组号留在未满足清单里", () => {
  const rows = [d("1-1", "done", { group: "G1" }), d("3-1", "open", { parent: "G1" })];
  assert.deepStrictEqual(pendingOf(rows[1], rows), ["G1"]);
  assert.strictEqual(isReady(rows[1], rows), false);
});

test("splitPrerequisites：拆出派单与组，保留屏障标记", () => {
  const split = splitPrerequisites({ parent: "G2", after: ["1-1", "G1", "*"] });
  assert.deepStrictEqual(split.dispatchIds, ["1-1"]);
  /* 顺序即声明顺序：`parent` 在前，`after` 按写入顺序。 */
  assert.deepStrictEqual(split.groupIds, ["G2", "G1"]);
  assert.strictEqual(split.barrier, true);
});

test("组的成员全部是 closed：按已完成放行", () => {
  const rows = [d("1-1", "closed", { group: "G1" }), d("3-1", "open", { parent: "G1" })];
  const idx = groupIndexOf(rows, [g("G1")]);
  assert.deepStrictEqual(pendingOf(rows[1], rows, idx), []);
});
