
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { serveBoard } = require(join(PKG, "dist/supervisor/board"));
const { recordEvent } = require(join(PKG, "dist/core/ledger.js"));

const AMEND_TEXT = "顶栏要用中文";
const THREAD = "u6/s1";

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-amenddedup-"));
  mkdirSync(join(root, ".capitalist", "inbox"), { recursive: true });
  mkdirSync(join(root, ".capitalist", "workers"), { recursive: true });
  return root;
}

function seed(root, { reply }) {
  const at = new Date().toISOString();
  writeFileSync(
    join(root, ".capitalist", "inbox", "dispatch.jsonl"),
    JSON.stringify({ id: "D-test1", at, stage: "u6", shard: "s1", action: "改一版界面", status: "claimed", worker: "W-test1" }) + "\n",
  );
  writeFileSync(
    join(root, ".capitalist", "supervisor-direct.jsonl"),
    JSON.stringify({
      id: "SD-test1",
      at,
      at_ts: Date.now() / 1000,
      text: `amend ${AMEND_TEXT}`,
      action: "amend",
      arg: AMEND_TEXT,
      via: "capitalist",
      target: "D-test1",
      consumed: true,
      result: { ok: true, reason: "", detail: "已追加到在途派单 D-test1" },
    }) + "\n",
  );
  recordEvent(root, "supervisor_reply", {
    ask: "顶栏要用中文",
    reply,
    want: "",
    applied: "已执行 amend：顶栏要用中文",
    acted: true,
    dispatch_text: AMEND_TEXT,
    thread: THREAD,
    from: "supervisor",
  });
  /* 结构记录：对话层 amend 落成后 loop 执行时记的事件，投影成“派单 X 追加内容：…”。 */
  recordEvent(root, "directive_amended", {
    dispatch: "D-test1",
    stage: "u6",
    shard: "s1",
    status: "claimed",
    text: AMEND_TEXT,
  });
}

async function supervisorSays(served, root) {
  const key = readFileSync(join(root, ".capitalist", "board.key"), "utf8").trim();
  const base = new URL(served.url);
  const res = await fetch(`${base.origin}/api/thread?id=${encodeURIComponent(THREAD)}&limit=300`, {
    headers: { cookie: `supervisor_board_key=${key}`, "x-capitalist-client": "board", origin: base.origin },
  });
  assert.strictEqual(res.status, 200, `/api/thread 应 200：${res.status}`);
  const d = await res.json();
  /* 结构记录是 verdict 块（“派单 X 追加内容：…”），叙述气泡是 supervisor 的 say，两类都取。 */
  return (d.messages || []).filter(
    (m) => m.role === "supervisor" && (m.kind === "say" || m.kind === "verdict"),
  );
}

async function withBoard(root, fn) {
  const served = await serveBoard({ root, port: 7919, maxPortTries: 20, out: () => {} });
  try {
    return await fn(served, root);
  } finally {
    served.close();
  }
}

test("amend 纯复述叙述不上屏，结构记录保留", async () => {
  const root = scratch();
  try {
    seed(root, { reply: `已把这条追加给在途单：${AMEND_TEXT}` });
    await withBoard(root, async (served, root2) => {
      const says = await supervisorSays(served, root2);
      const amend = says.find((m) => m.text.includes("追加内容"));
      assert.ok(amend, `结构记录必须保留，实际：${says.map((m) => m.text).join("｜")}`);
      assert.ok(
        says.every((m) => !m.text.includes("已把这条追加给在途单")),
        `复述叙述不得再上屏，实际：${says.map((m) => m.text).join("｜")}`,
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("amend 叙述的补充说明并入结构记录，不单独成泡", async () => {
  const root = scratch();
  try {
    seed(root, { reply: `${AMEND_TEXT}。另外输入框占位文案也要换` });
    await withBoard(root, async (served, root2) => {
      const says = await supervisorSays(served, root2);
      const amend = says.find((m) => m.text.includes("追加内容"));
      assert.ok(amend, "结构记录必须保留");
      assert.ok(
        amend.text.includes("另外输入框占位文案也要换"),
        `补充说明应并入结构记录，实际：${amend.text}`,
      );
      assert.strictEqual(says.length, 1, `补充说明不得单独成泡，实际：${says.map((m) => m.text).join("｜")}`);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const DISPATCH_BODY = "改一版界面";

function seedDispatch(root, { reply }) {
  const at = new Date().toISOString();
  writeFileSync(
    join(root, ".capitalist", "inbox", "dispatch.jsonl"),
    JSON.stringify({
      id: "D-test1",
      at,
      stage: "u6",
      shard: "s1",
      action: DISPATCH_BODY,
      status: "claimed",
      worker: "W-test1",
    }) + "\n",
  );
  recordEvent(root, "supervisor_reply", {
    ask: DISPATCH_BODY,
    reply,
    want: "",
    applied: "已加入队列",
    acted: true,
    dispatch_text: DISPATCH_BODY,
    directive: "SD-test1",
    thread: THREAD,
    from: "supervisor",
  });
}

test("dispatch 叙述并进派单卡，不再单独成泡", async () => {
  const root = scratch();
  try {
    seedDispatch(root, { reply: `${DISPATCH_BODY}。另外把输入区的变量名统一成 paneHint` });
    await withBoard(root, async (served, root2) => {
      const key = readFileSync(join(root2, ".capitalist", "board.key"), "utf8").trim();
      const base = new URL(served.url);
      const res = await fetch(`${base.origin}/api/thread?id=${encodeURIComponent(THREAD)}&limit=300`, {
        headers: { cookie: `supervisor_board_key=${key}`, "x-capitalist-client": "board", origin: base.origin },
      });
      assert.strictEqual(res.status, 200);
      const d = await res.json();
      const msgs = d.messages || [];

      const cards = msgs.filter((m) => m.kind === "dispatch");
      assert.strictEqual(cards.length, 1, `派单卡应有且只有一条，实际 ${cards.length} 条`);
      assert.ok(
        cards[0].text.includes("另外把输入区的变量名统一成 paneHint"),
        `补充说明应并入派单卡，实际“${cards[0].text}”`,
      );
      assert.ok(
        msgs.every((m) => !(m.role === "supervisor" && m.kind === "say" && m.text.includes("变量名"))),
        `叙述不得再单独成泡，实际：${msgs.filter((m) => m.kind === "say").map((m) => m.text).join("｜")}`,
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
