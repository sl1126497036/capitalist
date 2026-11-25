/**
 * 重开规则。
 *
 * 两条规则必须分开：
 * 1. 用户要求重开：任何状态都能重开，包括在跑的、已完成的、用户结束后又反悔的。
 * 2. 监工自己判定重派：只对失败的单；用户手动结束的单不许被自动拉回队列。
 *
 * 这里覆盖第 1 条与编号定位；第 2 条由 loop 的救援分支保证（只放行 failed）。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { createTaskRoot } = require("../dist/core/policy/init");
const { appendDispatch, readDispatches, requeueDispatch } = require("../dist/core/record/supervisor");
const { dispatchOfThreadNo } = require("../dist/supervisor/usage/threadNo");

const LINEAGE = "D-abc123";

/** 一个任务根：一张指定状态的单，并在编号表里给它 #1。 */
function scenario(status) {
  const root = mkdtempSync(join(tmpdir(), "capitalist-reopen-"));
  createTaskRoot({ target: "重开规则", policySpec: "minimal", root });
  appendDispatch(root, {
    id: LINEAGE,
    at: new Date(Date.now() - 60_000).toISOString(),
    shard: "",
    action: "同一件事",
    status,
    lineage: LINEAGE,
  });
  /* 线程键 = x + lineage 尾 6 位，与 laneKeyOf 的派生一致。 */
  for (const _d of ["runtime", "ledger", "model", "board", "config", "meta", "workers", "sessions", "inbox", "mq", "guard", "brain", "reload", "locks", "archive", ".root"]) mkdirSync(join(root, ".capitalist", _d), { recursive: true });
  writeFileSync(
    join(root, ".capitalist", "ledger", "thread-no.json"),
    JSON.stringify({ next: 2, ids: { "xabc123": 1 } }),
  );
  return root;
}

test("用户要求重开：已结束的单按编号能定位到", () => {
  for (const st of ["done", "closed", "failed"]) {
    const root = scenario(st);
    const hit = dispatchOfThreadNo(root, 1, readDispatches(root), { includeDone: true });
    assert.ok(hit, `${st} 的单必须能被用户按编号找到`);
    assert.strictEqual(hit.id, LINEAGE);
  }
});

test("用户要求重开：用户手动结束（closed）也能翻回队列", () => {
  const root = scenario("closed");
  const next = requeueDispatch(root, LINEAGE, "用户要求重开");
  assert.ok(next, "closed 必须能重开");
  assert.strictEqual(next.status, "open");
});

test("用户要求重开：在途的单同样能翻回队列", () => {
  /* 在途由调用方先停进程，这里只验状态能翻回。 */
  const root = scenario("claimed");
  const next = requeueDispatch(root, LINEAGE, "用户要求重开");
  assert.ok(next);
  assert.strictEqual(next.status, "open");
});

test("只看在途时，已结束的单不会被误当成当前目标", () => {
  const root = scenario("closed");
  assert.strictEqual(
    dispatchOfThreadNo(root, 1, readDispatches(root)),
    undefined,
    "默认口径用于“这单执行到哪一步”，不能把已结束的单算进来",
  );
});
