
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/supervisor");
const { writeJsonl } = require("../dist/core/json");
const { createTaskRoot } = require("../dist/core/init");
const { buildForestView } = require("../dist/supervisor/forestView");

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-forest-view-"));
  createTaskRoot({ target: "工作树看板", contractSpec: "minimal", root: base });
  return base;
}

function put(root, id, extra = {}) {
  capitalist.appendDispatch(root, {
    id,
    at: new Date().toISOString(),
    stage: "S0",
    shard: id,
    action: `做 ${id}`,
    status: "open",
    lineage: id,
    ...extra,
  });
}

/** 直接改台账行：模拟收尸判死、手改结构等外部事实。 */
function patch(root, id, fields) {
  const rows = capitalist.readDispatches(root).map((x) => (x.id === id ? { ...x, ...fields } : x));
  writeJsonl(capitalist.dispatchPath(root), rows);
}

function nodeOf(view, id) {
  for (const t of view.trees) for (const n of t.nodes) if (n.id === id) return n;
  return null;
}


test("空森林：台账没有派单时返回空树集，不报错", () => {
  const root = sandbox();
  const v = buildForestView(root);
  assert.strictEqual(v.empty, true);
  assert.deepStrictEqual(v.trees, []);
  assert.strictEqual(v.totals.total, 0);
  assert.strictEqual(v.degraded, "");
  assert.deepStrictEqual(v.anomalies.cycles, []);
});


test("单节点树：一个根、零子节点，进度读数为 1/1", () => {
  const root = sandbox();
  put(root, "S1", { title: "独立的一单" });
  const v = buildForestView(root);

  assert.strictEqual(v.empty, false);
  assert.strictEqual(v.trees.length, 1);
  const t = v.trees[0];
  assert.strictEqual(t.rootId, "S1");
  assert.strictEqual(t.maxDepth, 0);
  assert.strictEqual(t.stats.total, 1);
  assert.strictEqual(t.alive, true, "排队中的单算活着");

  const n = t.nodes[0];
  assert.strictEqual(n.title, "独立的一单");
  assert.strictEqual(n.state, "queued");
  assert.strictEqual(n.childCount, 0);
  assert.strictEqual(n.parent, "");
  assert.strictEqual(n.blocked, false);
});


test("深度大于 3 的链：父在子前、层数正确，未满足前置标成等父节点", () => {
  const root = sandbox();
  put(root, "L0");
  put(root, "L1", { parent: "L0", parent_reason: "等 L0" });
  put(root, "L2", { parent: "L1", parent_reason: "等 L1" });
  put(root, "L3", { parent: "L2", parent_reason: "等 L2" });
  put(root, "L4", { parent: "L3", parent_reason: "等 L3" });

  const v = buildForestView(root);
  assert.strictEqual(v.trees.length, 1);
  const t = v.trees[0];
  assert.strictEqual(t.stats.total, 5);
  assert.strictEqual(t.maxDepth, 4);
  assert.deepStrictEqual(
    t.nodes.map((n) => n.id),
    ["L0", "L1", "L2", "L3", "L4"],
    "先序：父一定排在子前面",
  );
  assert.deepStrictEqual(
    t.nodes.map((n) => n.depth),
    [0, 1, 2, 3, 4],
  );

  assert.strictEqual(nodeOf(v, "L0").state, "queued", "根没有前置，只是在排队");
  for (const id of ["L1", "L2", "L3", "L4"]) {
    const n = nodeOf(v, id);
    assert.strictEqual(n.state, "waiting", `${id} 的前置没完成`);
    assert.ok(n.stuckOn, `${id} 要标出卡在谁身上`);
  }
  assert.strictEqual(nodeOf(v, "L1").stuckOn, "L0");
});


test("成环：不死循环，环上节点收进降级树并给出提示", () => {
  const root = sandbox();
  put(root, "C1", { parent: "C2", parent_reason: "环" });
  put(root, "C2", { parent: "C1", parent_reason: "环" });

  const v = buildForestView(root);
  assert.strictEqual(v.anomalies.cycles.length, 1, "识别出一组环");
  assert.deepStrictEqual([...v.anomalies.cycles[0]].sort(), ["C1", "C2"]);
  assert.ok(v.degraded.includes("成环"), "降级提示要说清看到什么");

  const cyclic = v.trees.filter((t) => t.cycle);
  assert.strictEqual(cyclic.length, 1, "环上的节点单独成树，不假装有根");
  assert.strictEqual(cyclic[0].stats.total, 2);
  assert.strictEqual(cyclic[0].alive, false, "环上的节点等不到根，不算有活");
  assert.ok(cyclic[0].nodes.every((n) => n.inCycle), "环上节点都要标 inCycle");
  assert.ok(cyclic[0].nodes.every((n) => n.blocked), "环上节点按断链处理：这条链做不下去");
});

test("成环 + 环下子树：下游一路带上，渲染层不会转圈", () => {
  const root = sandbox();
  put(root, "C1", { parent: "C2", parent_reason: "环" });
  put(root, "C2", { parent: "C1", parent_reason: "环" });
  put(root, "C3", { parent: "C2", parent_reason: "挂在环下面" });

  const v = buildForestView(root);
  const cyclic = v.trees.find((t) => t.cycle);
  assert.ok(cyclic);
  assert.deepStrictEqual(cyclic.nodes.map((n) => n.id).sort(), ["C1", "C2", "C3"]);
  assert.strictEqual(nodeOf(v, "C3").blocked, true);
});


test("堵点：父节点失败后整棵子树标断链，并指回那张失败的单", () => {
  const root = sandbox();
  put(root, "P0");
  put(root, "P1", { parent: "P0", parent_reason: "等 P0" });
  put(root, "P2", { parent: "P1", parent_reason: "等 P1" });
  put(root, "Q0", { parent: "P0", parent_reason: "等 P0" });
  patch(root, "P0", { status: "failed", note: "worker exited", retry_why: "测试挂死 600 秒" });

  const v = buildForestView(root);
  const t = v.trees.find((x) => x.nodes.some((n) => n.id === "P0"));
  assert.ok(t);
  assert.strictEqual(t.stats.blocked, 4, "失败节点自己也算断链");
  assert.strictEqual(t.alive, false, "整棵树都断了，就没有活");

  const p0 = nodeOf(v, "P0");
  assert.strictEqual(p0.state, "failed");
  assert.strictEqual(p0.blockedBy, "P0");
  assert.ok(p0.reason.includes("测试挂死"), "失败原因取自台账");

  for (const id of ["P1", "P2", "Q0"]) {
    const n = nodeOf(v, id);
    assert.strictEqual(n.blocked, true, `${id} 在断链子树里`);
    assert.strictEqual(n.blockedBy, "P0", `${id} 要指回断掉的那张单`);
  }
});

test("失败后重派：兄弟照旧按各自父节点算，不互相连坐", () => {
  const root = sandbox();
  put(root, "A1");
  put(root, "A1b", { lineage: "A1", attempt: 2 });
  patch(root, "A1", { status: "failed", retry_why: "第一次失败" });

  const v = buildForestView(root);
  assert.strictEqual(v.trees.length, 1, "同一 lineage 的重派归并为一条，旧尝试不单独成树");
  const retried = nodeOf(v, "A1b");
  assert.strictEqual(retried.retries, 1, "重派次数取 attempt-1");
  assert.strictEqual(retried.blocked, false, "新单不受旧单失败牵连");
});

test("运行中的子树节点：父节点失败不改写它的状态，只把没起来的后代标成断链", () => {
  const root = sandbox();
  put(root, "R0");
  put(root, "R1", { parent: "R0", parent_reason: "等 R0" });
  put(root, "R2", { parent: "R1", parent_reason: "等 R1" });
  patch(root, "R0", { status: "failed", retry_why: "挂了" });
  patch(root, "R1", { status: "claimed", worker: "W-1" });

  const v = buildForestView(root);
  const r1 = nodeOf(v, "R1");
  assert.strictEqual(r1.state, "running");
  assert.strictEqual(r1.blocked, false, "运行中的单不算断链");
  assert.strictEqual(nodeOf(v, "R2").blocked, true, "它下面的还没起来，仍算断链");
  assert.strictEqual(nodeOf(v, "R2").blockedBy, "R0", "断链的来源是最上面那张失败的父单");
  assert.strictEqual(v.trees[0].alive, true, "有进程运行中，这棵树就算有活");
});


test("排序：还有活的树排在前面，全部收口的树沉到后面", () => {
  const root = sandbox();
  put(root, "D1");
  put(root, "D2");
  patch(root, "D1", { status: "done", note: "完成" });

  const v = buildForestView(root);
  assert.deepStrictEqual(
    v.trees.map((t) => t.rootId),
    ["D2", "D1"],
    "有排在队的树的排前面，已完成的后置",
  );
  assert.strictEqual(v.trees[1].alive, false);
  assert.strictEqual(v.trees[1].stats.remaining, 0);
});


test("总计：跨树的节点数与状态计数加起来等于台账行数", () => {
  const root = sandbox();
  put(root, "E1");
  put(root, "E2", { parent: "E1", parent_reason: "等 E1" });
  put(root, "E3");
  patch(root, "E1", { status: "claimed" });

  const v = buildForestView(root);
  assert.strictEqual(v.totals.total, 3);
  assert.strictEqual(v.totals.running, 1);
  assert.strictEqual(v.totals.waiting, 1);
  assert.strictEqual(v.totals.queued, 1);
  assert.strictEqual(v.totals.remaining, 3);
  const sum = v.trees.reduce((n, t) => n + t.stats.total, 0);
  assert.strictEqual(sum, 3, "每棵树只收自己的节点");
});
