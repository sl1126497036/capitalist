/**
 * 组状态派生与放行判定：纯函数，不读盘、不拿锁。
 *
 * 这一层最容易出错的地方是"放宽的边界"：同一件事重派成功应当算这个成员完成，
 * 但不能外溢成"组里有一份完成就算整组完成"。因此每个用例都同时断言
 * "该成员的判定"与"整组的放行"两件事。
 */

const test = require("node:test");
const assert = require("node:assert");

const { groupIndexOf } = require("../dist/core/record/groups");
const { groupStatusOf, groupSettled, ancestorsOf } = require("../dist/core/dispatch/groupGraph");

function d(id, status, extra = {}) {
  return { id, at: "2026-11-20T00:00:00.000Z", stage: "S0", action: `做 ${id}`, status, ...extra };
}

function group(id, extra = {}) {
  return { id, title: `组 ${id}`, at: "2026-11-20T00:00:00.000Z", state: "open", ...extra };
}

function idxOf(rows, groups) {
  return groupIndexOf(rows, groups);
}

test("全体完成：组 done，下游放行", () => {
  const rows = [d("1-1", "done", { group: "G1" }), d("2-1", "done", { group: "G1" })];
  const idx = idxOf(rows, [group("G1")]);
  const st = groupStatusOf("G1", rows, idx);
  assert.strictEqual(st.state, "done");
  assert.strictEqual(st.done, 2);
  assert.deepStrictEqual(st.pending, []);
  assert.strictEqual(groupSettled("G1", rows, idx).settled, true);
});

test("成员在跑：组 running，下游不放行", () => {
  const rows = [d("1-1", "done", { group: "G1" }), d("2-1", "claimed", { group: "G1" })];
  const idx = idxOf(rows, [group("G1")]);
  assert.strictEqual(groupStatusOf("G1", rows, idx).state, "running");
  assert.strictEqual(groupSettled("G1", rows, idx).settled, false);
});

test("成员待验收：组 review，下游不放行", () => {
  const rows = [d("1-1", "done", { group: "G1" }), d("2-1", "reported", { group: "G1" })];
  const idx = idxOf(rows, [group("G1")]);
  assert.strictEqual(groupStatusOf("G1", rows, idx).state, "review");
  assert.strictEqual(groupSettled("G1", rows, idx).settled, false);
});

test("可重试的失败：组 waiting，不算断链，下游继续等", () => {
  const rows = [d("1-1", "done", { group: "G1" }), d("2-1", "failed", { group: "G1", retry_verdict: "retry" })];
  const idx = idxOf(rows, [group("G1")]);
  const st = groupStatusOf("G1", rows, idx);
  assert.strictEqual(st.state, "waiting");
  assert.deepStrictEqual(st.failed, [], "可重试的失败不记断链");
  assert.deepStrictEqual(st.pending, ["2-1"]);
  const settled = groupSettled("G1", rows, idx);
  assert.strictEqual(settled.settled, false);
  assert.deepStrictEqual(settled.failed, []);
});

test("判定不再重试的失败：组 blocked，给出断链位置，下游不放行", () => {
  const rows = [
    d("1-1", "done", { group: "G1" }),
    d("2-1", "failed", { group: "G1", retry_verdict: "give_up" }),
  ];
  const idx = idxOf(rows, [group("G1")]);
  const st = groupStatusOf("G1", rows, idx);
  assert.strictEqual(st.state, "blocked");
  assert.strictEqual(st.brokenAt, "2-1");
  assert.deepStrictEqual(st.failed, ["2-1"]);
  const settled = groupSettled("G1", rows, idx);
  assert.strictEqual(settled.settled, false);
  assert.deepStrictEqual(settled.failed, ["2-1"]);
});

test("重派成功：同一件事已有 done，成员算完成，组恢复放行", () => {
  const rows = [
    d("1-1", "failed", { group: "G1", lineage: "1", retry_verdict: "give_up" }),
    d("1-2", "done", { group: "G1", lineage: "1" }),
    d("2-1", "done", { group: "G1", lineage: "2" }),
  ];
  const idx = idxOf(rows, [group("G1")]);
  const st = groupStatusOf("G1", rows, idx);
  assert.strictEqual(st.state, "done");
  assert.deepStrictEqual(st.failed, []);
  assert.strictEqual(groupSettled("G1", rows, idx).settled, true);
});

test("成员被人工结束：不阻塞放行，也不计入完成数", () => {
  const rows = [d("1-1", "done", { group: "G1" }), d("2-1", "closed", { group: "G1" })];
  const idx = idxOf(rows, [group("G1")]);
  const st = groupStatusOf("G1", rows, idx);
  assert.strictEqual(st.state, "done");
  assert.strictEqual(st.done, 1, "closed 不计入完成数");
  assert.strictEqual(groupSettled("G1", rows, idx).settled, true);
});

test("组被解散：挂在该组下的下游直接放行", () => {
  const rows = [d("1-1", "claimed", { group: "G1" })];
  const idx = idxOf(rows, [group("G1", { state: "closed" })]);
  assert.strictEqual(groupStatusOf("G1", rows, idx).state, "closed");
  assert.strictEqual(groupSettled("G1", rows, idx).settled, true);
});

test("成员记录缺失（已归档）：按已完成处理，不阻塞放行", () => {
  /* 组记录里还有两条，但台账只剩 1-1：2-1 已被归档。 */
  const rows = [d("1-1", "done", { group: "G1" })];
  const idx = idxOf(rows, [group("G1")]);
  idx.members.get("G1").push("2-1");
  assert.strictEqual(groupSettled("G1", rows, idx).settled, true);
});

test("成员仍在台账且未完成：即使组索引里有别的成员，也不放行", () => {
  const rows = [d("1-1", "done", { group: "G1" }), d("2-1", "open", { group: "G1" })];
  const idx = idxOf(rows, [group("G1")]);
  const st = groupStatusOf("G1", rows, idx);
  assert.strictEqual(st.state, "queued");
  assert.deepStrictEqual(st.pending, ["2-1"]);
  assert.strictEqual(groupSettled("G1", rows, idx).settled, false);
});

test("组不存在：不放行，返回空结果", () => {
  const rows = [d("1-1", "done", { group: "G9" })];
  const idx = idxOf(rows, [group("G1")]);
  assert.strictEqual(groupStatusOf("G9", rows, idx), null);
  const settled = groupSettled("G9", rows, idx);
  assert.strictEqual(settled.settled, false);
});

test("挂错组号：不把该单算进任何组，索引记 dangling", () => {
  const rows = [d("1-1", "done", { group: "G9" })];
  const idx = idxOf(rows, [group("G1")]);
  assert.deepStrictEqual(idx.dangling, ["1-1"]);
  assert.deepStrictEqual(idx.members.get("G1"), []);
  assert.strictEqual(groupStatusOf("G1", rows, idx).state, "done", "空组成员全部满足，但这是数据问题，另有 dangling 报出");
});

test("祖先：组的位置由成员父推导，组挂组能一路往上", () => {
  const rows = [
    d("1-1", "done", { group: "G1" }),
    d("2-1", "open", { group: "G2", parent: "G1" }),
  ];
  const idx = idxOf(rows, [group("G1"), group("G2")]);
  assert.deepStrictEqual(ancestorsOf("G2", rows, idx), ["G1"]);
  assert.deepStrictEqual(ancestorsOf("2-1", rows, idx), ["G1"]);
  assert.deepStrictEqual(ancestorsOf("G1", rows, idx), []);
});

test("祖先：遇到环不死循环", () => {
  const rows = [
    d("1-1", "open", { group: "G1", parent: "G2" }),
    d("2-1", "open", { group: "G2", parent: "G1" }),
  ];
  const idx = idxOf(rows, [group("G1"), group("G2")]);
  const chain = ancestorsOf("G1", rows, idx);
  assert.ok(chain.length <= 2, `上溯应在环上停住，实际 ${chain.join(" → ")}`);
});
