
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
const { eventsPath } = require("../dist/core/record/ledger");
const { readJsonl } = require("../dist/core/record/json");

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-order-"));
  createTaskRoot({ target: "派单顺序一致性", contractSpec: "minimal", root: base });
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
    ...extra,
  });
  return capitalist.readDispatches(root).find((x) => x.id === id);
}

/** 直接改台账行状态（模拟收尸判死等外部事实，不改行序）。 */
function setStatus(root, id, status) {
  const rows = capitalist.readDispatches(root).map((x) => (x.id === id ? { ...x, status } : x));
  writeJsonl(capitalist.dispatchPath(root), rows);
}

/**
 * 重启后的队列：与 fillSlots 同一条判定（open + 依赖满足），按 compareQueueOrder 排。
 * “重启”在这个测试里的含义是：一切排序输入只从台账文件来，进程内存里什么都不留。
 */
function queueAfterRestart(root) {
  const rows = capitalist.readDispatches(root);
  return rows
    .map((d, i) => ({ d, i }))
    .filter((x) => x.d.status === "open" && capitalist.dependenciesSettled(x.d, rows))
    .sort((a, b) => capitalist.compareQueueOrder(a.d, b.d, a.i, b.i))
    .map((x) => x.d.id);
}

test("依赖门：前置单没完成，挂了编号的单不启动；完成后才启动", () => {
  const root = sandbox();
  put(root, "A");
  put(root, "B", { after: ["A"] });
  assert.deepStrictEqual(queueAfterRestart(root), ["A"], "B 挂着 A，A 未完成时 B 不启动");
  capitalist.finishDispatch(root, "A", "done", "完成");
  assert.deepStrictEqual(queueAfterRestart(root), ["B"], "A 完成后 B 才进队列");
});

test("血缘解析：前置单失败重派后，重派单完成同样算满足（B 不因 A 换编号而永久卡死）", () => {
  const root = sandbox();
  put(root, "A");
  put(root, "B", { after: ["A"] });
  capitalist.finishDispatch(root, "A", "failed", "进程崩了");
  assert.deepStrictEqual(queueAfterRestart(root), [], "A 失败，B 继续等");
  put(root, "A2", { lineage: "A", action: "做 A" });
  assert.deepStrictEqual(queueAfterRestart(root), ["A2"], "A 的重派单先进队列，B 仍等");
  capitalist.finishDispatch(root, "A2", "done", "重派完成");
  assert.deepStrictEqual(queueAfterRestart(root), ["B"], "同一件事的重派完成后，B 解锁");
});

test("前置是契约分片单：分片重派另起新血缘，重派完成后同样算满足（U1 实测缺口回归）", () => {
  const root = sandbox();
  /* 分片单（有 shard 字段）：planDispatch / shardRetry / 模型回退的重派都另写 lineage。 */
  put(root, "S1", { shard: "s1", lineage: "S1" });
  put(root, "B", { shard: "", after: ["S1"] });
  capitalist.finishDispatch(root, "S1", "failed", "进程崩了");
  assert.deepStrictEqual(queueAfterRestart(root), [], "分片失败，B 继续等");
  /* 重派单：同 stage+shard，但血缘是新的（分片重派不整链继承血缘）。 */
  put(root, "S2", { shard: "s1", lineage: "S2" });
  assert.deepStrictEqual(queueAfterRestart(root), ["S2"], "重派单先进队列，B 仍等");
  capitalist.finishDispatch(root, "S2", "done", "重派完成");
  assert.deepStrictEqual(queueAfterRestart(root), ["B"], "同一片活有了完成单，B 解锁");
  /* 反向确认：别的分片完成不算数，按 stage+shard 认，不按“有分片就行”认。 */
  const root2 = sandbox();
  put(root2, "T1", { shard: "s1", lineage: "T1" });
  put(root2, "T2", { shard: "s2", lineage: "T2", status: "done" });
  put(root2, "B2", { shard: "", after: ["T1"] });
  assert.deepStrictEqual(queueAfterRestart(root2), ["T1"], "T1 照常在队列；s2 完成不代表 s1 完成，B2 不进队列");
});

test("通配依赖 after:[*]：其它单全部到终态（含 failed）才启动", () => {
  const root = sandbox();
  put(root, "A");
  put(root, "B");
  put(root, "Z", { after: ["*"] });
  assert.deepStrictEqual(queueAfterRestart(root), ["A", "B"], "还有活着的单，收尾单不启动");
  capitalist.finishDispatch(root, "A", "done", "x");
  capitalist.finishDispatch(root, "B", "failed", "y");
  assert.deepStrictEqual(queueAfterRestart(root), ["Z"], "全部到终态后收尾单启动");
});

test("场景：异常中断与关机——重启后队列顺序与启动前一致，被杀单重派后排到队尾", () => {
  const root = sandbox();
  put(root, "D1");
  put(root, "D2");
  put(root, "D3");
  const before = queueAfterRestart(root);
  assert.deepStrictEqual(before, ["D1", "D2", "D3"]);

  /* 异常中断：D2 的进程被杀，单留在 claimed（重启不拉起在途单，等收尸）。 */
  setStatus(root, "D2", "claimed");
  assert.deepStrictEqual(queueAfterRestart(root), ["D1", "D3"], "重启后只剩 open 单，台账顺序不变");

  /* 收尸判 failed，重派单按台账追加排在队尾，顺序仍是确定的、可复现的。 */
  capitalist.finishDispatch(root, "D2", "failed", "worker 中断");
  put(root, "D2r", { lineage: "D2" });
  const after = queueAfterRestart(root);
  assert.deepStrictEqual(after, ["D1", "D3", "D2r"]);
  /* 再“重启”一次：顺序必须原样复原，不能有任何一拍发生漂移。 */
  assert.deepStrictEqual(queueAfterRestart(root), after, "二次重启顺序不变");
});

test("场景：插队——urgent 与手动置顶都写在台账上，重启后插队顺序照旧", () => {
  const root = sandbox();
  put(root, "P1");
  put(root, "P2", { urgent: true });
  put(root, "P3", { urgent: true, promoted_at: "2026-11-03T10:00:00.000Z", promoted_by: "user" });
  const before = queueAfterRestart(root);
  assert.deepStrictEqual(before, ["P3", "P2", "P1"], "置顶 > 插队 > 台账顺序");
  /* 关机后重启：urgent / promoted_at 是台账字段，顺序必须原样复原。 */
  assert.deepStrictEqual(queueAfterRestart(root), before);
  /* 后点置顶的先上：这也是写在数据里的，重启不丢。 */
  put(root, "P4", { promoted_at: "2026-11-03T11:00:00.000Z", promoted_by: "user" });
  assert.deepStrictEqual(queueAfterRestart(root), ["P4", "P3", "P2", "P1"]);
  assert.deepStrictEqual(queueAfterRestart(root), ["P4", "P3", "P2", "P1"], "再重启仍一致");
});

test("场景：被拒——closed 是终态，重启后不回队列；依赖它的单按“前置已结”处理", () => {
  const root = sandbox();
  put(root, "R1", { status: "closed" });
  put(root, "R2", { after: ["R1"] });
  put(root, "R3", { status: "closed" });
  const sel = queueAfterRestart(root);
  assert.deepStrictEqual(sel, ["R2"], "closed 单不回队列，被拒单的下游按前置已结启动");
  assert.deepStrictEqual(queueAfterRestart(root), sel, "重启后一致");
});

test("场景：派单失败——依赖链在失败重派后依然成立，顺序不漂移", () => {
  const root = sandbox();
  put(root, "F1");
  put(root, "F2", { after: ["F1"] });
  put(root, "F3");
  capitalist.finishDispatch(root, "F1", "failed", "第一次失败");
  /* F1 失败退避期间：F2 被按住，F3 不受牵连。 */
  assert.deepStrictEqual(queueAfterRestart(root), ["F3"], "F2 等 F1，F3 照常");
  const f1r = put(root, "F1r", { lineage: "F1", action: "做 F1" });
  capitalist.finishDispatch(root, "F1r", "done", "重派成功");
  assert.deepStrictEqual(queueAfterRestart(root), ["F2", "F3"], "F1 重派完成后 F2 解锁，F3 仍在队列");
  assert.ok(f1r);
});

test("跨进程重启：队列顺序只从台账复原（真实子进程重算，不用本进程的任何状态）", () => {
  const root = sandbox();
  put(root, "C1");
  put(root, "C2", { urgent: true });
  put(root, "C3", { after: ["C1"] });
  const before = queueAfterRestart(root);
  assert.deepStrictEqual(before, ["C2", "C1"], "C3 挂着 C1 不启动");

  capitalist.finishDispatch(root, "C1", "done", "完成");
  const script = `
    const capitalist = require(${JSON.stringify(require.resolve("../dist/core/record/supervisor"))});
    const rows = capitalist.readDispatches(process.argv[1]);
    const sel = rows
      .map((d, i) => ({ d, i }))
      .filter((x) => x.d.status === "open" && capitalist.dependenciesSettled(x.d, rows))
      .sort((a, b) => capitalist.compareQueueOrder(a.d, b.d, a.i, b.i))
      .map((x) => x.d.id);
    process.stdout.write(JSON.stringify(sel));
  `;
  const r = spawnSync(process.execPath, ["-e", script, root], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, `子进程退出码 ${r.status}：${r.stderr}`);
  assert.deepStrictEqual(JSON.parse(r.stdout), ["C2", "C3"], "子进程重算结果与本进程一致");
});

test("AFTER 行解析：编号进解析结果，不进气泡正文；AFTER: none 等于不写", () => {
  const p = parseReply("正文\nDO: dispatch [ui] 重做顶栏\nAFTER: #03, #05\nATT: none");
  assert.strictEqual(p.act.action, "dispatch");
  assert.deepStrictEqual(p.after, ["#03", "#05"]);
  assert.ok(!p.reply.includes("AFTER"), "AFTER 行不进正文");
  const none = parseReply("DO: dispatch [x] y\nAFTER: none");
  assert.strictEqual(none.after, undefined);
  const star = parseReply("DO: dispatch [x] y\nAFTER: *");
  assert.deepStrictEqual(star.after, ["*"]);
});

test("dispatch 指令把依赖写进台账 after 字段（编号 -> 派单 id 落数据）", async () => {
  const root = sandbox();
  const a = put(root, "A");
  /* 编号表：A 的线程键（阶段 / x+血缘尾 6 位）拿 1 号。 */
  assignThreadNos(root, [`S0/x${String(a.lineage ?? a.id).slice(-6).toLowerCase()}`]);
  const w = appendSupervisorDirective(root, {
    action: "dispatch",
    arg: "[t] 后做的活",
    after: ["#1"],
  });
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
  const created = capitalist
    .readDispatches(root)
    .find((x) => x.source === "adhoc" && String(x.action).includes("后做的活"));
  assert.ok(created, "新单已建");
  assert.deepStrictEqual(created.after, [a.id], "AFTER 编号已翻译成台账 id 落在 after 字段");
});

test("AFTER 指向不存在的单：派单被拒并说明原因，不静默丢依赖", async () => {
  const root = sandbox();
  appendSupervisorDirective(root, { action: "dispatch", arg: "[t] 依赖悬空的活", after: ["D-nope"] });
  await loop.__testing.applySupervisorDirectives({
    root,
    contract: {},
    state: loadState(root),
    wopts: {},
    concurrency: null,
    out: () => {},
  });
  const rec = listSupervisorDirectives(root).find((x) => String(x.arg).includes("依赖悬空的活"));
  assert.ok(rec, "指令记录在案");
  assert.strictEqual(rec.result && rec.result.ok, false, "执行被拒");
  assert.ok(
    String(rec.result && rec.result.reason).includes("AFTER"),
    `拒绝原因要说明依赖没落上：${rec.result && rec.result.reason}`,
  );
  assert.ok(
    !capitalist.readDispatches(root).some((x) => String(x.action).includes("依赖悬空的活")),
    "被拒的单不进台账",
  );
});

test("多前置孤儿：AFTER 挂了台账里没有的编号，放行时记 dispatch_parent_missing 留痕", () => {
  const root = sandbox();
  put(root, "M1");
  /* 多前置是遗留 DAG 形状，dispatchForest 只认单父边，这类孤儿只能靠 missingPrerequisites 补查。 */
  put(root, "M2", { after: ["M1", "GONE-1", "GONE-2"] });
  assert.deepStrictEqual(
    capitalist.missingPrerequisites(capitalist.readDispatches(root).find((x) => x.id === "M2"), capitalist.readDispatches(root)),
    ["GONE-1", "GONE-2"],
    "缺的编号一个不少地列出来",
  );
  const seen = [];
  loop.__testing.reportForestAnomalies(root, capitalist.readDispatches(root), (s) => seen.push(s));
  const events = readJsonl(eventsPath(root)).filter((x) => x.event === "dispatch_parent_missing");
  const m2 = events.find((x) => x.dispatch === "M2");
  assert.ok(m2, "M2 的孤儿前置记了事件");
  assert.deepStrictEqual(m2.missing, ["GONE-1", "GONE-2"], "事件里列出缺的编号");
  assert.ok(seen.some((s) => s.includes("M2") && s.includes("GONE-1")), "监工流里也播了");
  /* 再报一轮：同一处异常不重复刷屏（条件没变就不重报）。 */
  loop.__testing.reportForestAnomalies(root, capitalist.readDispatches(root), () => {});
  const again = readJsonl(eventsPath(root)).filter((x) => x.event === "dispatch_parent_missing" && x.dispatch === "M2");
  assert.strictEqual(again.length, 1, "同一条孤儿前置只报一次");
  /* 单父边的孤儿由森林 orphans 覆盖，不在这里重复报。 */
  put(root, "M3", { after: ["M1"] });
  /* M3 单前置且存在，无孤儿；M1 挂单前置但单父路径由 orphans 负责，这里只断言 M3 没被多前置路径报。 */
  loop.__testing.reportForestAnomalies(root, capitalist.readDispatches(root), () => {});
  const m3 = readJsonl(eventsPath(root)).filter((x) => x.event === "dispatch_parent_missing" && x.dispatch === "M3");
  assert.strictEqual(m3.length, 0, "前置齐全的单不报");
});

test("场景：立即执行——让位不改台账行序，恢复后与重启后都是原来的顺序", () => {
  const root = sandbox();
  const preempt = require("../dist/core/dispatch/preempt");
  put(root, "A", { status: "claimed", worker: "W-a" });
  put(root, "B");
  put(root, "C");
  put(root, "NOW", { promoted_at: "2026-11-03T10:00:00.000Z", promoted_by: "user" });

  /* 让位前 A 运行中，不在 open 队列里；B、C 排队。 */
  assert.deepStrictEqual(queueAfterRestart(root).filter((id) => id !== "NOW"), ["B", "C"]);

  /* 让位：运行中的 A 与排队的 B、C 都退回排队，顺序记在台账上。 */
  preempt.markYielded(root, ["A", "B", "C"], "NOW");
  assert.deepStrictEqual(
    capitalist.readDispatches(root).map((d) => d.id),
    ["A", "B", "C", "NOW"],
    "让位不搬台账行（行序就是建单时间线）",
  );
  /* 让位期间“重启”：队列里立即执行排最前，让位的按原顺序跟在后面。 */
  assert.deepStrictEqual(queueAfterRestart(root), ["NOW", "A", "B", "C"]);

  /* 立即执行结束 -> 恢复：顺序回到让位前，重启再算一遍也不能漂移。 */
  capitalist.finishDispatch(root, "NOW", "done", "做完了");
  preempt.releaseYielded(root, "NOW");
  assert.deepStrictEqual(queueAfterRestart(root), ["A", "B", "C"]);
  assert.deepStrictEqual(queueAfterRestart(root), ["A", "B", "C"], "二次重启顺序不变");
});
