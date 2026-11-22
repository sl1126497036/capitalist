/**
 * 组内事项聚合与接替：完成数按事项计，补单顶替失败成员不撑大分母。
 *
 * 用真实事故的数据形状做断言：四个成员各重派多次，全失败；补单完成并声明接替。
 * 断言同时看“事项数”与“放行”，避免只修显示、没修判定。
 */

const test = require("node:test");
const assert = require("node:assert");

const { groupIndexOf } = require("../dist/core/record/groups");
const { groupItemsOf, groupStatusOf, groupSettled } = require("../dist/core/dispatch/groupGraph");

function d(id, status, extra = {}) {
  return { id, at: "2026-11-22T00:00:00.000Z", stage: "S0", action: `做 ${id}`, status, ...extra };
}

function group(id, extra = {}) {
  return { id, title: `组 ${id}`, at: "2026-11-22T00:00:00.000Z", state: "open", ...extra };
}

test("同一件事重派多次：分母按事项计，不随重派次数增长", () => {
  const rows = [
    d("1-1", "failed", { group: "G1", lineage: "1-1", retry_verdict: "hold" }),
    d("1-2", "failed", { group: "G1", lineage: "1-1", retry_verdict: "hold" }),
    d("1-3", "failed", { group: "G1", lineage: "1-1", retry_verdict: "hold" }),
    d("2-1", "done", { group: "G1", lineage: "2-1" }),
  ];
  const idx = groupIndexOf(rows, [group("G1")]);
  const st = groupStatusOf("G1", rows, idx);
  assert.strictEqual(st.total, 2, "两个事项，不是四张派单");
  assert.strictEqual(st.done, 1);
  assert.deepStrictEqual(st.pending, ["1-3"], "待完成取事项代表单（最新一张）");
  assert.deepStrictEqual(groupItemsOf("G1", rows, idx).map((i) => i.ids.length), [3, 1]);
});

test("补单接替失败成员：合并为同一事项，完成后整组放行", () => {
  const rows = [
    d("1-1", "failed", { group: "G1", lineage: "1-1", retry_verdict: "hold" }),
    d("1-2", "failed", { group: "G1", lineage: "1-1", retry_verdict: "hold" }),
    d("2-1", "done", { group: "G1", lineage: "2-1" }),
    d("9-1", "done", { group: "G1", lineage: "9-1", supersedes: "1-1" }),
  ];
  const idx = groupIndexOf(rows, [group("G1")]);
  const st = groupStatusOf("G1", rows, idx);
  assert.strictEqual(st.total, 2, "补单顶替，不新增第三项");
  assert.strictEqual(st.done, 2);
  assert.deepStrictEqual(st.pending, []);
  assert.strictEqual(groupSettled("G1", rows, idx).settled, true);
  const item = groupItemsOf("G1", rows, idx).find((i) => i.key === "1-1");
  assert.deepStrictEqual(item?.ids, ["1-1", "1-2", "9-1"], "接替单并入被接替事项");
  assert.strictEqual(item?.head, "9-1", "代表单取最新一张");
});

test("补单接替但尚未完成：事项仍等待，下游不放行", () => {
  const rows = [
    d("1-1", "failed", { group: "G1", lineage: "1-1", retry_verdict: "hold" }),
    d("2-1", "done", { group: "G1", lineage: "2-1" }),
    d("9-1", "open", { group: "G1", lineage: "9-1", supersedes: "1-1" }),
  ];
  const idx = groupIndexOf(rows, [group("G1")]);
  const st = groupStatusOf("G1", rows, idx);
  assert.strictEqual(st.total, 2);
  assert.strictEqual(st.state, "queued");
  assert.deepStrictEqual(st.pending, ["9-1"]);
  assert.strictEqual(groupSettled("G1", rows, idx).settled, false);
});

test("接替目标在别的组：不合并，两个组各自计数", () => {
  const rows = [
    d("1-1", "failed", { group: "G1", lineage: "1-1", retry_verdict: "hold" }),
    d("2-1", "done", { group: "G1", lineage: "2-1" }),
    d("9-1", "done", { group: "G2", lineage: "9-1", supersedes: "1-1" }),
  ];
  const idx = groupIndexOf(rows, [group("G1"), group("G2")]);
  assert.strictEqual(groupStatusOf("G1", rows, idx).total, 2, "G1 仍两项");
  assert.strictEqual(groupStatusOf("G2", rows, idx).total, 1, "G2 只有补单一项");
});

test("接替目标已归档：跳过合并不抛错，按独立事项计", () => {
  const rows = [
    d("1-1", "done", { group: "G1", lineage: "1-1" }),
    d("9-1", "done", { group: "G1", lineage: "9-1", supersedes: "8-1" }),
  ];
  const idx = groupIndexOf(rows, [group("G1")]);
  const st = groupStatusOf("G1", rows, idx);
  assert.strictEqual(st.total, 2);
  assert.strictEqual(st.done, 2);
  assert.strictEqual(groupSettled("G1", rows, idx).settled, true);
});

test("链式接替：A 被 B 接替、B 被 C 接替，仍算一个事项", () => {
  const rows = [
    d("1-1", "failed", { group: "G1", lineage: "1-1", retry_verdict: "hold" }),
    d("2-1", "failed", { group: "G1", lineage: "2-1", supersedes: "1-1" }),
    d("3-1", "done", { group: "G1", lineage: "3-1", supersedes: "2-1" }),
  ];
  const idx = groupIndexOf(rows, [group("G1")]);
  const st = groupStatusOf("G1", rows, idx);
  assert.strictEqual(st.total, 1, "三次接替仍是同一件事");
  assert.strictEqual(st.done, 1);
  assert.strictEqual(groupSettled("G1", rows, idx).settled, true);
});
