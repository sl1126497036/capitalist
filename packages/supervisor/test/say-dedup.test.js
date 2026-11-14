/** 用户发言的去重：同一条消息在消息流里只渲染一次。 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { serveBoard } = require(join(PKG, "dist/supervisor/board"));
const { recordEvent } = require(join(PKG, "dist/core/record/ledger.js"));

const TEXT = "这条消息只该出现一次";

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-saydedup-"));
  mkdirSync(join(root, ".capitalist", "inbox"), { recursive: true });
  mkdirSync(join(root, ".capitalist", "workers"), { recursive: true });
  return root;
}

function seedDirect(root, rows) {
  writeFileSync(join(root, ".capitalist", "direct.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

async function withBoard(root, fn) {
  const served = await serveBoard({ root, port: 7917, maxPortTries: 20, out: () => {} });
  try {
    return await fn(served, root);
  } finally {
    served.close();
  }
}

async function userSays(served, root, id) {
  const key = readFileSync(join(root, ".capitalist", "board.key"), "utf8").trim();
  const base = new URL(served.url);
  const res = await fetch(`${base.origin}/api/thread?id=${encodeURIComponent(id)}&shard=s1&limit=300`, {
    headers: {
      cookie: `supervisor_board_key=${key}`,
      "x-capitalist-client": "board",
      origin: base.origin,
    },
  });
  assert.strictEqual(res.status, 200, `/api/thread 应 200：${res.status}`);
  const d = await res.json();
  return (d.messages || []).filter((m) => m.role === "user" && m.kind === "say");
}

test("同一次发送的双通路记录只出一条气泡", async () => {
  const root = scratch();
  try {
    const t0 = "2026-11-01T16:21:27.600Z";
    seedDirect(root, [
      { at: t0, at_ts: 1, type: "direct", text: TEXT, shard: "s1", stage: "U6", consumed: true },
    ]);
    recordEvent(root, "supervisor_chat_ask", { text: TEXT, thread: "u6/s1", from: "user", at: "2026-11-01T16:21:27.637Z" });
    await withBoard(root, async (served, root2) => {
      const said = await userSays(served, root2, "u6/s1");
      assert.strictEqual(said.length, 1, `同文同拍的 ask 与指令只画一条，实际 ${said.length}`);
      assert.ok(said[0].id.startsWith("S-"), "保留的是带状态标的指令那条");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("老指令不吞十分钟后同文的新发言", async () => {
  const root = scratch();
  try {
    seedDirect(root, [
      { at: "2026-11-01T10:00:00.000Z", at_ts: 1, type: "direct", text: TEXT, shard: "s1", stage: "U6", consumed: true },
    ]);
    recordEvent(root, "supervisor_chat_ask", { text: TEXT, thread: "u6/s1", from: "user", at: "2026-11-01T10:10:00.000Z" });
    await withBoard(root, async (served, root2) => {
      const said = await userSays(served, root2, "u6/s1");
      assert.strictEqual(said.length, 2, `老指令与新 ask 是两次发送，都要在屏上，实际 ${said.length}`);
      const ids = said.map((m) => m.id[0]).sort().join("");
      assert.strictEqual(ids, "CS", "一条来自指令（S-），一条来自 ask（CH-）");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("只有 ask、没有指令：原样出一条", async () => {
  const root = scratch();
  try {
    recordEvent(root, "supervisor_chat_ask", { text: TEXT, thread: "u6/s1", from: "user", at: "2026-11-01T11:00:00.000Z" });
    await withBoard(root, async (served, root2) => {
      const said = await userSays(served, root2, "u6/s1");
      assert.strictEqual(said.length, 1, "无指令可去重时 ask 原样保留");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
