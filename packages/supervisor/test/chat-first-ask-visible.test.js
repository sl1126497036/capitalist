/**
 * 监工窗口发出的消息必须留在对话区。
 *
 * 判据：在还没有会话记录的任务根上发第一条消息，`/api/capitalist-events` 里要有这一条。
 * 新建会话会写 `chat_session_new` 作为监工消息流的下界，它必须早于本条消息；写成之后
 * 就会把刚发出的这条挡在下界之外，界面刷新后只剩派单。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { serveBoard } = require(join(PKG, "dist/supervisor/board"));
const { eventsPath } = require(join(PKG, "dist/core/record/ledger.js"));

const TEXT = "第一条消息刷新后仍应在对话区";

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-firstask-"));
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
    ".root",
  ]) {
    mkdirSync(join(root, ".capitalist", d), { recursive: true });
  }
  return root;
}

/** 替身 CLI：回一段正文就退出，不碰真实模型。 */
function fakeCli(dir) {
  const file = join(dir, "fake-chat-cli.cjs");
  writeFileSync(
    file,
    [
      'const line = { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "收到" } } };',
      "process.stdout.write(`${JSON.stringify(line)}\\n`);",
    ].join("\n"),
    "utf8",
  );
  return file;
}

function withEnv(patch, fn) {
  const saved = {};
  for (const key of Object.keys(patch)) {
    saved[key] = process.env[key];
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(saved)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

test("无会话记录时发出的第一条消息，在监工消息流里可见", async () => {
  const root = scratch();
  const cli = fakeCli(root);
  const served = await serveBoard({ root, port: 0, out: () => {} });
  const base = new URL(`http://127.0.0.1:${served.server.address().port}`);
  const key = readFileSync(join(root, ".capitalist", "board", "key"), "utf8").trim();
  const headers = {
    cookie: `supervisor_board_key=${key}`,
    "x-capitalist-client": "board",
    origin: base.origin,
    "content-type": "application/json",
  };
  try {
    await withEnv({ CAPITALIST_WORKER_BIN: cli }, async () => {
      const res = await fetch(`${base.origin}/api/capitalist-chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: TEXT, thread: "", via: "" }),
      });
      assert.strictEqual(res.status, 200, `对话接口应 200：${res.status}`);
      await res.text();
    });

    const res = await fetch(`${base.origin}/api/capitalist-events?limit=400&hours=0`, { headers });
    assert.strictEqual(res.status, 200, `/api/capitalist-events 应 200：${res.status}`);
    const d = await res.json();
    const said = (d.messages || []).filter((m) => m.role === "user");
    assert.strictEqual(said.length, 1, `应只有一条用户消息，实际 ${said.length}`);
    assert.strictEqual(said[0].text, TEXT, "上屏的应是刚发出的原文");
    /* 同一轮里监工的回复照常上屏：本条修复不影响其它角色的消息。 */
    assert.ok(
      (d.messages || []).some((m) => m.role === "supervisor" && String(m.text || "").includes("收到")),
      "监工回复应照常出现在消息流里",
    );
    /* 台账侧同样要能查到：刷新后重新构建视图的依据是这条事件。 */
    const rows = readFileSync(eventsPath(root), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.ok(
      rows.some((r) => r.event === "supervisor_chat_ask" && r.text === TEXT),
      "台账里要有本条用户消息",
    );
  } finally {
    served.close();
    rmSync(root, { recursive: true, force: true });
  }
});
