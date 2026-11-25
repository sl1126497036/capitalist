
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/record/supervisor");
const cmds = require("../dist/core/dispatch/commands");
const { createTaskRoot } = require("../dist/core/policy/init");

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-dirmatch-"));
  for (const _d of ["runtime", "ledger", "model", "board", "config", "meta", "workers", "sessions", "inbox", "mq", "guard", "brain", "reload", "locks", "archive", ".root"]) mkdirSync(join(base, ".capitalist", _d), { recursive: true });
  createTaskRoot({ target: "插话匹配测试", policySpec: "minimal", root: base });
  return base;
}

function seed(root, row) {
  capitalist.appendDispatch(root, {
    at: new Date().toISOString(),
    stage: "S0",
    shard: "",
    action: `做 ${row.id}`,
    status: "done",
    lineage: row.id,
    ...row,
  });
}


test("target 指向同链的中途派单：重派生成的新派单仍能领取该消息", () => {
  const root = sandbox();
  /* 一条链：D-chain（首）-> D-mid（中途被重派掉）。话钉在 D-mid 上。 */
  seed(root, { id: "D-chain", lineage: "D-chain" });
  seed(root, { id: "D-mid", lineage: "D-chain" });

  cmds.appendDirective(root, { text: "改跳过卡点的提示词", target: "D-mid", stage: "S0" });

  const taken = cmds.claimDirectives(root, {
    shard: "",
    stage: "S0",
    dispatchId: "D-new",
    lineage: "D-chain",
  });
  assert.equal(taken.length, 1, "同链的中途单上的话必须能被本单取走");
  assert.equal(taken[0].text, "改跳过卡点的提示词");
});

test("target 指向其他链：任何派单都无法领取（串台是本通道必须根除的问题）", () => {
  const root = sandbox();
  seed(root, { id: "D-chain", lineage: "D-chain" });
  seed(root, { id: "D-other", lineage: "D-other" });

  cmds.appendDirective(root, { text: "这句是说给另一条链的", target: "D-other", stage: "S0" });

  const taken = cmds.claimDirectives(root, {
    shard: "",
    stage: "S0",
    dispatchId: "D-new",
    lineage: "D-chain",
  });
  assert.equal(taken.length, 0, "别的链的话不许被本单取走");
});

test("target 就是本单：直接命中，不必走链", () => {
  const root = sandbox();
  seed(root, { id: "D-chain", lineage: "D-chain" });
  cmds.appendDirective(root, { text: "本单的补充内容", target: "D-chain", stage: "S0" });

  const taken = cmds.claimDirectives(root, {
    shard: "",
    stage: "S0",
    dispatchId: "D-chain",
    lineage: "D-chain",
  });
  assert.equal(taken.length, 1);
});


test("thread 里是线程键时按线程认领：重派换了进程也还归这条线程", () => {
  const root = sandbox();
  seed(root, { id: "D-chain", lineage: "D-chain" });
  /* 看板落的形状：lane 是线程键，thread 不写。 */
  cmds.appendDirective(root, { text: "收到没", lane: "s0/xchain", stage: "S0" });

  const taken = cmds.claimDirectives(root, {
    shard: "",
    stage: "S0",
    dispatchId: "D-new",
    lineage: "D-chain",
    lane: "s0/xchain",
  });
  assert.equal(taken.length, 1, "线程上的话必须能被这条线程的新进程领走");
});

test("线程对不上就不领：其他线程的插话不会被这条线程认领", () => {
  const root = sandbox();
  seed(root, { id: "D-chain", lineage: "D-chain" });
  cmds.appendDirective(root, { text: "别的线程说的", lane: "s0/a", stage: "S0" });

  const taken = cmds.claimDirectives(root, {
    shard: "",
    stage: "S0",
    dispatchId: "D-new",
    lineage: "D-chain",
    lane: "s0/b",
  });
  assert.equal(taken.length, 0);
});

test("thread 为进程 id 时仅认该进程：进程退出即作废，不转交其他进程", () => {
  const root = sandbox();
  seed(root, { id: "D-chain", lineage: "D-chain" });
  cmds.appendDirective(root, { text: "说给某一台进程的私话", thread: "W-oldproc", stage: "S0" });

  const other = cmds.claimDirectives(root, {
    shard: "",
    stage: "S0",
    dispatchId: "D-new",
    lineage: "D-chain",
    workerId: "W-newproc",
    lane: "s0/xchain",
  });
  assert.equal(other.length, 0, "进程 id 形状的插话不许被别的进程领走");

  const mine = cmds.claimDirectives(root, {
    shard: "",
    stage: "S0",
    dispatchId: "D-new",
    lineage: "D-chain",
    workerId: "W-oldproc",
    lane: "s0/xchain",
  });
  assert.equal(mine.length, 1, "本人来了当然要认");
});

test("老记录只在 thread 里写了线程键：按线程认领", () => {
  const root = sandbox();
  seed(root, { id: "D-chain", lineage: "D-chain" });
  /* 直接落一条老形状：thread 里是线程键，没有 lane。 */
  cmds.appendDirective(root, { text: "老形状的线程话", thread: "u1/main", stage: "S0" });

  const taken = cmds.claimDirectives(root, {
    shard: "",
    stage: "S0",
    dispatchId: "D-new",
    lineage: "D-chain",
    lane: "u1/main",
  });
  assert.equal(taken.length, 1, "历史数据不用迁移也要能领到");
});


test("线程键规则与看板一致：有分片用分片，无分片用派生链尾号", () => {
  assert.equal(cmds.laneKeyOf({ shard: "ui", lineage: "D-abc" }), "ui");
  assert.equal(cmds.laneKeyOf({ shard: "", lineage: "D-mw01lmdixjs" }), "xmdixjs");
  assert.equal(cmds.laneKeyOf({ id: "D-abcdef123456" }), "x123456");
  /* 派生链优先于 id：同一链上不同单必须落到同一个键，否则一次重派就换一条线程。 */
  assert.equal(cmds.laneKeyOf({ lineage: "D-zzzzzz999999", id: "D-other" }), "x999999");
  assert.equal(cmds.laneKeyOf({ shard: null, lineage: "" }), "main");
});


const { appendFileSync } = require("node:fs");
const loop = require("../dist/supervisor/loop");

const noop = () => {};

function rowOf(root, id) {
  return capitalist.readDispatches(root).find((d) => String(d.id) === id);
}

test("悬空追加回收：失败的单挂着追加时翻回 open，并清掉终止痕迹", () => {
  const root = sandbox();
  seed(root, { id: "D-chain", lineage: "D-chain" });
  seed(root, {
    id: "D-last",
    lineage: "D-chain",
    status: "failed",
    retry_verdict: "give_up",
    retry_why: "上一轮判过不再重试",
    done_at: new Date().toISOString(),
  });
  cmds.appendDirective(root, { text: "这条没人读过", target: "D-last", stage: "S0" });

  loop.__testing.rescueOrphanDirectives(root, noop);

  const after = rowOf(root, "D-last");
  assert.equal(after.status, "open", "挂着追加的失败单必须被重新置为 open");
  assert.equal(after.retry_verdict, undefined, "give_up 留着会挡住重派");
  assert.equal(after.done_at, undefined, "done_at 留着会被当成已结束");
  assert.match(String(after.note), /没人读/, "note 要写清为什么又活了");
});

test("悬空追加回收：链上仍有在途派单时不回收（由该派单自行领取）", () => {
  const root = sandbox();
  seed(root, { id: "D-chain", lineage: "D-chain" });
  seed(root, { id: "D-live", lineage: "D-chain", status: "claimed" });
  cmds.appendDirective(root, { text: "等这一单领", target: "D-live", stage: "S0" });

  loop.__testing.rescueOrphanDirectives(root, noop);

  assert.equal(rowOf(root, "D-live").status, "claimed", "在途的单不该被回收动到");
});

test("悬空追加回收：每拍只回收一条链，不一次拉起多个进程", () => {
  const root = sandbox();
  seed(root, { id: "D-a", lineage: "D-a", status: "failed" });
  seed(root, { id: "D-b", lineage: "D-b", status: "failed" });
  cmds.appendDirective(root, { text: "链 A 的追加", target: "D-a", stage: "S0" });
  cmds.appendDirective(root, { text: "链 B 的追加", target: "D-b", stage: "S0" });

  loop.__testing.rescueOrphanDirectives(root, noop);

  const reopened = ["D-a", "D-b"].filter((id) => rowOf(root, id).status === "open");
  assert.equal(reopened.length, 1, "一拍只救一条链，余下的下一拍再说");
});

test("悬空追加回收：用户手动结束的单不被自动拉起", () => {
  /* 关闭是用户的明确意图，监工不得因“仍有消息未读”而将其重新打开。 */
  const root = sandbox();
  seed(root, { id: "D-closed", lineage: "D-closed", status: "closed" });
  cmds.appendDirective(root, { text: "关闭之后补的话", target: "D-closed", stage: "S0" });

  loop.__testing.rescueOrphanDirectives(root, noop);

  assert.equal(rowOf(root, "D-closed").status, "closed", "用户关掉的单必须保持关闭");
});

test("悬空追加回收：正常完成的单也不被自动拉起", () => {
  const root = sandbox();
  seed(root, { id: "D-done", lineage: "D-done", status: "done" });
  cmds.appendDirective(root, { text: "完成之后补的话", target: "D-done", stage: "S0" });

  loop.__testing.rescueOrphanDirectives(root, noop);

  assert.equal(rowOf(root, "D-done").status, "done", "已完成不等于失败，不该由监工自动返工");
});

test("悬空追加回收：超过追诉期的老追加不再回收", () => {
  const root = sandbox();
  seed(root, { id: "D-old", lineage: "D-old" });
  const stale = {
    at: new Date(Date.now() - 48 * 3600_000).toISOString(),
    at_ts: Date.now() / 1000 - 48 * 3600,
    type: "direct",
    text: "两天前的话",
    shard: null,
    target: "D-old",
    stage: "S0",
    consumed: false,
  };
  appendFileSync(join(root, ".capitalist", "ledger", "direct.jsonl"), `${JSON.stringify(stale)}\n`, "utf8");

  loop.__testing.rescueOrphanDirectives(root, noop);

  assert.equal(rowOf(root, "D-old").status, "done", "老账不翻：重开等于让人重做一遍老活");
});
