/**
 * "编号 → 派单 id"的唯一入口。
 *
 * 三处调用方（调度挂依赖、命令行排结构、看板按号操作）曾各自解析：调度侧走
 * "at 最新 → 线程键 → 台账最后一行"，另外两处按"派单序最大"。落盘顺序被并发
 * 打乱、或派生链与任务号脱钩时，同一个 `#NN` 会指向不同的单，且不报错。
 *
 * 这里守住三件事：
 *   1. 基准唯一：任务号一律取派单序最大的那一单；
 *   2. 不跨任务：派生链被改写也不许落到别的任务上；
 *   3. 旧格式单能寻址：命令与调度给出同一个答案。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { createTaskRoot } = require(join(PKG, "dist/core/contract/init.js"));
const { appendDispatch, dispatchPath, readDispatches } = require(join(PKG, "dist/core/record/supervisor.js"));
const { writeJsonl } = require(join(PKG, "dist/core/record/json.js"));
const { assignThreadNos, dispatchOfRef, dispatchOfThreadNo } = require(join(PKG, "dist/supervisor/usage/threadNo.js"));
const { laneKeyOf } = require(join(PKG, "dist/core/dispatch/commands.js"));
const { resolveIds } = require(join(PKG, "dist/cli/cmd/treeGroup.js"));

/* 清理失败（本机安全策略会拦删除）不该把已通过的断言判成失败。 */
function cleanup(p) {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* 留给系统回收。 */
  }
}

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-ref-"));
  createTaskRoot({ target: "编号解析", contractSpec: "minimal", root: base });
  return base;
}

function seed(root, id, over = {}) {
  appendDispatch(root, {
    id,
    at: new Date().toISOString(),
    stage: "S0",
    shard: "",
    action: `做 ${id}`,
    status: "open",
    lineage: id,
    ...over,
  });
}

/** 把两张单在台账里的落盘顺序对调，模拟并发建单时先取号的后落盘。 */
function swapRows(root, a, b) {
  const rows = readDispatches(root);
  const i = rows.findIndex((x) => String(x.id) === a);
  const j = rows.findIndex((x) => String(x.id) === b);
  assert.ok(i >= 0 && j >= 0, "两张单都在台账里");
  [rows[i], rows[j]] = [rows[j], rows[i]];
  writeJsonl(dispatchPath(root), rows);
}

test("落盘顺序与派单序不一致：按号仍取派单序最大的那一单", () => {
  const root = sandbox();
  try {
    seed(root, "1-1", { status: "done", lineage: "1-1" });
    seed(root, "1-2", { status: "done", lineage: "1-1" });
    seed(root, "1-3", { status: "open", lineage: "1-1" });
    /* 顺序变成 1-1, 1-3, 1-2：此时"台账最后一行"是 1-2，"派单序最大"是 1-3。 */
    swapRows(root, "1-2", "1-3");

    const hit = dispatchOfRef(root, "#1", { anyStatus: true });
    assert.equal(String(hit?.id ?? ""), "1-3", "调度侧不能按落盘顺序取最后一行");
    assert.deepEqual(resolveIds(root, ["#1"]).ids, ["1-3"], "命令侧与调度侧给出同一张单");
  } finally {
    cleanup(root);
  }
});

test("派生链与任务号脱钩：不落到别的任务上", () => {
  const root = sandbox();
  try {
    seed(root, "5-1", { status: "done", lineage: "5-1" });
    seed(root, "5-2", { status: "done", lineage: "5-1" });
    /* 6-3 的派生链被改成任务 5 的链首：线程键会跟着跑到任务 5 那条线上。 */
    seed(root, "6-1", { status: "done", lineage: "6-1" });
    seed(root, "6-2", { status: "done", lineage: "6-1" });
    seed(root, "6-3", { status: "open", lineage: "5-1" });

    const hit = dispatchOfRef(root, "#6", { anyStatus: true });
    assert.equal(String(hit?.id ?? ""), "6-3", "只认任务号前缀，派生链怎么写都不许跨任务");
    assert.notEqual(String(hit?.id ?? ""), "5-2", "不能挂到任务 5 的单上");
    assert.deepEqual(resolveIds(root, ["#6"]).ids, ["6-3"]);
  } finally {
    cleanup(root);
  }
});

test("旧格式单：命令与调度都能按号寻址（此前命令侧按字符串前缀比较，找不到）", () => {
  const root = sandbox();
  try {
    seed(root, "D-old1", { status: "done" });
    /* 旧单没有任务号前缀，号来自历史编号表。 */
    const d = readDispatches(root).find((x) => x.id === "D-old1");
    const key = laneKeyOf({ stage: d.stage, shard: d.shard, lineage: d.lineage || d.id });
    const no = assignThreadNos(root, [key]).get(key);
    assert.ok(Number.isFinite(no) && no > 0, "历史号已写入");

    assert.equal(String(dispatchOfRef(root, `#${no}`, { anyStatus: true })?.id ?? ""), "D-old1");
    assert.deepEqual(resolveIds(root, [`#${no}`]).ids, ["D-old1"], "命令侧与调度侧一致");
  } finally {
    cleanup(root);
  }
});

test("状态范围由调用方决定：默认只认在途，排结构可指向已结束的单", () => {
  const root = sandbox();
  try {
    seed(root, "2-1", { status: "done", lineage: "2-1" });
    /* 看板按号重试只认在途单，已结束的不能当作"当前在做的单"。 */
    assert.equal(dispatchOfThreadNo(root, 2), undefined);
    /* 挂依赖、排结构要能指向已结束的单。 */
    assert.equal(String(dispatchOfRef(root, "#2", { anyStatus: true })?.id ?? ""), "2-1");
  } finally {
    cleanup(root);
  }
});

test("派单号与任务号指向同一张单，前导零不影响", () => {
  const root = sandbox();
  try {
    seed(root, "3-1", { status: "done", lineage: "3-1" });
    seed(root, "3-2", { status: "open", lineage: "3-1" });
    for (const tok of ["#3", "#03", "3-2", "03-2"]) {
      assert.equal(String(dispatchOfRef(root, tok, { anyStatus: true })?.id ?? ""), "3-2", tok);
    }
  } finally {
    cleanup(root);
  }
});

test("组号与无法识别的形态返回 undefined，由调用方给文案", () => {
  const root = sandbox();
  try {
    seed(root, "4-1", { status: "open", lineage: "4-1" });
    assert.equal(dispatchOfRef(root, "#G1"), undefined, "组不是派单行");
    assert.equal(dispatchOfRef(root, "s0/x4-1"), undefined, "线程键不是编号形态");
    /* 命令侧要报"不是派单编号"，不能静默当成找不到。 */
    assert.match(resolveIds(root, ["#G1"]).errors[0] ?? "", /不是派单编号/);
  } finally {
    cleanup(root);
  }
});
