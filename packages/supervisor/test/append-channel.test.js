
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/supervisor");
const cmds = require("../dist/core/commands");
const { createTaskRoot } = require("../dist/core/init");
const { recordEvent } = require("../dist/core/ledger");
const { loadState } = require("../dist/core/state");
const dispatch = require("../dist/host/dispatch").dispatch;
const { byId } = require("../dist/host/registry");
const { buildThreadMessages, buildSupervisorLog } = require("../dist/supervisor/board");
const { appendSupervisorDirective, listSupervisorDirectives, markSupervisorDirective } = require("../dist/supervisor/direct");
const { assignThreadNos } = require("../dist/supervisor/threadNo");
const loop = require("../dist/supervisor/loop");

const hook = byId("generic").hook;

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-append-"));
  createTaskRoot({ target: "追加消息测试", contractSpec: "minimal", root: base });
  return base;
}

function seedDispatch(root, extra = {}) {
  capitalist.appendDispatch(root, {
    id: "D-append1",
    at: new Date().toISOString(),
    stage: "S0",
    shard: "a",
    action: "改 A",
    status: "claimed",
    lineage: "D-append1",
    ...extra,
  });
}

function workerEvent(root, overrides = {}) {
  return {
    point: "on_action",
    native: "PreToolUse",
    sessionId: "sess-1",
    cwd: root,
    tool: "Bash",
    toolInput: { command: "npm test" },
    transcript: "",
    prompt: "",
    ...overrides,
  };
}

function withWorkerEnv(root, fn) {
  const saved = {
    CAPITALIST_ROOT: process.env.CAPITALIST_ROOT,
    CAPITALIST_WORKER_ID: process.env.CAPITALIST_WORKER_ID,
    CAPITALIST_DISPATCH_ID: process.env.CAPITALIST_DISPATCH_ID,
  };
  process.env.CAPITALIST_ROOT = root;
  process.env.CAPITALIST_WORKER_ID = "W-append";
  process.env.CAPITALIST_DISPATCH_ID = "D-append1";
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("执行中的单：hook 在下一次工具调用前送达追加内容，不中断的语义由模型续跑承担", () => {
  const root = sandbox();
  seedDispatch(root);
  cmds.appendDirective(root, { text: "把重试间隔改成 5 秒", shard: "a" });

  withWorkerEnv(root, () => {
    const r = dispatch(hook, workerEvent(root));
    if (hook.structuredDeny) {
      assert.equal(r.code, 0, "送达走结构化拒绝，退出码 0");
      assert.ok(r.stdout && r.stdout.includes("把重试间隔改成 5 秒"), "追加原文必须出现在拒绝理由里");
      assert.ok(r.stdout.includes("D-append1"), "理由里写明属于哪一单");
      assert.ok(r.stdout.includes("permissionDecision"), "按宿主协议输出结构化拒绝");
    } else {
      assert.equal(r.code, 2, "无结构化输出的宿主用退出码 2 阻断以送达");
    }
  });

  const row = cmds.listDirectives(root)[0];
  assert.equal(row.consumed, true, "送达即领走：同一句话不能反复送达");
  assert.equal(row.consumed_by, "D-append1", "留痕：进了哪一单");
  assert.ok(row.consumed_at, "留痕：什么时候送达的");
  assert.equal(row.consumed_via, "hook", "留痕：是执行中送达的，不是启动带入的");
});

test("送达之后不再重复：第二次工具调用放行，插话保持已消费", () => {
  const root = sandbox();
  seedDispatch(root);
  cmds.appendDirective(root, { text: "追加内容", shard: "a" });

  withWorkerEnv(root, () => {
    dispatch(hook, workerEvent(root));
    const r2 = dispatch(hook, workerEvent(root, { sessionId: "sess-2" }));
    assert.ok(!r2.stdout || !r2.stdout.includes("追加内容"), "同一句话只能送达一次");
  });
  assert.equal(cmds.listDirectives(root)[0].consumed, true);
});

test("别单的消息不串：血缘对不上的插话不会被这一单领走", () => {
  const root = sandbox();
  seedDispatch(root, { lineage: "D-other" });
  cmds.appendDirective(root, { text: "这是给另一条链的话", lineage: "D-mine" });

  withWorkerEnv(root, () => {
    const r = dispatch(hook, workerEvent(root));
    assert.ok(!r.stdout || !r.stdout.includes("另一条链"), "带血缘的插话只归那条链");
  });
  assert.equal(cmds.listDirectives(root)[0].consumed, false);
});

test("非 worker 会话不领插话：没有 CAPITALIST_WORKER_ID 时 hook 照常放行", () => {
  const root = sandbox();
  seedDispatch(root);
  cmds.appendDirective(root, { text: "给派单的话", shard: "a" });

  const saved = process.env.CAPITALIST_WORKER_ID;
  delete process.env.CAPITALIST_WORKER_ID;
  delete process.env.CAPITALIST_DISPATCH_ID;
  delete process.env.CAPITALIST_ROOT;
  try {
    const r = dispatch(hook, workerEvent(root));
    assert.ok(!r.stdout || !r.stdout.includes("给派单的话"), "插话通道只对执行中的派单生效");
  } finally {
    if (saved !== undefined) process.env.CAPITALIST_WORKER_ID = saved;
  }
  assert.equal(cmds.listDirectives(root)[0].consumed, false, "未送达就保持未消费，留给下一次派单");
});

test("送达留痕进台账：direct_deliver 事件带派单与进程归属", () => {
  const root = sandbox();
  seedDispatch(root);
  cmds.appendDirective(root, { text: "追加内容", shard: "a" });

  withWorkerEnv(root, () => {
    dispatch(hook, workerEvent(root));
  });
  const events = require("../dist/core/json").readJsonl(join(root, ".capitalist", "events.jsonl"));
  const hit = events.filter((e) => String(e.event ?? e.kind) === "direct_deliver");
  assert.equal(hit.length, 1, "一次送达只记一条事件");
  assert.equal(hit[0].dispatch, "D-append1");
  assert.equal(hit[0].worker, "W-append");
  assert.ok(String(hit[0].text).includes("追加内容"));
});

test("未开工的单：启动时领取并拼进 action，consumed_via=launch", () => {
  const root = sandbox();
  seedDispatch(root, { status: "open" });
  cmds.appendDirective(root, { text: "启动时一起带入", shard: "a" });

  const taken = cmds.claimDirectives(root, {
    shard: "a",
    stage: "S0",
    dispatchId: "D-append1",
    lineage: "D-append1",
  });
  assert.equal(taken.length, 1);
  assert.equal(taken[0].consumed_via, "launch", "默认途径记 launch（随派单启动带入）");

  const spliced = cmds.spliceDirectives("改 A", taken);
  assert.ok(spliced.includes("【用户插话 · 只对本次派单生效】"), "拼进 action 时带插话标记");
  assert.ok(spliced.includes("启动时一起带入"));
});

test("看板会话流可查：送达回执与消息状态区分两种生效方式", () => {
  const root = sandbox();
  seedDispatch(root);
  cmds.appendDirective(root, { text: "追加内容", shard: "a" });

  withWorkerEnv(root, () => {
    dispatch(hook, workerEvent(root));
  });
  /* 任务编号由后端分配（/api/threads 做这件事）；本测试直接建表，验证卡片按它取号。 */
  assignThreadNos(root, ["s0/a"]);

  const { messages } = buildThreadMessages(root, "shard:a", "a", { limit: 400 });
  const deliver = messages.find((m) => m.event === "direct_deliver");
  assert.ok(deliver, "送达回执要出现在该单的会话流里");
  assert.ok(deliver.text.includes("追加内容"), "回执带上送达的原文");
  assert.ok(deliver.text.includes("执行中的进程"), "回执说明送达对象");
  assert.ok(deliver.text.includes("#01"), `回执要带任务编号：${deliver.text}`);
  assert.ok(!deliver.text.includes("D-append1"), "回执不显示内部派单标识");

  const say = messages.find((m) => m.kind === "say" && String(m.text).includes("追加内容"));
  assert.ok(say, "用户那句话也在流里");
  assert.equal(say.status, "已送达执行中的进程 · 待结论", "已送达但还没给结论时，状态要说清");
  assert.equal(say.no, "01", "追加卡片显示目标单号");
  assert.ok(!String(say.status).includes("D-append1"), "状态里不出现内部派单标识");
});

test("看板会话流：未消费的追加内容显示去向，不写成无限期等待", () => {
  const root = sandbox();
  seedDispatch(root, { status: "open" });
  cmds.appendDirective(root, { text: "还没生效的话", shard: "a" });
  recordEvent(root, "direct_inject", { shard: "a", text: "还没生效的话" });

  const { messages } = buildThreadMessages(root, "shard:a", "a", { limit: 400 });
  const say = messages.find((m) => m.kind === "say" && String(m.text).includes("还没生效的话"));
  assert.ok(say, "未生效的话也显示（那是「我说过什么」，不是待办清单）");
  assert.equal(say.status, "已登记，随归属单带入");
  assert.equal(say.no, undefined, "未消费的追加还没进任何一单，不许显示单号");
  assert.ok(!String(say.status).includes("等下一次派单"), "目标单在跑或即将启动时不许写无限期等待");
});

test("滞留追加补投递：目标单已终结时翻回 open，下一拍带着追加重新拉起", () => {
  const root = sandbox();
  seedDispatch(root, { status: "failed", done_at: new Date().toISOString() });
  cmds.appendDirective(root, {
    text: "结单之后才补的这句也要执行",
    shard: "a",
    target: "D-append1",
    lineage: "D-append1",
  });

  const loop = require("../dist/supervisor/loop");
  const reopened = loop.drainSettledDirectives(root);
  assert.deepEqual(reopened, ["D-append1"]);
  const row = capitalist.readDispatches(root).find((d) => d.id === "D-append1");
  assert.equal(row.status, "open", "已终结的单要翻回 open 才有进程去执行这条追加");
  assert.equal(row.done_at, undefined, "旧的完成时间要清掉，否则下一拍又当它已结束");
  assert.equal(cmds.listDirectives(root)[0].consumed, false, "翻单不等于消费，启动时才并入");

  /* 仍在途的单不动：在跑由 hook 下一个动作间隙送达。 */
  seedDispatch(root, { id: "D-run", lineage: "D-run", status: "claimed" });
  cmds.appendDirective(root, { text: "在跑的单不要翻", shard: "a", target: "D-run", lineage: "D-run" });
  assert.deepEqual(loop.drainSettledDirectives(root), [], "在途单不该被翻回 open");
});

test("同一次追加只画一张卡片：directive_amended 与插话记录同文时不重复下发", () => {
  const root = sandbox();
  seedDispatch(root);
  const text = "把 tooltip 里重复元素自身文字的那些提示删掉，逐处判定而不是一把删光";
  cmds.appendDirective(root, {
    text,
    shard: "a",
    target: "D-append1",
    lineage: "D-append1",
    via: "capitalist",
  });
  recordEvent(root, "directive_amended", {
    dispatch: "D-append1",
    stage: "S0",
    shard: "a",
    status: "claimed",
    text,
  });

  const { messages } = buildThreadMessages(root, "shard:a", "a", { limit: 400 });
  const hits = messages.filter((m) =>
    String(m.text ?? "").replace(/\s+/g, "").includes(text.replace(/\s+/g, "")),
  );
  assert.equal(hits.length, 1, `同一次追加应只剩一张卡片，实际 ${hits.length} 条：${hits.map((h) => h.kind).join(" / ")}`);
  assert.equal(hits[0].kind, "say", "保留消息卡片，丢掉带「追加内容」标签的原始记录");
});


async function runSupervisorDirectives(root) {
  await loop.__testing.applySupervisorDirectives({
    root,
    contract: { stages: [], data: {} },
    state: loadState(root),
    wopts: {},
    concurrency: null,
    out: () => {},
  });
}

test("合并回执显示并入的任务编号：卡片与结果说明都不出现内部派单 id", async () => {
  const root = sandbox();
  capitalist.appendDispatch(root, {
    id: "D-merge",
    at: new Date().toISOString(),
    stage: "S0",
    shard: "a",
    action: "改 A",
    status: "open",
    lineage: "D-merge",
    source: "adhoc",
    attempt: 1,
    tags: ["ui"],
  });
  assignThreadNos(root, ["s0/a"]);

  appendSupervisorDirective(root, { action: "dispatch", arg: "[ui] 再加一条同类要求" });
  await runSupervisorDirectives(root);

  const rec = listSupervisorDirectives(root)[0];
  assert.equal(rec.result?.ok, true, "合并成功");
  assert.equal(rec.result?.dispatch, "D-merge", "结果里落目标单（回执据此查号）");
  assert.ok(String(rec.result?.detail).includes("#01"), `回执要写清并入了哪一单：${rec.result?.detail}`);
  assert.ok(!String(rec.result?.detail).includes("D-merge"), "回执不显示内部派单标识");

  const log = buildSupervisorLog(root, { hours: 0 });
  const card = log.messages.find((m) => m.id === `SC-${rec.id}`);
  assert.ok(card, "调度指令那条回执在监工流里");
  assert.equal(card.no, "01", "合并回执卡片带目标单号（与任务列表同源）");
});

test("历史合并回执按自己的说明回填编号：查不到归属时不显示，也不猜", () => {
  const root = sandbox();
  capitalist.appendDispatch(root, {
    id: "D-old",
    at: new Date().toISOString(),
    stage: "S0",
    shard: "a",
    action: "老单",
    status: "open",
    lineage: "D-old",
    source: "adhoc",
    attempt: 1,
  });
  assignThreadNos(root, ["s0/a"]);

  const a = appendSupervisorDirective(root, { action: "dispatch", arg: "[ui] 并进老单" });
  markSupervisorDirective(root, a.rec.id, {
    ok: true,
    reason: "",
    detail: "同类任务已在执行：本条并入派单 D-old（批次 ui，累计 10 字），不新建进程",
  });
  /* 编号表中查不到的派单不写编号，也不按时间或队列顺序推断。 */
  const b = appendSupervisorDirective(root, { action: "dispatch", arg: "[ui] 并进未知单" });
  markSupervisorDirective(root, b.rec.id, {
    ok: true,
    reason: "",
    detail: "同类任务已在执行：本条并入派单 D-missing（批次 ui，累计 10 字），不新建进程",
  });

  const log = buildSupervisorLog(root, { hours: 0 });
  const old = log.messages.find((m) => m.id === `SC-${a.rec.id}`);
  const missing = log.messages.find((m) => m.id === `SC-${b.rec.id}`);
  assert.equal(old?.no, "01", "能查到归属的历史回执按同一规则回填单号");
  assert.equal(missing?.no, undefined, "查不到归属就不显示单号");
});

test("追加被启动带入时，卡片状态写「已并入派单 #号」而不是只写并入", () => {
  const root = sandbox();
  seedDispatch(root, { status: "open" });
  assignThreadNos(root, ["s0/a"]);
  cmds.appendDirective(root, { text: "启动时一起带入的话", shard: "a" });
  cmds.claimDirectives(root, {
    shard: "a",
    stage: "S0",
    dispatchId: "D-append1",
    lineage: "D-append1",
  });

  const { messages } = buildThreadMessages(root, "shard:a", "a", { limit: 400 });
  const say = messages.find((m) => m.kind === "say" && String(m.text).includes("启动时一起带入的话"));
  assert.equal(say.status, "已并入派单 · 待结论");
  assert.equal(say.no, "01", "已并入时要显示目标单号");

  /* 回报结论之后，同一个卡片要变成「已落实」，这是用户能不能看出「到底改没改」的地方。 */
  const rec = cmds.listDirectives(root).find((x) => String(x.text).includes("启动时一起带入的话"));
  cmds.markDirectiveOutcome(root, cmds.directiveRef(rec), "done", { by: "D-append1", note: "改了 styles.css" });
  const after = buildThreadMessages(root, "shard:a", "a", { limit: 400 });
  const say2 = after.messages.find((m) => m.kind === "say" && String(m.text).includes("启动时一起带入的话"));
  assert.equal(say2.status, "已并入派单 · 已落实");
});

test("没有归属单的追加：不显示单号（宁可不写，也不猜）", () => {
  const root = sandbox();
  seedDispatch(root, { status: "claimed", lineage: "D-other" });
  assignThreadNos(root, ["s0/a"]);
  /* 这句话落在 s0/a 线程上，但没有任何一张单领走它。 */
  cmds.appendDirective(root, { text: "还没有归属的话", shard: "a" });

  const { messages } = buildThreadMessages(root, "shard:a", "a", { limit: 400 });
  const say = messages.find((m) => m.kind === "say" && String(m.text).includes("还没有归属的话"));
  assert.ok(say, "说过的话照样上屏");
  assert.equal(say.no, undefined, "未消费 / 无归属时不显示单号");
});
