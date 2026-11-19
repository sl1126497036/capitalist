
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { createTaskRoot } = require("../dist/core/contract/init");
const { resolveDispatchNo, ensureTaskForDispatch, readTasks } = require("../dist/core/record/tasks");

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-resolve-no-"));
  createTaskRoot({ target: "派单号发行测试", contractSpec: "minimal", root: base });
  return base;
}

/** 建单并登记，返回派单号。origin 缺省为新任务，给定为对该派单的重派。 */
function disp(root, stage, shard, action, origin) {
  const r = resolveDispatchNo(root, stage, shard, origin);
  ensureTaskForDispatch(root, {
    id: r.dispatchId,
    stage,
    shard: shard ?? "",
    action,
    status: "open",
    attempt: r.attempt,
  });
  return r.dispatchId;
}

test("多个独立任务（同一阶段、无分片）各自发行新任务号", () => {
  const root = sandbox();
  try {
    const ids = [];
    for (let i = 1; i <= 7; i += 1) ids.push(disp(root, "S0", undefined, `任务${i}`));
    assert.deepEqual(ids, ["1-1", "2-1", "3-1", "4-1", "5-1", "6-1", "7-1"]);

    const rows = readTasks(root);
    assert.equal(rows.length, 7, "7 个独立任务应有 7 条任务项");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("同一任务重派（显式传 origin）复用任务号，派发序递增", () => {
  const root = sandbox();
  try {
    const a1 = disp(root, "S0", undefined, "任务A");
    const a2 = disp(root, "S0", undefined, "任务A重派", a1);
    const a3 = disp(root, "S0", undefined, "任务A再重派", a2);

    assert.equal(a1, "1-1");
    assert.equal(a2, "1-2", "重派复用任务号 1、派发序加一");
    assert.equal(a3, "1-3");

    const rows = readTasks(root);
    assert.equal(rows.length, 1, "同一任务重派不新建任务项");
    assert.equal(rows[0].no, 1);
    assert.equal(rows[0].attempts, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("不同任务各自独立，互不干扰", () => {
  const root = sandbox();
  try {
    const a = disp(root, "S0", undefined, "任务A");
    const b = disp(root, "S0", undefined, "任务B");
    const b2 = disp(root, "S0", undefined, "任务B重派", b);
    const c = disp(root, "S0", undefined, "任务C");

    assert.equal(a, "1-1");
    assert.equal(b, "2-1");
    assert.equal(b2, "2-2", "只重派任务 B，任务号 2、派发序 +1");
    assert.equal(c, "3-1", "任务 C 不受任务 B 重派影响");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
