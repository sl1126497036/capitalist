/**
 * 派单级暂停：启动标记、调度跳过、唤醒恢复、看板分档。
 *
 * 暂停是上次退出时未完成派单的默认状态，不是全局暂停：新派单照常执行，旧单等用户唤醒。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/supervisor");
const { createTaskRoot } = require("../dist/core/init");
const { loadState } = require("../dist/core/state");
const loop = require("../dist/supervisor/loop");
const board = require("../dist/supervisor/board");

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-pause-"));
  createTaskRoot({ target: "暂停测试", contractSpec: "minimal", root });
  return root;
}

function put(root, id, extra = {}) {
  capitalist.appendDispatch(root, {
    id,
    at: new Date().toISOString(),
    stage: "S1",
    shard: id,
    action: `做 ${id}`,
    status: "open",
    ...extra,
  });
}

const rowOf = (root, id) => capitalist.readDispatches(root).find((d) => d.id === id);

test("启动只暂停未完成的派单，已结项的不动", () => {
  const root = sandbox();
  put(root, "D-open");
  put(root, "D-claimed", { status: "claimed", worker: "W-1" });
  put(root, "D-done", { status: "done", done_at: new Date().toISOString() });

  const held = loop.holdLegacyDispatches(root);
  assert.strictEqual(held, 2, "open 与 claimed 各一张");

  const open = rowOf(root, "D-open");
  assert.ok(open.paused_at, "暂停标记要落盘");
  assert.strictEqual(open.paused_by, "startup");
  assert.strictEqual(open.status, "open", "暂停不改状态：它仍是一张待办的派单");

  assert.strictEqual(rowOf(root, "D-done").paused_at, undefined, "已结项的单不该被暂停");
});

test("暂停标记幂等：重复启动不刷新暂停时刻", () => {
  const root = sandbox();
  put(root, "D-a");
  loop.holdLegacyDispatches(root);
  const first = rowOf(root, "D-a").paused_at;

  const again = loop.holdLegacyDispatches(root);
  assert.strictEqual(again, 0, "已有标记的不重复写入");
  assert.strictEqual(rowOf(root, "D-a").paused_at, first, "暂停时刻要指向用户失去控制的那次");
});

test("暂停单不被领取，也不参与填槽", () => {
  const root = sandbox();
  put(root, "D-a");
  loop.holdLegacyDispatches(root);

  assert.strictEqual(capitalist.firstOpenDispatch(root), undefined, "capitalist next 不能领暂停单");
  assert.ok(capitalist.pausedDispatches(root).some((d) => d.id === "D-a"));

  const contract = { name: "minimal", data: {}, stages: [{ id: "S1", name: "执行" }] };
  loop.__testing.fillSlots(root, contract, loadState(root), "claude", 1, {}, () => {});
  assert.strictEqual(rowOf(root, "D-a").status, "open", "填槽必须跳过暂停单");
  assert.strictEqual(capitalist.listWorkers(root).length, 0, "暂停单不拉起工作进程");
});

test("唤醒清除标记；失败单退回排队并清掉终止字段", () => {
  const root = sandbox();
  put(root, "D-fail", {
    status: "failed",
    done_at: new Date().toISOString(),
    retry_verdict: "give_up",
    note: "连续失败",
  });
  assert.strictEqual(capitalist.holdDispatch(root, "D-fail", "startup", "上次退出时未完成"), true);

  const r = capitalist.wakeDispatch(root, "D-fail");
  assert.deepStrictEqual({ from: r.from, to: r.to }, { from: "failed", to: "open" });

  const d = rowOf(root, "D-fail");
  assert.strictEqual(d.status, "open");
  assert.strictEqual(d.paused_at, undefined);
  assert.strictEqual(d.retry_verdict, undefined, "retry_verdict 留着会再次挡住重派");
  assert.strictEqual(d.done_at, undefined, "done_at 留着会被当作已终结");
  assert.ok(capitalist.firstOpenDispatch(root), "唤醒后可被领取");
});

test("已结项的单不唤醒：完成或关闭是终态", () => {
  const root = sandbox();
  put(root, "D-done", { status: "done", done_at: new Date().toISOString() });
  capitalist.holdDispatch(root, "D-done", "startup", "测试");
  assert.strictEqual(capitalist.wakeDispatch(root, "D-done"), null);
  assert.strictEqual(rowOf(root, "D-done").status, "done");
});

test("未暂停的单不唤醒，返回 null", () => {
  const root = sandbox();
  put(root, "D-plain");
  assert.strictEqual(capitalist.wakeDispatch(root, "D-plain"), null);
});

test("看板：暂停单独成档，线程状态与计数一致", () => {
  const root = sandbox();
  put(root, "D-p");
  loop.holdLegacyDispatches(root);

  assert.strictEqual(board.taskBucket("paused"), "paused");
  const counts = board.taskCountsOf([
    { id: "a", status: "paused" },
    { id: "b", status: "queued" },
  ]);
  assert.strictEqual(counts.paused, 1);
  assert.strictEqual(counts.queued, 1);
  assert.strictEqual(counts.total, 2, "每条线程只进一档");

  const t = board.buildThreads(root).find((x) => x.dispatch === "D-p");
  assert.ok(t, "暂停单要出现在队列里，否则用户看不到它在等唤醒");
  assert.strictEqual(t.status, "paused", "线程状态与卡片状态词同源");
});

test("暂停单算作待办：监工不因它转成待命", () => {
  const root = sandbox();
  put(root, "D-p", { status: "failed" });
  capitalist.holdDispatch(root, "D-p", "startup", "测试");

  const state = loadState(root);
  const contract = { name: "minimal", data: {}, stages: [{ id: "S1", name: "执行", done: { type: "none" } }] };
  assert.strictEqual(loop.hasPendingWork(root, contract, state), true, "队列里挂着暂停单不是“无待办”");
});

test("启动后新派单不受旧单暂停影响：仍可被领取与填槽", () => {
  const root = sandbox();
  put(root, "D-old");
  loop.holdLegacyDispatches(root);
  /* 监工已运行中时宿主侧派入的单：没有暂停标记。 */
  put(root, "D-new");

  assert.strictEqual(capitalist.firstOpenDispatch(root)?.id, "D-new", "暂停旧单不挡新单领取");

  const contract = { name: "minimal", data: {}, stages: [{ id: "S1", name: "执行" }] };
  loop.__testing.fillSlots(root, contract, loadState(root), "claude", 1, {}, () => {});
  assert.strictEqual(rowOf(root, "D-old").status, "open", "旧单保持暂停");
  assert.strictEqual(rowOf(root, "D-new").status, "claimed", "新单立即进入执行");
});
