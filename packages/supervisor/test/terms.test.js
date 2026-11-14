/**
 * 监工消息文案：中文语境下不许出现英文内部词，事件名必须有中文标签。
 *
 * 守三件事：
 *
 * 1. `dispatch_retry` 这类事件名只活在台账里，界面上必须翻成“重派任务”；
 * 2. 消息正文里的 worker / exit / pid / SIGTERM / hook 全部换成中文，
 *    `open` / `gone` 这类原始状态也不许直接摆出来；
 * 3. 标签表只有 `src/supervisor/terms.ts` 一份，前端 `fmt.js` 直接读它。
 *    谁再抄一张表出来，这条测试会拦住（抄表就会漂移）。
 *
 * 空状态图标不放在这里（那是 .vue 的渲染口径），交付时用 SSR 探针验。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const terms = require(join(PKG, "dist/supervisor/terms.js"));
const board = require(join(PKG, "dist/supervisor/board"));

const CJK = /[\u4e00-\u9fa5]/;
/** 界面上不该出现的英文内部词（整词匹配，避免误伤模型名、宿主名）。 */
const BANNED = /\b(worker|exit|pid|SIGTERM|hook|open|queued|closed|gone|missing|running|failed)\b/i;

test("术语表：每条事件 / 指令 / 状态都有中文，dispatch_retry 是“重派任务”", () => {
  assert.equal(terms.zhEvent("dispatch_retry"), "重派任务");
  assert.equal(terms.zhEvent("dispatch_orphan"), "判死重派");
  assert.equal(terms.zhStatus("open"), "待执行");
  assert.equal(terms.zhStatus("gone"), "已退出");
  assert.equal(terms.zhCommand("set-next"), "设定下一步");
  assert.equal(terms.zhCommand("dispatch"), "已派单");
  assert.equal(terms.zhCommandLabel("dispatch"), "已派单");
  assert.equal(terms.zhCommandLabel("dispatch", true), "插队派单");
  assert.equal(terms.zhCommandLabel("dispatch", false), "已派单");
  assert.equal(terms.zhCommandLabel("pause"), "暂停调度", "非 dispatch 动作不受标记影响");

  for (const [key, label] of Object.entries(terms.EVENT_ZH)) {
    assert.match(label, CJK, `事件 ${key} 的标签没有中文`);
    assert.doesNotMatch(label, /^[a-z_]+$/, `事件 ${key} 的标签还是英文枚举`);
  }
  for (const [key, label] of Object.entries(terms.CMD_ZH)) {
    assert.match(label, CJK, `指令 ${key} 的名字没有中文`);
  }

  /* 未知值不许回落原始枚举：回落一次，界面上就多一行机器话。 */
  assert.equal(terms.zhEvent("whatever_new_event"), "其他事件");
  assert.equal(terms.zhCommand("whatever_new_action"), "其他指令");
  assert.equal(terms.zhStatus("whatever_new_status"), "未知状态");
});

test("进程/单号消息：正文没有英文内部词，且每一条都是中文", () => {
  const root = mkdtempSync(join(tmpdir(), "terms-"));
  try {
    mkdirSync(join(root, ".capitalist"), { recursive: true });
    const at = new Date().toISOString();
    const events = [
      { event: "dispatch_open", dispatch: "D-aaaa1111", stage: "U6", shard: "msg-refs", action: "改消息文案" },
      { event: "dispatch_done", dispatch: "D-aaaa1111", stage: "U6", note: "改完" },
      { event: "dispatch_failed", dispatch: "D-aaaa1111", stage: "U6", note: "没改成" },
      { event: "dispatch_closed", dispatch: "D-aaaa1111", stage: "U6", from: "open", worker: "W-bbbb2222", killed: true, reason: "手动关" },
      { event: "dispatch_wake", dispatch: "D-aaaa1111", from: "done" },
      { event: "dispatch_retry", dispatch: "D-aaaa1111", stage: "U6", attempt: 2, previous_failures: 1 },
      { event: "dispatch_orphan", dispatch: "D-aaaa1111", worker_status: "gone" },
      { event: "dispatch_reaped", dispatch: "D-aaaa1111", worker: "W-bbbb2222", exit_code: 1 },
      { event: "dispatch_superseded", dispatch: "D-aaaa1111", stage: "U6" },
      { event: "worker_start", worker: "W-bbbb2222", host: "codebuddy", pid: 4321, dispatch: "D-aaaa1111" },
      { event: "worker_gone", worker: "W-bbbb2222", stale: true },
      { event: "worker_stopped", worker: "W-bbbb2222", killed: true, dispatch: "D-aaaa1111" },
      { event: "worker_launch_failed", error: "端口被占用" },
      { event: "worker_reaped", worker: "W-bbbb2222", dispatch: "D-aaaa1111" },
      { event: "worker_killed", worker: "W-bbbb2222", dispatch: "D-aaaa1111", how: "收到结束信号" },
      { event: "model_fallback", from_model: "m1", to_model: "m2" },
      { event: "takeover", shard: "msg-refs", reason: "人工介入" },
      { event: "release", shard: "*" },
      { event: "direct_inject", shard: "msg-refs", text: "先别动" },
      { event: "supervisor_advance", from: "U5", to: "U6" },
      { event: "supervisor_done", stage: "U6" },
      { event: "hook_error", error: "钩子超时" },
      { event: "supervisor_cmd", action: "set-next", arg: "收尾", ok: false, reason: "参数缺失" },
      { event: "mq_message", kind: "stuck", from: "W-bbbb2222", stage: "U6", shard: "msg-refs" },
      { event: "gate_eval", stage: "U6", ok: false, missing: ["测试未跑"] },
      { event: "contract_refused", kind: "requirement_violation" },
      { event: "redispatch_capped", shard: "msg-refs", limit: 3 },
    ].map((e) => ({ at, ...e }));
    writeFileSync(join(root, ".capitalist/events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const texts = [
      ...board.buildFeed(root, 200).map((x) => x.text),
      ...board.buildSupervisorLog(root, { limit: 200, hours: 0 }).messages.map((m) => m.text),
    ];
    assert.ok(texts.length >= 20, `消息条数不足：${texts.length}`);

    const bad = texts.filter((t) => BANNED.test(t));
    assert.deepEqual(bad, [], `仍有英文内部词：\n${bad.join("\n")}`);
    const noCjk = texts.filter((t) => !CJK.test(t));
    assert.deepEqual(noCjk, [], `有消息没有中文：\n${noCjk.join("\n")}`);
    assert.ok(!texts.some((t) => t.includes("dispatch_")), "消息里出现了原始事件名");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("监工自己落的指令：英文动作名翻成中文，用户原话不动", () => {
  const root = mkdtempSync(join(tmpdir(), "terms-direct-"));
  try {
    mkdirSync(join(root, ".capitalist"), { recursive: true });
    const at = new Date().toISOString();
    const rows = [
      {
        id: "SD-1",
        at,
        at_ts: Math.floor(Date.parse(at) / 1000),
        text: "dispatch [ui] 把消息里的编号做成引用",
        action: "dispatch",
        arg: "[ui] 把消息里的编号做成引用",
        via: "capitalist",
        consumed: true,
      },
      {
        id: "SD-2",
        at,
        at_ts: Math.floor(Date.parse(at) / 1000),
        text: "pause 我先自己看一眼",
        action: "pause",
        arg: "",
        via: "user",
        consumed: true,
      },
    ];
    writeFileSync(join(root, ".capitalist/supervisor-direct.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const msgs = board.buildSupervisorLog(root, { limit: 50, hours: 0 }).messages;
    const capitalist = msgs.find((m) => m.id === "SC-SD-1");
    const user = msgs.find((m) => m.id === "SC-SD-2");
    assert.ok(capitalist && user, "两条指令都应回显");
    assert.equal(capitalist.role, "supervisor");
    assert.match(capitalist.text, /^调度指令：已派单 \[ui\] 把消息里的编号做成引用$/, capitalist.text);
    assert.equal(user.role, "user");
    assert.equal(user.text, "pause 我先自己看一眼", "用户原话被改写了");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("标签表只有一份：前端 fmt.js 直接读服务端 terms.ts", () => {
  const fmt = readFileSync(join(PKG, "web/src/lib/fmt.js"), "utf8");
  assert.match(fmt, /from "\.\.\/\.\.\/\.\.\/src\/supervisor\/terms\.ts"/);
  assert.doesNotMatch(fmt, /const EVT_LABEL\s*=/, "前端又抄了一张事件标签表");
});
