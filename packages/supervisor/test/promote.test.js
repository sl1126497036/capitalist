
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/supervisor");
const { createTaskRoot } = require("../dist/core/init");
const { promoteTask } = require("../dist/core/commands");
const { runCommand } = require("../dist/supervisor/board");

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-promote-"));
  createTaskRoot({ target: "插队测试", contractSpec: "minimal", root: base });
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
    ...extra,
  });
}

test("队列顺序：手动置顶 > 插队单 > 台账顺序，后置顶的先上", () => {
  const base = {
    id: "x",
    at: "",
    stage: "S0",
    action: "",
    status: "open",
  };
  const plain = { ...base, id: "a" };
  const urgent = { ...base, id: "b", urgent: true };
  const p1 = { ...base, id: "c", urgent: true, promoted_at: "2026-11-01T10:00:00.000Z" };
  const p2 = { ...base, id: "d", promoted_at: "2026-11-01T11:00:00.000Z" };

  const order = [plain, urgent, p1, p2]
    .map((d, i) => ({ d, i }))
    .sort((x, y) => capitalist.compareQueueOrder(x.d, y.d, x.i, y.i))
    .map((x) => x.d.id);

  assert.deepStrictEqual(order, ["d", "c", "b", "a"], `实际顺序 ${order.join(",")}`);
});

test("置顶只写 promoted_at：status 仍是 open，台账顺序不变", () => {
  const root = sandbox();
  put(root, "D-a");
  put(root, "D-b");
  const r = promoteTask(root, "D-b");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.ahead, 1, "D-a 原本排在它前面，置顶要越过 1 张");

  const rows = capitalist.readDispatches(root);
  assert.deepStrictEqual(rows.map((d) => d.id), ["D-a", "D-b"], "台账顺序不能被搬动");
  const b = rows.find((d) => d.id === "D-b");
  assert.strictEqual(b.status, "open");
  assert.strictEqual(b.urgent, true);
  assert.ok(b.promoted_at, "promoted_at 必须落盘，否则调度层看不出这是手动置顶");
  assert.strictEqual(b.promoted_by, "user");
});

test("重复置顶：刷新时间而不是报错", () => {
  const root = sandbox();
  put(root, "D-a", { urgent: true, promoted_at: "2026-11-01T09:00:00.000Z" });
  put(root, "D-b");
  const r = promoteTask(root, "D-a");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.already, true);
  assert.ok(capitalist.readDispatches(root).find((d) => d.id === "D-a").promoted_at > "2026-11-01T09:00:00.000Z");
});

test("在跑的单不接受插队：给出原因，不改台账", () => {
  const root = sandbox();
  put(root, "D-run", { status: "claimed", worker: "W-1" });
  const r = promoteTask(root, "D-run");
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /已在执行|已经在跑/);
  assert.strictEqual(capitalist.readDispatches(root).find((d) => d.id === "D-run").urgent, undefined);
});

test("终态的单不接受插队：那是唤醒，不是置顶", () => {
  const root = sandbox();
  put(root, "D-done", { status: "done" });
  const r = promoteTask(root, "D-done");
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /终态|唤醒/);
});

test("看板接口：promote 走同一套原语，回执说清越过了几张", () => {
  const root = sandbox();
  put(root, "D-a");
  put(root, "D-b");
  put(root, "D-c");
  const res = runCommand(root, { action: "promote", id: "D-c" });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.ahead, 2);

  const running = runCommand(root, { action: "promote", id: "nope" });
  assert.strictEqual(running.status, 404, "不存在的单不能当成成功");
});



const preempt = require("../dist/core/preempt");

test("立即执行回执：没有别的立即执行在跑时说会腾槽，有的话说排在谁后面", () => {
  const root = sandbox();
  put(root, "D-run", { status: "claimed", worker: "W-run" });
  put(root, "D-now");
  put(root, "D-next");

  const first = promoteTask(root, "D-now");
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.preempt, true, "空槽 / 可腾槽时要说真插队");
  assert.strictEqual(first.behind, "", "没人挡在前面");

  /* 模拟监工已经为 D-now 腾过槽并把它拉起来了：单是 claimed，租约在盘上。 */
  capitalist.claimDispatch(root, "D-now", "W-now");
  preempt.savePreemptLease(root, { dispatch: "D-now", worker: "W-now", at: new Date().toISOString(), yielded: [] });
  const second = promoteTask(root, "D-next");
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.preempt, false, "同一时刻只允许一个立即执行");
  assert.strictEqual(second.behind, "D-now");

  /* 立即执行单结束（退回排队）后租约失效，下一张又能真插队。 */
  capitalist.finishDispatch(root, "D-now", "done", "做完了");
  const third = promoteTask(root, "D-next");
  assert.strictEqual(third.ok, true);
  assert.strictEqual(third.preempt, true, "上一张结束后，租约不再挡路");
});

test("让位：在跑的单退回排队，排队单按原顺序编号，且都不是失败", () => {
  const root = sandbox();
  put(root, "D-run", { status: "claimed", worker: "W-run" });
  put(root, "D-2");
  put(root, "D-3");
  put(root, "D-imm");

  const rows = capitalist.readDispatches(root);
  const order = preempt.yieldOrder(rows, "D-imm").map((d) => d.id);
  assert.deepStrictEqual(order, ["D-run", "D-2", "D-3"], "让位顺序就是让位前的队列顺序");

  const changed = preempt.markYielded(root, order, "D-imm");
  assert.deepStrictEqual(changed, ["D-run", "D-2", "D-3"]);

  const after = capitalist.readDispatches(root);
  for (const d of after) {
    if (d.id === "D-imm") continue;
    assert.strictEqual(d.status, "open", `${d.id} 退回排队，不是失败`);
    assert.ok(d.yielded_at, `${d.id} 要有让位时刻，否则界面看不出它为什么不动`);
    assert.strictEqual(d.yielded_by, "D-imm");
  }
  const ranks = Object.fromEntries(after.filter((d) => d.id !== "D-imm").map((d) => [d.id, d.yield_rank]));
  assert.deepStrictEqual(ranks, { "D-run": 0, "D-2": 1, "D-3": 2 }, "恢复顺序写在台账上");

  /* 台账行序不动：让位不搬行，历史时间线不能被一次插队抹掉。 */
  assert.deepStrictEqual(after.map((d) => d.id), ["D-run", "D-2", "D-3", "D-imm"]);
});

test("恢复：标记清掉、顺序还原；被领走时让位痕迹一起清（不重复计数）", () => {
  const root = sandbox();
  put(root, "D-run", { status: "claimed", worker: "W-run" });
  put(root, "D-2");
  put(root, "D-3");
  put(root, "D-imm");

  preempt.markYielded(root, ["D-run", "D-2", "D-3"], "D-imm");
  /* 让位期间新来一张普通单：它不在让位名单里，恢复后应排在恢复组之后。 */
  put(root, "D-new");

  capitalist.finishDispatch(root, "D-imm", "done", "立即执行的那一单做完了");
  const restored = preempt.releaseYielded(root, "D-imm");
  assert.deepStrictEqual(restored.map((d) => d.id), ["D-run", "D-2", "D-3"], "恢复的是让位过的这几张");
  assert.deepStrictEqual(
    capitalist.openQueue(root).map((d) => d.id),
    ["D-run", "D-2", "D-3", "D-new"],
    "按原顺序恢复，让位期间新来的排在后面",
  );
  for (const d of capitalist.readDispatches(root)) {
    assert.strictEqual(d.yielded_at, undefined, `${d.id} 恢复后不该还挂着让位标记`);
    assert.strictEqual(d.yielded_by, undefined);
  }

  /* 被领走 = 已经回到执行，让位痕迹没有继续存在的理由。 */
  capitalist.claimDispatch(root, "D-run", "W-2");
  const run = capitalist.readDispatches(root).find((d) => d.id === "D-run");
  assert.strictEqual(run.status, "claimed");
  assert.strictEqual(run.yield_rank, undefined, "领走后不再参与排队排序");
});
