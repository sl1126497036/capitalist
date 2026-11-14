
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { serveBoard, buildSupervisorLog } = require(join(PKG, "dist/supervisor/board"));
const { recordUserMessage } = require(join(PKG, "dist/core/messages.js"));
const { settleChat } = require(join(PKG, "dist/supervisor/chatSettle.js"));
const { listSupervisorDirectives } = require(join(PKG, "dist/supervisor/direct.js"));

function sandbox(name = "capitalist-unhandled-api-") {
  const root = mkdtempSync(join(tmpdir(), name));
  mkdirSync(join(root, ".capitalist", "inbox"), { recursive: true });
  mkdirSync(join(root, ".capitalist", "workers"), { recursive: true });
  return root;
}

/** 每个用例一块独立看板：端口逐次递增，避免上一个 server 还没收干净。 */
let boardSeq = 0;

/** 起一块临时看板，返回带 key 的请求函数。 */
async function withBoard(root, fn) {
  /* 端口不能用 0：serveBoard 的 port 是“起始端口 + 顺延”，0 会让它把地址算成 :0。 */
  const served = await serveBoard({ root, port: 7900 + ((process.pid + boardSeq * 7) % 90), maxPortTries: 20 });
  boardSeq += 1;
  const base = `http://127.0.0.1:${served.port}`;
  try {
    /* 先按 ?key= 取得 cookie；数据接口同时校验该 key。 */
    const key = readFileSync(join(root, ".capitalist", "board.key"), "utf8").trim();
    const bounce = await fetch(`${base}/?key=${encodeURIComponent(key)}`, { redirect: "manual" });
    const cookie = String(bounce.headers.get("set-cookie") || "").split(";")[0];
    const call = (path, init = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { "x-capitalist-client": "board", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
      });
    return await fn(call);
  } finally {
    served.close();
  }
}

test("接口：列出 -> 建单（原话预填、只带本条附件）-> 出列；再来一次 409", async () => {
  const root = sandbox();
  /* 前一条带过一张旧图，后一条本身没贴图：建单时不许把旧图带进来。 */
  recordUserMessage(root, { text: "上一张图是别的单的", atts: [".capitalist/attachments/old.png"] });
  const msg = recordUserMessage(root, { text: "新消息挪到中间，这里上方" });
  settleChat(root, { msg_id: msg.id, verdict: "answered_only", text: "新消息挪到中间，这里上方" });

  await withBoard(root, async (call) => {
    const listed = await (await call("/api/unhandled")).json();
    assert.strictEqual(listed.ok, true);
    assert.strictEqual(listed.items.length, 1);
    assert.strictEqual(listed.items[0].msg_id, msg.id);
    assert.deepStrictEqual(listed.items[0].hints, ["挪到"]);

    const created = await call("/api/unhandled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root, msg_id: msg.id, op: "dispatch" }),
    });
    assert.strictEqual(created.status, 200);
    const made = await created.json();
    assert.strictEqual(made.ok, true);
    assert.strictEqual(made.items.length, 0, "补建单后这条要出列");

    const dirs = listSupervisorDirectives(root);
    const dir = dirs.find((d) => d.id === made.directive);
    assert.ok(dir, "应落一条调度指令");
    assert.strictEqual(dir.action, "dispatch");
    assert.match(String(dir.text || dir.arg || ""), /新消息挪到中间/);
    assert.deepStrictEqual(dir.atts || [], [], "本条没贴图，不许从历史里带旧图");

    /* 重复点一次：接口拒绝，不会建第二张单。 */
    const again = await call("/api/unhandled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root, msg_id: msg.id, op: "dispatch" }),
    });
    assert.strictEqual(again.status, 409);
    assert.strictEqual(listSupervisorDirectives(root).filter((d) => d.action === "dispatch").length, 1);
  });
});

test("接口：已答复 -> 不再出现，消息流上的未建单标记一起消失", async () => {
  const root = sandbox();
  const msg = recordUserMessage(root, { text: "把按钮换成圆角" });
  settleChat(root, { msg_id: msg.id, verdict: "answered_only", text: "把按钮换成圆角" });
  assert.ok(buildSupervisorLog(root, { hours: 0 }).messages.some((m) => m.unhandled === true));

  await withBoard(root, async (call) => {
    const dismissed = await call("/api/unhandled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root, msg_id: msg.id, op: "dismiss" }),
    });
    assert.strictEqual(dismissed.status, 200);
    const d = await dismissed.json();
    assert.strictEqual(d.ok, true);
    assert.deepStrictEqual(d.items, []);
    assert.strictEqual(listSupervisorDirectives(root).length, 0, "“不需要动作”不建单");
  });

  const after = buildSupervisorLog(root, { hours: 0 }).messages.find((m) => m.role === "user");
  assert.strictEqual(after.unhandled, undefined, "已答复后标记消失");
});
