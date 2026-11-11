
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawn } = require("node:child_process");

const capitalist = require("../dist/core/supervisor");
const { writeJsonl, readJsonl } = require("../dist/core/json");
const { createTaskRoot } = require("../dist/core/init");
const { loadState } = require("../dist/core/state");
const loop = require("../dist/supervisor/loop");

/*
 * 判定通道指向一个不存在的可执行文件：本文件验的是“判死后怎么传导”，
 * 不验“模型认为该不该重试”。不挡的话每次判死都会真的拉起一个模型会话。
 */
process.env.CAPITALIST_WORKER_BIN = join(tmpdir(), "no-such-worker-bin-for-cascade-test");

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-cascade-"));
  createTaskRoot({ target: "失败沿树传导", contractSpec: "minimal", root: base });
  mkdirSync(join(base, ".capitalist", "workers"), { recursive: true });
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
    lineage: id,
    ...extra,
  });
}

/** 直接改台账行（模拟收尸判死、外部改动），不改行序。 */
function patch(root, id, fields) {
  const rows = capitalist.readDispatches(root).map((x) => (x.id === id ? { ...x, ...fields } : x));
  writeJsonl(capitalist.dispatchPath(root), rows);
}

function row(root, id) {
  return capitalist.readDispatches(root).find((x) => x.id === id);
}

function fakeWorker(root, wid, dispatchId) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  /* 不 unref 的话这个长命子进程会把测试进程挂在事件循环上退不出去。 */
  child.unref();
  const now = new Date().toISOString();
  capitalist.saveWorker(root, {
    id: wid,
    host: "custom",
    pid: child.pid,
    session: wid,
    dispatch: dispatchId,
    stage: "S0",
    shard: "",
    started_at: now,
    heartbeat_at: now,
    heartbeat_ts: Date.now() / 1000,
    status: "running",
    log: join(root, ".capitalist", "workers", `${wid}.log`),
    mode: "background",
  });
  return { id: wid, pid: child.pid, child };
}

function writeLog(root, workerId, text) {
  writeFileSync(join(root, ".capitalist", "workers", `${workerId}.log`), text, "utf8");
}

function events(root, name) {
  return readJsonl(join(root, ".capitalist", "events.jsonl")).filter((e) => e.event === name);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const quiet = () => {};

/** 一条“父节点带一条链”的标准现场：父已失败两次，第三次正运行中，下面挂两代子孙。 */
function scene(root, { log = "worker 崩了：unexpected exit" } = {}) {
  put(root, "P0", { status: "failed", note: "第一次：启动即退", done_at: new Date().toISOString() });
  put(root, "P1", { status: "failed", note: "第二次：又退", done_at: new Date().toISOString(), attempt: 2 });
  put(root, "P2", {
    status: "claimed",
    attempt: 3,
    lineage: "P0",
    worker: "W-p2",
    claimed_at: new Date().toISOString(),
    title: "父节点",
  });
  patch(root, "P0", { lineage: "P0" });
  patch(root, "P1", { lineage: "P0" });

  put(root, "C1", { status: "open", parent: "P2", parent_reason: "要 P2 的产物" });
  put(root, "C2", { status: "claimed", parent: "P2", parent_reason: "要 P2 的产物", worker: "W-c2" });
  put(root, "G1", { status: "open", parent: "C1", parent_reason: "要 C1 的产物" });
  /* 已完成的子孙：既成事实，不许被改成失败。 */
  put(root, "D1", { status: "done", parent: "P2", parent_reason: "要 P2 的产物" });
  /* 另一棵树：与这条子树无关，不该被牵连。 */
  put(root, "T2", { status: "open" });

  const p2 = fakeWorker(root, "W-p2", "P2");
  writeLog(root, "W-p2", log);
  const c2 = fakeWorker(root, "W-c2", "C2");
  return { p2, c2 };
}


test("父节点第三次失败：整棵子树判死、运行中的子进程被停、不再有重试", () => {
  const root = sandbox();
  const { c2 } = scene(root);
  const before = capitalist.readDispatches(root).length;

  const ok = loop.__testing.failDispatchAndJudge(
    root,
    row(root, "P2"),
    "worker 进程退出（code 1）",
    quiet,
  );
  assert.equal(ok, true, "父节点应被结单");

  assert.equal(row(root, "P2").status, "failed", "父节点失败");

  for (const id of ["C1", "C2", "G1"]) {
    const r = row(root, id);
    assert.equal(r.status, "failed", `${id} 应级联判为失败（含孙子）`);
    assert.equal(r.retry_verdict, "give_up", `${id} 不许再重试`);
    assert.equal(r.cascade_from, "P2", `${id} 要记下是哪个祖先断的`);
  }

  assert.equal(row(root, "D1").status, "done", "已完成的子孙不动");
  assert.equal(row(root, "T2").status, "open", "别的树不受牵连");

  assert.equal(alive(c2.pid), false, "运行中的子进程必须停掉");

  const ev = events(root, "dispatch_cascade_failed");
  assert.equal(ev.length, 1, "级联要记一条事件");
  assert.equal(ev[0].ancestor, "P2");
  assert.deepStrictEqual(ev[0].nodes.sort(), ["C1", "C2", "G1"]);
  assert.deepStrictEqual(ev[0].stopped_workers, ["W-c2"]);

  /* 不再重试：没有新增派单，子树里也没有任何一张回到可派状态。 */
  assert.equal(capitalist.readDispatches(root).length, before, "级联不新开单");
  assert.equal(
    capitalist.readDispatches(root).filter((d) => ["C1", "C2", "G1"].includes(d.id) && d.status === "open").length,
    0,
    "子树里不该留下可派节点",
  );
});

test("未到上限不级联：第二次失败只结自己这一单", () => {
  const root = sandbox();
  put(root, "P0", { status: "claimed", lineage: "P0", worker: "W-p0" });
  put(root, "C1", { status: "open", parent: "P0", parent_reason: "要 P0 的产物" });
  writeLog(root, "W-p0", "boom");
  fakeWorker(root, "W-p0", "P0");

  loop.__testing.failDispatchAndJudge(root, row(root, "P0"), "worker 进程退出（code 1）", quiet);

  assert.equal(row(root, "P0").status, "failed");
  assert.equal(row(root, "C1").status, "open", "没到上限，子节点照旧等父节点");
  assert.equal(events(root, "dispatch_cascade_failed").length, 0);
});


test("诊断不出原因：登记待裁决 + 标阻塞，停手等人", () => {
  const root = sandbox();
  scene(root, { log: "一些没头没尾的输出\n第二个 worker 崩了" });

  loop.__testing.cascadeFailure(root, row(root, "P2"), 3, quiet);

  const inbox = readJsonl(join(root, ".capitalist", "inbox", "qa.jsonl")).filter((q) => q.type === "ask");
  assert.equal(inbox.length, 1, "要登记一条待裁决问题");
  assert.match(String(inbox[0].text), /级联失败 P2/);
  assert.match(String(inbox[0].context), /诊断原因/);

  const st = loadState(root);
  assert.equal(st.blockers.length, 1, "要标阻塞（否则宽限期一过又自己跑起来）");
  assert.equal(st.blockers[0].type, "cascade");

  assert.equal(events(root, "dispatch_cascade_diagnosed")[0].cause, "unknown");
  assert.equal(events(root, "dispatch_cascade_escalated").length, 1);
  assert.equal(row(root, "P2").retry_verdict, "give_up", "父节点不许被自动重试");
});

test("被拒（权限/凭证）：不自动重跑，直接转人工", () => {
  const root = sandbox();
  scene(root, { log: "请求失败：403 forbidden，permission denied" });

  loop.__testing.cascadeFailure(root, row(root, "P2"), 3, quiet);

  assert.equal(events(root, "dispatch_cascade_diagnosed")[0].cause, "denied");
  assert.equal(events(root, "dispatch_subtree_reset").length, 0, "被拒不重跑");
  assert.equal(readJsonl(join(root, ".capitalist", "inbox", "qa.jsonl")).filter((q) => q.type === "ask").length, 1);
});

test("上下文超限：重置子树重跑一次，父节点换新单、子孙回到可派", () => {
  const root = sandbox();
  scene(root, { log: "Error: context window exceeded (maximum context length is 200000 tokens)" });

  loop.__testing.cascadeFailure(root, row(root, "P2"), 3, quiet);

  assert.equal(events(root, "dispatch_cascade_diagnosed")[0].cause, "context_overflow");
  const reset = events(root, "dispatch_subtree_reset");
  assert.equal(reset.length, 1, "可修原因要重置重跑");
  assert.equal(reset[0].resets, 1);

  const nextId = reset[0].replacement;
  const next = row(root, nextId);
  assert.ok(next, "父节点要有后续单");
  assert.equal(next.status, "open");
  assert.equal(next.source, "requeue");
  assert.equal(next.lineage, "P0", "血缘不变：门禁靠血缘认前置");
  assert.equal(next.attempt, 4, "第 4 次尝试");

  for (const id of ["C1", "C2", "G1"]) {
    const r = row(root, id);
    assert.equal(r.status, "open", `${id} 回到可派状态`);
    assert.equal(r.retry_verdict, "retry", `${id} 允许重跑`);
  }
  assert.equal(row(root, "C1").parent, nextId, "直接子节点的树边改挂到新父单");
  assert.equal(row(root, "G1").parent, "C1", "孙子的边不动（它的父节点还在）");
});

test("可修原因但已经自动重置过一次：不再重跑，转人工", () => {
  const root = sandbox();
  scene(root, { log: "socket hang up" });
  patch(root, "P2", { cascade_resets: 1 });

  loop.__testing.cascadeFailure(root, row(root, "P2"), 3, quiet);

  assert.equal(events(root, "dispatch_subtree_reset").length, 0, "第二次不再自动重跑");
  assert.equal(events(root, "dispatch_cascade_escalated").length, 1);
  assert.match(String(readJsonl(join(root, ".capitalist", "inbox", "qa.jsonl"))[0].text), /已自动重置过 1 次/);
});


test("descendantsOf 取全部后代（不只直接子节点），成环不死循环", () => {
  const root = sandbox();
  put(root, "A");
  put(root, "B", { parent: "A", parent_reason: "要 A" });
  put(root, "C", { parent: "B", parent_reason: "要 B" });
  put(root, "D", { parent: "A", parent_reason: "要 A" });
  put(root, "X", { parent: "Y", parent_reason: "环" });
  put(root, "Y", { parent: "X", parent_reason: "环" });

  const rows = capitalist.readDispatches(root);
  assert.deepStrictEqual(capitalist.descendantsOf(rows, "A"), ["B", "D", "C"]);
  assert.deepStrictEqual(capitalist.descendantsOf(rows, "C"), []);
  assert.deepStrictEqual(capitalist.descendantsOf(rows, "X"), ["Y"]);
});
