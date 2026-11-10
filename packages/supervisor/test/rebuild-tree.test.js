
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/supervisor");
const { createTaskRoot } = require("../dist/core/init");
const { applyRebuild, planRebuild } = require("../dist/core/rebuildTree");

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-rebuild-"));
  createTaskRoot({ target: "存量重建树", contractSpec: "minimal", root: base });
  return base;
}

function put(root, id, extra = {}) {
  capitalist.appendDispatch(root, {
    id,
    at: new Date().toISOString(),
    stage: "U1",
    shard: id,
    action: `做 ${id}`,
    status: "open",
    lineage: id,
    ...extra,
  });
}

function rowsById(root) {
  return new Map(capitalist.readDispatches(root).map((d) => [String(d.id), d]));
}

test("同一件事的三条失败记录：归并成一条待办，另两条关闭，父节点继承到代表单", () => {
  const root = sandbox();
  const failedAt = new Date(Date.now() - 60_000).toISOString();

  put(root, "P", { action: "做上游的活" });
  for (const id of ["C1", "C2", "C3"]) {
    put(root, id, {
      action: "做下游的活",
      status: "failed",
      done_at: failedAt,
      parent: "P",
      parent_reason: "要上游的产物",
    });
  }

  const plan = planRebuild(root);
  const group = plan.groups.find((g) => g.members.includes("C3"));
  assert.ok(group, "三条记录归成一组");
  assert.deepStrictEqual([...group.members].sort(), ["C1", "C2", "C3"]);
  assert.strictEqual(group.representative, "C3", "全组没完工时取台账最后一张做代表");

  applyRebuild(root, plan);
  const rows = rowsById(root);

  const groupRows = ["C1", "C2", "C3"].map((id) => rows.get(id));
  assert.deepStrictEqual(
    groupRows.map((r) => r.status),
    ["closed", "closed", "open"],
    "同一件事只留一条待办：两个 closed、一个 open",
  );

  assert.strictEqual(rows.get("C3").parent, "P", "父节点继承到代表单");
  assert.match(String(rows.get("C3").parent_reason), /重建/, "父边注明是重建落下的");
  assert.match(String(rows.get("C1").note), /并入代表单 C3/, "被关的残留写清并入了谁");
  assert.strictEqual(plan.stats.trees, 1, "下游挂在代表单上，两条记录合成同一棵树的两个节点");

  /* 幂等：再读一次台账应当无事可做，否则第二轮会把刚重开的待办又关掉。 */
  const again = planRebuild(root);
  assert.strictEqual(again.stats.close + again.stats.reopen, 0, "重建成果不会被第二次重建推翻");
});

test("组内有 done：整组不进树，失败的残留被关闭，代表为空", () => {
  const root = sandbox();
  const doneAt = new Date(Date.now() - 120_000).toISOString();

  put(root, "D1", { action: "做同一件事", status: "failed", done_at: doneAt });
  put(root, "D2", { action: "做同一件事", status: "done", done_at: doneAt });
  put(root, "D3", { action: "做同一件事", status: "failed", done_at: doneAt });

  const plan = planRebuild(root);
  const group = plan.groups.find((g) => g.members.includes("D2"));
  assert.ok(group);
  assert.strictEqual(group.settledBy, "D2", "取组内完工的那张做代表");
  assert.strictEqual(group.representative, "", "已完工的组不参与重建，代表为空");
  assert.strictEqual(plan.stats.trees, 0, "整组不进树，重建后没有未完工的根");

  applyRebuild(root, plan);
  const rows = rowsById(root);

  assert.strictEqual(rows.get("D2").status, "done", "完工记录不动");
  assert.strictEqual(rows.get("D1").status, "closed", "失败的残留被关闭");
  assert.strictEqual(rows.get("D3").status, "closed");
  assert.match(String(rows.get("D1").note), /同一件事已完成于 D2/, "关闭原因指向完工的那张");

  const live = capitalist.readDispatches(root).filter((d) => ["open", "claimed", "review"].includes(String(d.status)));
  assert.deepStrictEqual(live, [], "重建后没有待办");
});

test("子单挂着已完工的父：重建不连这条边，按根处理并进注意事项", () => {
  const root = sandbox();
  put(root, "P", { action: "做上游的活", status: "done", done_at: new Date(Date.now() - 60_000).toISOString() });
  put(root, "C", { action: "做下游的活", parent: "P", parent_reason: "要上游的产物" });

  const plan = planRebuild(root);
  const item = plan.items.find((x) => x.id === "C");
  assert.strictEqual(item.parent, "", "父组已完成，边不重建");
  assert.strictEqual(plan.stats.trees, 1, "子单自己就是一棵树的根");
  assert.ok(
    plan.warnings.some((w) => w.includes("C") && w.includes("P")),
    `注意事项应写明这条边被放弃：${plan.warnings.join(" / ")}`,
  );

  applyRebuild(root, plan);
  const rows = rowsById(root);

  assert.strictEqual(rows.get("C").status, "open", "子单留在待办里");
  assert.strictEqual(rows.get("C").parent, "", "已完工的父不进树，旧父边一并清掉");
  assert.strictEqual(rows.get("P").status, "done", "完工记录不动");

  const forest = capitalist.dispatchForest(capitalist.readDispatches(root));
  assert.ok(forest.roots.includes("C"), "重建后子单是可调度的根");
});


test("已上报待裁决的单，重建不许把它打回 open", () => {
  const root = sandbox();
  put(root, "D-report", { status: "reported", reported_at: new Date().toISOString() });
  put(root, "D-review", { status: "review" });
  put(root, "D-open");

  const plan = planRebuild(root);
  applyRebuild(root, plan);

  const rows = rowsById(root);
  assert.equal(rows.get("D-report").status, "reported", "reported 必须保留");
  assert.ok(rows.get("D-report").reported_at, "报告时间不许清掉");
  assert.equal(rows.get("D-review").status, "review", "review 必须保留");
});


test("已上报待裁决的单，重建不许把它打回 open", () => {
  const root = sandbox();
  put(root, "D-report", { status: "reported", reported_at: new Date().toISOString() });
  put(root, "D-review", { status: "review" });
  put(root, "D-open");

  const plan = planRebuild(root);
  applyRebuild(root, plan);

  const rows = rowsById(root);
  assert.equal(rows.get("D-report").status, "reported", "reported 必须保留");
  assert.ok(rows.get("D-report").reported_at, "报告时间不许清掉");
  assert.equal(rows.get("D-review").status, "review", "review 必须保留");
});

test("用户手动关的单，重建不许再把它排回队列", () => {
  const root = sandbox();
  put(root, "D-user-closed", {
    status: "closed",
    closed_by: "user",
    closed_at: new Date().toISOString(),
    rebuilt_at: "2026-11-03T03:26:55.249Z",
  });

  const plan = planRebuild(root);
  applyRebuild(root, plan);

  assert.equal(rowsById(root).get("D-user-closed").status, "closed", "人关掉的单不许复活");
});

test("用户手动关的单，重建不许再把它排回队列", () => {
  const root = sandbox();
  put(root, "D-user-closed", {
    status: "closed",
    closed_by: "user",
    closed_at: new Date().toISOString(),
    rebuilt_at: "2026-11-03T03:26:55.249Z",
  });

  const plan = planRebuild(root);
  applyRebuild(root, plan);

  assert.equal(rowsById(root).get("D-user-closed").status, "closed", "人关掉的单不许复活");
});
