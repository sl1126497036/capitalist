/**
 * 卡点是组时的界面取值：报组号，成员号只作附注。
 *
 * 守两件事：同一张单同时挂着组与组内成员时，`stuck_on` 是组号而不是第一个成员；
 * 首个未完成成员另放 `stuck_member_no`，不被当成卡点本身。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const cap = require("../dist/core/record/supervisor");
const { createTaskRoot } = require("../dist/core/policy/init");
const { buildThreadsPage } = require("../dist/supervisor/board/threads");
const { buildForestView } = require("../dist/supervisor/view/forestView");

/** 两名成员 + 一张挂在组上的下游；成员状态由调用方给。 */
function scene(memberA = "claimed", memberB = "open") {
  const root = mkdtempSync(join(tmpdir(), "capitalist-wait-group-"));
  createTaskRoot({ target: "等待组号", policySpec: "minimal", root });
  const at = new Date(Date.now() - 120_000).toISOString();
  const put = (row) => cap.appendDispatch(root, { at, stage: "S0", lineage: row.id, ...row });
  put({ id: "59-1", action: "成员一", status: memberA, group: "G2" });
  put({ id: "60-1", action: "成员二", status: memberB, group: "G2" });
  put({
    id: "62-1",
    at: new Date().toISOString(),
    action: "下游",
    status: "open",
    parent: "G2",
    parent_reason: "整组完成才放行",
    /* 挂组后遗留的成员边：与组边指同一批前置。 */
    after: ["59-1", "60-1"],
  });
  writeFileSync(
    join(root, ".capitalist", "inbox", "groups.jsonl"),
    `${JSON.stringify({ id: "G2", title: "提示词清单", at, state: "open" })}\n`,
  );
  return root;
}

function threadOf(page, no) {
  return page.threads.find((t) => String(t.no) === no);
}

test("等待组时卡点报组号，首个未完成成员只作附注", () => {
  const page = buildThreadsPage(scene(), 50);
  const t = threadOf(page, "62");
  assert.ok(t, "下游单要出现在列表里");
  assert.strictEqual(t.stuck_on, "#G02", "卡点写组号");
  assert.strictEqual(t.stuck_on_no, "", "组号不走任务号位");
  assert.strictEqual(t.stuck_member_no, "59", "附注取组内首个未完成成员");
});

test("组内成员全部完成时不再显示等待", () => {
  const t = threadOf(buildThreadsPage(scene("done", "done"), 50), "62");
  assert.ok(t);
  assert.strictEqual(t.stuck_on, "");
  assert.strictEqual(t.stuck_on_no, "");
  assert.strictEqual(t.stuck_member_no, undefined);
});

test("任务树上的等待也写组号，不退回成员号", () => {
  const view = buildForestView(scene());
  const node = view.trees.flatMap((tr) => tr.nodes).find((n) => n.id === "62-1");
  assert.ok(node, "下游单要在树里");
  assert.strictEqual(node.state, "waiting");
  assert.strictEqual(node.stuckOn, "#G02");
  assert.strictEqual(node.stuckOnNo, "");
});
