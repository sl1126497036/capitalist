/**
 * 场景实测：把一段 LLM 风格的派单回复跑完整条链路。
 *
 * 链路是"解析 -> 建单 -> 树结构 -> 放行判定"四段，任何一段口径不一致，最终表现都是
 * 下游提前启动或永远不动，而这两件事都不会抛错。所以这里不测单个函数，而是喂文本、
 * 断言树和队列。
 *
 * 覆盖三个场景：
 *   1. 前后端并行 + 组 + 联调 + 测试（用户描述的场景一）；
 *   2. 断链：组里一份失败且不再重试，下游不启动；
 *   3. 两条时间线各自推进，互不等待（用户描述的场景二的核心性质）。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseReply } = require("../dist/supervisor/channel/parseReply");
const { composeDispatch, commitDispatch } = require("../dist/core/dispatch/newDispatch");
const { finishDispatch, readDispatches } = require("../dist/core/record/supervisor");
const { issueGroupNo, readGroups, groupIndexOf } = require("../dist/core/record/groups");
const { joinGroup } = require("../dist/core/dispatch/groupOps");
const { isReady, pendingOf } = require("../dist/core/dispatch/deps");
const { groupStatusOf, groupSettled } = require("../dist/core/dispatch/groupGraph");
const { buildForestView } = require("../dist/supervisor/view/forestView");

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-scene-"));
  fs.mkdirSync(path.join(root, ".capitalist", "inbox"), { recursive: true });
  return root;
}
function dropRoot(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* 删除 shim 可能拦下清理，残留不影响结论 */
  }
}

/** 建一张单。`extra` 用来写 parent / group / status。 */
function make(root, id, title, extra = {}) {
  const d = composeDispatch({
    id,
    stage: "S0",
    title,
    action: `做 ${title}`,
    status: extra.status ?? "open",
    source: "adhoc",
    attempt: 1,
    ...(extra.parent ? { parent: extra.parent, parentReason: extra.reason ?? "测试用树边" } : {}),
    ...(extra.group ? { group: extra.group } : {}),
  });
  commitDispatch(root, d);
  return d;
}

/** 把一个引用换成台账 id，模拟 loop 里 resolveDispatchRef 的结果（去 `#`、去前导零）。 */
const toId = (ref) => {
  const bare = String(ref).replace(/^#/, "");
  const m = /^(\d+)$/.exec(bare);
  return m ? `${Number(m[1])}-1` : bare;
};

// ---------------------------------------------------------------- 解析

test("GROUP 行：三种写法都解析成原话，交给建单侧解释", () => {
  const a = parseReply(["DO: dispatch [fe] 重做页面", "GROUP: new 前后端并行改造"].join("\n"));
  assert.strictEqual(a.group, "new 前后端并行改造");

  const b = parseReply(["DO: dispatch [be] 重做接口", "GROUP: #G1"].join("\n"));
  assert.strictEqual(b.group, "#G1");

  const c = parseReply(["DO: dispatch [x] 补一个空态", "GROUP: none"].join("\n"));
  assert.strictEqual(c.group, undefined, "none 等价于未写");

  const d = parseReply(["DO: dispatch [x] 补一个空态"].join("\n"));
  assert.strictEqual(d.group, undefined);
});

test("GROUP 行：多动作消息里不生效，避免把组挂到错误的单上", () => {
  const r = parseReply(
    ["DO: dispatch [fe] 重做页面", "DO: dispatch [be] 重做接口", "GROUP: new 前后端并行"].join("\n"),
  );
  assert.strictEqual(r.group, undefined);
});

test("GROUP 行：不进正文，用户看到的回复是干净的", () => {
  const r = parseReply(
    ["按新原型重做。", "DO: dispatch [fe] 重做页面", "GROUP: #G1", "PARENT: #03", "PARENT_REASON: 原型定了"].join("\n"),
  );
  assert.strictEqual(r.reply, "按新原型重做。");
});

// ---------------------------------------------------------------- 场景一

test("场景一：前后端并行成组，联调挂在组上，测试挂在联调上", () => {
  const root = makeRoot();
  try {
    /* #03 是原型定稿，前后端的共同上游。 */
    make(root, "3-1", "原型定稿", { status: "done" });

    /* 第一条 LLM 回复：前端，建组。 */
    const r1 = parseReply(
      ["DO: dispatch [fe] 按新原型重做页面", "GROUP: new 前后端并行改造", "PARENT: #03", "PARENT_REASON: 原型在 #03 定稿"].join("\n"),
    );
    const created = issueGroupNo(root, { title: "前后端并行改造", created_by: "llm" });
    assert.strictEqual(created.ok, true);
    const gid = created.group.id;
    make(root, "4-1", "重做页面", { group: gid, parent: "3-1", reason: "原型在 #03 定稿" });

    /* 第二条：后端，加入同一组。 */
    const joined = joinGroup(root, "#G1", { parentId: toId("#03"), rows: readDispatches(root) });
    assert.strictEqual(joined.ok, true, joined.error);
    assert.strictEqual(joined.id, gid, "#G1 必须解析到同一个组");
    make(root, "5-1", "重做接口", { group: joined.id, parent: "3-1", reason: "与页面同源" });

    /* 第三条：联调挂在组上。 */
    make(root, "6-1", "前后端联调", { parent: gid, reason: "页面与接口都落地后才能对字段" });
    /* 第四条：测试挂在联调上。 */
    make(root, "7-1", "端到端测试", { parent: "6-1", reason: "联调通过后才能测" });

    const rows = readDispatches(root);
    const groups = readGroups(root);
    const idx = groupIndexOf(rows, groups);

    assert.deepStrictEqual(idx.members.get(gid), ["4-1", "5-1"], "组成员是前后端两张单");
    assert.deepStrictEqual(idx.dangling, [], "没有指向不存在组的成员");

    /* 组未完成时，联调不可跑；测试隔着联调，也不可跑。 */
    assert.strictEqual(isReady(rows.find((d) => d.id === "6-1"), rows, idx), false);
    assert.deepStrictEqual(pendingOf(rows.find((d) => d.id === "6-1"), rows, idx), [gid]);
    assert.strictEqual(isReady(rows.find((d) => d.id === "7-1"), rows, idx), false);

    /* 组的两名成员本身可跑（父 #03 已完成）。 */
    assert.strictEqual(isReady(rows.find((d) => d.id === "4-1"), rows, idx), true);

    /* 树结构：一个组节点，其子节点是两名成员与联调。 */
    const view = buildForestView(root);
    const all = view.trees.flatMap((t) => t.nodes);
    const gnode = all.find((n) => n.kind === "group");
    assert.ok(gnode, "树上必须有组节点");
    assert.strictEqual(gnode.id, gid);
    assert.strictEqual(gnode.groupTotal, 2);
    assert.strictEqual(gnode.groupDone, 0);
    const kids = all.filter((n) => n.parent === gid).map((n) => n.id);
    assert.deepStrictEqual(kids.sort(), ["4-1", "5-1", "6-1"].sort(), "组成员与挂组的下游都在组下");

    /*
     * 前端按 `edge` 分段渲染：成员内嵌进组卡片，下游排在组卡片下方。
     * 两者混成同一层会让下游看起来是又一个成员，故契约固定在此。
     */
    const edgeOfKid = new Map(all.filter((n) => n.parent === gid).map((n) => [n.id, n.edge]));
    assert.strictEqual(edgeOfKid.get("4-1"), "member", "组成员标 member");
    assert.strictEqual(edgeOfKid.get("6-1"), "after", "挂组下游标 after");
    assert.strictEqual(gnode.childCount, 1, "组的子单数只计挂组下游，成员由组内完成数表达");

    /* 成员不再同时挂在组的上游：3-1 的子节点只有组。 */
    const kidsOfParent = all.filter((n) => n.parent === "3-1").map((n) => n.id);
    assert.deepStrictEqual(kidsOfParent, [gid], "成员已从原父节点摘到组下");

    /* 组节点不计入节点总数：5 张单（原型 + 前端 + 后端 + 联调 + 测试）就是 5，不是 6。 */
    assert.strictEqual(view.totals.total, 5);
  } finally {
    dropRoot(root);
  }
});

test("场景一续：组内全部完成才放行联调；少一份不放行", () => {
  const root = makeRoot();
  try {
    make(root, "3-1", "原型定稿", { status: "done" });
    const g = issueGroupNo(root, { title: "前后端并行改造", created_by: "llm" });
    make(root, "4-1", "重做页面", { group: g.group.id });
    make(root, "5-1", "重做接口", { group: g.group.id });
    make(root, "6-1", "前后端联调", { parent: g.group.id, reason: "两边都落地" });

    finishDispatch(root, "4-1", "done");
    let rows = readDispatches(root);
    let idx = groupIndexOf(rows, readGroups(root));
    assert.strictEqual(isReady(rows.find((d) => d.id === "6-1"), rows, idx), false, "只完成一份不能放行");

    finishDispatch(root, "5-1", "done");
    rows = readDispatches(root);
    idx = groupIndexOf(rows, readGroups(root));
    assert.strictEqual(isReady(rows.find((d) => d.id === "6-1"), rows, idx), true, "两份都完成才放行");
    assert.deepStrictEqual(groupSettled(g.group.id, rows, idx), { settled: true, pending: [], failed: [] });
  } finally {
    dropRoot(root);
  }
});

// ---------------------------------------------------------------- 断链

test("场景一断链：后端失败且不再重试，组断链、下游不启动", () => {
  const root = makeRoot();
  try {
    const g = issueGroupNo(root, { title: "前后端并行改造", created_by: "llm" });
    make(root, "4-1", "重做页面", { group: g.group.id });
    make(root, "5-1", "重做接口", { group: g.group.id });
    make(root, "6-1", "前后端联调", { parent: g.group.id, reason: "两边都落地" });

    finishDispatch(root, "4-1", "done");
    finishDispatch(root, "5-1", "failed", "接口改不动：原型字段缺失");
    /* 判定不再重试。 */
    const rows0 = readDispatches(root);
    const { writeJsonl } = require("../dist/core/record/json");
    const { dispatchPath } = require("../dist/core/record/supervisor");
    writeJsonl(
      dispatchPath(root),
      rows0.map((d) => (d.id === "5-1" ? { ...d, retry_verdict: "give_up" } : d)),
    );

    const rows = readDispatches(root);
    const idx = groupIndexOf(rows, readGroups(root));
    const st = groupStatusOf(g.group.id, rows, idx);
    assert.strictEqual(st.state, "blocked");
    assert.strictEqual(st.brokenAt, "5-1", "断链位置应指向失败成员");
    assert.strictEqual(isReady(rows.find((d) => d.id === "6-1"), rows, idx), false, "下游不得启动");

    /* 树上：组节点失败，联调被标为断链。 */
    const view = buildForestView(root);
    const all = view.trees.flatMap((t) => t.nodes);
    const gnode = all.find((n) => n.kind === "group");
    assert.strictEqual(gnode.state, "failed");
    assert.strictEqual(gnode.groupBroken, "5-1");
    const api = all.find((n) => n.id === "6-1");
    assert.strictEqual(api.blocked, true);
    assert.strictEqual(api.blockedBy, g.group.id, "断链经组传下去，断在组节点");
  } finally {
    dropRoot(root);
  }
});

test("断链恢复：失败成员重派成功，下游解锁", () => {
  const root = makeRoot();
  try {
    const g = issueGroupNo(root, { title: "前后端并行改造", created_by: "llm" });
    make(root, "4-1", "重做页面", { group: g.group.id });
    make(root, "5-1", "重做接口", { group: g.group.id });
    make(root, "6-1", "前后端联调", { parent: g.group.id, reason: "两边都落地" });
    finishDispatch(root, "4-1", "done");
    finishDispatch(root, "5-1", "failed");
    /* 可重试的失败：组处于等待，不算断链，下游仍等。 */
    let rows = readDispatches(root);
    let idx = groupIndexOf(rows, readGroups(root));
    assert.strictEqual(groupStatusOf(g.group.id, rows, idx).state, "waiting");
    assert.strictEqual(isReady(rows.find((d) => d.id === "6-1"), rows, idx), false);

    /* 重派成功（同一件事的新一张单，lineage 相同）。 */
    const retry = composeDispatch({
      id: "5-2",
      stage: "S0",
      title: "重做接口",
      action: "做 重做接口",
      source: "requeue",
      attempt: 2,
      group: g.group.id,
      inherit: { from: readDispatches(root).find((d) => d.id === "5-1") },
    });
    commitDispatch(root, retry);
    finishDispatch(root, "5-2", "done");

    rows = readDispatches(root);
    idx = groupIndexOf(rows, readGroups(root));
    assert.strictEqual(isReady(rows.find((d) => d.id === "6-1"), rows, idx), true, "重派成功后解锁");
  } finally {
    dropRoot(root);
  }
});

// ---------------------------------------------------------------- 场景二

test("场景二：两条时间线各自推进，互不等待", () => {
  const root = makeRoot();
  try {
    /* 共享设定组：故事框架 + 人物关系，两条线都要它。 */
    const setup = issueGroupNo(root, { title: "共享设定", created_by: "llm" });
    make(root, "1-1", "故事框架", { group: setup.group.id });
    make(root, "2-1", "人物关系", { group: setup.group.id });

    /* 每条时间线自己一组，各自挂在设定组上。 */
    const lineA = issueGroupNo(root, { title: "百年前时间线", created_by: "llm" });
    const lineB = issueGroupNo(root, { title: "当下时间线", created_by: "llm" });
    make(root, "3-1", "百年前 第1集", { group: lineA.group.id, parent: setup.group.id, reason: "先有设定" });
    make(root, "4-1", "当下 第1集", { group: lineB.group.id, parent: setup.group.id, reason: "先有设定" });
    make(root, "3-2", "百年前 第2集", { parent: "3-1", reason: "第1集写完才写第2集" });
    make(root, "4-2", "当下 第2集", { parent: "4-1", reason: "第1集写完才写第2集" });

    let rows = readDispatches(root);
    let idx = groupIndexOf(rows, readGroups(root));
    /* 设定没写完，两条线都不可跑。 */
    assert.strictEqual(isReady(rows.find((d) => d.id === "3-1"), rows, idx), false);
    assert.strictEqual(isReady(rows.find((d) => d.id === "4-1"), rows, idx), false);

    finishDispatch(root, "1-1", "done");
    finishDispatch(root, "2-1", "done");
    rows = readDispatches(root);
    idx = groupIndexOf(rows, readGroups(root));
    assert.strictEqual(isReady(rows.find((d) => d.id === "3-1"), rows, idx), true);
    assert.strictEqual(isReady(rows.find((d) => d.id === "4-1"), rows, idx), true);

    /*
     * 关键性质：百年前那条线先推进到第 2 集，不会因为当下那条线没动而被拖住。
     */
    finishDispatch(root, "3-1", "done");
    rows = readDispatches(root);
    idx = groupIndexOf(rows, readGroups(root));
    assert.strictEqual(isReady(rows.find((d) => d.id === "3-2"), rows, idx), true, "A 线不等 B 线");
    assert.strictEqual(isReady(rows.find((d) => d.id === "4-2"), rows, idx), false, "B 线第2集仍等自己第1集");
  } finally {
    dropRoot(root);
  }
});

// ---------------------------------------------------------------- 补充场景

test("组解散：挂在组上的下游按已收尾放行", () => {
  const root = makeRoot();
  try {
    const g = issueGroupNo(root, { title: "并行改造", created_by: "llm" });
    make(root, "1-1", "前端", { group: g.group.id });
    make(root, "1-2", "后端", { group: g.group.id });
    make(root, "2-1", "联调", { parent: g.group.id, reason: "两边都落地" });
    const { closeGroup } = require("../dist/core/dispatch/treeOps");
    const r = closeGroup(root, g.group.id, "改方案，不再等这两份");
    assert.strictEqual(r.ok, true);

    const rows = readDispatches(root);
    const idx = groupIndexOf(rows, readGroups(root));
    assert.strictEqual(isReady(rows.find((d) => d.id === "2-1"), rows, idx), true, "解散后不再等");
    assert.deepStrictEqual(groupSettled(g.group.id, rows, idx), { settled: true, pending: [], failed: [] });
  } finally {
    dropRoot(root);
  }
});

test("成员人工结束（closed）：不阻塞放行，也不计为完成", () => {
  const root = makeRoot();
  try {
    const g = issueGroupNo(root, { title: "并行改造", created_by: "llm" });
    make(root, "1-1", "前端", { group: g.group.id });
    make(root, "1-2", "后端", { group: g.group.id });
    make(root, "2-1", "联调", { parent: g.group.id, reason: "两边都落地" });
    finishDispatch(root, "1-1", "done");
    /* 人工结束后端：这一份不再产出，不该让下游永久等待。 */
    finishDispatch(root, "1-2", "failed");
    const { writeJsonl } = require("../dist/core/record/json");
    const { dispatchPath } = require("../dist/core/record/supervisor");
    writeJsonl(
      dispatchPath(root),
      readDispatches(root).map((d) => (d.id === "1-2" ? { ...d, status: "closed", closed_by: "user" } : d)),
    );

    const rows = readDispatches(root);
    const idx = groupIndexOf(rows, readGroups(root));
    const st = groupStatusOf(g.group.id, rows, idx);
    assert.strictEqual(st.failed.length, 0, "人工结束不算断链");
    assert.strictEqual(st.done, 1, "人工结束不计入完成数");
    assert.strictEqual(isReady(rows.find((d) => d.id === "2-1"), rows, idx), true);
  } finally {
    dropRoot(root);
  }
});

test("AFTER 引用组：与 PARENT 同一判定，多前置仍按整组算", () => {
  const root = makeRoot();
  try {
    make(root, "9-1", "另一个前置", { status: "done" });
    const g = issueGroupNo(root, { title: "并行改造", created_by: "llm" });
    make(root, "1-1", "前端", { group: g.group.id });
    make(root, "1-2", "后端", { group: g.group.id });
    const api = composeDispatch({
      id: "3-1",
      stage: "S0",
      title: "联调",
      action: "做 联调",
      source: "adhoc",
      attempt: 1,
      after: ["9-1", g.group.id],
    });
    commitDispatch(root, api);

    let rows = readDispatches(root);
    let idx = groupIndexOf(rows, readGroups(root));
    assert.deepStrictEqual(pendingOf(rows.find((d) => d.id === "3-1"), rows, idx), [g.group.id]);

    finishDispatch(root, "1-1", "done");
    finishDispatch(root, "1-2", "done");
    rows = readDispatches(root);
    idx = groupIndexOf(rows, readGroups(root));
    assert.strictEqual(isReady(rows.find((d) => d.id === "3-1"), rows, idx), true);
  } finally {
    dropRoot(root);
  }
});

test("组为根：独立成树，与另一棵树互不影响", () => {
  const root = makeRoot();
  try {
    const g = issueGroupNo(root, { title: "根组", created_by: "llm" });
    make(root, "1-1", "甲", { group: g.group.id });
    make(root, "1-2", "乙", { group: g.group.id });
    make(root, "2-1", "另一棵树的根");

    const view = buildForestView(root);
    assert.strictEqual(view.trees.length, 2, "组一棵树、另一单一棵树");
    const gtree = view.trees.find((t) => t.nodes.some((n) => n.kind === "group"));
    assert.ok(gtree);
    assert.strictEqual(gtree.rootId, g.group.id, "组是树根");
    assert.strictEqual(gtree.nodes.length, 3, "组 + 两名成员");

    /* 两棵树互不影响：另一棵树在跑，不改变组的放行。 */
    finishDispatch(root, "2-1", "done");
    const rows = readDispatches(root);
    const idx = groupIndexOf(rows, readGroups(root));
    assert.strictEqual(isReady(rows.find((d) => d.id === "1-1"), rows, idx), true);
    assert.strictEqual(groupStatusOf(g.group.id, rows, idx).done, 0);
  } finally {
    dropRoot(root);
  }
});

test("LLM 混写组号：GROUP: #G01 / G01 / g1 落在同一个组", () => {
  const root = makeRoot();
  try {
    const g = issueGroupNo(root, { title: "并行改造", created_by: "llm" });
    /* 三条消息分别照抄显示形态、去 # 形态、小写形态。 */
    for (const [i, ref] of ["#G01", "G01", "g1"].entries()) {
      const joined = joinGroup(root, ref, { parentId: "", rows: readDispatches(root) });
      assert.strictEqual(joined.ok, true, `${ref}: ${joined.error}`);
      assert.strictEqual(joined.id, g.group.id, `${ref} 必须落在 G1`);
      make(root, `1-${i + 1}`, `成员${i + 1}`, { group: joined.id });
    }
    const idx = groupIndexOf(readDispatches(root), readGroups(root));
    assert.deepStrictEqual(idx.members.get(g.group.id), ["1-1", "1-2", "1-3"]);
    assert.deepStrictEqual(idx.dangling, []);
  } finally {
    dropRoot(root);
  }
});
