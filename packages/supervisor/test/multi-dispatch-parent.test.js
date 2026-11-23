/**
 * 一条消息里派多单：树字段按动作归属，`@N` 指本条消息第 N 个派单。
 *
 * 背景：监工一次派出两张单，第二张写“校验第 1 张单产出的清单”，
 * 结果两单都成了根，并行跑起来。原因有两层：
 *   1. 树字段是整条消息共用的，`acts.length > 1` 时一律丢弃 → 写了 `PARENT` 也不生效；
 *   2. 即便不丢弃，两张单的编号在建单前均不存在，`PARENT: #01` 无法指向“同批第一张单”。
 *
 * 这里断言的是“按动作归属”与“`@N` 的解析结果”，不测试 loop 的消费循环：
 * loop 里那段用同一对函数（`dispatchOfSeq` + `checkTreeEdge`），单独跑循环要拉起
 * 整个监工，代价远大于收益。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseReply, treeDirectiveFields } = require("../dist/supervisor/channel/parseReply");
const {
  appendSupervisorDirective,
  markSupervisorDirective,
} = require("../dist/supervisor/channel/direct");
const { dispatchOfSeq, isSeqRef } = require("../dist/supervisor/loop/seqRef");
const { composeDispatch, commitDispatch } = require("../dist/core/dispatch/newDispatch");
const { readDispatches } = require("../dist/core/record/supervisor");
const { groupIndexOf } = require("../dist/core/record/groups");
const { isReady, pendingOf } = require("../dist/core/dispatch/deps");

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-seqref-"));
  fs.mkdirSync(path.join(root, ".capitalist", "inbox"), { recursive: true });
  fs.mkdirSync(path.join(root, ".capitalist", "ledger"), { recursive: true });
  return root;
}

function dropRoot(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* 删除 shim 可能拦下清理 */
  }
}

test("多动作消息：树字段挂到各自的 DO，不互相串", () => {
  const p = parseReply(
    [
      "DO: dispatch [盘点] 逐文件盘点中文文案，输出问题清单",
      "DO: dispatch [校验] 校验第 1 单的清单，判断每条改法是否得当",
      "PARENT: @1",
      "PARENT_REASON: 校验对象是第 1 单的产出，它没出来就无从校验",
    ].join("\n"),
  );
  assert.strictEqual(p.acts.length, 2);
  assert.strictEqual(p.acts[0].parent, undefined, "第一单不该有父节点");
  assert.strictEqual(p.acts[1].parent, "@1");
  assert.strictEqual(p.acts[1].parentReason, "校验对象是第 1 单的产出，它没出来就无从校验");
  /* 多动作时不返回顶层：给一份不分归属的值会让人误以为整条消息共用同一棵树边。 */
  assert.strictEqual(p.parent, undefined);
});

test("树字段归属于它前面的那个 DO", () => {
  const p = parseReply(
    ["DO: dispatch [a] 甲", "PARENT: #03", "PARENT_REASON: 等 #03", "DO: dispatch [b] 乙"].join("\n"),
  );
  assert.strictEqual(p.acts[0].parent, "#03", "写在第一个 DO 之后即属于第一单");
  assert.strictEqual(p.acts[1].parent, undefined, "第二单不该继承上一单的父节点");
});

test("单动作消息：顶层仍返回树字段（兼容既有调用点）", () => {
  const p = parseReply(
    ["DO: dispatch [ui] 重做顶栏", "PARENT: #03", "PARENT_REASON: 按 #03 的栅格排版"].join("\n"),
  );
  assert.strictEqual(p.acts.length, 1);
  assert.strictEqual(p.parent, "#03");
  assert.strictEqual(p.acts[0].parent, "#03");
  const fields = treeDirectiveFields(p.acts[0]);
  assert.strictEqual(fields.parent, "#03");
  assert.strictEqual(fields.parent_reason, "按 #03 的栅格排版");
});

test("首个 DO 之前写的树字段归入第一单", () => {
  const p = parseReply(["PARENT: #07", "PARENT_REASON: 等 #07", "DO: dispatch [x] 做事"].join("\n"));
  assert.strictEqual(p.acts[0].parent, "#07");
});

test("三个 DO 各自带组与父：互不覆盖", () => {
  const p = parseReply(
    [
      "DO: dispatch [fe] 重做页面",
      "GROUP: new 前后端并行改造",
      "DO: dispatch [be] 重做接口",
      "GROUP: #G1",
      "DO: dispatch [api] 联调",
      "PARENT: @1",
      "PARENT_REASON: 等页面落地",
    ].join("\n"),
  );
  assert.strictEqual(p.acts.length, 3);
  assert.strictEqual(p.acts[0].group, "new 前后端并行改造");
  assert.strictEqual(p.acts[1].group, "#G1");
  assert.strictEqual(p.acts[2].group, undefined, "第三单没写 GROUP，不该继承");
  assert.strictEqual(p.acts[2].parent, "@1");
});

test("isSeqRef：只认 @数字", () => {
  assert.strictEqual(isSeqRef("@1"), true);
  assert.strictEqual(isSeqRef("@12"), true);
  assert.strictEqual(isSeqRef(" @3 "), true);
  assert.strictEqual(isSeqRef("@"), false);
  assert.strictEqual(isSeqRef("@a"), false);
  assert.strictEqual(isSeqRef("#01"), false);
});

test("dispatchOfSeq：取同一条消息第 N 个派单建出的单", () => {
  const root = makeRoot();
  try {
    commitDispatch(
      root,
      composeDispatch({ id: "1-1", stage: "S0", title: "盘点", action: "做 盘点", status: "open", source: "adhoc", attempt: 1 }),
    );
    const first = appendSupervisorDirective(root, {
      action: "dispatch",
      arg: "[盘点] 逐文件盘点",
      confirm: true,
      msg_id: "M1",
      via: "capitalist",
    });
    assert.strictEqual(first.ok, true, first.error);
    markSupervisorDirective(root, first.rec.id, {
      ok: true,
      reason: "",
      detail: "已建单",
      dispatch: "1-1",
    });

    const second = appendSupervisorDirective(root, {
      action: "dispatch",
      arg: "[校验] 校验第 1 单",
      confirm: true,
      msg_id: "M1",
      parent: "@1",
      parent_reason: "校验对象是第 1 单的产出",
      via: "capitalist",
    });
    assert.strictEqual(second.ok, true, second.error);

    const hit = dispatchOfSeq(root, "M1", 1);
    assert.ok(hit, "第一条已建单，@1 应能找到");
    assert.strictEqual(String(hit.id), "1-1");

    /* 第二条自己还没建成：查 @2 必须返回 undefined，由调用方拒绝而不是退成根节点。 */
    assert.strictEqual(dispatchOfSeq(root, "M1", 2), undefined);
    assert.strictEqual(dispatchOfSeq(root, "M1", 3), undefined);
    assert.strictEqual(dispatchOfSeq(root, "别的消息", 1), undefined);
  } finally {
    dropRoot(root);
  }
});

test("dispatchOfSeq 只数 dispatch：中间的 ask 不占序号", () => {
  const root = makeRoot();
  try {
    commitDispatch(
      root,
      composeDispatch({ id: "1-1", stage: "S0", title: "甲", action: "做 甲", status: "open", source: "adhoc", attempt: 1 }),
    );
    const ask = appendSupervisorDirective(root, {
      action: "ask",
      arg: "问一句",
      confirm: true,
      msg_id: "M2",
      via: "capitalist",
    });
    assert.strictEqual(ask.ok, true, ask.error);
    const disp = appendSupervisorDirective(root, {
      action: "dispatch",
      arg: "做甲",
      confirm: true,
      msg_id: "M2",
      via: "capitalist",
    });
    assert.strictEqual(disp.ok, true, disp.error);
    markSupervisorDirective(root, disp.rec.id, { ok: true, reason: "", detail: "", dispatch: "1-1" });

    assert.strictEqual(String(dispatchOfSeq(root, "M2", 1).id), "1-1", "第 1 个 dispatch 是 1-1，不是 ask");
  } finally {
    dropRoot(root);
  }
});

test("串起来：第 2 单挂到第 1 单之前不可跑，第 1 单完成后放行", () => {
  const root = makeRoot();
  try {
    /* 模拟 loop 的消费结果：第 1 条建出 1-1 并写回 result。 */
    commitDispatch(
      root,
      composeDispatch({
        id: "1-1",
        stage: "S0",
        title: "盘点",
        action: "做 盘点",
        status: "open",
        source: "adhoc",
        attempt: 1,
      }),
    );
    const first = appendSupervisorDirective(root, {
      action: "dispatch",
      arg: "盘点",
      confirm: true,
      msg_id: "M3",
      via: "capitalist",
    });
    markSupervisorDirective(root, first.rec.id, { ok: true, reason: "", detail: "", dispatch: "1-1" });

    /* 第 2 条带 `PARENT: @1`，loop 会把它解析成 1-1 再建单。这里按同样结果建单。 */
    const parent = dispatchOfSeq(root, "M3", 1);
    assert.ok(parent);
    commitDispatch(
      root,
      composeDispatch({
        id: "2-1",
        stage: "S0",
        title: "校验",
        action: "做 校验",
        status: "open",
        source: "adhoc",
        attempt: 1,
        parent: String(parent.id),
        parentReason: "校验对象是第 1 单的产出",
      }),
    );

    let rows = readDispatches(root);
    let idx = groupIndexOf(rows, []);
    const second = rows.find((d) => d.id === "2-1");
    assert.deepStrictEqual(pendingOf(second, rows, idx), ["1-1"], "第 2 单要等第 1 单");
    assert.strictEqual(isReady(second, rows, idx), false);

    /* 第 1 单完成 → 第 2 单可跑。 */
    const { claimDispatch, finishDispatch } = require("../dist/core/record/supervisor");
    claimDispatch(root, "1-1", "W1");
    finishDispatch(root, "1-1", "done");
    rows = readDispatches(root);
    idx = groupIndexOf(rows, []);
    assert.strictEqual(isReady(rows.find((d) => d.id === "2-1"), rows, idx), true);
  } finally {
    dropRoot(root);
  }
});
