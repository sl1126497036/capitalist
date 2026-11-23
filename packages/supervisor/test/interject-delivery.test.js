/**
 * 插话送达档位：服务端出码，界面出词。
 *
 * 守的是一个反复出现过的故障：前端解析 `status` 文案判断送没送到，服务端一改措辞
 * （分隔符从中点换成竖线、结论词换掉），整片插话就判成待送达。档位改由 `delivery`
 * 独立下发，文案随便改都不影响判定。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, writeFileSync, mkdirSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const capitalist = require("../dist/core/record/supervisor");
const { createTaskRoot } = require("../dist/core/contract/init");
const { directPath } = require("../dist/core/dispatch/commands");
const { buildThreadMessages } = require("../dist/supervisor/board");

const PKG = resolve(__dirname, "..");
const WEB = resolve(PKG, "web/src");
/** Windows 下动态 import ESM 必须用 file:// URL。 */
const load = async (rel) => import(pathToFileURL(resolve(WEB, rel)).href);

const SHARD = "a";
const TID = "shard:a";
const DISPATCH = "D-say1";
const WORKER = "W-say1";

/** 造任务根，按给定记录写进插话台账。 */
function scenario(rows) {
  const root = mkdtempSync(join(tmpdir(), "capitalist-say-"));
  createTaskRoot({ target: "插话送达档位", contractSpec: "minimal", root });
  for (const d of [
    "runtime", "ledger", "model", "board", "config", "meta", "workers",
    "sessions", "inbox", "mq", "guard", "brain", "reload", "locks", "archive", ".root",
  ]) {
    mkdirSync(join(root, ".capitalist", d), { recursive: true });
  }

  const startedAt = new Date(Date.now() - 600_000).toISOString();
  capitalist.appendDispatch(root, {
    id: DISPATCH,
    at: startedAt,
    stage: "S0",
    shard: SHARD,
    action: "改 C",
    status: "running",
    lineage: DISPATCH,
  });

  const log = capitalist.workerLogPath(root, WORKER);
  mkdirSync(join(root, ".capitalist", "workers", WORKER), { recursive: true });
  writeFileSync(log, "");
  capitalist.registerWorker(root, {
    id: WORKER,
    host: "generic",
    pid: process.pid,
    session: "sess-say",
    dispatch: DISPATCH,
    shard: SHARD,
    stage: "S0",
    started_at: startedAt,
    heartbeat_at: new Date().toISOString(),
    status: "running",
    log,
  });

  writeFileSync(directPath(root), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return root;
}

/** 一条插话台账记录；`no` 拼成合法消息号，界面才按消息渲染而不是视图块。 */
function say(no, consumed, extra = {}) {
  return {
    id: `1-U2W-17954000000${no}`,
    msg_id: `1-U2W-17954000000${no}`,
    at: `2026-11-23T03:5${no}:00.000Z`,
    at_ts: 1795400000 + Number(no),
    type: "direct",
    text: `第 ${no} 条插话`,
    shard: SHARD,
    target: DISPATCH,
    consumed,
    ...extra,
  };
}

const saysOf = (messages) => messages.filter((m) => m.role === "user" && m.kind === "say");

test("服务端三档：未领走待送达，hook 投递已送达，作废未投递", () => {
  const root = scenario([
    say("1", false),
    say("2", true, { consumed_via: "hook", delivered: true }),
    say("3", true, { consumed_via: "dropped" }),
  ]);
  const says = saysOf(buildThreadMessages(root, TID, SHARD, { limit: 400 }).messages);
  assert.equal(says.length, 3, "三条插话都要上屏");
  const byText = new Map(says.map((m) => [String(m.text), m]));
  assert.equal(byText.get("第 1 条插话").delivery, "pending");
  assert.equal(byText.get("第 2 条插话").delivery, "ok");
  assert.equal(byText.get("第 3 条插话").delivery, "bad");
  /* 档位与文案同源：已送达的记录不能带一句「待送达」的原因。 */
  assert.ok(String(byText.get("第 2 条插话").status).startsWith("已送达"));
});

test("界面只读档位：状态文案怎么改都不影响判定", async () => {
  const { deliveryOf } = await load("lib/statusParts.js");
  assert.equal(deliveryOf({ delivery: "ok", status: "随便什么措辞 | 已执行" }), "ok");
  assert.equal(deliveryOf({ delivery: "bad", status: "x" }), "bad");
  assert.equal(deliveryOf({ delivery: "", status: "已送达执行中的进程" }), "pending", "没有码就是待送达");
  assert.equal(deliveryOf(undefined), "pending");
});

test("合并：档位只前进不后退，回退时档位与文案一起保留", async () => {
  const { mergeInterject } = await load("lib/statusParts.js");
  const said = (delivery, status) => ({ role: "user", kind: "say", delivery, status, text: "x" });
  const kept = mergeInterject(said("ok", "已送达执行中的进程 | 已执行"), said("pending", "已登记，进程下一次动作时送达"));
  assert.equal(kept.delivery, "ok", "已送达不能被旧的待送达覆盖");
  assert.equal(kept.status, "已送达执行中的进程 | 已执行", "文案与档位一起保留，不能各说各话");
  const moved = mergeInterject(said("pending", "已登记"), said("ok", "已送达执行中的进程"));
  assert.equal(moved.delivery, "ok", "档位前进时照常替换");
  /* 非插话不受约束：工作进程输出块靠整条替换原地增长。 */
  const log = mergeInterject({ role: "worker", kind: "output", status: "a" }, { role: "worker", kind: "output", status: "b" });
  assert.equal(log.status, "b");
});

test("气泡与派单卡：档位一处出词，文案不当协议解析", () => {
  const chatSrc = readFileSync(resolve(WEB, "components/chat-pane/index.vue"), "utf8");
  const tplSrc = readFileSync(resolve(WEB, "components/chat-pane/template.html"), "utf8");
  const appSrc = readFileSync(resolve(WEB, "App.vue"), "utf8");
  const statusSrc = readFileSync(resolve(WEB, "lib/statusParts.js"), "utf8");
  /* 用户插话把整条消息交给 interjectStatus，由它读 delivery。 */
  assert.match(chatSrc, /interjectStatus\(v\.m\)/);
  assert.ok(!statusSrc.includes("splitStatus"), "档位不再解析状态文案");
  /* 用户插话分支只取短词，不得出现编号兜底。 */
  const statBody = chatSrc.slice(chatSrc.indexOf("function stat(v)"));
  const userBranch = statBody.slice(0, statBody.indexOf('if (v.c === "supervisorsay")'));
  assert.ok(userBranch.length > 0, "stat() 应分出用户插话与监工派单卡两支");
  assert.ok(!userBranch.includes("noLabel("), "用户插话的尾标不得用编号兜底");
  /* 配色档绑到 statTone，不直接拿中文状态串当类名。 */
  assert.match(tplSrc, /:class="statTone\(v\)"/);
  assert.ok(!tplSrc.includes(':class="v.m.status"'));
  /* 合并入口只有 mergeInterject，档位才不会被旧对象覆盖回去。 */
  assert.match(appSrc, /mergeInterject\(out\[at\], m\)/);
  /* 监工派单卡按状态码整串比对。 */
  assert.match(chatSrc, /sayStatus\(v\.m\.status,\s*v\.m\.no,\s*v\.m\.reason,\s*v\.m\.detail\)/);
});
