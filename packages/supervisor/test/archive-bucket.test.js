/**
 * 分档清空：清哪一档只动哪一档。
 *
 * 这里守的是三条：
 *   1. 分档只有一处来源（`taskBucket`），计数与列表落到同一档；
 *   2. 清空范围由档内线程决定，清“已取消”不得带走“已完成”；
 *   3. 单卡清除只影响那一张卡。
 *
 * 出现过的线上问题：清空已取消档时，后端按派单状态 `isSettled` 归档，已完成的单一起被移走。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, existsSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { composeDispatch, commitDispatch } = require(join(PKG, "dist/core/dispatch/newDispatch.js"));
const {
  claimDispatch,
  closeDispatch,
  finishDispatch,
  readDispatches,
  registerWorker,
} = require(join(PKG, "dist/core/record/supervisor.js"));
const locations = require(join(PKG, "dist/core/record/locations.js"));
const { archiveRecords } = require(join(PKG, "dist/core/record/archive.js"));
const { buildThreads, taskCountsOf, taskBucket } = require(join(PKG, "dist/supervisor/board/threads.js"));
const { removeScopeOfBucket, removeScopeOfKey } = require(join(PKG, "dist/supervisor/board/removeScope.js"));
const { runCommand } = require(join(PKG, "dist/supervisor/board/commands.js"));

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-bucket-"));
  for (const d of ["runtime", "ledger", "model", "board", "config", "meta", "workers", "sessions", "inbox", "mq", "guard", "brain", "reload", "locks", "archive"]) {
    mkdirSync(join(root, ".capitalist", d), { recursive: true });
  }
  return root;
}

function dropRoot(root) {
  try {
    require("node:fs").rmSync(root, { recursive: true, force: true });
  } catch {
    /* 删除 shim 可能拦下清理 */
  }
}

/** 建一张派单，返回 id。 */
function put(root, id, shard, extra = {}) {
  commitDispatch(
    root,
    composeDispatch({
      id,
      stage: "S0",
      shard,
      title: id,
      action: `做 ${id}`,
      status: extra.status ?? "open",
      source: "adhoc",
      attempt: 1,
    }),
  );
  return id;
}

function addWorker(root, id, dispatchId, shard, status) {
  const dir = locations.workers.of(root, id);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  registerWorker(root, {
    id,
    host: "test",
    pid: 4321,
    session: id,
    dispatch: dispatchId,
    shard,
    stage: "S0",
    started_at: now,
    heartbeat_at: now,
    heartbeat_ts: Date.now() / 1000,
    status,
    log: join(dir, "output.log"),
  });
}

/** 一张已完成、一张已取消、一张运行中，三档互不重叠。 */
function buildThreeBuckets(root) {
  put(root, "D-done", "s1");
  claimDispatch(root, "D-done", "1-P1");
  finishDispatch(root, "D-done", "done");
  addWorker(root, "1-P1", "D-done", "s1", "exited");

  put(root, "D-cancel", "s2");
  claimDispatch(root, "D-cancel", "1-P2");
  closeDispatch(root, "D-cancel", "用户取消", "user");
  addWorker(root, "1-P2", "D-cancel", "s2", "exited");

  put(root, "D-run", "s3");
  claimDispatch(root, "D-run", "1-P3");
  addWorker(root, "1-P3", "D-run", "s3", "running");
}

test("分档只有一处来源：计数与线程的 bucket 一致", () => {
  const root = sandbox();
  try {
    buildThreeBuckets(root);
    const threads = buildThreads(root);
    const byBucket = Object.fromEntries(threads.map((t) => [t.id, t.bucket]));
    assert.equal(byBucket["s0/s1"], "done");
    assert.equal(byBucket["s0/s2"], "canceled");
    assert.equal(byBucket["s0/s3"], "run");

    const counts = taskCountsOf(threads);
    assert.equal(counts.done, 1);
    assert.equal(counts.canceled, 1);
    assert.equal(counts.running, 1);
    assert.equal(counts.total, 3);
  } finally {
    dropRoot(root);
  }
});

test("exited 的结局按派单是否结束分档", () => {
  assert.equal(taskBucket("exited", true), "done");
  assert.equal(taskBucket("exited", false), "queue");
  /* 拿不到线程键时不改变旧行为。 */
  assert.equal(taskBucket("exited"), "done");
});

test("清空已取消只移走已取消的派单与进程", () => {
  const root = sandbox();
  try {
    buildThreeBuckets(root);
    const scope = removeScopeOfBucket(root, "canceled");
    assert.equal(scope.keys.length, 1, "范围只有那一张已取消的卡");
    assert.deepEqual(scope.dispatches, ["D-cancel"]);
    assert.deepEqual(scope.workers, ["1-P2"]);

    const r = archiveRecords(root, { dispatchIds: scope.dispatches, workerIds: scope.workers });
    assert.equal(r.dispatches, 1);
    assert.equal(r.workers, 1);

    const left = readDispatches(root).map((d) => d.id).sort();
    assert.deepEqual(left, ["D-done", "D-run"], "已完成的单与运行中的单必须留在台账");
    assert.ok(existsSync(locations.workers.of(root, "1-P1")), "已完成的进程目录不得移走");
    assert.ok(existsSync(locations.workers.of(root, "1-P3")), "运行中的进程目录不得移走");
    assert.ok(!existsSync(locations.workers.of(root, "1-P2")), "已取消的进程目录应已归档");
  } finally {
    dropRoot(root);
  }
});

test("清空已完成不动已取消", () => {
  const root = sandbox();
  try {
    buildThreeBuckets(root);
    const scope = removeScopeOfBucket(root, "done");
    assert.deepEqual(scope.dispatches, ["D-done"]);
    archiveRecords(root, { dispatchIds: scope.dispatches, workerIds: scope.workers });

    const left = readDispatches(root).map((d) => d.id).sort();
    assert.deepEqual(left, ["D-cancel", "D-run"]);
    assert.ok(existsSync(locations.workers.of(root, "1-P2")), "已取消的进程目录不得移走");
  } finally {
    dropRoot(root);
  }
});

test("clear-threads 只接受已知档名，暂停档拒清", () => {
  const root = sandbox();
  try {
    buildThreeBuckets(root);
    assert.equal(runCommand(root, { action: "clear-threads", bucket: "bogus" }).status, 400);
    assert.equal(runCommand(root, { action: "clear-threads", bucket: "paused" }).status, 409);

    const r = runCommand(root, { action: "clear-threads", bucket: "canceled" });
    assert.equal(r.status, 200);
    assert.equal(r.body.keys, 1);
    assert.match(String(r.body.effective), /已取消/);

    const left = readDispatches(root).map((d) => d.id).sort();
    assert.deepEqual(left, ["D-done", "D-run"], "回执与台账必须只动已取消档");
  } finally {
    dropRoot(root);
  }
});

test("单卡清除只影响选中的那一张", () => {
  const root = sandbox();
  try {
    buildThreeBuckets(root);
    const scope = removeScopeOfKey(root, "s0/s1");
    assert.deepEqual(scope.keys, ["s0/s1"]);

    const r = runCommand(root, { action: "clear-thread", key: "s0/s1" });
    assert.equal(r.status, 200);
    assert.equal(r.body.key, "s0/s1");

    const marks = JSON.parse(readFileSync(locations.board.cleared(root), "utf8"));
    assert.deepEqual(Object.keys(marks), ["s0/s1"], "只写这一张卡的标记");
    assert.equal(readDispatches(root).length, 3, "单卡清除不搬派单，台账保持原样");
  } finally {
    dropRoot(root);
  }
});
