/** 台账与状态写入的回归测试。 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  recordViolation,
  openViolations,
  resolveViolations,
  recordReview,
  openReviews,
  resolveReviews,
  loadSessions,
  touchSession,
  retireSession,
} = require("../dist/core/ledger");
const { loadState, updateState } = require("../dist/core/state");

function tmpRoot(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "capitalist-ledger-"));
  mkdirSync(join(root, ".capitalist", "inbox"), { recursive: true });
  writeFileSync(
    join(root, ".capitalist", "state.json"),
    JSON.stringify({
      version: 2,
      target: "t",
      contract: "minimal",
      contract_path: "x",
      stage: "S0",
      next_action: "",
      rev: 0,
      ...extra,
    }),
  );
  return root;
}

const hit = (root, evidence, session = "s1") =>
  recordViolation(root, {
    rule: "LOCAL-DELETE",
    label: "删除越界",
    evidence,
    decision: "BLOCK",
    session,
  });

test("同一命令 60 秒内只记一次（否则“第几次”这个信号就废了）", () => {
  const root = tmpRoot();
  const a = hit(root, "rm -rf /tmp/x");
  const b = hit(root, "rm -rf /tmp/x");
  const c = hit(root, "rm -rf /tmp/x");

  assert.equal(a.recorded, true);
  assert.equal(a.nth, 1);
  assert.equal(b.recorded, false, "重复内容不记账");
  assert.equal(b.nth, 1);
  assert.equal(c.nth, 1);
  assert.equal(openViolations(root, "s1").length, 1);
});

test("内容不同则累加：nth 递增到 3，level 同步升到 3", () => {
  const root = tmpRoot();
  assert.equal(hit(root, "rm -rf /tmp/a").nth, 1);
  assert.equal(hit(root, "rm -rf /tmp/b").nth, 2);
  const third = hit(root, "rm -rf /tmp/c");
  assert.equal(third.nth, 3);
  assert.equal(third.level, 3);
});

test("会话隔离：别的会话的账不算到本会话头上", () => {
  const root = tmpRoot();
  hit(root, "rm -rf /tmp/a", "s1");
  hit(root, "rm -rf /tmp/b", "s2");
  assert.equal(openViolations(root, "s1").length, 1);
  assert.equal(openViolations(root, "s2").length, 1);

  const n = resolveViolations(root, { session: "s1" });
  assert.equal(n, 1);
  assert.equal(openViolations(root, "s1").length, 0);
  assert.equal(openViolations(root, "s2").length, 1, "不该误清别的会话");
});

test("消解之后同类再犯算新的一次", () => {
  const root = tmpRoot();
  hit(root, "rm -rf /tmp/a");
  hit(root, "rm -rf /tmp/b");
  assert.equal(openViolations(root, "s1")[0].nth, 2);

  resolveViolations(root, { session: "s1" });
  assert.equal(openViolations(root, "s1").length, 0);

  // 已消解的记录不参与去重，也不计入次数
  const again = hit(root, "rm -rf /tmp/c");
  assert.equal(again.nth, 3, "累计次数继续递增（历史不过期）");
  assert.equal(openViolations(root, "s1")[0].nth, 3);
});

test("复核队列：同一证据不重复排队，消解后可再排", () => {
  const root = tmpRoot();
  const first = recordReview(root, {
    rule: "LOCAL-OUTSIDE",
    label: "越界放行",
    why: "已登记理由",
    evidence: "cat C:/outside/x",
    session: "s1",
  });
  const dup = recordReview(root, {
    rule: "LOCAL-OUTSIDE",
    label: "越界放行",
    why: "已登记理由",
    evidence: "cat C:/outside/x",
    session: "s1",
  });
  assert.equal(first, true);
  assert.equal(dup, false);
  assert.equal(openReviews(root).length, 1);

  assert.equal(resolveReviews(root, "0"), 1);
  assert.equal(openReviews(root).length, 0);

  const again = recordReview(root, {
    rule: "LOCAL-OUTSIDE",
    label: "越界放行",
    evidence: "cat C:/outside/x",
    session: "s1",
  });
  assert.equal(again, true, "消解之后同一条动作可以重新排队");
});

test("会话登记与退役", () => {
  const root = tmpRoot();
  touchSession(root, "s1");
  touchSession(root, "s1", { compact: true });
  touchSession(root, "s2");

  const all = loadSessions(root);
  assert.equal(Object.keys(all).length, 2);
  assert.equal(all.s1.compacts, 1);
  assert.equal(all.s1.retired, false);

  assert.equal(retireSession(root, "s1", "交接"), true);
  assert.equal(loadSessions(root).s1.retired, true);
  assert.equal(retireSession(root, "nope"), false, "没登记过的会话不该假装退役成功");
});

test("updateState：成功写会把 rev 加一", () => {
  const root = tmpRoot();
  const before = loadState(root).rev;
  updateState(root, (s) => {
    s.next_action = "新的一步";
  });
  const after = loadState(root);
  assert.equal(after.rev, before + 1);
  assert.equal(after.next_action, "新的一步");
});

test("updateState：任务根不存在时返回 null，不抛", () => {
  const root = join(tmpdir(), "definitely-no-capitalist-root-xyz");
  assert.equal(updateState(root, (s) => { s.stage = "S9"; }), null);
});
