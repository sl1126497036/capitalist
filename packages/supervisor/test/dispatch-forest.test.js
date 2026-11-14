
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const capitalist = require("../dist/core/record/supervisor");
const { writeJsonl } = require("../dist/core/record/json");
const { loadState } = require("../dist/core/record/state");
const { createTaskRoot } = require("../dist/core/contract/init");
const loop = require("../dist/supervisor/loop");
const { appendSupervisorDirective, listSupervisorDirectives } = require("../dist/supervisor/channel/direct");
const { parseReply } = require("../dist/supervisor/channel/llm");
const { assignThreadNos } = require("../dist/supervisor/usage/threadNo");

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-forest-"));
  createTaskRoot({ target: "派单多节点结构", contractSpec: "minimal", root: base });
  return base;
}

function put(root, id, extra = {}) {
  capitalist.appendDispatch(root, {
    id,
    at: new Date().toISOString(),
    stage: "S0",
    shard: id,
    action: `做 ${id}`,
    status: "open",
    lineage: id,
    ...extra,
  });
  return capitalist.readDispatches(root).find((x) => x.id === id);
}

/** 直接改台账行（模拟收尸判死、手改结构等外部事实，不改行序）。 */
function patch(root, id, fields) {
  const rows = capitalist.readDispatches(root).map((x) => (x.id === id ? { ...x, ...fields } : x));
  writeJsonl(capitalist.dispatchPath(root), rows);
}

/**
 * 重启后的队列：与 fillSlots 同一条判定（open + 依赖满足），按 compareQueueOrder 排。
 * “重启”= 所有排序输入只从台账文件来，进程内存里什么都不留。
 */
function queueAfterRestart(root) {
  const rows = capitalist.readDispatches(root);
  return rows
    .map((d, i) => ({ d, i }))
    .filter((x) => x.d.status === "open" && capitalist.dependenciesSettled(x.d, rows))
    .sort((a, b) => capitalist.compareQueueOrder(a.d, b.d, a.i, b.i))
    .map((x) => x.d.id);
}


test("多节点并行：没有父节点的单各自成树，互不影响", () => {
  const root = sandbox();
  put(root, "T1");
  put(root, "T1a", { parent: "T1", parent_reason: "要 T1 的产物" });
  put(root, "T2");
  put(root, "T2a", { parent: "T2", parent_reason: "要 T2 的产物" });

  const f = capitalist.dispatchForest(capitalist.readDispatches(root));
  assert.deepStrictEqual(f.roots, ["T1", "T2"], "两棵树，各自一个根");
  assert.deepStrictEqual(f.children.T1, ["T1a"]);
  assert.deepStrictEqual(f.children.T2, ["T2a"]);
  assert.strictEqual(f.depth.T1a, 1);
  assert.deepStrictEqual(f.cycles, []);
  assert.deepStrictEqual(f.orphans, []);

  assert.deepStrictEqual(queueAfterRestart(root), ["T1", "T2"], "两棵树的第一层同拍就绪");
  capitalist.finishDispatch(root, "T1", "done", "完成");
  assert.deepStrictEqual(queueAfterRestart(root), ["T1a", "T2"], "T1 完成后它这棵往下走，另一棵不受影响");
});

test("兄弟节点：同挂一个父节点的两张单在父节点完成后一起就绪", () => {
  const root = sandbox();
  put(root, "A");
  put(root, "B", { parent: "A", parent_reason: "要 A 的接口" });
  put(root, "C", { parent: "A", parent_reason: "要 A 的接口" });

  const f = capitalist.dispatchForest(capitalist.readDispatches(root));
  assert.deepStrictEqual(f.children.A, ["B", "C"], "同父即兄弟");

  assert.deepStrictEqual(queueAfterRestart(root), ["A"], "父节点没完成，兄弟都不启动");
  capitalist.finishDispatch(root, "A", "done", "完成");
  assert.deepStrictEqual(queueAfterRestart(root), ["B", "C"], "父完成后兄弟同拍进入队列");
  assert.deepStrictEqual(queueAfterRestart(root), ["B", "C"], "重启后仍是同一组兄弟");
});

test("三层链：A -> B -> C 逐层推进，中间层没完成前最底层不出现", () => {
  const root = sandbox();
  put(root, "A");
  put(root, "B", { parent: "A", parent_reason: "B 要 A 的产物" });
  put(root, "C", { parent: "B", parent_reason: "C 要 B 的产物" });

  assert.deepStrictEqual(queueAfterRestart(root), ["A"]);
  capitalist.finishDispatch(root, "A", "done", "完成");
  assert.deepStrictEqual(queueAfterRestart(root), ["B"]);
  capitalist.finishDispatch(root, "B", "done", "完成");
  assert.deepStrictEqual(queueAfterRestart(root), ["C"]);
});


test("成环：两条互指的树边不会让判定卡死，环上的单都不启动且被识别出来", () => {
  const root = sandbox();
  put(root, "A", { parent: "B", parent_reason: "手改出来的环" });
  put(root, "B", { parent: "A", parent_reason: "手改出来的环" });

  const rows = capitalist.readDispatches(root);
  assert.strictEqual(capitalist.dependenciesSettled(rows[0], rows), false, "A 等 B，不启动");
  assert.strictEqual(capitalist.dependenciesSettled(rows[1], rows), false, "B 等 A，不启动");
  assert.deepStrictEqual(queueAfterRestart(root), [], "环上的单一张都不进队列");

  const f = capitalist.dispatchForest(rows);
  assert.strictEqual(f.cycles.length, 1, "成环被识别出来");
  assert.deepStrictEqual([...f.cycles[0]].sort(), ["A", "B"]);
  assert.strictEqual(f.roots.length, 0, "环上的节点不是任何一棵树的根");
});

test("成环校验：父节点的上溯链已经成环时，新挂上去的单被拒", () => {
  const root = sandbox();
  put(root, "A", { parent: "B", parent_reason: "手改出来的环" });
  put(root, "B", { parent: "A", parent_reason: "手改出来的环" });
  const rows = capitalist.readDispatches(root);
  const chk = capitalist.checkTreeEdge(rows, "A", "要环上的产物");
  assert.strictEqual(chk.ok, false);
  assert.strictEqual(chk.code, "cycle");
  assert.ok(chk.reason.includes("成环"), chk.reason);
});

test("自指树边被拒：父节点不能是本单自己", () => {
  const rows = capitalist.readDispatches(sandbox());
  const chk = capitalist.checkTreeEdge(rows, "D-self", "理由", "D-self");
  assert.strictEqual(chk.ok, false);
  assert.strictEqual(chk.code, "self_parent");
});

test("孤儿父节点：父记录不在台账里时放行，并在森林视图里列出来（不静默等死）", () => {
  const root = sandbox();
  put(root, "A", { parent: "D-gone", parent_reason: "父记录被清理掉了" });
  put(root, "B");
  const rows = capitalist.readDispatches(root);
  assert.strictEqual(capitalist.dependenciesSettled(rows[0], rows), true, "等一个不存在的编号没有意义，放行");
  const f = capitalist.dispatchForest(rows);
  assert.deepStrictEqual(f.orphans, ["A"], "孤儿被列出来，不静默");
  assert.deepStrictEqual(queueAfterRestart(root), ["A", "B"]);
});


async function dispatchViaDirective(root, extra) {
  const w = appendSupervisorDirective(root, { action: "dispatch", arg: "[t] 新活", ...extra });
  assert.ok(w.ok, `指令应入列：${w.error || ""}`);
  const res = await loop.__testing.applySupervisorDirectives({
    root,
    contract: {},
    state: loadState(root),
    wopts: {},
    concurrency: null,
    out: () => {},
  });
  assert.ok(res);
  return listSupervisorDirectives(root).find((x) => x.arg.includes("新活"));
}

test("建单：PARENT 编号翻译成台账 id，parent_reason 一起落盘", async () => {
  const root = sandbox();
  const a = put(root, "A");
  assignThreadNos(root, [`S0/x${String(a.lineage ?? a.id).slice(-6).toLowerCase()}`]);

  const rec = await dispatchViaDirective(root, { parent: "#1", parent_reason: "要 A 定稿的接口" });
  assert.strictEqual(rec.result.ok, true, rec.result.reason);
  const created = capitalist.readDispatches(root).find((x) => x.source === "adhoc" && String(x.action).includes("新活"));
  assert.ok(created, "新单已建");
  assert.strictEqual(created.parent, a.id, "编号已翻译成台账 id");
  assert.strictEqual(created.parent_reason, "要 A 定稿的接口");
});

test("建单：父节点不存在被拒，原因写明 PARENT，不静默变成无依赖", async () => {
  const root = sandbox();
  const rec = await dispatchViaDirective(root, { parent: "D-nope", parent_reason: "随便挂" });
  assert.strictEqual(rec.result.ok, false, "执行被拒");
  assert.ok(String(rec.result.reason).includes("PARENT"), rec.result.reason);
  assert.ok(
    !capitalist.readDispatches(root).some((x) => String(x.action).includes("新活")),
    "被拒的单不进台账",
  );
});

test("建单：父节点已 closed 被拒——父节点不会再有产出，挂上去等于永久等待", async () => {
  const root = sandbox();
  put(root, "A", { status: "closed", done_at: new Date().toISOString() });
  const rec = await dispatchViaDirective(root, { parent: "A", parent_reason: "要 A 的产物" });
  assert.strictEqual(rec.result.ok, false);
  assert.ok(String(rec.result.reason).includes("closed"), rec.result.reason);
  assert.ok(
    !capitalist.readDispatches(root).some((x) => String(x.action).includes("新活")),
    "被拒的单不进台账",
  );
});

test("建单：写了 PARENT 没写理由被拒——树边要能被判断真假", async () => {
  const root = sandbox();
  put(root, "A");
  const rec = await dispatchViaDirective(root, { parent: "A" });
  assert.strictEqual(rec.result.ok, false);
  assert.ok(String(rec.result.reason).includes("PARENT_REASON"), rec.result.reason);
});

test("建单：PARENT: none 等于不挂父节点（新树 / 兄弟）", async () => {
  const root = sandbox();
  put(root, "A");
  const rec = await dispatchViaDirective(root, { parent: "none" });
  assert.strictEqual(rec.result.ok, true, rec.result.reason);
  const created = capitalist.readDispatches(root).find((x) => x.source === "adhoc" && String(x.action).includes("新活"));
  assert.ok(created);
  assert.strictEqual(created.parent, undefined, "没有树边");
  assert.strictEqual(capitalist.dependenciesSettled(created, capitalist.readDispatches(root)), true);
});

test("挂父节点的单不参与同类合并：合进去等于替它背一条没写在自己记录上的树边", async () => {
  const root = sandbox();
  put(root, "A");
  const run = async (arg, parent, reason) => {
    const w = appendSupervisorDirective(root, { action: "dispatch", arg, parent, parent_reason: reason });
    assert.ok(w.ok, w.error || "");
    await loop.__testing.applySupervisorDirectives({
      root,
      contract: {},
      state: loadState(root),
      wopts: {},
      concurrency: null,
      out: () => {},
    });
    return listSupervisorDirectives(root).filter((x) => x.arg === arg).pop();
  };

  const first = await run("[t] 第一件活", "A", "要 A");
  const second = await run("[t] 第二件活", "A", "要 A");
  assert.strictEqual(first.result.ok, true, first.result.reason);
  assert.strictEqual(second.result.ok, true, second.result.reason);

  const adhoc = capitalist.readDispatches(root).filter((x) => x.source === "adhoc");
  assert.strictEqual(adhoc.length, 2, "两张都在台账里，没有并成一张");
  assert.ok(
    adhoc.every((x) => x.parent === "A"),
    "两张各自带着自己的树边，不靠别人的记录承载依赖",
  );

  /* 对照组：同类但没挂父节点时，第二张会被并进第一张（这是原有行为，本单没有改动它）。 */
  const root2 = sandbox();
  const run2 = async (arg, parent) => {
    const w = appendSupervisorDirective(root2, { action: "dispatch", arg, ...(parent ? { parent } : {}) });
    assert.ok(w.ok, w.error || "");
    await loop.__testing.applySupervisorDirectives({
      root: root2,
      contract: {},
      state: loadState(root2),
      wopts: {},
      concurrency: null,
      out: () => {},
    });
  };
  await run2("[t] 第一件活");
  await run2("[t] 第二件活");
  const merged = capitalist.readDispatches(root2).filter((x) => x.source === "adhoc");
  assert.strictEqual(merged.length, 1, "无树边的同类活仍然合并");
});


test("场景：异常中断 / 进程被杀——重启后树与队列和中断前一致", () => {
  const root = sandbox();
  put(root, "A");
  put(root, "B", { parent: "A", parent_reason: "要 A" });
  put(root, "C", { parent: "A", parent_reason: "要 A" });
  put(root, "X");

  capitalist.finishDispatch(root, "A", "done", "完成");
  const before = queueAfterRestart(root);
  assert.deepStrictEqual(before, ["B", "C", "X"]);

  /* B 的进程被杀：单留在 claimed，重启不拉起在途单（等收尸）。 */
  patch(root, "B", { status: "claimed" });
  assert.deepStrictEqual(queueAfterRestart(root), ["C", "X"], "在途单不重复拉起，其余顺序不变");

  /* 收尸判 failed，重派单按台账追加排队尾；树边跟着重派走。 */
  patch(root, "B", { status: "failed", done_at: new Date().toISOString() });
  put(root, "B2", { parent: "A", parent_reason: "要 A", lineage: "B" });
  assert.deepStrictEqual(queueAfterRestart(root), ["C", "X", "B2"], "重派单排到队尾，树边仍在");
});

test("场景：机器重启——换一个进程只读台账重算，树与队列完全一致", () => {
  const root = sandbox();
  put(root, "A");
  put(root, "B", { parent: "A", parent_reason: "要 A" });
  put(root, "C", { parent: "B", parent_reason: "要 B" });
  put(root, "R", { urgent: true });
  capitalist.finishDispatch(root, "A", "done", "完成");
  const before = queueAfterRestart(root);
  assert.deepStrictEqual(before, ["R", "B"]);

  const script = `
    const capitalist = require(${JSON.stringify(require.resolve("../dist/core/record/supervisor"))});
    const rows = capitalist.readDispatches(process.argv[1]);
    const sel = rows
      .map((d, i) => ({ d, i }))
      .filter((x) => x.d.status === "open" && capitalist.dependenciesSettled(x.d, rows))
      .sort((a, b) => capitalist.compareQueueOrder(a.d, b.d, a.i, b.i))
      .map((x) => x.d.id);
    const f = capitalist.dispatchForest(rows);
    process.stdout.write(JSON.stringify({ sel, roots: f.roots, depth: f.depth, cycles: f.cycles }));
  `;
  const r = spawnSync(process.execPath, ["-e", script, root], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, `子进程退出码 ${r.status}：${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.deepStrictEqual(out.sel, before, "子进程重算的队列与本进程一致");
  assert.deepStrictEqual(out.roots, ["A", "R"], "根节点一致");
  assert.strictEqual(out.depth.C, 2, "层级一致");
  assert.deepStrictEqual(out.cycles, []);
});

test("场景：插队——urgent / 置顶写在台账上，重启后仍在同一棵树里按原顺序", () => {
  const root = sandbox();
  put(root, "A");
  put(root, "B", { parent: "A", parent_reason: "要 A" });
  put(root, "C", { parent: "A", parent_reason: "要 A", urgent: true });
  put(root, "D", { parent: "A", parent_reason: "要 A", promoted_at: "2026-11-03T10:00:00.000Z", promoted_by: "user" });

  assert.deepStrictEqual(queueAfterRestart(root), ["A"], "父节点没完成，插队也进不来");
  capitalist.finishDispatch(root, "A", "done", "完成");
  const after = queueAfterRestart(root);
  assert.deepStrictEqual(after, ["D", "C", "B"], "父完成后：置顶 > 插队 > 台账顺序");
  assert.deepStrictEqual(queueAfterRestart(root), after, "再重启一次顺序不变");
});

test("场景：派单失败——父节点失败期间子节点继续等，重派完成后子节点解锁", () => {
  const root = sandbox();
  put(root, "A");
  put(root, "B", { parent: "A", parent_reason: "要 A" });
  put(root, "X");
  capitalist.finishDispatch(root, "A", "failed", "进程崩了");
  assert.deepStrictEqual(queueAfterRestart(root), ["X"], "A 失败，B 继续等，X 不受牵连");

  /* 重派单继承原单正文（requeueAdhoc / resetSubtree 的真实行为），血缘才认得出“同一件事”。 */
  put(root, "A2", { lineage: "A", action: "做 A", urgent: true });
  assert.deepStrictEqual(queueAfterRestart(root), ["A2", "X"], "重派单先进队列，B 仍等");
  capitalist.finishDispatch(root, "A2", "done", "重派完成");
  assert.deepStrictEqual(queueAfterRestart(root), ["B", "X"], "同一件事的重派完成后，B 解锁");
});

test("场景：被拒之后——父节点被人工结项（closed）视为已终结，子节点照常启动且不再回来", () => {
  const root = sandbox();
  put(root, "A", { status: "closed", done_at: new Date().toISOString() });
  put(root, "B", { parent: "A", parent_reason: "要 A 的产物（A 后来被关掉）" });
  put(root, "R", { status: "closed", done_at: new Date().toISOString() });

  assert.deepStrictEqual(queueAfterRestart(root), ["B"], "closed 的父节点不再阻塞子节点");
  assert.deepStrictEqual(queueAfterRestart(root), ["B"], "重启后仍是同一结果");
});

test("派单失败重派：树边（parent / parent_reason）跟着重派单走，不静默丢依赖", () => {
  const root = sandbox();
  put(root, "A", { status: "done", done_at: new Date().toISOString() });
  put(root, "B", {
    parent: "A",
    parent_reason: "要 A 的接口",
    source: "adhoc",
    status: "failed",
    done_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });
  loop.__testing.requeueAdhoc(root, loadState(root), () => {});
  const b2 = capitalist.readDispatches(root).find((x) => x.id !== "B" && x.lineage === "B");
  assert.ok(b2, "失败单已重派");
  assert.strictEqual(b2.parent, "A", "父节点继承");
  assert.strictEqual(b2.parent_reason, "要 A 的接口", "理由继承");
});


test("PARENT 行解析：编号与理由进结构，不进气泡正文；PARENT: none 等于不挂", () => {
  const p = parseReply("正文\nDO: dispatch [ui] 重做顶栏\nPARENT: #03\nPARENT_REASON: 要 #03 的栅格\nATT: none");
  assert.strictEqual(p.act.action, "dispatch");
  assert.strictEqual(p.parent, "#03");
  assert.strictEqual(p.parentReason, "要 #03 的栅格");
  assert.ok(!p.reply.includes("PARENT"), "PARENT 行不进正文");

  const none = parseReply("DO: dispatch [x] y\nPARENT: none");
  assert.strictEqual(none.parent, undefined, "none 折成“没有父节点”");

  const zh = parseReply("DO: dispatch [x] y\n父节点: #02\n父节点理由: 要 #02");
  assert.strictEqual(zh.parent, "#02");
  assert.strictEqual(zh.parentReason, "要 #02");
});

test("老台账兼容：只有一个 after 的记录按树边读，森林里仍是父子关系", () => {
  const root = sandbox();
  put(root, "A");
  put(root, "B", { after: ["A"] });
  const f = capitalist.dispatchForest(capitalist.readDispatches(root));
  assert.strictEqual(capitalist.parentOf(capitalist.readDispatches(root)[1]), "A");
  assert.deepStrictEqual(f.children.A, ["B"], "老记录进得了树视图");
  assert.deepStrictEqual(queueAfterRestart(root), ["A"]);
  capitalist.finishDispatch(root, "A", "done", "完成");
  assert.deepStrictEqual(queueAfterRestart(root), ["B"]);
});

test("多前置（老 AFTER 多编号）仍按门禁等齐，但在树视图里是根（树只认单父）", () => {
  const root = sandbox();
  put(root, "A");
  put(root, "B");
  put(root, "Z", { after: ["A", "B"] });
  const rows = capitalist.readDispatches(root);
  const z = rows.find((x) => x.id === "Z");
  assert.strictEqual(capitalist.parentOf(z), "", "多前置没有唯一父节点");
  assert.strictEqual(capitalist.dependenciesSettled(z, rows), false);
  capitalist.finishDispatch(root, "A", "done", "完成");
  assert.strictEqual(capitalist.dependenciesSettled(z, capitalist.readDispatches(root)), false, "还差 B");
  capitalist.finishDispatch(root, "B", "done", "完成");
  assert.strictEqual(capitalist.dependenciesSettled(z, capitalist.readDispatches(root)), true);
});
