
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const {
  CHAT_VERDICTS,
  REQUIREMENT_HINTS,
  chatVerdictOf,
  dismissChat,
  listUnhandled,
  requirementHints,
  settleChat,
  unhandledFromEvents,
} = require(join(PKG, "dist/supervisor/chatSettle.js"));
const { eventsPath } = require(join(PKG, "dist/core/ledger.js"));
const { recordUserMessage } = require(join(PKG, "dist/core/messages.js"));
const { buildSupervisorLog } = require(join(PKG, "dist/supervisor/board.js"));
const { readJsonl } = require(join(PKG, "dist/core/json.js"));

function sandbox(name = "capitalist-chat-settle-") {
  return mkdtempSync(join(tmpdir(), name));
}

function eventsOf(root, name) {
  return readJsonl(eventsPath(root)).filter((e) => String(e.event ?? e.kind) === name);
}

test("四条动作分支 + 只回答：每一种 verdict 都落一条 chat_settled", () => {
  const root = sandbox();
  const cases = [
    ["dispatched", { dispatch: "SD-1" }],
    ["amended", { dispatch: "D-existing" }],
    ["queued", { dispatch: "SD-2" }],
    ["promoted", { dispatch: "D-now" }],
    ["answered_only", {}],
  ];
  for (const [i, [verdict, extra]] of cases.entries()) {
    settleChat(root, { msg_id: `M-${i}`, verdict, text: "把这块改一下", thread: "", ...extra });
  }
  const rows = eventsOf(root, "chat_settled");
  assert.strictEqual(rows.length, 5);
  assert.deepStrictEqual(
    rows.map((r) => r.verdict),
    ["dispatched", "amended", "queued", "promoted", "answered_only"],
  );
  /* 字段齐全：msg_id / verdict / at 必填，dispatch 有则填。 */
  for (const r of rows) {
    assert.ok(String(r.msg_id || ""), "msg_id 必填");
    assert.ok(String(r.at || ""), "at 必填");
    assert.ok(CHAT_VERDICTS.includes(r.verdict));
  }
  assert.strictEqual(rows[0].dispatch, "SD-1");
  assert.strictEqual(rows[1].dispatch, "D-existing");
  assert.strictEqual(rows[4].dispatch, undefined, "只回答不该有 dispatch");
});

test("失败路径同样落账：登记失败按 answered_only 记，并带上原因", () => {
  const root = sandbox();
  const r = settleChat(root, {
    msg_id: "M-fail",
    verdict: "answered_only",
    text: "这里的滚动太快了，不要一下跳到底",
    error: "登记失败：命令行未返回原因",
  });
  const rows = eventsOf(root, "chat_settled");
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].verdict, "answered_only");
  assert.match(String(rows[0].error || ""), /登记失败/);
  assert.strictEqual(r.unhandled, true);
});

test("answered_only + 要求特征 → 追加 chat_unhandled", () => {
  const root = sandbox();
  const r = settleChat(root, {
    msg_id: "M-req",
    verdict: "answered_only",
    text: "消息数不要了，换一个闪光的小点就行了",
  });
  assert.strictEqual(r.unhandled, true);
  assert.ok(r.hints.includes("不要"));
  const [row] = eventsOf(root, "chat_unhandled");
  assert.ok(row, "应有一条 chat_unhandled");
  assert.strictEqual(row.msg_id, "M-req");
  assert.strictEqual(row.text, "消息数不要了，换一个闪光的小点就行了");
  assert.ok(Array.isArray(row.hints) && row.hints.includes("不要"));
  const items = listUnhandled(root);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].msg_id, "M-req");
});

test("纯提问：只有 chat_settled，不产生 chat_unhandled", () => {
  const root = sandbox();
  const r = settleChat(root, {
    msg_id: "M-ask",
    verdict: "answered_only",
    text: "这一单现在跑到哪一步了？",
  });
  assert.strictEqual(r.unhandled, false);
  assert.deepStrictEqual(r.hints, []);
  assert.strictEqual(eventsOf(root, "chat_settled").length, 1);
  assert.strictEqual(eventsOf(root, "chat_unhandled").length, 0);
  assert.deepStrictEqual(listUnhandled(root), []);
});

test("有动作的 verdict 不会落 chat_unhandled（即便原话带要求特征）", () => {
  const root = sandbox();
  const r = settleChat(root, {
    msg_id: "M-ok",
    verdict: "dispatched",
    text: "把这个改成两列",
    dispatch: "SD-9",
  });
  assert.strictEqual(r.unhandled, false);
  assert.strictEqual(eventsOf(root, "chat_unhandled").length, 0);
});

test("人后来补建单 → 出列；人点「已答复」→ 出列", () => {
  const root = sandbox();
  settleChat(root, { msg_id: "M-a", verdict: "answered_only", text: "新增一个入口" });
  settleChat(root, { msg_id: "M-b", verdict: "answered_only", text: "把按钮挪到中间" });
  assert.strictEqual(listUnhandled(root).length, 2);

  /* 补建单：同一条消息再落一条 dispatched。 */
  settleChat(root, { msg_id: "M-a", verdict: "dispatched", text: "新增一个入口", dispatch: "SD-10" });
  let items = listUnhandled(root);
  assert.deepStrictEqual(items.map((x) => x.msg_id), ["M-b"]);

  /* 已答复：不再出现。 */
  assert.strictEqual(dismissChat(root, { msg_id: "M-b" }), true);
  assert.deepStrictEqual(listUnhandled(root), []);
  assert.strictEqual(eventsOf(root, "chat_dismissed").length, 1);
});

test("时间倒序：后处理的排在前面", () => {
  const rows = [
    { event: "chat_unhandled", msg_id: "M-old", text: "改成 A", at: "2026-11-04T00:00:00.000Z", hints: ["改成"] },
    { event: "chat_unhandled", msg_id: "M-new", text: "改成 B", at: "2026-11-04T01:00:00.000Z", hints: ["改成"] },
  ];
  assert.deepStrictEqual(unhandledFromEvents(rows).map((x) => x.msg_id), ["M-new", "M-old"]);
});

test("不回填存量：没有 chat_unhandled 的历史发言不会被算成待处理", () => {
  const rows = [
    { event: "supervisor_chat_ask", msg_id: "M-legacy", text: "把这里改成两列", at: "2026-11-03T05:00:00.000Z" },
    { event: "supervisor_reply", text: "好的", at: "2026-11-03T05:00:05.000Z" },
  ];
  assert.deepStrictEqual(unhandledFromEvents(rows), []);
});

test("要求特征清单与判定：按派单给定的 15 个词，保持清单顺序去重", () => {
  assert.strictEqual(REQUIREMENT_HINTS.length, 15);
  assert.deepStrictEqual(
    requirementHints("把这块改成两列，去掉多余的按钮，不要重复"),
    ["改成", "去掉", "不要"],
  );
  assert.deepStrictEqual(requirementHints("这单为什么还没跑？"), []);
  assert.deepStrictEqual(requirementHints(""), []);
});

test("动作 → verdict 映射：dispatch/amend/queue/promote 各归各类，--now 算 promote", () => {
  assert.strictEqual(chatVerdictOf("dispatch", "做一件事"), "dispatched");
  assert.strictEqual(chatVerdictOf("dispatch", "--now 做一件事"), "promoted");
  assert.strictEqual(chatVerdictOf("amend", "D-1 加一句"), "amended");
  assert.strictEqual(chatVerdictOf("queue", "排队"), "queued");
  assert.strictEqual(chatVerdictOf("promote", "D-1"), "promoted");
  /* 其余调度动作确实落成了指令，但没有对应的用户可见类别：一律 dispatched。 */
  assert.strictEqual(chatVerdictOf("pause", ""), "dispatched");
});

test("没有 msg_id 的调用不落账（老入口不带标识）", () => {
  const root = sandbox();
  const r = settleChat(root, { msg_id: "", verdict: "answered_only", text: "改成两列" });
  assert.strictEqual(r.unhandled, false);
  assert.strictEqual(readJsonl(eventsPath(root)).length, 0);
});

test("对话流投影：未建单的发言在 capitalist-events 里带 unhandled 标记，纯提问不带", () => {
  const root = sandbox();
  const asked = recordUserMessage(root, { text: "新消息挪到中间，这里上方" });
  settleChat(root, { msg_id: asked.id, verdict: "answered_only", text: "新消息挪到中间，这里上方" });
  const plain = recordUserMessage(root, { text: "这一单现在跑到哪一步了？" });
  settleChat(root, { msg_id: plain.id, verdict: "answered_only", text: "这一单现在跑到哪一步了？" });

  const log = buildSupervisorLog(root, { hours: 0 });
  const reqMsg = log.messages.find((m) => m.role === "user" && m.text === "新消息挪到中间，这里上方");
  const plainMsg = log.messages.find((m) => m.role === "user" && m.text === "这一单现在跑到哪一步了？");
  assert.ok(reqMsg, "要求那条应出现在监工流里");
  assert.strictEqual(reqMsg.unhandled, true, "带要求特征、没建单的发言要挂未建单标记");
  assert.strictEqual(reqMsg.msg_id, asked.id, "标记要带 msg_id，前端靠它回查原话");
  assert.ok(plainMsg, "纯提问也要照常上屏");
  assert.strictEqual(plainMsg.unhandled, undefined, "纯提问不该出现未建单标记");

  /* 人补建单之后，标记消失。 */
  settleChat(root, { msg_id: asked.id, verdict: "dispatched", text: "新消息挪到中间，这里上方", dispatch: "SD-11" });
  const after = buildSupervisorLog(root, { hours: 0 });
  const settled = after.messages.find((m) => m.role === "user" && m.text === "新消息挪到中间，这里上方");
  assert.strictEqual(settled.unhandled, undefined, "补建单后不再标未建单");
});
