
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/supervisor");
const preempt = require("../dist/core/preempt");
const { createTaskRoot } = require("../dist/core/init");

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-queue-"));
  createTaskRoot({ target: "插队语义测试", contractSpec: "minimal", root: base });
  return base;
}

function put(root, id, extra = {}) {
  capitalist.appendDispatch(root, {
    id,
    at: new Date().toISOString(),
    stage: "S0",
    shard: "",
    action: `做 ${id}`,
    status: "open",
    ...extra,
  });
}

function read(root, id) {
  return capitalist.readDispatches(root).find((d) => d.id === id);
}

function order(root) {
  return capitalist.openQueue(root).map((d) => d.id);
}

test("插队只写 front_at，不是立即执行", () => {
  const root = sandbox();
  put(root, "D-a");
  put(root, "D-b");

  const r = capitalist.frontDispatch(root, "D-b");
  assert.ok(r, "排队中的单应能插队");
  const d = read(root, "D-b");
  assert.ok(d.front_at, "应写 front_at");
  assert.equal(d.promoted_at, undefined, "不许写 promoted_at——否则会被当立即执行去腾槽");
  assert.equal(preempt.isImmediate(d), false, "插队单不能被判成立即执行");
});

test("插队单排在普通单与 urgent 单之前", () => {
  const root = sandbox();
  put(root, "D-normal");
  put(root, "D-urgent", { urgent: true });
  put(root, "D-front");

  capitalist.frontDispatch(root, "D-front");
  assert.deepEqual(order(root), ["D-front", "D-urgent", "D-normal"]);
});

test("立即执行（promote）压过插队单", () => {
  const root = sandbox();
  put(root, "D-front");
  put(root, "D-now");
  capitalist.frontDispatch(root, "D-front");
  capitalist.promoteDispatch(root, "D-now");

  assert.deepEqual(order(root), ["D-now", "D-front"]);
  assert.equal(preempt.isImmediate(read(root, "D-now")), true);
});

test("正运行中的单不能插队：要抢跑得用立即执行", () => {
  const root = sandbox();
  put(root, "D-run", { status: "claimed" });
  assert.equal(capitalist.frontDispatch(root, "D-run"), null, "claimed 的单插不进去");
});

test("让位单按 yield_rank 恢复，不会掉到队尾", () => {
  const root = sandbox();
  put(root, "D-y1", { urgent: true, yield_rank: 1 });
  put(root, "D-y2", { urgent: true, yield_rank: 2 });
  put(root, "D-new", { urgent: true });

  assert.deepEqual(order(root), ["D-y1", "D-y2", "D-new"]);
});

test("让位恢复的单排在插队与新建单之前，仅次于手动置顶", () => {
  const root = sandbox();
  put(root, "D-r1");
  put(root, "D-r2");
  put(root, "D-front");
  capitalist.frontDispatch(root, "D-front");

  preempt.markYielded(root, ["D-r1", "D-r2"], "D-now");
  preempt.releaseYielded(root, "D-now");

  /* 恢复之后再新建的插队单与普通单都排在恢复单后面，恢复单不掉回队尾。 */
  put(root, "D-new", { urgent: true });
  put(root, "D-newer");
  assert.deepEqual(order(root), ["D-r1", "D-r2", "D-front", "D-new", "D-newer"]);

  /* 手动置顶仍然压过恢复单。 */
  capitalist.promoteDispatch(root, "D-newer");
  assert.deepEqual(order(root), ["D-newer", "D-r1", "D-r2", "D-front", "D-new"]);
});

test("让位期间（yielded_at 还在）不算恢复档，仍按当时队列顺序排", () => {
  const root = sandbox();
  put(root, "D-a");
  put(root, "D-b", { urgent: true });
  preempt.markYielded(root, ["D-a", "D-b"], "D-now");

  /* D-a 带序号但还挂着 yielded_at：不进恢复档，urgent 的 D-b 仍排在它前面。 */
  assert.deepEqual(order(root), ["D-b", "D-a"]);
});
