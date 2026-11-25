/**
 * 读接口的消息身份必须每轮一致。
 *
 * 前端按 id 合并消息：同一段内容换了 id 就会被当成新消息追加，界面上表现为同一条消息
 * 反复出现，直到切走重建缓冲。守的是工作进程输出块与思考块：它们由日志切分而来，重建
 * 一次就是一次新的构造，身份只能落在稳定量上。
 *
 * 视图块不是消息。它们的身份是 `viewId` 的 `归属~类型~序号`，不带消息编号，界面不提供
 * 引用与复制。判别依据与 `isMsgNo` 同一处。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/record/supervisor");
const { createTaskRoot } = require("../dist/core/policy/init");
const { isMsgNo } = require("../dist/core/message/msgId");
const { buildThreadMessages } = require("../dist/supervisor/board");
const { buildSupervisorLog } = require("../dist/supervisor/board");

const SHARD = "a";
const TID = "shard:a";
const DISPATCH = "D-id1";
const WORKER = "W-id1";

/** 两行日志共用同一个事件时间：真实日志里同一毫秒会产生多个输出块。 */
const BORN = "2026-11-22T11:42:17.498Z";

/** 一段正文行；`▸` 开头会被切成新块。 */
const text = (body) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: body }] },
    __timestamp: BORN,
  });

/** 一段思考行。 */
const think = (body) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "thinking", thinking: body }] },
    __timestamp: BORN,
  });

function scenario() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-msgid-"));
  createTaskRoot({ target: "消息身份稳定性", policySpec: "minimal", root });
  for (const d of [
    "runtime", "ledger", "model", "board", "config", "meta", "workers", "sessions",
    "inbox", "mq", "guard", "brain", "reload", "locks", "archive", ".root",
  ]) {
    mkdirSync(join(root, ".capitalist", d), { recursive: true });
  }

  const startedAt = new Date(Date.now() - 60_000).toISOString();
  capitalist.appendDispatch(root, {
    id: DISPATCH,
    at: startedAt,
    stage: "S0",
    shard: SHARD,
    action: "改 B",
    status: "running",
    lineage: DISPATCH,
  });

  const log = capitalist.workerLogPath(root, WORKER);
  mkdirSync(join(root, ".capitalist", "workers", WORKER), { recursive: true });
  writeFileSync(log, [think("先看结构"), text("▸ 读取一"), text("▸ 读取二"), text("收尾")].join("\n") + "\n");

  const t1 = Date.now() / 1000;
  capitalist.registerWorker(root, {
    id: WORKER,
    host: "generic",
    pid: process.pid,
    session: "sess-id1",
    dispatch: DISPATCH,
    shard: SHARD,
    stage: "S0",
    started_at: new Date((t1 - 60) * 1000).toISOString(),
    heartbeat_at: new Date(t1 * 1000).toISOString(),
    heartbeat_ts: t1,
    status: "running",
    log,
  });
  return { root, log };
}

const outputs = (messages) => messages.filter((m) => m.kind === "output");
const thinks = (messages) => messages.filter((m) => m.kind === "thinking");

test("输出块与思考块连续两次重建的 id 完全一致", () => {
  const { root } = scenario();
  const first = buildThreadMessages(root, TID, SHARD, { limit: 400 });
  const second = buildThreadMessages(root, TID, SHARD, { limit: 400 });
  assert.deepStrictEqual(
    second.messages.map((m) => m.id),
    first.messages.map((m) => m.id),
    "两次重建的 id 必须一致，否则前端会把同一块反复追加成新气泡",
  );
  assert.ok(outputs(first.messages).length >= 2, "日志里的多块输出都要出现");
  assert.equal(thinks(first.messages).length, 1, "思考块按插话切块，这里只有一块");
});

test("日志追加新内容后，旧块的 id 不变", () => {
  const { root, log } = scenario();
  const before = outputs(buildThreadMessages(root, TID, SHARD, { limit: 400 }).messages).map((m) => m.id);
  writeFileSync(log, [text("▸ 读取三"), text("又一段")].join("\n") + "\n", { flag: "a" });
  const after = outputs(buildThreadMessages(root, TID, SHARD, { limit: 400 }).messages).map((m) => m.id);
  for (const id of before) {
    assert.ok(after.includes(id), `旧块 ${id} 不能因为日志增长而换号`);
  }
});

test("视图块不带消息编号：不冒充消息，界面不给引用与复制", () => {
  const { root } = scenario();
  const page = buildThreadMessages(root, TID, SHARD, { limit: 400 });
  const views = [...outputs(page.messages), ...thinks(page.messages)];
  assert.ok(views.length > 0);
  for (const m of views) {
    assert.equal(m.view, true, "视图块要带 view 标记");
    assert.equal(isMsgNo(m.id), false, `视图块 id 不得是消息编号：${m.id}`);
    assert.ok(String(m.id).includes("~"), `视图块身份应为 归属~类型~序号：${m.id}`);
  }
});

test("监工事件流与线程流：同一批事件两次重建的 id 一致", () => {
  const { root } = scenario();
  const { recordEvent } = require("../dist/core/record/ledger");
  /* 两条同一毫秒的可引用事件：补号必须按源顺序取，不能受上一轮计数影响。 */
  for (const status of ["done", "closed"]) {
    recordEvent(root, "dispatch_done", { dispatch: DISPATCH, at: BORN, status });
  }
  const log1 = buildSupervisorLog(root, { limit: 200, hours: 1 });
  const log2 = buildSupervisorLog(root, { limit: 200, hours: 1 });
  assert.deepStrictEqual(
    log2.messages.map((m) => m.id),
    log1.messages.map((m) => m.id),
    "监工事件流的 id 同样必须稳定",
  );
  const thread1 = buildThreadMessages(root, TID, SHARD, { limit: 400 });
  const thread2 = buildThreadMessages(root, TID, SHARD, { limit: 400 });
  assert.deepStrictEqual(
    thread2.messages.map((m) => m.id),
    thread1.messages.map((m) => m.id),
    "线程流里的补号事件同样必须稳定",
  );
});
