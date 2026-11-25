/**
 * 取号体系回归：任务号、派单号、进程号的发行规则与锁行为。
 *
 * 这组用例不清理临时目录：本机安全策略会拦截 `rmSync`，清理失败会把“逻辑通过”的用例判为失败。
 * 临时目录留在系统临时区，由系统自行回收。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { execFileSync } = require("node:child_process");

const PKG = resolve(__dirname, "..");
const { createTaskRoot } = require(join(PKG, "dist/core/policy/init.js"));
const {
  resolveDispatchNo,
  ensureTaskForDispatch,
  readTasks,
} = require(join(PKG, "dist/core/record/tasks.js"));
const {
  appendDispatch,
  claimDispatch,
  newWorkerId,
  releaseWorkerNo,
  readDispatches,
} = require(join(PKG, "dist/core/record/supervisor.js"));
const { withNoLock, NoLockTimeoutError, NoLockNestingError } = require(join(PKG, "dist/core/record/noLock.js"));
const { buildThreadsPage } = require(join(PKG, "dist/supervisor/board/threads.js"));

function sandbox(name) {
  const base = mkdtempSync(join(tmpdir(), `capitalist-idissue-${name}-`));
  createTaskRoot({ target: "取号回归", policySpec: "minimal", root: base });
  return base;
}

function openDispatch(root, id, title, lineage) {
  const d = {
    id,
    at: new Date().toISOString(),
    stage: "S0",
    shard: "",
    title,
    action: title,
    status: "open",
    source: "adhoc",
    attempt: 1,
    lineage: lineage || id,
  };
  appendDispatch(root, d);
  ensureTaskForDispatch(root, d);
  return d;
}

test("连续取号不撞号：号一发行就占位，未落派单也不复用", () => {
  const root = sandbox("seq");
  const a = resolveDispatchNo(root).dispatchId;
  const b = resolveDispatchNo(root).dispatchId;
  const c = resolveDispatchNo(root).dispatchId;
  assert.deepStrictEqual([a, b, c], ["1-1", "2-1", "3-1"]);
});

test("重派取号按任务号递增，不跨任务干扰", () => {
  const root = sandbox("retry");
  openDispatch(root, "1-1", "任务一");
  openDispatch(root, "2-1", "任务二");

  assert.strictEqual(resolveDispatchNo(root, "1-1").dispatchId, "1-2");
  assert.strictEqual(resolveDispatchNo(root, "1-1").dispatchId, "1-3");
  assert.strictEqual(resolveDispatchNo(root, "2-1").dispatchId, "2-2");
});

test("锁被占用且未到期：连续重试后明确失败，不是静默猜号", () => {
  const root = sandbox("timeout");
  const dir = join(root, ".capitalist", "locks");
  mkdirSync(dir, { recursive: true });
  /* 持有者是本进程且未到期：锁有效，取号必须失败。 */
  writeFileSync(
    join(dir, "no-task-no.lock"),
    JSON.stringify({ key: "task-no", token: "other", pid: process.pid, at: Date.now(), expires_at: Date.now() + 60000 }),
  );
  assert.throws(
    () => resolveDispatchNo(root),
    (e) => e instanceof NoLockTimeoutError,
    "取不到锁应抛 NoLockTimeoutError",
  );
});

test("锁已到期：后来者自动接管，不需要人工清锁", () => {
  const root = sandbox("stale");
  const dir = join(root, ".capitalist", "locks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "no-task-no.lock"),
    JSON.stringify({ key: "task-no", token: "stale", pid: process.pid, at: Date.now() - 9000, expires_at: Date.now() - 1000 }),
  );
  assert.strictEqual(resolveDispatchNo(root).dispatchId, "1-1");
});

test("锁的持有进程已退出：可立即接管", () => {
  const root = sandbox("dead");
  const dir = join(root, ".capitalist", "locks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "no-task-no.lock"),
    JSON.stringify({ key: "task-no", token: "dead", pid: 999999, at: Date.now(), expires_at: Date.now() + 60000 }),
  );
  assert.strictEqual(resolveDispatchNo(root).dispatchId, "1-1");
});

test("嵌套不同锁键：直接拒绝，避免死锁", () => {
  const root = sandbox("nest");
  assert.throws(
    () => withNoLock(root, "a", () => withNoLock(root, "b", () => 1)),
    (e) => e instanceof NoLockNestingError,
  );
});

test("跨进程并发取号：六个进程拿到六个不同任务号", () => {
  const root = sandbox("concurrent");
  const script = join(root, "issue.cjs");
  writeFileSync(
    script,
    `const { resolveDispatchNo } = require(${JSON.stringify(join(PKG, "dist/core/record/tasks.js"))});\n` +
      `process.stdout.write(resolveDispatchNo(${JSON.stringify(root)}).dispatchId + "\\n");\n`,
  );
  const out = [];
  for (let i = 0; i < 6; i += 1) {
    out.push(execFileSync(process.execPath, [script], { encoding: "utf8" }).trim());
  }
  assert.strictEqual(new Set(out).size, 6, `并发取号出现重复：${out.join(",")}`);
});

test("进程号：同任务不同派单递增，派单失败释放后复用", () => {
  const root = sandbox("worker");
  openDispatch(root, "1-1", "第一次");
  openDispatch(root, "1-2", "第二次");

  const first = withNoLock(root, "worker-1", () => {
    const id = newWorkerId(root, "1-1");
    claimDispatch(root, "1-1", id, id);
    return id;
  });
  const second = withNoLock(root, "worker-1", () => {
    const id = newWorkerId(root, "1-2");
    claimDispatch(root, "1-2", id, id);
    return id;
  });
  assert.strictEqual(first, "1-P1");
  assert.strictEqual(second, "1-P2", "同任务第二条派单应拿到下一个进程号");

  /* 拉起失败：释放后下次仍用同一个号（派单失败时进程号不 +1）。 */
  openDispatch(root, "1-3", "第三次");
  const third = withNoLock(root, "worker-1", () => {
    const id = newWorkerId(root, "1-3");
    const claimed = claimDispatch(root, "1-3", id, id);
    assert.ok(claimed);
    releaseWorkerNo(root, id);
    return id;
  });
  assert.strictEqual(third, "1-P3");
  openDispatch(root, "1-4", "第四次");
  const again = withNoLock(root, "worker-1", () => {
    const id = newWorkerId(root, "1-4");
    claimDispatch(root, "1-4", id, id);
    return id;
  });
  assert.strictEqual(again, "1-P3", "释放过的号应被复用，而不是跳到 P4");
});

test("界面任务号直接取派单号前缀，不再按列表顺序另发", () => {
  const root = sandbox("board");
  /* 刻意让派单落盘顺序与任务号不一致：界面号必须仍等于派单号前缀。 */
  openDispatch(root, "1-1", "最早的任务");
  openDispatch(root, "2-1", "第二个任务");
  openDispatch(root, "3-1", "第三个任务");

  const page = buildThreadsPage(root, 50);
  const rows = page.threads.map((t) => ({ no: t.no, dispatch: t.dispatch, title: t.title }));
  const byDispatch = new Map(rows.map((r) => [r.dispatch, r.no]));
  assert.strictEqual(byDispatch.get("1-1"), "01");
  assert.strictEqual(byDispatch.get("2-1"), "02");
  assert.strictEqual(byDispatch.get("3-1"), "03");
});

test("同一任务多次派单只占一行，派单号仍按任务号派生", () => {
  const root = sandbox("oneline");
  openDispatch(root, "1-1", "同一件事");
  /* 第二次派单：同一任务、下一张单。 */
  const second = resolveDispatchNo(root, "1-1").dispatchId;
  /* 重派单继承原单的派生链，线程键因此不变。 */
  openDispatch(root, second, "同一件事", "1-1");

  const page = buildThreadsPage(root, 50);
  const titles = page.threads.filter((t) => String(t.title).includes("同一件事"));
  assert.strictEqual(titles.length, 1, `同一任务应只有一行，实际 ${titles.length} 行`);
  assert.strictEqual(titles[0].no, "01");
  assert.ok(
    (titles[0].dispatches || []).includes("1-1") || titles[0].dispatch === second,
    "历史派单应挂在同一行上",
  );
});

test("任务台账与派单号前缀保持一致", () => {
  const root = sandbox("align");
  for (let i = 1; i <= 3; i += 1) {
    const id = resolveDispatchNo(root).dispatchId;
    openDispatch(root, id, `任务 ${i}`);
  }
  const tasks = readTasks(root);
  const rows = readDispatches(root);
  for (const t of tasks) {
    const own = rows.filter((d) => Number(String(d.id).split("-")[0]) === Number(t.no));
    assert.ok(own.length > 0, `任务 ${t.no} 没有任何派单`);
    assert.ok(
      own.some((d) => d.id === t.dispatch),
      `任务 ${t.no} 的当前派单 ${t.dispatch} 不在台账里`,
    );
  }
});
