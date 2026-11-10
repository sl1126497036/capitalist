
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { createTaskRoot } = require(join(PKG, "dist/core/init.js"));
const { appendDispatch, readDispatches } = require(join(PKG, "dist/core/supervisor.js"));
const { assignThreadNos, dispatchOfThreadNo } = require(join(PKG, "dist/supervisor/threadNo.js"));
const { laneKeyOf } = require(join(PKG, "dist/core/commands.js"));
const { appendSupervisorDirective } = require(join(PKG, "dist/supervisor/direct.js"));
const { loadState } = require(join(PKG, "dist/core/state.js"));
const { readJsonl } = require(join(PKG, "dist/core/json.js"));
const loop = require(join(PKG, "dist/supervisor/loop.js"));

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-promote-no-"));
  createTaskRoot({ target: "按号置顶", contractSpec: "minimal", root: base });
  return base;
}

/** 建一张单并给它分配任务号，返回 { id, no }。 */
function seedWithNo(root, id, over = {}) {
  appendDispatch(root, {
    id,
    at: new Date().toISOString(),
    stage: "U1",
    shard: "",
    action: `做 ${id}`,
    status: "open",
    source: "adhoc",
    lineage: id,
    ...over,
  });
  const d = readDispatches(root).find((x) => x.id === id);
  const key = laneKeyOf({ stage: d.stage, shard: d.shard, lineage: d.lineage || d.id });
  const nos = assignThreadNos(root, [key]);
  return { id, no: nos.get(key), key };
}

test("按号定位：`#75` 能翻到它那条线程上的在途单", () => {
  const root = sandbox();
  try {
    const { id, no } = seedWithNo(root, "D-mw0vjtrbssn");
    assert.ok(Number.isFinite(no) && no > 0, "号已分配");
    const hit = dispatchOfThreadNo(root, no);
    assert.ok(hit, "按号找到了单");
    assert.equal(hit.id, id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("按号定位：单已终结时不返回（不拿死单去置顶）", () => {
  const root = sandbox();
  try {
    const { no } = seedWithNo(root, "D-done1", { status: "done" });
    assert.equal(dispatchOfThreadNo(root, no), undefined, "终结的单不该被翻出来");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("按号定位：编号表里没有这个号 → undefined，不按队列顺序猜", () => {
  const root = sandbox();
  try {
    seedWithNo(root, "D-any");
    assert.equal(dispatchOfThreadNo(root, 999), undefined, "猜一张最像的比报错更糟");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("监工我说「立即执行 #N」：指令落下去能真的置顶", async () => {
  const root = sandbox();
  try {
    const { id, no } = seedWithNo(root, "D-queued1");
    appendSupervisorDirective(root, { action: "promote", arg: `#${no}` });
    await loop.__testing.applySupervisorDirectives({
      root,
      contract: { stages: [], data: {} },
      state: loadState(root),
      wopts: {},
      concurrency: null,
      out: () => {},
    });

    const rec = readJsonl(join(root, ".capitalist", "supervisor-direct.jsonl")).pop();
    assert.equal(rec?.result?.ok, true, `指令应成功，实际：${JSON.stringify(rec?.result)}`);

    const d = readDispatches(root).find((x) => x.id === id);
    assert.ok(d?.promoted_at, "单上应留下置顶标记");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("监工我说「立即执行 #N」而号不存在：给明确的拒绝理由，不再说「找不到排队中的单」", async () => {
  const root = sandbox();
  try {
    seedWithNo(root, "D-queued2");
    appendSupervisorDirective(root, { action: "promote", arg: "#999" });
    await loop.__testing.applySupervisorDirectives({
      root,
      contract: { stages: [], data: {} },
      state: loadState(root),
      wopts: {},
      concurrency: null,
      out: () => {},
    });

    const rec = readJsonl(join(root, ".capitalist", "supervisor-direct.jsonl")).pop();
    assert.equal(rec?.result?.ok, false);
    assert.match(String(rec?.result?.reason ?? ""), /#999/, "要把那个号原话说回来");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
