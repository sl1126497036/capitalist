
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/record/supervisor");
const { createTaskRoot } = require("../dist/core/contract/init");
const loop = require("../dist/supervisor/loop");
const { buildPrompt, buildResumePrompt } = require("../dist/supervisor/worker/worker");

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-wake-"));
  createTaskRoot({ target: "唤醒测试", contractSpec: "minimal", root: base });
  return base;
}

function dispatchWithTail(root, extra = {}) {
  capitalist.appendDispatch(root, {
    id: "D-wake1",
    at: new Date().toISOString(),
    stage: "S0",
    shard: "a",
    action: "改 A",
    status: "done",
    ...extra,
  });
}

test("续跑提示词自包含：重发正文，并带上用户唤醒的话", () => {
  const root = sandbox();
  const d = {
    id: "D-wake1",
    stage: "S0",
    shard: "a",
    action: "改 A\n\n【用户插话 · 只对本次派单生效】\n- 把重试间隔改成 5 秒",
  };
  const p = buildResumePrompt({ root, target: "唤醒测试", dispatch: d });

  assert.match(p, /把重试间隔改成 5 秒/, "唤醒的话必须进续跑提示词，否则续跑进程根本不知道用户说了什么");
  assert.match(p, /【用户插话/, "插话标记要保留，进程据此分辨哪些是新要求");
  assert.equal(p.split("改 A").length - 1, 1, "正文要自包含地重发一次，且只一次");
  assert.match(p, /自成一体/, "要明确告诉进程这份提示词不依赖上一轮上下文");
  assert.match(p, /D-wake1/, "派单 id 要在，收尾 report 用得上");
});

test("没有尾巴时续跑提示词照样带正文，不出现空的插话段", () => {
  const root = sandbox();
  const p = buildResumePrompt({
    root,
    target: "唤醒测试",
    dispatch: { id: "D-wake1", stage: "S0", shard: "a", action: "改 A" },
  });
  assert.match(p, /改 A/, "没有尾巴时正文就是全部依据，必须重发");
  assert.ok(!p.includes("【用户插话"), "没有插话就不该有插话段");
  assert.ok(!p.includes("追加了新要求"), "没有新要求就不该说“追加了新要求”");
});

test("首次启动提示词照旧带整段 action（含尾巴）", () => {
  const root = sandbox();
  const d = {
    id: "D-wake1",
    stage: "S0",
    shard: "a",
    action: "改 A\n\n【用户插话 · 只对本次派单生效】\n- 把重试间隔改成 5 秒",
  };
  const p = buildPrompt({ root, target: "唤醒测试", id: "W-1", dispatch: d });
  assert.match(p, /改 A/, "首启没有上下文，正文必须发");
  assert.match(p, /把重试间隔改成 5 秒/, "插话也必须发");
});

const WAKE_CONTRACT = {
  name: "minimal",
  data: {},
  stages: [
    // 当前阶段是 S1：S0 的在途单按“阶段已推进”本应作废
    { id: "S1", name: "下一阶段", next: "做点事", parallel: [{ id: "b", action: "改 B" }] },
  ],
};

function openStaleDispatch(root, id, extra = {}) {
  capitalist.appendDispatch(root, {
    id,
    at: new Date().toISOString(),
    stage: "S0",
    shard: "a",
    action: "改 A",
    status: "open",
    ...extra,
  });
}

test("刚唤醒的单有宽限期，不因阶段推进被作废", () => {
  const root = sandbox();
  openStaleDispatch(root, "D-woken", { wake_at: new Date().toISOString() });

  loop.__testing.supersedeStaleDispatches(root, WAKE_CONTRACT, "S1", () => {});
  assert.equal(capitalist.readDispatches(root)[0].status, "open", "宽限期内的在途单必须活着，唤醒不能被下一拍掐死");
});

test("唤醒宽限期过期后照常按阶段推进作废", () => {
  const root = sandbox();
  openStaleDispatch(root, "D-old-wake", {
    wake_at: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
  });

  loop.__testing.supersedeStaleDispatches(root, WAKE_CONTRACT, "S1", () => {});
  assert.equal(capitalist.readDispatches(root)[0].status, "superseded", "宽限期不能变成永久豁免");
});

test("没盖唤醒章的在途单不享受宽限", () => {
  const root = sandbox();
  openStaleDispatch(root, "D-plain");

  loop.__testing.supersedeStaleDispatches(root, WAKE_CONTRACT, "S1", () => {});
  assert.equal(capitalist.readDispatches(root)[0].status, "superseded");
});
