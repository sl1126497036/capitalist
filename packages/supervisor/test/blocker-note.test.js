
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/record/supervisor");
const { createTaskRoot } = require("../dist/core/contract/init");
const { appendSection } = require("../dist/core/dispatch/commands");
const worker = require("../dist/supervisor/worker/worker");

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-blocker-"));
  createTaskRoot({ target: "卡点测试", contractSpec: "minimal", root: base });
  return base;
}

function fail(root, extra) {
  capitalist.appendDispatch(root, {
    id: extra.id,
    at: new Date(Date.now() - (extra.back ?? 1000)).toISOString(),
    stage: "S0",
    shard: "a",
    action: "改 A",
    status: "failed",
    ...extra,
  });
}

test("卡点段只写卡点与打法，长度不超过上限", () => {
  const text = worker.buildSkipBlocker({ note: "跑测试时进程挂住，十分钟没有任何新输出。" });
  assert.ok(text.includes(worker.BLOCKER_MARKER), "要标明这是上一轮卡点，不是新要求");
  assert.match(text, /挂住/);
  assert.ok(text.length <= worker.BLOCKER_MAX_CHARS, `卡点段 ${text.length} 字，超过上限`);
});

test("拿不到失败原因时明说，并让 worker 先复现", () => {
  const text = worker.buildSkipBlocker({});
  assert.match(text, /没留下失败原因/);
  assert.match(text, /复现/);
});

test("重派后的正文只出现一次，卡点段挂在后面", () => {
  const root = sandbox();
  fail(root, { id: "D-1", note: "端口被占，重启后再跑仍然挂住。" });

  const body = "把重派提示词改成追加卡点段。";
  const prev = worker.findPreviousBlocker(root, { shard: "a" });
  const action = appendSection(body, worker.BLOCKER_MARKER, worker.blockerLines(prev));

  assert.equal(action.split(body).length - 1, 1, "原任务正文只能出现一次");
  assert.match(action, /端口被占/, "上一轮的卡点要带上");
  assert.ok(action.startsWith(body), "旧正文原样留在前面，不在中途被改写");
});

test("同一张单连续重派两次，卡点段跟着台账里最新的失败单变化", () => {
  const root = sandbox();
  fail(root, { id: "D-1", back: 3000, note: "第一次：测试进程挂住。" });
  const first = worker.buildSkipBlocker(worker.findPreviousBlocker(root, { shard: "a" }));

  fail(root, { id: "D-2", back: 1000, note: "第二次：契约里这一片已被删掉，找不到入口。" });
  const second = worker.buildSkipBlocker(worker.findPreviousBlocker(root, { shard: "a" }));

  assert.match(first, /第一次/);
  assert.match(second, /第二次/);
  assert.notEqual(first, second);
});

test("没有失败前身时不追加卡点段", () => {
  const root = sandbox();
  assert.equal(worker.findPreviousBlocker(root, { shard: "a" }), null);
});

test("续跑提示词与重派共用同一份卡点段，正文重发一次且卡点只说一次", () => {
  const root = sandbox();
  fail(root, { id: "D-1", note: "npm test 卡住，十分钟没有输出。" });
  const body = "把重派提示词改成追加卡点段。";
  const dispatched = appendSection(
    body,
    worker.BLOCKER_MARKER,
    worker.blockerLines(worker.findPreviousBlocker(root, { shard: "a" })),
  );
  capitalist.appendDispatch(root, {
    id: "D-2",
    at: new Date().toISOString(),
    stage: "S0",
    shard: "a",
    action: dispatched,
    status: "running",
  });
  const prompt = worker.buildResumePrompt({
    root,
    target: "卡点测试",
    dispatch: { id: "D-2", stage: "S0", shard: "a", action: dispatched },
  });

  assert.equal(prompt.split(body).length - 1, 1, "续跑提示词自包含：正文原样重发一次");
  assert.equal(prompt.split(worker.BLOCKER_MARKER).length - 1, 1, "卡点段只能说一次");
});

test("续跑时上一轮失败过、本单还没带卡点段，由续跑自己补上", () => {
  const root = sandbox();
  fail(root, { id: "D-1", note: "权限不足，写不进目标目录。" });
  const prompt = worker.buildResumePrompt({
    root,
    target: "卡点测试",
    dispatch: { id: "D-9", stage: "S0", shard: "a", action: "改 A" },
  });
  assert.match(prompt, /权限不足/);
  assert.equal(prompt.split(worker.BLOCKER_MARKER).length - 1, 1);
});

test("卡点段不撑爆提示词：追加后总长度增长不超过 15%", () => {
  const root = sandbox();
  fail(root, { id: "D-1", note: "测试进程把端口占住，重启后仍挂住。" });
  const body =
    "重派时不再重写提示词，改为在正文末尾追加一条跳过卡点的短消息，改动限定在重派与续跑两条路径。";
  const blocker = worker.blockerLines(worker.findPreviousBlocker(root, { shard: "a" }));
  const mk = (action) =>
    worker.buildPrompt({
      root,
      target: "卡点测试",
      id: "D-2",
      dispatch: { id: "D-2", stage: "S0", shard: "a", action },
    }).length;
  const before = mk(body);
  const after = mk(appendSection(body, worker.BLOCKER_MARKER, blocker));
  assert.ok(after > before, "卡点段要真的追加上去");
  assert.ok((after - before) / before <= 0.15, `增长 ${(after - before) / before}，超过 15%`);
});
