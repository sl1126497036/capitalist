/**
 * 消息引用的持久化与重建（派单：聊天消息引用刷新后丢失）+ 严重异常摘要（上下文瘦身）。
 *
 * 钉住三件事：
 *   1. recordUserMessage 带 quote 时，supervisor_chat_ask 事件持久化 quote 与 quote_text；
 *      不带引用时两个字段都不写（老行为不变）。
 *   2. buildSupervisorLog 重建时把 quote / quote_text 原样下发，前端按同一字段画
 *      引用块，刷新后不再只剩正文。
 *   3. severeSupervisorEventLines 只取白名单内的严重异常，心跳（supervisor_tick）与过程流水进不来，
 *      条数有上限。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { recordUserMessage } = require(join(PKG, "dist/core/messages.js"));
const { buildSupervisorLog } = require(join(PKG, "dist/supervisor/board.js"));
const { severeSupervisorEventLines, supervisorChatTurnSessionId } = require(join(PKG, "dist/supervisor/reload.js"));
const { eventsPath, recordEvent } = require(join(PKG, "dist/core/ledger.js"));
const { readJsonl } = require(join(PKG, "dist/core/json.js"));

function sandbox(name = "capitalist-msg-quote-") {
  return mkdtempSync(join(tmpdir(), name));
}

function eventsOf(root, name) {
  return readJsonl(eventsPath(root)).filter((e) => String(e.event ?? e.kind) === name);
}

test("带引用的发言：quote 与原文摘要随 supervisor_chat_ask 持久化", () => {
  const root = sandbox();
  recordUserMessage(root, {
    text: "按这张图改",
    quote: "SE-abc123",
    quoteText: "把顶栏改成一行",
  });
  const rows = eventsOf(root, "supervisor_chat_ask");
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].quote, "SE-abc123");
  assert.strictEqual(rows[0].quote_text, "把顶栏改成一行");
});

test("不带引用的发言：不写 quote 字段（老行为不变）", () => {
  const root = sandbox();
  recordUserMessage(root, { text: "现在什么情况" });
  const rows = eventsOf(root, "supervisor_chat_ask");
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].quote, undefined);
  assert.strictEqual(rows[0].quote_text, undefined);
});

test("重建路径：buildSupervisorLog 把引用原样下发", () => {
  const root = sandbox();
  recordUserMessage(root, {
    text: "按这张图改",
    quote: "SE-abc123",
    quoteText: "把顶栏改成一行",
  });
  const log = buildSupervisorLog(root, { limit: 50 });
  const hit = log.messages.find((m) => String(m.msg_id ?? "").startsWith("M-"));
  assert.ok(hit, "用户发言应出现在监工流里");
  assert.strictEqual(hit.quote, "SE-abc123");
  assert.strictEqual(hit.quote_text, "把顶栏改成一行");
});

test("严重异常摘要：心跳与过程流水进不来，只有白名单内的严重事件", () => {
  const root = sandbox();
  mkdirSync(join(root, ".capitalist"), { recursive: true });
  const events = join(root, ".capitalist", "events.jsonl");
  const row = (e) => `${JSON.stringify(e)}\n`;
  appendFileSync(
    events,
    row({ at: "2026-11-05T01:00:00.000Z", event: "supervisor_tick", n: 1 }) +
      row({ at: "2026-11-05T01:00:05.000Z", event: "supervisor_done", stage: "WORK" }) +
      row({ at: "2026-11-05T01:00:10.000Z", event: "supervisor_chat_ask", text: "在吗" }) +
      row({ at: "2026-11-05T01:00:20.000Z", event: "worker_killed", worker: "W-1", reason: "worker timeout" }) +
      row({ at: "2026-11-05T01:00:30.000Z", event: "contract_error", error: "bad json" }) +
      row({ at: "2026-11-05T01:00:40.000Z", event: "supervisor_tick", n: 2 }),
  );
  const lines = severeSupervisorEventLines(root);
  assert.strictEqual(lines.length, 2, "只有两条严重异常");
  assert.ok(lines[0].includes("中断进程"), "worker_killed 出中文标签");
  assert.ok(lines[0].includes("W-1"));
  assert.ok(lines[1].includes("任务列表解析失败"), "contract_error 出中文标签");
  /* 心跳与普通事件不出现在摘要里 */
  assert.ok(lines.every((l) => !l.includes("心跳") && !l.includes("在吗")));
});

test("严重异常摘要：最多 max 条，取最近的", () => {
  const root = sandbox();
  mkdirSync(join(root, ".capitalist"), { recursive: true });
  const events = join(root, ".capitalist", "events.jsonl");
  let body = "";
  for (let i = 0; i < 12; i += 1) {
    body += JSON.stringify({
      at: `2026-11-05T02:${String(i).padStart(2, "0")}:00.000Z`,
      event: "dispatch_failed",
      dispatch: `D-${i}`,
      reason: `失败 ${i}`,
    }) + "\n";
  }
  writeFileSync(events, body);
  const lines = severeSupervisorEventLines(root, 5);
  assert.strictEqual(lines.length, 5);
  assert.ok(lines[0].includes("D-7"), "取最近 5 条，时间正序");
  assert.ok(lines[4].includes("D-11"));
});

test("单轮注入上限：没有宿主会话记录时沿用当前会话 id", () => {
  const root = sandbox();
  recordEvent(root, "supervisor_tick", { n: 1 });
  const prevProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.USERPROFILE = root;
  process.env.HOME = root;
  try {
    assert.strictEqual(supervisorChatTurnSessionId(root), "capitalist-chat");
  } finally {
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});
