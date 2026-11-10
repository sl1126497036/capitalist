/** 看板统计只有一个真相源。 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const board = require(join(PKG, "dist/supervisor/board.js"));
const { createTaskRoot } = require(join(PKG, "dist/core/init.js"));
const { appendDispatch, registerWorker } = require(join(PKG, "dist/core/supervisor.js"));
const { supervisorDir } = require(join(PKG, "dist/core/paths.js"));

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-stats-"));
  createTaskRoot({ target: "统计一致", contractSpec: "minimal", root, supervisor: false });
  return root;
}

function worker(root, id, dispatch, status, shard) {
  const at = new Date(Date.now() - 60_000).toISOString();
  registerWorker(root, {
    id,
    host: "generic",
    pid: 0,
    session: `s-${id}`,
    dispatch,
    shard,
    stage: "S0",
    started_at: at,
    heartbeat_at: at,
    heartbeat_ts: Date.now() / 1000 - 60,
    status,
    log: join(supervisorDir(root), "workers", `${id}.log`),
  });
}

/** 四种当前状态各一单：运行 / 排队 / 异常 / 完成（其中完成的一单已验收）。 */
function seed(root) {
  const at = new Date(Date.now() - 120_000).toISOString();
  const base = { at, stage: "S0", action: "做事", attempt: 1 };

  appendDispatch(root, { id: "D-run", ...base, shard: "run", status: "claimed", worker: "W-run" });
  appendDispatch(root, { id: "D-queued", ...base, shard: "queued", status: "open" });
  appendDispatch(root, { id: "D-fail", ...base, shard: "fail", status: "failed", worker: "W-fail" });
  appendDispatch(root, { id: "D-done", ...base, shard: "done", status: "done", worker: "W-done", done_at: at });

  worker(root, "W-run", "D-run", "running", "run");
  worker(root, "W-fail", "D-fail", "failed", "fail");
  worker(root, "W-done", "D-done", "exited", "done");

  /* 任务池：D-done 这一单验收通过；其余不在 accepted 状态。 */
  writeFileSync(
    join(supervisorDir(root), "tasks.jsonl"),
    [
      { id: "T-run", title: "运行", state: "dispatched", dispatch: "D-run", stage: "S0" },
      { id: "T-done", title: "完成", state: "accepted", dispatch: "D-done", stage: "S0" },
      { id: "T-fail", title: "失败", state: "failed", dispatch: "D-fail", stage: "S0" },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
}

const SUM_KEYS = ["running", "queued", "paused", "failed", "done", "ended", "canceled"];

function assertShape(c) {
  assert.equal(
    c.total,
    SUM_KEYS.reduce((n, k) => n + c[k], 0),
    `总数必须等于各状态之和：${JSON.stringify(c)}`,
  );
}

test("统计唯一来源：四处接口逐字段一致，且总数等于各状态之和", () => {
  const root = sandbox();
  try {
    seed(root);
    const page = board.buildThreadsPage(root, 500);
    const counts = page.counts;
    assert.deepStrictEqual(counts, {
      total: 4,
      running: 1,
      queued: 1,
      paused: 0,
      failed: 1,
      done: 1,
      ended: 0,
      canceled: 0,
      accepted: 1,
    });
    assertShape(counts);

    const capitalist = board.buildSupervisorStatus(root);
    assert.deepStrictEqual(capitalist.tasks, counts, "/api/supervisor 的任务统计必须同源");
    assert.equal(capitalist.running, counts.running, "兼容字段 running 也不能另算");
    assert.equal(capitalist.queued, counts.queued, "兼容字段 queued 也不能另算");

    const met = board.buildMetrics(root);
    assert.deepStrictEqual(met.stats, counts, "/api/metrics 的任务统计必须同源");
    assert.equal(met.done, counts.done, "兼容字段 done 不能另数 worker 收尾记录");
    assert.equal(met.queued, counts.queued, "兼容字段 queued 不能另数派单台账");

    const ov = board.buildOverview([root]);
    assert.deepStrictEqual(ov.tasks, counts, "/api/overview 的合计必须同源");
    assert.deepStrictEqual(ov.roots[0].tasks, counts, "overview 每根也必须同源");
    assertShape(ov.tasks);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("分页不改变统计：limit=1 时数字仍是全量", () => {
  const root = sandbox();
  try {
    seed(root);
    const one = board.buildThreadsPage(root, 1);
    assert.equal(one.threads.length, 1, "列表被截断");
    assert.equal(one.total, 4, "total 是任务总数");
    assert.deepStrictEqual(one.counts, board.buildThreadsPage(root, 500).counts, "统计与分页无关");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("未知状态归异常，不藏进已完成", () => {
  const counts = board.taskCountsOf([
    { id: "a", status: "running" },
    { id: "b", status: "gone" },
    { id: "c", status: "exited" },
    { id: "d", status: "canceled" },
  ]);
  assert.deepStrictEqual(counts, {
    total: 4,
    running: 1,
    queued: 0,
    paused: 0,
    failed: 1,
    done: 1,
    ended: 0,
    canceled: 1,
    accepted: 0,
  });
  assertShape(counts);
});

test("exited 按派单是否结项拆成 done / ended", () => {
  const counts = board.taskCountsOf(
    [
      { id: "S0/settled", status: "exited" },
      { id: "S0/open", status: "exited" },
      { id: "S0/finished", status: "finished" },
    ],
    undefined,
    new Set(["S0/settled", "S0/finished"]),
  );
  assert.deepStrictEqual(counts, {
    total: 3,
    running: 0,
    queued: 0,
    paused: 0,
    failed: 0,
    done: 2,
    ended: 1,
    canceled: 0,
    accepted: 0,
  });
  assertShape(counts);
});
