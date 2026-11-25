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
const { userMsgDirectionOf, isMsgNo } = require(join(PKG, "dist/core/message/msgId.js"));
const { recordUserMessage } = require(join(PKG, "dist/core/message/messages.js"));
const { viewId, isViewId } = require(join(PKG, "dist/supervisor/board/viewId.js"));
const { appendSupervisorDirective } = require(join(PKG, "dist/supervisor/channel/direct.js"));
const { directiveShortRef } = require(join(PKG, "dist/core/dispatch/commands.js"));
const NO_LIB = pathToFileURL(join(PKG, "web", "src", "lib", "no.js")).href;

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
  /* 同一毫秒内生成多条时末段带序号，判定口径见 msgId.ts 的 `isMsgId`。 */
  assert.match(msg.id, /^S0-U2S-\d+(?:-\d+)?$/);
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

test("消息编号形态：只认任务号-方向-时间戳，其余一律不是", () => {
  for (const good of [
    "19-U2W-1795263657871",
    "19-U2S-1795263504973",
    "S0-S-1795263504973",
    "19-W-1795263504973",
    "19-U2S-1795100679233-1",
  ]) {
    assert.equal(isMsgNo(good), true, `应认成消息号：${good}`);
  }
  for (const bad of ["19-1", "19-P1", "n0fg0v", "19-P3#think-0", "19-1~think~0", "", "19-1-U2W"]) {
    assert.equal(isMsgNo(bad), false, `不应认成消息号：${bad}`);
  }
});

test("视图块身份：不含编号分隔符，带 ~ 的一律不是消息", () => {
  assert.equal(viewId("19-1", "think", 0), "19-1~think~0");
  assert.equal(viewId("19-1", "engine"), "19-1~engine");
  assert.equal(isViewId("19-1~think~0"), true);
  assert.equal(isViewId("19-U2W-1795263657871"), false);
  assert.equal(isMsgNo(viewId("19-1", "output", 16)), false);
});

test("用户下发的调度指令方向段是 U2S，监工发给工作进程的才是 S2W", () => {
  const root = sandbox("capitalist-msg-form-");
  const byUser = appendSupervisorDirective(root, { text: "resume", action: "resume" });
  assert.equal(byUser.ok, true);
  assert.match(byUser.rec.id, /^S0-U2S-\d+(?:-\d+)?$/, "界面上“我：”的气泡必须是用户消息编号");
  const bySupervisor = appendSupervisorDirective(root, { text: "pause", action: "pause", via: "capitalist" });
  assert.equal(bySupervisor.ok, true);
  assert.match(bySupervisor.rec.id, /^S0-S2W-\d+(?:-\d+)?$/);
});

test("插话对外编号用消息编号，不再用台账行号", () => {
  const root = sandbox("capitalist-directive-ref-");
  const rec = appendSupervisorDirective(root, { text: "resume", action: "resume" }).rec;
  const ref = directiveShortRef(rec);
  assert.match(ref, /^S0-U2S-\d+(?:-\d+)?$/, "回报与正文都用消息编号");
  assert.ok(!ref.startsWith("@"), "不得再发行号");
});

test("引用编号：消息给消息号，派单给派单号，哈希与视图块不给号", async () => {
  const { refNo } = await import(NO_LIB);
  assert.strictEqual(refNo("19-U2W-1795263657871"), "#19-U2W-1795263657871");
  assert.strictEqual(refNo("#S0-U2S-1795263504973"), "#S0-U2S-1795263504973");
  assert.strictEqual(refNo("19-1"), "", "派单卡没有消息号，不给引用编号");
  assert.strictEqual(refNo("n0fg0v"), "");
  assert.strictEqual(refNo("19-P3#think-0"), "");
  assert.strictEqual(refNo("19-P1"), "");
});

test("引用与复制按钮：只有带消息编号的真实消息可引用", async () => {
  const { refableOf } = await import(NO_LIB);
  assert.equal(refableOf({id: "19-U2W-1795263657871", kind: "say"}), true, "用户消息可引用");
  assert.equal(refableOf({id: "19-S-1795263504973", kind: "say"}), true, "监工回复可引用");
  /* 派单卡：身份是派单号，代表一张单，不是消息。 */
  assert.equal(refableOf({id: "19-1", kind: "dispatch"}), false, "派单卡不可引用");
  /* 视图块：思考、输出分块、进程提醒。 */
  assert.equal(refableOf({id: "19-1~think~0", kind: "thinking", view: true}), false, "思考块不可引用");
  assert.equal(refableOf({id: "19-1~event~k2f", kind: "verdict", view: true}), false, "进程提醒不可引用");
  /* 老台账或本地回显：身份是内容指纹或临时串。 */
  assert.equal(refableOf({id: "hhs87c", kind: "say"}), false, "内容指纹不可引用");
  assert.equal(refableOf({id: "L-m3k2-1", kind: "say"}), false, "本地回显不可引用");
  assert.equal(refableOf({kind: "say"}), false, "没有身份不可引用");
});
