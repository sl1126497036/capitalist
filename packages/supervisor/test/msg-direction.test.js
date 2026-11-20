/**
 * 用户消息方向与编号切分。
 *
 * 钉住三件事：
 *   1. 承接方判定只看会话归属与请求声明：监工面板直发（thread 为空）、线程内监工介入
 *      都由监工承接，方向记 `U2S`；工作进程线程内的补充记 `U2W`。
 *   2. recordUserMessage 的方向必填，漏传直接失败，不再静默落成 `U2W`。
 *   3. 前端切分能覆盖同一毫秒连发时的序号后缀（`S0-U2S-<毫秒>-1`）。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const PKG = resolve(__dirname, "..");
const REFS = pathToFileURL(join(PKG, "web", "src", "lib", "msgRefs.js")).href;
const { chatCarrierOf, chatDirectionOf, SUPERVISOR_THREAD, SUPERVISOR_VIA } = require(join(
  PKG,
  "dist/supervisor/board/chatDirection.js",
));
const { userMsgDirectionOf } = require(join(PKG, "dist/core/message/msgId.js"));
const { recordUserMessage } = require(join(PKG, "dist/core/message/messages.js"));

function sandbox(name = "capitalist-msg-direction-") {
  const root = mkdtempSync(join(tmpdir(), name));
  for (const dir of ["ledger", "runtime", "config"]) {
    mkdirSync(join(root, ".capitalist", dir), { recursive: true });
  }
  return root;
}

test("承接方：监工面板直发由监工承接", () => {
  assert.strictEqual(chatCarrierOf({ thread: "", via: "" }), "supervisor");
  assert.strictEqual(chatCarrierOf({}), "supervisor");
  assert.strictEqual(chatDirectionOf({ thread: "", via: "" }), "U2S");
});

test("承接方：会话标成监工会话时同样由监工承接", () => {
  assert.strictEqual(chatCarrierOf({ thread: SUPERVISOR_THREAD, via: "" }), "supervisor");
  assert.strictEqual(chatDirectionOf({ thread: SUPERVISOR_THREAD, via: "" }), "U2S");
});

test("承接方：工作进程线程内的补充登记给工作进程", () => {
  assert.strictEqual(chatCarrierOf({ thread: "12-P1", via: "" }), "worker");
  assert.strictEqual(chatDirectionOf({ thread: "12-P1", via: "" }), "U2W");
});

test("承接方：线程内发起监工介入由监工承接，不受线程归属影响", () => {
  assert.strictEqual(chatCarrierOf({ thread: "12-P1", via: SUPERVISOR_VIA }), "supervisor");
  assert.strictEqual(chatDirectionOf({ thread: "12-P1", via: SUPERVISOR_VIA }), "U2S");
});

test("方向映射：承接方到方向段一一对应", () => {
  assert.strictEqual(userMsgDirectionOf("supervisor"), "U2S");
  assert.strictEqual(userMsgDirectionOf("worker"), "U2W");
});

test("消息登记：方向缺省即失败，不再静默落成 U2W", () => {
  const root = sandbox();
  assert.throws(
    () => recordUserMessage(root, { text: "漏了方向" }),
    /direction 必填/,
    "缺方向应直接失败",
  );
  assert.throws(() => recordUserMessage(root, { text: "方向不是用户消息方向", direction: "S" }), /direction 必填/);
});

test("消息登记：监工承接的消息落成 U2S", () => {
  const root = sandbox();
  const msg = recordUserMessage(root, { text: "重试一次", direction: userMsgDirectionOf("supervisor") });
  assert.match(msg.id, /^S0-U2S-\d+$/);
});

test("前端切分：带同毫秒序号的消息编号整段切出", async () => {
  const { splitMessageRefs } = await import(REFS);
  const parts = splitMessageRefs("引用 #S0-U2S-1795100679233-1 这条");
  const ref = parts.find((p) => p.type === "ref");
  assert.ok(ref, "应切出一个引用片段");
  assert.strictEqual(ref.raw, "#S0-U2S-1795100679233-1");
});

test("前端切分：不带序号的消息编号与派单号保持原样", async () => {
  const { splitMessageRefs } = await import(REFS);
  const plain = splitMessageRefs("2-U2W-1795100679233").find((p) => p.type === "ref");
  assert.strictEqual(plain.raw, "2-U2W-1795100679233");
  const dispatch = splitMessageRefs("见 #2-3").find((p) => p.type === "ref");
  assert.strictEqual(dispatch.raw, "#2-3");
});
