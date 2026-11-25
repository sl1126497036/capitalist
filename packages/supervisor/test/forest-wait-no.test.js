/**
 * 任务树上“等待前置单”的显示。
 *
 * 守的是编号：节点等的是台账里的某张单，界面上要写任务编号（等待 #05），
 * 不得将 `D-…` 这类内部标识加上 `#` 作为任务号显示。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/record/supervisor");
const { createTaskRoot } = require("../dist/core/policy/init");
const { laneKeyOf } = require("../dist/core/dispatch/commands");
const { buildForestView } = require("../dist/supervisor/view/forestView");
const { assignThreadNos, dispatchNoTable } = require("../dist/supervisor/usage/threadNo");

/** 一条前置单（执行中）+ 一条等它的单；编号按台账顺序分配。 */
function scene() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-forest-"));
  createTaskRoot({ target: "等待编号测试", policySpec: "minimal", root });
  const at = new Date(Date.now() - 60_000).toISOString();
  const pre = { id: "D-pre1", stage: "S0", shard: "", lineage: "D-pre1" };
  const next = { id: "D-next1", stage: "S0", shard: "", lineage: "D-next1" };
  capitalist.appendDispatch(root, {
    ...pre,
    at,
    action: "前置单",
    /* 执行中的单在台账里是 claimed；stateOf 把它映射成 running。 */
    status: "claimed",
  });
  capitalist.appendDispatch(root, {
    ...next,
    at: new Date().toISOString(),
    action: "后续单",
    status: "open",
    after: ["D-pre1"],
  });
  assignThreadNos(root, [laneKeyOf(pre), laneKeyOf(next)]);
  return root;
}

test("等待前置单时带回编号，供界面显示“等待 #编号”", () => {
  const root = scene();
  const nos = dispatchNoTable(root);
  const view = buildForestView(root, (id) => nos.get(id) ?? "");
  const nodes = view.trees.flatMap((t) => t.nodes);
  const next = nodes.find((n) => n.id === "D-next1");

  assert.ok(next, "后续单要出现在树里");
  assert.equal(next.state, "waiting", "前置未完成时应为等待态");
  assert.equal(next.stuckOn, "D-pre1", "阻塞来源仍是台账 id");
  assert.equal(next.stuckOnNo, nos.get("D-pre1"), "要一并给出前置单编号");
  assert.ok(next.stuckOnNo, "编号不能为空，否则界面只能退回显示 id");
});

test("不在等待态的节点不带编号", () => {
  const root = scene();
  const nos = dispatchNoTable(root);
  const view = buildForestView(root, (id) => nos.get(id) ?? "");
  const nodes = view.trees.flatMap((t) => t.nodes);
  const pre = nodes.find((n) => n.id === "D-pre1");
  assert.ok(pre, "前置单要在树里");
  assert.equal(pre.state, "running");
  assert.equal(pre.stuckOnNo, "", "运行中的单没有等待对象，不该带编号");
});

test("编号表缺失时留空，不用 id 代替编号", () => {
  const root = scene();
  /* 不传 noOf：等同编号表不可用。 */
  const view = buildForestView(root);
  const nodes = view.trees.flatMap((t) => t.nodes);
  const next = nodes.find((n) => n.id === "D-next1");
  assert.ok(next);
  assert.equal(next.stuckOnNo, "", "查不到编号就留空，由界面决定如何显示");
  assert.equal(next.stuckOn, "D-pre1", "阻塞来源照旧保留");
});
