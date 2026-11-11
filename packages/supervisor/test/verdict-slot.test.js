/** “已上报、等裁决”的单要占住并发槽位。 */

const test = require("node:test");
const assert = require("node:assert");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { awaitingVerdict } = require(join(PKG, "dist/supervisor/loop.js"));
const { VERDICT_HOLD_MS } = require(join(PKG, "dist/core/limits.js"));

function at(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}

function row(status, reportedAgo) {
  const r = { id: `D-${Math.random().toString(36).slice(2, 10)}`, status };
  if (reportedAgo !== undefined) r.reported_at = at(reportedAgo);
  return r;
}

test("刚上报、还在等裁决的单占一个槽", () => {
  assert.strictEqual(awaitingVerdict([row("reported", 5_000)]), 1);
});

test("上报超过窗口的单不再占槽（交给 sweepReported 退回重派）", () => {
  assert.strictEqual(awaitingVerdict([row("reported", VERDICT_HOLD_MS + 60_000)]), 0);
});

test("没有上报时刻的老记录不占槽", () => {
  assert.strictEqual(awaitingVerdict([row("reported")]), 0);
});

test("只有 reported 占槽，其它状态一律不算", () => {
  const rows = [
    row("open"),
    row("claimed"),
    row("done"),
    row("closed"),
    row("failed"),
    row("reported", 1_000),
  ];
  assert.strictEqual(awaitingVerdict(rows), 1);
});

test("多张单在窗口内各自占槽", () => {
  const rows = [row("reported", 1_000), row("reported", 2_000), row("reported", VERDICT_HOLD_MS + 1)];
  assert.strictEqual(awaitingVerdict(rows), 2);
});

test("空台账返回 0", () => {
  assert.strictEqual(awaitingVerdict([]), 0);
});

test("窗口边界：正好卡在阈值上仍算占槽", () => {
  assert.strictEqual(awaitingVerdict([row("reported", VERDICT_HOLD_MS - 5_000)]), 1);
});
