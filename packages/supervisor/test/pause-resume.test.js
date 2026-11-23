/**
 * 暂停调度与恢复调度：同一入口覆盖全部未结派单，恢复后按原状态继续。
 *
 * 与 `pause-dispatch.test.js` 的分工：那份守单张标记与看板分档，这份守调度级动作，
 * 重点是“运行中退回排队、待重派与排队都能一次恢复”。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/record/supervisor");
const pause = require("../dist/core/record/pause");
const { createTaskRoot } = require("../dist/core/contract/init");
const board = require("../dist/supervisor/board");

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-pause-resume-"));
  createTaskRoot({ target: "暂停恢复", contractSpec: "minimal", root });
  return root;
}

/** 造一张派单；进程记录单独用 worker() 挂。 */
function put(root, id, extra = {}) {
  capitalist.appendDispatch(root, {
    id,
    at: new Date(Date.now() - 60_000).toISOString(),
    stage: "S1",
    shard: id,
    action: `做 ${id}`,
    status: "open",
    ...extra,
  });
}

/** 挂一条工作进程记录；`pid` 用于“进程未退出”的判定。 */
function worker(root, id, dispatch, status, pid = 0) {
  capitalist.registerWorker(root, {
    id,
    host: "generic",
    pid,
    session: `s-${id}`,
    dispatch,
    shard: dispatch,
    stage: "S1",
    started_at: new Date(Date.now() - 60_000).toISOString(),
    heartbeat_at: new Date(Date.now() - 60_000).toISOString(),
    heartbeat_ts: Date.now() / 1000 - 60,
    status,
    log: join(root, ".capitalist", "workers", id, "output.log"),
  });
}

const rowOf = (root, id) => capitalist.readDispatches(root).find((d) => d.id === id);

test("暂停调度：运行中退回排队并记住原态，待重派与排队各自标记", () => {
  const root = sandbox();
  put(root, "D-run", { status: "claimed", worker: "W-run" });
  put(root, "D-retry", { worker: "W-retry" });
  put(root, "D-queue", {});
  put(root, "D-report", { status: "reported", worker: "W-report" });
  worker(root, "W-run", "D-run", "running");
  worker(root, "W-retry", "D-retry", "exited");
  worker(root, "W-report", "D-report", "exited");

  const marks = pause.pauseAll(root, "board", "测试暂停");

  assert.strictEqual(marks.marked, 4);
  assert.deepStrictEqual(marks.origins, { running: 1, retry: 1, queued: 1, review: 1 });

  const run = rowOf(root, "D-run");
  assert.strictEqual(run.status, "open", "claimed 必须退回 open，否则回收会判成进程丢失");
  assert.strictEqual(run.paused_from, "running");
  assert.ok(run.paused_at);
  assert.match(String(run.note), /恢复后继续执行/);

  assert.strictEqual(rowOf(root, "D-retry").paused_from, "retry");
  assert.strictEqual(rowOf(root, "D-queue").paused_from, "queued");
  const report = rowOf(root, "D-report");
  assert.strictEqual(report.status, "reported", "等裁决的单保持状态，恢复后仍等裁决");
  assert.strictEqual(report.paused_from, "review");

  assert.ok(pause.readPause(root), "暂停文件与派单标记必须同时成立");
});

test("恢复调度：标记全清，运行中的单回到可领取状态", () => {
  const root = sandbox();
  put(root, "D-run", { status: "claimed", worker: "W-run" });
  put(root, "D-queue", {});
  worker(root, "W-run", "D-run", "running");

  pause.pauseAll(root, "board", "测试");
  assert.strictEqual(capitalist.firstOpenDispatch(root), undefined, "暂停期间不出现在可领取队列");

  const outcome = pause.resumeAll(root, "board");
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.cleared, 2);
  assert.strictEqual(outcome.kept.length, 0);
  assert.strictEqual(pause.readPause(root), null);

  for (const id of ["D-run", "D-queue"]) {
    const d = rowOf(root, id);
    assert.strictEqual(d.paused_at, undefined);
    assert.strictEqual(d.paused_from, undefined);
    assert.strictEqual(d.status, "open");
  }
  assert.ok(capitalist.firstOpenDispatch(root), "恢复后重新进入调度");
});

test("暂停期间不推进等确认与待裁决：到点也不结算", () => {
  const root = sandbox();
  const past = new Date(Date.now() - 60_000).toISOString();
  put(root, "D-review", { status: "review", review_until: past });
  put(root, "D-reported", { status: "reported", reported_at: past });

  pause.pauseAll(root, "board", "测试");
  assert.deepStrictEqual(capitalist.sweepReviews(root), []);
  assert.deepStrictEqual(capitalist.sweepReported(root), []);
  assert.strictEqual(rowOf(root, "D-review").status, "review");
  assert.strictEqual(rowOf(root, "D-reported").status, "reported");
});

test("终态不随恢复复活：暂停期间取消的单恢复后仍是 closed", () => {
  const root = sandbox();
  put(root, "D-a", {});
  pause.pauseAll(root, "board", "测试");

  assert.ok(capitalist.closeDispatch(root, "D-a", "用户取消"));
  const outcome = pause.resumeAll(root, "user");
  assert.strictEqual(outcome.ok, true);

  const d = rowOf(root, "D-a");
  assert.strictEqual(d.status, "closed");
  assert.strictEqual(d.paused_at, undefined, "取消时顺手清标记，不留脏数据");
  assert.strictEqual(capitalist.wakeDispatch(root, "D-a"), null, "终态不接受唤醒");
});

test("进程未退出时保留暂停：恢复会与残留进程双跑", () => {
  const root = sandbox();
  put(root, "D-run", { status: "claimed", worker: "W-run" });
  /* 用当前进程的 pid：判活为真，模拟“终止未确认”的残留进程。 */
  worker(root, "W-run", "D-run", "exited", process.pid);

  pause.pauseAll(root, "board", "测试");
  const outcome = pause.resumeAll(root, "board");

  assert.strictEqual(outcome.cleared, 0);
  assert.strictEqual(outcome.kept.length, 1);
  assert.match(outcome.kept[0].reason, /进程未退出/);
  const d = rowOf(root, "D-run");
  assert.ok(d.paused_at, "进程还在跑的单必须保持暂停");
  assert.match(String(d.paused_reason), /进程未退出/);
});

test("看板：运行中的单暂停后显示暂停中，不再显示待重派", () => {
  const root = sandbox();
  put(root, "D-run", { status: "claimed", worker: "W-run" });
  worker(root, "W-run", "D-run", "running");

  pause.pauseAll(root, "board", "测试");
  /* 暂停动作会停进程；这里补上进程已退出的记录，复现界面看到的组合。 */
  capitalist.saveWorker(root, { ...capitalist.loadWorker(root, "W-run"), status: "exited" });

  const t = board.buildThreads(root).find((x) => x.dispatch === "D-run");
  assert.ok(t);
  assert.strictEqual(t.status, "paused", "进程行也要先判暂停");
});

test("看板唤醒动作属于允许的动作：不再返回未知动作", () => {
  const root = sandbox();
  put(root, "D-a", {});
  capitalist.holdDispatch(root, "D-a", "startup", "测试");

  const r = board.runCommand(root, { action: "wake", id: "D-a" });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(rowOf(root, "D-a").paused_at, undefined);
});

test("等确认的单恢复后计时顺延，不因暂停被判超时", () => {
  const root = sandbox();
  const { readFileSync, writeFileSync } = require("node:fs");
  const expired = new Date(Date.now() - 60_000).toISOString();
  put(root, "D-review", { status: "review", review_until: expired });
  pause.pauseAll(root, "board", "测试");

  /* 把暂停时刻改到 30 分钟前：模拟长时间暂停，此时 review_until 早就过了。 */
  const file = join(root, ".capitalist", "inbox", "dispatch.jsonl");
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const r of rows) {
    if (r.id === "D-review") r.paused_at = new Date(Date.now() - 30 * 60_000).toISOString();
  }
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  pause.resumeAll(root, "board");
  const d = rowOf(root, "D-review");
  assert.ok(Date.parse(String(d.review_until)) > Date.now(), "恢复后应还有剩余确认时间");
  assert.deepStrictEqual(capitalist.sweepReviews(root), [], "恢复瞬间不该被判超时");
});

test("全局暂停期间点名唤醒的单不会被下一轮补标记覆盖", () => {
  const root = sandbox();
  put(root, "D-a", {});
  put(root, "D-b", {});

  const paused = pause.pauseAll(root, "board", "测试");
  assert.ok(capitalist.wakeDispatch(root, "D-a"), "点名唤醒成功");
  assert.strictEqual(rowOf(root, "D-a").paused_at, undefined);

  /* 主循环每轮补标记：默认设置下会再标一次，wake_at 晚于暂停时刻的单必须跳过。 */
  pause.pauseLiveDispatches(root, "supervisor", "测试", paused.at);
  assert.strictEqual(rowOf(root, "D-a").paused_at, undefined, "唤醒后不该被标回去");
  assert.ok(rowOf(root, "D-b").paused_at, "其余单保持暂停");
});

test("排空式停止的门闩与用户暂停分开：不冻结在途派单", () => {
  const root = sandbox();
  put(root, "D-a", {});
  const gate = pause.setPauseGate(root, "supervisor", "停止请求", true);
  assert.strictEqual(gate.drain, true);

  const rec = pause.readPause(root);
  assert.strictEqual(rec?.drain, true, "drain 要落盘，监工每轮据此跳过停进程");
  assert.strictEqual(rowOf(root, "D-a").paused_at, undefined, "排空停止只挡新派单，不打暂停标记");
});

test("排空式停止不冻在途：pauseRun 遇到 drain 门闩直接返回", () => {
  const root = sandbox();
  put(root, "D-a", { status: "claimed", worker: "W-a" });
  worker(root, "W-a", "D-a", "running", 0);

  const gate = pause.setPauseGate(root, "supervisor", "停止请求", true);
  require("../dist/supervisor/loop").__testing.pauseRun(root, gate, () => {});

  assert.strictEqual(capitalist.loadWorker(root, "W-a").status, "running", "排空停止不该停进程");
  assert.strictEqual(rowOf(root, "D-a").status, "claimed");
  assert.strictEqual(rowOf(root, "D-a").paused_at, undefined, "也不该打暂停标记");
});

test("空任务根不写暂停文件：没有可暂停的派单", () => {
  const root = sandbox();
  const r = pause.pauseAll(root, "startup", "测试");
  assert.strictEqual(r.written, false);
  assert.strictEqual(r.marked, 0);
  assert.strictEqual(pause.readPause(root), null, "新任务根不该一启动就落 paused");
});

test("已暂停但单据都已结束时，重复暂停如实报告仍在暂停态", () => {
  const root = sandbox();
  put(root, "D-a", {});
  pause.pauseAll(root, "board", "测试");
  capitalist.closeDispatch(root, "D-a", "用户取消");

  const again = pause.pauseAll(root, "board", "测试");
  assert.strictEqual(again.written, true, "文件还在，不能报成未写");
  assert.ok(pause.readPause(root));
});

test("手工删除暂停文件后，主循环兜底清除标记", () => {
  const root = sandbox();
  put(root, "D-a", {});
  pause.pauseAll(root, "board", "测试");
  /* 用户按帮助里的办法直接删文件，不经过 resume。 */
  require("node:fs").unlinkSync(pause.pausePath(root));

  const cleared = pause.resumeDanglingMarks(root, "supervisor");
  assert.strictEqual(cleared, 1);
  assert.strictEqual(rowOf(root, "D-a").paused_at, undefined);
});
