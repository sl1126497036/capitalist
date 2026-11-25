/**
 * 重派闸门：用户重派一张已完成的任务后，下游必须等重派单了结。
 *
 * 事故形状取自实际台账：#41 在 G1 里已被验收（41-1 done），用户发现回退漏做，重派为
 * 41-2 / 41-3。旧实现按“任一单完成即完成”判定，组立刻算满，下游 #46 在重派单还在写时
 * 就被放出。这里同时断言组前置与派单前置两条路径，避免只修显示、没修放行。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { groupIndexOf } = require("../dist/core/record/groups");
const { groupStatusOf, groupSettled } = require("../dist/core/dispatch/groupGraph");
const { pendingOf } = require("../dist/core/dispatch/deps");
const cap = require("../dist/core/record/supervisor");
const { amendTargetOf } = require("../dist/supervisor/usage/threadNo");
const { createTaskRoot } = require("../dist/core/policy/init");
const { loadState } = require("../dist/core/record/state");
const { appendSupervisorDirective, listSupervisorDirectives } = require("../dist/supervisor/channel/direct");
const loop = require("../dist/supervisor/loop");

function d(id, status, extra = {}) {
  return { id, at: "2026-11-25T11:00:00.000Z", stage: "S0", action: `做 ${id}`, status, ...extra };
}

function g(id) {
  return { id, title: `组 ${id}`, at: "2026-11-25T11:00:00.000Z", state: "open" };
}

test("组内成员已完成后被重派：组不放行，等重派单了结", () => {
  const rows = [
    d("41-1", "done", { group: "G1", lineage: "41-1" }),
    d("42-1", "done", { group: "G1", lineage: "42-1" }),
    d("41-2", "open", { group: "G1", lineage: "41-1" }),
    d("46-1", "open", { parent: "G1" }),
  ];
  const idx = groupIndexOf(rows, [g("G1")]);
  const st = groupStatusOf("G1", rows, idx);
  assert.strictEqual(st.total, 2, "重派不新增事项");
  assert.strictEqual(st.done, 1, "只有 42 这一项算完成");
  assert.deepStrictEqual(st.pending, ["41-2"], "待完成取重派单");
  assert.strictEqual(groupSettled("G1", rows, idx).settled, false);
  assert.deepStrictEqual(pendingOf(rows[3], rows, idx), ["G1"], "下游继续等组");
});

test("重派单完成：组放行", () => {
  const rows = [
    d("41-1", "done", { group: "G1", lineage: "41-1" }),
    d("42-1", "done", { group: "G1", lineage: "42-1" }),
    d("41-2", "done", { group: "G1", lineage: "41-1" }),
    d("46-1", "open", { parent: "G1" }),
  ];
  const idx = groupIndexOf(rows, [g("G1")]);
  assert.strictEqual(groupStatusOf("G1", rows, idx).done, 2);
  assert.strictEqual(groupSettled("G1", rows, idx).settled, true);
});

test("重派单失败且不再重试：组断链，下游不放行", () => {
  const rows = [
    d("41-1", "done", { group: "G1", lineage: "41-1" }),
    d("41-2", "failed", { group: "G1", lineage: "41-1", retry_verdict: "give_up" }),
    d("46-1", "open", { parent: "G1" }),
  ];
  const idx = groupIndexOf(rows, [g("G1")]);
  const st = groupStatusOf("G1", rows, idx);
  assert.strictEqual(st.state, "blocked", "旧单的 done 不能盖住重派失败");
  assert.deepStrictEqual(st.failed, ["41-2"]);
});

test("派单前置指向旧完成单：链上有在途重派时仍等待", () => {
  const rows = [
    d("41-1", "done", { lineage: "41-1" }),
    d("41-2", "open", { lineage: "41-1" }),
    d("46-1", "open", { parent: "41-1" }),
  ];
  assert.deepStrictEqual(cap.pendingPrerequisites(rows[2], rows), ["41-1"]);
  assert.strictEqual(cap.dependenciesSettled(rows[2], rows), false);
});

test("派单前置：重派单完成后放行", () => {
  const rows = [
    d("41-1", "done", { lineage: "41-1" }),
    d("41-2", "done", { lineage: "41-1" }),
    d("46-1", "open", { parent: "41-1" }),
  ];
  assert.deepStrictEqual(cap.pendingPrerequisites(rows[2], rows), []);
});

test("分片兜底同样按最后一次尝试：同分片重派未了结时不放行", () => {
  const rows = [
    d("41-1", "done", { lineage: "41-1", shard: "S1" }),
    d("41-2", "open", { lineage: "41-1", shard: "S1" }),
    /* 前置单自己未完成，同分片另有完成单：旧实现按分片兜底放行。 */
    d("40-1", "open", { lineage: "40-1", shard: "S1" }),
    d("47-1", "open", { parent: "40-1" }),
  ];
  assert.deepStrictEqual(cap.pendingPrerequisites(rows[3], rows), ["40-1"]);
});

test("分片兜底：同分片更晚一次尝试已完成时放行", () => {
  const rows = [
    d("40-1", "open", { lineage: "40-1", shard: "S1" }),
    /* 同一份工作的后一张单已完成：沿用分片兜底，不要求前置单自己完成。 */
    d("41-1", "done", { lineage: "41-1", shard: "S1" }),
    d("47-1", "open", { parent: "40-1" }),
  ];
  assert.deepStrictEqual(cap.pendingPrerequisites(rows[2], rows), []);
});

test("amend 取单：在途优先，全部终结时取最近一张终态单", () => {
  const root = "/nonexistent-capitalist-root";
  const live = [
    d("41-1", "done", { lineage: "41-1" }),
    d("41-2", "open", { lineage: "41-1" }),
  ];
  assert.strictEqual(amendTargetOf(root, 41, live)?.id, "41-2", "有在途单时追加到在途单");

  const settledRows = [
    d("41-1", "done", { lineage: "41-1" }),
    d("41-2", "done", { lineage: "41-1" }),
  ];
  assert.strictEqual(amendTargetOf(root, 41, settledRows)?.id, "41-2", "全部终结时取派发序最大的单");

  assert.strictEqual(amendTargetOf(root, 99, settledRows), undefined, "号不存在返回空");
});

test("amend 指向已完成的单：重开一张新单，追加落到原单", async () => {
  const root = mkdtempSync(join(tmpdir(), "capitalist-reopen-gate-"));
  createTaskRoot({ target: "重派闸门测试", policySpec: "minimal", root });
  cap.appendDispatch(root, {
    at: new Date().toISOString(),
    stage: "S0",
    id: "41-1",
    lineage: "41-1",
    action: "回退三处分隔符",
    status: "done",
  });

  const w = appendSupervisorDirective(root, {
    action: "amend",
    arg: "#41 把三处分隔符恢复原文",
    msg_id: "41-U2S-1795194741636",
    via: "capitalist",
  });
  assert.ok(w.ok, "指令应写入调度通道");

  await loop.__testing.applySupervisorDirectives({
    root,
    policy: { data: {} },
    state: loadState(root),
    wopts: {},
    concurrency: null,
    out: () => {},
  });

  const rec = listSupervisorDirectives(root).find((r) => r.id === w.rec.id);
  assert.strictEqual(rec?.result?.ok, true, `已完成的任务也要能重派，实际：${rec?.result?.reason}`);
  const rows = cap.readDispatches(root);
  assert.strictEqual(rows.find((d) => d.id === "41-1")?.status, "done", "旧单保持终态，不改写历史");
  const fresh = rows.find((d) => d.id === "41-2");
  assert.ok(fresh, "应新开一张派单");
  assert.strictEqual(fresh.status, "open");
  assert.strictEqual(fresh.lineage, "41-1", "重开沿用同一条派生链");
});
