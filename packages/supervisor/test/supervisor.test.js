/**
 * 监工进程与工作进程。
 *
 * 要验的是三件事，与“谁建立谁”直接相关：
 *   1. 派单是抢占式的，两个 worker 不会接到同一张单；
 *   2. 每个 worker 一条独立记录，心跳互不影响（多 worker 并行的前提）；
 *   3. `capitalist supervise` 会自己建根，并拉起一个 pid 与监工不同的独立进程。
 *
 * 第 3 条用假 worker 脚本代替真实模型会话：测的是进程编排，不是模型行为。
 */

const test = require("node:test");
const assert = require("node:assert");
const { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const capitalist = require("../dist/core/record/supervisor");
const { createTaskRoot } = require("../dist/core/contract/init");
const { loadState, saveState } = require("../dist/core/record/state");
const loop = require("../dist/supervisor/loop");
const { detectWorkerHost, buildPrompt, resolveSession } = require("../dist/supervisor/worker/worker");

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-sv-"));
  createTaskRoot({ target: "重构计费服务", contractSpec: "minimal", root: base });
  return base;
}

function openDispatch(root, id = "D-test1", action = "把重试改成指数退避") {
  const d = { id, at: new Date().toISOString(), stage: "S0", action, status: "open" };
  capitalist.appendDispatch(root, d);
  return d;
}

test("派单是抢占的：第二个人领不到同一张单", () => {
  const root = sandbox();
  openDispatch(root);

  const first = capitalist.claimDispatch(root, "D-test1", "W-a");
  assert.ok(first, "第一个人应当领到");
  assert.equal(first.status, "claimed");
  assert.equal(first.worker, "W-a");

  const second = capitalist.claimDispatch(root, "D-test1", "W-b");
  assert.equal(second, null, "同一张单不能被两个人领");
});

test("已经了结的单不能再改", () => {
  const root = sandbox();
  openDispatch(root);
  capitalist.claimDispatch(root, "D-test1", "W-a");

  assert.ok(capitalist.finishDispatch(root, "D-test1", "done", "改完了"));
  assert.equal(capitalist.finishDispatch(root, "D-test1", "failed", "又失败了"), null);

  const rows = capitalist.readDispatches(root);
  assert.equal(rows[0].status, "done");
  assert.equal(rows[0].note, "改完了");
});

test("每个 worker 一条记录，心跳互不影响", () => {
  const root = sandbox();
  const now = new Date().toISOString();
  for (const id of ["W-a", "W-b"]) {
    capitalist.registerWorker(root, {
      id,
      host: "claude",
      pid: 1000 + id.charCodeAt(2),
      session: id,
      dispatch: `D-${id}`,
      stage: "S0",
      started_at: now,
      heartbeat_at: now,
      heartbeat_ts: Date.now() / 1000,
      status: "running",
      log: "",
    });
  }

  // 只给 W-a 续命，W-b 应被单独判死
  capitalist.touchWorker(root, "W-a");
  const b = capitalist.loadWorker(root, "W-b");
  assert.ok(b);
  capitalist.saveWorker(root, { ...b, heartbeat_ts: Date.now() / 1000 - 5000 });

  assert.equal(capitalist.isWorkerAlive(root, "W-a", 900), true);
  assert.equal(capitalist.isWorkerAlive(root, "W-b", 900), false, "心跳超时的 worker 不能被算作活着");
  assert.equal(capitalist.listWorkers(root).length, 2, "两条记录都在，不互相覆盖");
});

test("worker 进程已退出时判死，并回收它手上的单", () => {
  const root = sandbox();
  openDispatch(root);
  capitalist.claimDispatch(root, "D-test1", "W-dead");

  const now = new Date().toISOString();
  capitalist.registerWorker(root, {
    id: "W-dead",
    host: "claude",
    pid: 999999,
    session: "W-dead",
    dispatch: "D-test1",
    stage: "S0",
    started_at: now,
    heartbeat_at: now,
    heartbeat_ts: Date.now() / 1000,
    status: "running",
    log: "",
  });

  loop.__testing.reap(root, 900, () => {});
  assert.equal(capitalist.loadWorker(root, "W-dead").status, "exited");
  assert.equal(capitalist.readDispatches(root)[0].status, "failed");
});

test("tick 收割所有 claimed 僵尸，不只最后一张", () => {
  const root = sandbox();
  const now = new Date().toISOString();
  const rows = [
    { id: "D-a", shard: "a", worker: "W-dead" },
    { id: "D-b", shard: "b", worker: "W-live" },
    { id: "D-c", shard: "c", worker: "W-gone" },
  ];
  for (const r of rows) {
    capitalist.appendDispatch(root, { id: r.id, at: now, stage: "S0", shard: r.shard, action: "做", status: "claimed", worker: r.worker });
  }
  // a：进程已死；b：进程活着；c：worker 记录丢失。
  capitalist.registerWorker(root, {
    id: "W-dead", host: "claude", pid: 999999, session: "W-dead", dispatch: "D-a", stage: "S0",
    started_at: now, heartbeat_at: now, heartbeat_ts: Date.now() / 1000, status: "running", log: "",
  });
  capitalist.registerWorker(root, {
    id: "W-live", host: "claude", pid: process.pid, session: "W-live", dispatch: "D-b", stage: "S0",
    started_at: now, heartbeat_at: now, heartbeat_ts: Date.now() / 1000, status: "running", log: "",
  });

  loop.__testing.reap(root, 900, () => {});

  const byId = Object.fromEntries(capitalist.readDispatches(root).map((d) => [d.id, d.status]));
  assert.equal(byId["D-a"], "failed", "进程已死的 claimed 必须结单");
  assert.equal(byId["D-c"], "failed", "worker 记录丢失的 claimed 必须结单");
  assert.equal(byId["D-b"], "claimed", "活着的 worker 手上的单不能被误杀");
  assert.equal(capitalist.loadWorker(root, "W-dead").status, "exited");
});

test("契约没有 parallel 时并行度就是 1", () => {
  const root = sandbox();
  const contract = {
    name: "minimal",
    stages: [{ id: "S0", name: "澄清" }],
  };
  assert.equal(loop.__testing.stageParallel(contract, "S0").length, 0);
});

test("有 parallel 时按分片派多张单", () => {
  const contract = {
    name: "dev",
    stages: [
      {
        id: "S1",
        name: "实现",
        next: "整段推进",
        parallel: [
          { id: "api", action: "改接口" },
          { id: "ui", action: "改界面" },
        ],
      },
    ],
  };
  const shards = loop.__testing.stageParallel(contract, "S1");
  assert.deepEqual(
    shards.map((s) => s.id),
    ["api", "ui"],
  );
});

test("worker prompt 只给这一单的边界，并禁止代监工推进", () => {
  const prompt = buildPrompt({
    root: "/tmp/x",
    target: "重构计费服务",
    id: "W-1",
    dispatch: { id: "D-1", at: "", stage: "S0", action: "改重试", status: "open" },
  });
  assert.match(prompt, /独立的工作进程/);
  assert.match(prompt, /capitalist report D-1/, "报告命令要用派单 id，不是进程 id");
  assert.match(prompt, /不要执行 capitalist advance/);
  assert.match(prompt, /动手前先核对现状/);
  assert.match(prompt, /现状与派单描述冲突/);
  assert.match(prompt, /改完要生效/);
  assert.match(prompt, /已重启生效/);
  assert.match(prompt, /怎么算做完/);
  assert.match(prompt, /全量测试、端到端长跑、构建全量校验/);
  assert.match(prompt, /不要求截图/);
});

test("续跑提示词同样带上下文约束与生效要求", () => {
  const { buildResumePrompt } = require("../dist/supervisor/worker/worker");
  const p = buildResumePrompt({
    root: "/tmp/x",
    target: "重构计费服务",
    dispatch: { id: "D-1", at: "", stage: "S0", action: "改重试", status: "open" },
  });
  assert.match(p, /动手前先核对现状/);
  assert.match(p, /改完要生效/);
  assert.match(p, /改重试/);
  assert.match(p, /自成一体/);
  assert.match(p, /怎么算做完/);
});

test("capitalist supervise 自己建根，并拉起 pid 不同的独立进程", async () => {
  const base = mkdtempSync(join(tmpdir(), "capitalist-sv-run-"));
  const fakeLog = join(base, "fake.log");
  const fake = join(base, "fake-worker.js");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(fakeLog)}, "[spawn] " + process.argv.slice(2).join(" ") + "\\n");
let stdin = "";
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(fakeLog)}, "[stdin] " + stdin + "\\n");
});
`,
  );
  chmodSync(fake, 0o755);

  const cli = join(__dirname, "..", "dist", "cli", "main.js");
  /*
   * 在 worker 进程里跑测试时，环境里带着 CAPITALIST_WORKER_ID / CAPITALIST_DISPATCH_ID。子进程继承
   * 这些值会被命令层判成“工作进程不能执行 supervise”而直接拒掉，测试测的是监工本身，
   * 必须先把调用者的 worker 身份剥干净。
   */
  const env = { ...process.env, CAPITALIST_WORKER_BIN: fake };
  delete env.CAPITALIST_WORKER_ID;
  delete env.CAPITALIST_DISPATCH_ID;
  delete env.CAPITALIST_STAGE;
  /*
   * 用异步 spawn + 主动等待，不用 spawnSync：Windows 上同步子进程会连带收掉它拉起的
   * 后代，`--once` 又只跑一拍就退，假 worker 常常还没执行就被一起带走。异步拉起后
   * 等它落盘再收尾，测的仍是“监工自己建根并拉出独立进程”。
   */
  const child = spawn(
    process.execPath,
    [cli, "supervise", "重构计费服务", "--contract", "minimal", "--max-ticks", "3", "--auto-dispatch"],
    { cwd: base, env, stdio: "ignore" },
  );
  const settled = new Promise((resolve) => child.once("exit", resolve));

  const rootDeadline = Date.now() + 10_000;
  while (!existsSync(join(base, ".capitalist", "state.json")) && Date.now() < rootDeadline) await sleep(50);
  assert.ok(existsSync(join(base, ".capitalist", "state.json")), "监工应当自己建任务根");

  /* 建根与服务启动之间隔着一拍调度：等 worker 记录出现再断言，避免抢跑。 */
  const bootDeadline = Date.now() + 10_000;
  while (
    (capitalist.listWorkers(base).length === 0 || capitalist.readDispatches(base).length === 0) &&
    Date.now() < bootDeadline
  ) await sleep(50);

  const workers = capitalist.listWorkers(base);
  assert.equal(
    workers.length,
    1,
    `应当拉起一个 worker（文件：${existsSync(join(base, ".capitalist", "workers", "index.jsonl")) ? "index 在" : "index 不在"} base=${base}）`,
  );
  assert.ok(workers[0].pid > 0, "worker 必须有独立 pid");
  assert.notEqual(workers[0].pid, process.pid, "worker 不能是本进程");
  assert.ok(existsSync(workers[0].log), "worker 输出应落到自己的日志");

  const dispatches = capitalist.readDispatches(base);
  assert.equal(dispatches.length, 1);
  /*
   * 假 worker 写完就退出，监工还活着时会立刻把它判成 failed，这正说明它真的被拉起过。
   * 这里验的是绑定关系：派单上有 worker 与 claimed_at，且指向刚建的那条进程记录。
   */
  assert.equal(dispatches[0].worker, workers[0].id, "派单应绑定到刚拉起的 worker");
  assert.ok(String(dispatches[0].claimed_at ?? "").trim() !== "", "派单应记录认领时间");

  const deadline = Date.now() + 10_000;
  while (!existsSync(fakeLog) && Date.now() < deadline) await sleep(50);
  assert.ok(existsSync(fakeLog), "worker 应当真的被执行");
  try { child.kill(); } catch { /* 已经退出 */ }
  await settled;

  const args = readFileSync(fakeLog, "utf8");
  assert.match(args, /\[spawn\] .*-p /, "应当以非交互方式启动宿主");
  /*
   * 提示词若在 stdin 落盘，必须带派单号；`--once` 退出太快没落盘也不算失败，
   * 拉起这件事由上面那条断言证明，提示词内容另有 blocker-note / wake 测试覆盖。
   */
  if (args.includes("[stdin] ") && args.split("[stdin] ")[1].trim()) {
    assert.match(args, /D-/, "prompt 里应带上派单号");
  }
});

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("宿主探测：没有可用 CLI 的机器直接报错，不假装拉起", () => {
  const saved = process.env.CAPITALIST_WORKER_BIN;
  delete process.env.CAPITALIST_WORKER_BIN;
  const host = detectWorkerHost();
  if (saved) process.env.CAPITALIST_WORKER_BIN = saved;

  // 探测结果必须是某个“参与自动探测”的 impl 的 worker key；都没有时是 null，
  // 而不是编一个出来。名单从注册表推导，不在测试里抄一份。
  const registry = require("../dist/agent/registry");
  const auto = registry
    .workerHosts()
    .filter((impl) => impl.worker.detectPriority !== undefined)
    .map((impl) => impl.worker.key);
  assert.ok(host === null || auto.includes(host), `探测到了未声明可自动探测的宿主：${host}`);
});

test("状态文件仍可被两边读：监工停止不改任务数据", () => {
  const root = sandbox();
  const before = loadState(root);
  capitalist.requestSupervisorStop(root);
  const after = loadState(root);
  assert.equal(after.stage, before.stage);
  assert.equal(after.target, before.target);
});

test("停止走哨兵文件，不会被心跳写回 running", () => {
  const root = sandbox();
  capitalist.saveSupervisor(root, runningRecord());

  capitalist.requestSupervisorStop(root);
  assert.equal(capitalist.stopRequested(root), true);

  // 另一个监工（或同一监工的下一 tick）写心跳，不能把停止请求冲掉
  capitalist.saveSupervisor(root, { ...runningRecord(), status: "running" });
  assert.equal(capitalist.stopRequested(root), true, "心跳不得覆盖停止请求");

  capitalist.clearStopFlag(root);
  assert.equal(capitalist.stopRequested(root), false);
});

test("已有监工运行中时，第二个拒绝启动", async () => {
  const root = sandbox();
  capitalist.saveSupervisor(root, runningRecord());

  const code = await loop.runSupervisor({
    root,
    tickSec: 1,
    once: true,
    workerHost: "claude",
    out: () => {},
  });
  assert.equal(code, 1, "同根第二个监工必须被拒绝");
});

function failedDispatch(root, id, shard, minutesAgo) {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  capitalist.appendDispatch(root, {
    id,
    at,
    stage: "S0",
    shard,
    action: "改 A",
    status: "failed",
    done_at: at,
  });
}

const SHARD_CONTRACT = {
  name: "minimal",
  data: {},
  stages: [
    { id: "S0", name: "澄清", next: "做点事", parallel: [{ id: "a", action: "改 A" }] },
  ],
};

test("刚失败的单按退避等待，不会每 tick 刷进程", () => {
  const root = sandbox();
  failedDispatch(root, "D-now", "a", 0);

  const verdict = loop.__testing.step(root, SHARD_CONTRACT, "claude", 0, {}, () => {});
  assert.equal(verdict, "continue");
  assert.equal(capitalist.readDispatches(root).filter((d) => d.status === "open").length, 0);
});

test("失败的单在退避后重派，分片不会永久缺失", () => {
  const root = sandbox();
  failedDispatch(root, "D-old", "a", 5);

  loop.__testing.step(root, SHARD_CONTRACT, "claude", 0, {}, () => {});

  const open = capitalist.readDispatches(root).filter((d) => d.status === "open");
  assert.equal(open.length, 1, "退避到期后必须重新派这一片");
  assert.equal(open[0].shard, "a");
  assert.equal(open[0].attempt, 2, "重派要记第几次，供事后追溯");
  assert.equal(loadState(root).stage, "S0", "不能因为一次失败就推进或退出");
});

test("已报完成等确认（review）的片不再派新单", () => {
  const root = sandbox();
  capitalist.appendDispatch(root, {
    id: "D-rev",
    at: new Date().toISOString(),
    stage: "S0",
    shard: "a",
    action: "改 A",
    status: "review",
    attempt: 1,
    review_until: new Date(Date.now() + 180_000).toISOString(),
  });

  loop.__testing.step(root, SHARD_CONTRACT, "claude", 0, {}, () => {});

  const open = capitalist.readDispatches(root).filter((d) => d.status === "open");
  assert.equal(open.length, 0, "review 是在途：确认前再派一张等于把同一件事做两遍");
});

test("复验单的正文不被契约刷新覆盖（否则复验退化成重做）", () => {
  const root = sandbox();
  const action = "复验（不是重做）：S0/a 改 A\n原要求：改 A";
  capitalist.appendDispatch(root, {
    id: "D-ver",
    at: new Date().toISOString(),
    stage: "S0",
    shard: "a",
    action,
    status: "open",
    attempt: 1,
    source: "reverify",
  });

  loop.__testing.step(root, SHARD_CONTRACT, "claude", 0, {}, () => {});

  const d = capitalist.readDispatches(root).find((x) => x.id === "D-ver");
  assert.equal(d.action, action, "复验单带着自己的核对口径，不该被换成裸分片文字");
});

/**
 * 一个确实还活着的 pid。
 *
 * 判活已经改成“心跳新鲜 + pid 仍在”：编一个不存在的号（早期写的 process.pid + 1000）
 * 现在会被正确判成“已停”，单实例用例就测不到东西了。这里真起一个哑进程，让它活到
 * 测试进程退出。
 */
let livePidCache = 0;
function livePid() {
  if (!livePidCache) {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    livePidCache = child.pid;
    process.on("exit", () => {
      try {
        process.kill(livePidCache);
      } catch {
        /* 已经退了 */
      }
    });
  }
  return livePidCache;
}

function runningRecord() {
  const now = new Date().toISOString();
  return {
    pid: livePid(),
    status: "running",
    started_at: now,
    heartbeat_at: now,
    heartbeat_ts: Date.now() / 1000,
    target: "重构计费服务",
    contract: "minimal",
    tick_sec: 5,
    worker_timeout_sec: 900,
    ticks: 2,
    max_workers: 1,
    worker_host: "claude",
  };
}


test("立即执行：一个 tick 内腾槽拉起，运行中的单挂起并标已让位", () => {
  const { chmodSync, writeFileSync: write } = require("node:fs");
  const preempt = require("../dist/core/dispatch/preempt");
  const boardMod = require("../dist/supervisor/board");

  const base = mkdtempSync(join(tmpdir(), "capitalist-preempt-"));
  createTaskRoot({ target: "立即执行", contractSpec: "minimal", root: base });

  /* 假 worker：不读命令、只保持存活，等测试结束时被结束。 */
  const fake = join(base, "fake-worker.js");
  write(fake, "#!/usr/bin/env node\nprocess.stdin.resume();\nsetTimeout(() => {}, 60000);\n");
  chmodSync(fake, 0o755);

  /* 一个真的活着的进程，扮演“正运行中的那一单”。 */
  const victim = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  victim.unref();
  const kill = (pid) => {
    try {
      process.kill(pid);
    } catch {
      /* 已经退出 */
    }
  };

  try {
    const at = new Date().toISOString();
    const common = { at, stage: "S0", action: "做点事", attempt: 1 };
    capitalist.appendDispatch(base, { id: "D-run", ...common, shard: "a", status: "claimed", worker: "W-run" });
    capitalist.appendDispatch(base, { id: "D-2", ...common, shard: "b", status: "open" });
    capitalist.appendDispatch(base, { id: "D-3", ...common, shard: "c", status: "open" });
    capitalist.appendDispatch(base, {
      id: "D-imm",
      ...common,
      shard: "",
      status: "open",
      promoted_at: at,
      promoted_by: "user",
    });

    capitalist.registerWorker(base, {
      id: "W-run",
      host: "claude",
      pid: victim.pid,
      session: "W-run",
      dispatch: "D-run",
      shard: "a",
      stage: "S0",
      started_at: at,
      heartbeat_at: at,
      heartbeat_ts: Date.now() / 1000,
      status: "running",
      log: join(base, ".capitalist", "workers", "W-run.log"),
    });

    /* 车道记录：先按正常派单算一次，记下它将来该续接的会话 id。 */
    const sessBefore = resolveSession(base, capitalist.readDispatches(base).find((d) => d.id === "D-run"));

    const contract = { name: "minimal", data: {}, stages: [{ id: "S0", name: "澄清" }] };
    const saved = process.env.CAPITALIST_WORKER_BIN;
    process.env.CAPITALIST_WORKER_BIN = fake;
    const out = [];
    try {
      loop.__testing.fillSlots(base, contract, loadState(base), "claude", 1, {}, (s) => out.push(s));
    } finally {
      if (saved === undefined) delete process.env.CAPITALIST_WORKER_BIN;
      else process.env.CAPITALIST_WORKER_BIN = saved;
    }

    const rows = capitalist.readDispatches(base);
    assert.strictEqual(
      rows.find((d) => d.id === "D-imm").status,
      "claimed",
      `立即执行单要在一个 tick 内被领走\n${out.join("\n")}`,
    );

    const run = rows.find((d) => d.id === "D-run");
    assert.strictEqual(run.status, "open", "运行中的单退回排队，不能停在 claimed");
    assert.ok(run.yielded_at, "让位要留痕，界面才能标“已让位”");
    assert.strictEqual(run.yielded_by, "D-imm");

    const victimRec = capitalist.loadWorker(base, "W-run");
    assert.strictEqual(victimRec.status, "suspended", "让位不是失败：worker 记 suspended");

    for (const id of ["D-2", "D-3"]) {
      const d = rows.find((x) => x.id === id);
      assert.strictEqual(d.status, "open");
      assert.ok(d.yielded_at, `${id} 也要标已让位（它被这一单越过去了）`);
    }

    /* 计数：运行中只有立即执行那一个，其余算排队，挂起的进程不能继续算作运行中。 */
    const counts = boardMod.buildThreadsPage(base, 500).counts;
    assert.strictEqual(counts.running, 1, `运行中应为 1：${JSON.stringify(counts)}`);
    assert.strictEqual(counts.queued, 3, `排队应为 3：${JSON.stringify(counts)}`);
    assert.strictEqual(counts.failed, 0, `让位不是失败：${JSON.stringify(counts)}`);

    const lease = preempt.readPreemptLease(base);
    assert.ok(lease, "租约要落盘（重启后靠它恢复）");
    assert.strictEqual(lease.dispatch, "D-imm");
    assert.deepStrictEqual(lease.yielded, ["D-run", "D-2", "D-3"], "让位名单就是让位前的顺序");

    /* 同一时刻只允许一个立即执行：第二张 promoted 单不抢槽。 */
    capitalist.appendDispatch(base, {
      id: "D-imm2",
      ...common,
      shard: "",
      status: "open",
      promoted_at: new Date().toISOString(),
    });
    loop.__testing.fillSlots(base, contract, loadState(base), "claude", 1, {}, () => {});
    assert.strictEqual(
      capitalist.readDispatches(base).find((d) => d.id === "D-imm2").status,
      "open",
      "已经有立即执行运行中时，第二张按普通置顶排队",
    );

    /* 结束立即执行单，再恢复。 */
    const imm = capitalist.readDispatches(base).find((d) => d.id === "D-imm");
    const immWorker = capitalist.loadWorker(base, imm.worker);
    kill(immWorker.pid);
    capitalist.finishDispatch(base, "D-imm", "done", "做完了");
    capitalist.saveWorker(base, { ...immWorker, status: "exited" });
    loop.__testing.releasePreemptLease(base, () => {});

    const after = capitalist.readDispatches(base);
    for (const id of ["D-run", "D-2", "D-3"]) {
      const d = after.find((x) => x.id === id);
      assert.strictEqual(d.status, "open");
      assert.strictEqual(d.yielded_at, undefined, `${id} 恢复后不该还挂着让位标记`);
    }
    assert.strictEqual(preempt.readPreemptLease(base), null, "租约要收掉");
    assert.deepStrictEqual(
      capitalist
        .openQueue(base)
        .map((d) => d.id)
        .filter((id) => id !== "D-imm2"),
      ["D-run", "D-2", "D-3"],
      "按原顺序恢复",
    );

    /* 恢复不等于重派：同一张单、同一条会话，下一次拉起是 --resume。 */
    const sessAfter = resolveSession(base, capitalist.readDispatches(base).find((d) => d.id === "D-run"));
    assert.strictEqual(sessAfter.id, sessBefore.id, "恢复要接回同一条会话");
    assert.strictEqual(sessAfter.resume, true, "恢复不是从零开始");
  } finally {
    for (const w of capitalist.listWorkers(base)) if (w.pid > 0) kill(w.pid);
    kill(victim.pid);
  }
});
