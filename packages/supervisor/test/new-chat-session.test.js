/** 清空任务卡与新建会话是两条互不触发的路径，监工流以会话边界截断。 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { buildSupervisorLog } = require(join(PKG, "dist/supervisor/board"));
const { COMMAND_ACTIONS, runCommand } = require(join(PKG, "dist/supervisor/board/commands.js"));
const { contextPath, reloadBrief } = require(join(PKG, "dist/supervisor/context/reload.js"));

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-session-"));
  for (const d of [
    "runtime",
    "ledger",
    "model",
    "board",
    "config",
    "meta",
    "workers",
    "sessions",
    "inbox",
    "mq",
    "guard",
    "brain",
    "reload",
    "locks",
    "archive",
  ]) {
    mkdirSync(join(root, ".capitalist", d), { recursive: true });
  }
  writeFileSync(
    join(root, ".capitalist", "runtime", "supervisor.json"),
    JSON.stringify({ heartbeat_ts: Date.now() / 1000 }),
    "utf8",
  );
  return root;
}

function eventsPath(root) {
  return join(root, ".capitalist", "ledger", "events.jsonl");
}

function writeEvents(root, rows) {
  writeFileSync(eventsPath(root), rows.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
}

function readEvents(root) {
  const file = eventsPath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function sessionIdOf(root) {
  const file = join(root, ".capitalist", "reload", "session.json");
  if (!existsSync(file)) return "";
  try {
    return String(JSON.parse(readFileSync(file, "utf8")).session_id || "");
  } catch {
    return "";
  }
}

test("新建会话后监工流不返回上一代消息", () => {
  const root = sandbox();
  const old = new Date(Date.now() - 60_000).toISOString();
  const boundary = new Date(Date.now() - 30_000).toISOString();
  const fresh = new Date(Date.now() - 10_000).toISOString();
  writeEvents(root, [
    { event: "supervisor_chat_ask", at: old, msg_id: "1-U2S-1763700000001", text: "上一代的问题" },
    { event: "chat_session_new", at: boundary, session: "s-new" },
    { event: "supervisor_chat_ask", at: fresh, msg_id: "1-U2S-1763700000002", text: "这一代的问题" },
  ]);

  const log = buildSupervisorLog(root, { limit: 50, hours: 6 });
  const texts = log.messages.map((m) => String(m.text || ""));

  assert.ok(texts.some((t) => t.includes("这一代的问题")), "边界之后的消息必须上屏");
  assert.ok(!texts.some((t) => t.includes("上一代的问题")), "边界之前的消息不得上屏");
  assert.equal(log.has_older, false, "边界之外不属于当前会话，不提供展开更早");
});

test("new-session 换代并写下会话边界事件", () => {
  const root = sandbox();
  writeEvents(root, [{ event: "supervisor_chat_ask", at: new Date().toISOString(), msg_id: "1-U2S-1763700000003", text: "旧会话" }]);

  const r = runCommand(root, { action: "new-session" });
  assert.equal(r.status, 200);
  const session = sessionIdOf(root);
  assert.ok(session, "会话 id 必须落盘");
  assert.equal(r.body.session, session);

  const boundary = readEvents(root).filter((e) => e.event === "chat_session_new");
  assert.equal(boundary.length, 1, "只写一条边界事件");
  assert.equal(boundary[0].session, session);
});

test("清空任务卡不换监工会话，也不动对话台账", () => {
  const root = sandbox();
  runCommand(root, { action: "new-session" });
  const session = sessionIdOf(root);
  writeEvents(root, [
    ...readEvents(root),
    { event: "supervisor_chat_ask", at: new Date().toISOString(), msg_id: "1-U2S-1763700000004", text: "保留这句话" },
  ]);

  const r = runCommand(root, { action: "clear-threads", bucket: "all" });
  assert.equal(r.status, 200);
  assert.equal(sessionIdOf(root), session, "清空不得换会话");
  assert.ok(existsSync(eventsPath(root)), "事件流属于监工对话，不得归档");
  assert.ok(readEvents(root).some((e) => String(e.text || "").includes("保留这句话")));
  assert.ok(!String(r.body.effective || "").includes("新会话"), "回执不再声称换会话");
});

test("new-session 是工作进程允许执行的命令", () => {
  assert.ok(COMMAND_ACTIONS.has("new-session"));
});

test("new-session 不把上一代压缩简报带进新会话", () => {
  const root = sandbox();
  writeFileSync(contextPath(root), "## 未完成\n旧摘要：这一条不该进新会话\n", "utf8");
  assert.match(reloadBrief(root), /旧摘要/, "前置：简报存在时会被注入");

  const r = runCommand(root, { action: "new-session" });
  assert.equal(r.status, 200);
  assert.equal(reloadBrief(root), "", "新会话不继承上一代摘要");
});
