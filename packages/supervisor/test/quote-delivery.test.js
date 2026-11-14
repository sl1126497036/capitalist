
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/record/supervisor");
const { createTaskRoot } = require("../dist/core/contract/init");
const { claimDirectives, spliceDirectives, listDirectives } = require("../dist/core/dispatch/commands");
const { runCommand, buildThreadMessages } = require("../dist/supervisor/board");

/*
 * 唤醒走 `capitalist update` 子进程，而 CLI 对带 `CAPITALIST_WORKER_ID` 的进程只放行汇报类命令
 * （进程边界，见 cli/main.ts）。测试宿主如果本身跑在 worker 环境里（比如从某个
 * 工作进程会话里起测试），子进程会继承这个变量、把 update 拒掉，这里是测试环境，
 * 不是真 worker，把它摘掉。
 */
delete process.env.CAPITALIST_WORKER_ID;

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-quote-"));
  createTaskRoot({ target: "引用测试", contractSpec: "minimal", root: base });
  return base;
}

/** 建一张派单，返回前端视角下它的消息 ref（与界面 #编号 同一份身份）。 */
function seedDispatch(root, extra = {}) {
  capitalist.appendDispatch(root, {
    id: "D-quote1",
    at: new Date().toISOString(),
    stage: "U1",
    shard: "s1",
    action: "把卡片样式改成同色系深浅区分，并加归属标识",
    status: "open",
    ...extra,
  });
  const { messages } = buildThreadMessages(root, "u1/s1", "");
  const hit = messages.find((m) => m.id.endsWith("quote1"));
  assert.ok(hit, " seeded 派单必须能在线程消息里投影出来");
  return hit.id;
}

test("带引用插话：落盘取回被引原文，领取时编号与原文一起拼进派单说明", () => {
  const root = sandbox();
  const ref = seedDispatch(root);

  const r = runCommand(root, { action: "say", id: "u1/s1", text: "照引用那条的正文来", quote: ref });
  assert.equal(r.status, 200, `登记失败：${JSON.stringify(r.body)}`);

  const [rec] = listDirectives(root);
  assert.equal(rec.quote, ref, "被引标识要原样落盘");
  assert.match(
    String(rec.quote_text || ""),
    /把卡片样式改成同色系深浅区分/,
    "落盘时必须按标识取回被引原文，只留 ref 的话消费端拼不出内容",
  );

  const taken = claimDirectives(root, {
    shard: "s1",
    stage: String(rec.stage || ""),
    dispatchId: "D-quote1",
    lane: "u1/s1",
  });
  assert.equal(taken.length, 1, "插话必须能被对应的那一单领走");
  const action = spliceDirectives("原始派单正文", taken);
  assert.match(action, /\[引用 #/, "派单说明里要有引用编号");
  assert.match(action, new RegExp(`\\[引用 #${ref}\\]`), "编号要与界面 #编号 一致");
  assert.match(action, /把卡片样式改成同色系深浅区分/, "被引原文要进派单说明");
});

test("取不到原文时退回前端摘要，派单说明仍能看到被引内容", () => {
  const root = sandbox();
  const r = runCommand(root, {
    action: "say",
    id: "u1/s1",
    text: "照引用来",
    quote: "D-nothing",
    quote_text: "前端带来的首行摘要",
  });
  assert.equal(r.status, 200);
  const [rec] = listDirectives(root);
  assert.match(String(rec.quote_text || ""), /前端带来的首行摘要/);
  const action = spliceDirectives("原始派单正文", claimDirectives(root, { shard: "s1", dispatchId: "D-x", lane: "u1/s1" }));
  assert.match(action, /\[引用 #D-nothing\] 前端带来的首行摘要/);
});

test("带引用的插话同样唤醒已结束的派单", () => {
  const root = sandbox();
  const ref = seedDispatch(root, { status: "done" });

  const r = runCommand(root, { action: "say", id: "u1/s1", shard: "s1", text: "继续改", quote: ref });
  assert.equal(r.status, 200);
  assert.equal(r.body.woke, "D-quote1", "带引用的插话必须走与普通插话相同的唤醒路径");
  assert.equal(capitalist.readDispatches(root)[0].status, "open", "原单要翻回 open 续跑");
});

test("不带引用的插话行为保持不变（登记 + 唤醒）", () => {
  const root = sandbox();
  seedDispatch(root, { status: "done" });

  const r = runCommand(root, { action: "say", id: "u1/s1", shard: "s1", text: "普通插话" });
  assert.equal(r.status, 200);
  assert.equal(r.body.woke, "D-quote1");
  assert.ok(!("quote" in r.body), "不带引用的回执不携带 quote 字段");
});
