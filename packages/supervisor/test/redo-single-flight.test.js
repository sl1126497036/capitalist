/**
 * 重开只对已结束的单生效，同一任务只允许一张在途单。
 *
 * 事故背景：#15 的一条追加同时触发 amend 与 redo，amend 开出 15-2 后 redo 又把 15-2
 * 复制成 15-3。两张单同时拉起，后一张因会话被占而换新会话，从零重做并撞回已改过的地方。
 *
 * 钉住四件事：
 *   1. 同一任务已有在途单时，redo 被拒绝，不建新单。
 *   2. 无在途单时，redo 复制最近一张已结束的单，派发序 +1。
 *   3. 按编号取单时，`settledOnly` 跳过在途单。
 *   4. 新会话的交接摘要取上一张已结束单的结论，并提示先核对工作树。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdirSync, mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/record/supervisor");
const { createTaskRoot } = require("../dist/core/contract/init");
const { loadState } = require("../dist/core/record/state");
const { appendSupervisorDirective, listSupervisorDirectives } = require("../dist/supervisor/channel/direct");
const { dispatchOfThreadNo } = require("../dist/supervisor/usage/threadNo");
const { handoffLines, lastSettledOf } = require("../dist/core/record/outcome");
const loop = require("../dist/supervisor/loop");

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-redo-single-"));
  createTaskRoot({ target: "重开单飞", contractSpec: "minimal", root });
  for (const dir of [
    "runtime",
    "ledger",
    "model",
    "board",
    "config",
    "meta",
    "workers",
    "sessions",
    "inbox",
    "mq",
    "guard",
    "brain",
    "reload",
    "locks",
    "archive",
    ".root",
  ]) {
    mkdirSync(join(root, ".capitalist", dir), { recursive: true });
  }
  return root;
}

function seed(root, row) {
  capitalist.appendDispatch(root, {
    at: new Date().toISOString(),
    stage: "S0",
    shard: "",
    action: "按终稿清单落地文案修改",
    status: "open",
    ...row,
  });
}

async function runDirectives(root) {
  await loop.__testing.applySupervisorDirectives({
    root,
    contract: { stages: [], data: {} },
    state: loadState(root),
    wopts: {},
    concurrency: null,
    out: () => {},
  });
}

function redoDirective(root, arg) {
  appendSupervisorDirective(root, {
    action: "redo",
    arg,
    confirm: true,
    via: "capitalist",
    msg_id: "15-U2S-1795363028723",
  });
}

function lastResult(root) {
  const rows = listSupervisorDirectives(root);
  return rows[rows.length - 1];
}

test("同一任务有在途单时 redo 被拒绝", async () => {
  const root = sandbox();
  seed(root, { id: "15-1", status: "done", lineage: "15-1", note: "已落地 455 条替换" });
  seed(root, { id: "15-2", status: "open", lineage: "15-1" });

  redoDirective(root, "#15");
  await runDirectives(root);

  const rows = capitalist.readDispatches(root).filter((d) => String(d.id).startsWith("15-"));
  assert.equal(rows.length, 2, "在途单存在时不得再建单");
  const rec = lastResult(root);
  assert.equal(rec.result.ok, false);
  assert.match(rec.result.reason, /正在执行/);
  assert.match(rec.result.reason, /amend #15/);
});

test("无在途单时 redo 复制最近一张已结束的单", async () => {
  const root = sandbox();
  seed(root, { id: "15-1", status: "done", lineage: "15-1", note: "已落地 455 条替换" });
  seed(root, { id: "15-2", status: "closed", lineage: "15-1", note: "用户手动结束" });

  redoDirective(root, "#15");
  await runDirectives(root);

  const rec = lastResult(root);
  assert.equal(rec.result.ok, true, rec.result.reason);
  const rows = capitalist.readDispatches(root);
  assert.equal(rows.length, 3);
  const fresh = rows.find((d) => d.id === "15-3");
  assert.ok(fresh, "应派出 15-3");
  assert.equal(fresh.status, "open");
  assert.equal(fresh.source, "requeue");
  assert.equal(fresh.action, "按终稿清单落地文案修改");
  assert.equal(fresh.lineage, "15-1");
});

test("按编号取单：settledOnly 跳过在途单", () => {
  const root = sandbox();
  seed(root, { id: "15-1", status: "done", lineage: "15-1" });
  seed(root, { id: "15-2", status: "open", lineage: "15-1" });

  const rows = capitalist.readDispatches(root);
  assert.equal(dispatchOfThreadNo(root, 15, rows, { settledOnly: true }).id, "15-1");
  assert.equal(dispatchOfThreadNo(root, 15, rows).id, "15-2");
});

test("交接摘要取上一张已结束单的结论", () => {
  const root = sandbox();
  seed(root, { id: "15-1", status: "done", lineage: "15-1", note: "恢复 8 处契约表述", review_note: "61 个测试文件只改用例名" });
  seed(root, { id: "15-2", status: "open", lineage: "15-1" });

  const prev = lastSettledOf(root, { id: "15-3", lineage: "15-1", shard: "" });
  assert.equal(prev.id, "15-1", "在途单不是上一轮结论");
  const lines = handoffLines(prev).join("\n");
  assert.match(lines, /15-1/);
  assert.match(lines, /恢复 8 处契约表述/);
  assert.match(lines, /61 个测试文件只改用例名/);
  assert.match(lines, /git status/);
});

test("没有已结束单时不生成交接摘要", () => {
  const root = sandbox();
  seed(root, { id: "16-1", status: "open", lineage: "16-1" });
  assert.equal(lastSettledOf(root, { id: "16-2", lineage: "16-1", shard: "" }), null);
  assert.deepEqual(handoffLines(null), []);
});

test("其他任务的在途单不影响本任务重开", async () => {
  const root = sandbox();
  seed(root, { id: "15-1", status: "done", lineage: "15-1" });
  seed(root, { id: "16-1", status: "open", lineage: "16-1" });

  redoDirective(root, "#15");
  await runDirectives(root);

  const rec = lastResult(root);
  assert.equal(rec.result.ok, true, rec.result.reason);
  assert.ok(
    capitalist.readDispatches(root).some((d) => d.id === "15-2"),
    "另一任务在跑不妨碍本任务重开",
  );
});
