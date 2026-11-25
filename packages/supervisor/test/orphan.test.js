/**
 * 父进程被强制结束后的回收：worker 自保、监工启动时回收孤儿进程、统一退出清理表。
 *
 * 这一组验证监工不在场时的行为，因此需要真实启动进程：
 *   - 自保：hook 连续两次检测不到监工即写日志并退出，且只结束记录中的 worker pid；
 *   - 回收孤儿进程：监工启动时按 pid 与命令行（或父进程）认定归属后才清理，无法确认则不清理；
 *   - 清理表：登记的资源按逆序清理一次，重复清理不产生副作用。
 *
 * 全部用 `node -e` 启动的占位进程作为 worker，验证的是进程编排，不是模型行为。
 */

const test = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const capitalist = require("../dist/core/record/supervisor");
const { createTaskRoot } = require("../dist/core/policy/init");
const { reapOrphans, describePid } = require("../dist/supervisor/worker/reapOrphans");
const { registerDisposer, disposeAll, __resetDisposers } = require("../dist/supervisor/dispose");
const { launchWorker } = require("../dist/supervisor/worker/worker");

const HOOK = resolve(__dirname, "..", "dist", "agent", "main.js");

/** 启动一个不会自行退出的 node 进程；args 写入其命令行。 */
function dummy(args = []) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)", ...args], {
    stdio: "ignore",
    windowsHide: true,
  });
  return child;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 等待指定 pid 退出，最长 timeoutMs。 */
function waitGone(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return !alive(pid);
}

/** 获取一个已结束的进程号，用于模拟被强制结束的监工。 */
function deadPid() {
  const r = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  return r.pid;
}

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-orphan-"));
  createTaskRoot({ target: "强杀监工后不留孤儿", policySpec: "minimal", root: base });
  return base;
}

function putWorker(root, rec) {
  mkdirSync(join(root, ".capitalist", "workers"), { recursive: true });
  mkdirSync(join(root, ".capitalist", "runtime"), { recursive: true });
  mkdirSync(join(root, ".capitalist", "ledger"), { recursive: true });
  mkdirSync(join(root, ".capitalist", ".root"), { recursive: true });
  const full = {
    host: "custom",
    session: rec.id,
    dispatch: "D-1",
    shard: "",
    stage: "S0",
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    heartbeat_ts: Date.now() / 1000,
    log: join(root, ".capitalist", "workers", rec.id, "output.log"),
    mode: "background",
    ...rec,
  };
  // 须经 registerWorker 登记：listWorkers 从 index.jsonl 读取，仅写入 json 文件不视为登记。
  capitalist.registerWorker(root, full);
  return full;
}

function runHook(env, event = "PreToolUse") {
  return spawnSync(process.execPath, [HOOK, event, "--agent", "generic"], {
    input: "{}",
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 20000,
  });
}

test("worker 自保：连续两次检测不到监工才退出，并留下日志说明", () => {
  const root = sandbox();
  const worker = dummy();
  const gone = deadPid();
  putWorker(root, { id: "W-guard", pid: worker.pid, status: "running" });

  const env = {
    CAPITALIST_ROOT: root,
    CAPITALIST_WORKER_ID: "W-guard",
    CAPITALIST_SUPERVISOR_PID: String(gone),
  };

  try {
    const first = runHook(env);
    assert.equal(first.status, 0, `第一次检测不到只记账，不应拦会话\n${first.stderr}`);
    assert.ok(alive(worker.pid), "第一次不应结束 worker");
    const guard = join(root, ".capitalist", "workers", "W-guard", "guard.json");
    assert.equal(JSON.parse(readFileSync(guard, "utf8")).misses, 1, "漏检次数应落盘");

    const second = runHook(env);
    assert.equal(second.status, 1, "连续两次检测不到应退出 1");
    assert.ok(waitGone(worker.pid), "worker 进程应被结束");
    const log = readFileSync(join(root, ".capitalist", "workers", "W-guard", "output.log"), "utf8");
    assert.match(log, /capitalist-guard/);
    assert.match(log, /连续 2 次检测不到/);
  } finally {
    if (alive(worker.pid)) process.kill(worker.pid);
  }
});

test("worker 自保：监工仍在运行时不检查文件，也不结束进程", () => {
  const root = sandbox();
  const worker = dummy();
  // 用本进程 pid 模拟监工：该进程仍在运行。
  putWorker(root, { id: "W-alive", pid: worker.pid, status: "running" });
  try {
    for (let i = 0; i < 3; i += 1) {
      const r = runHook({
        CAPITALIST_ROOT: root,
        CAPITALIST_WORKER_ID: "W-alive",
        CAPITALIST_SUPERVISOR_PID: String(process.pid),
      });
      assert.equal(r.status, 0);
    }
    assert.ok(alive(worker.pid), "监工活着时不得结束 worker");
    assert.equal(
      existsSync(join(root, ".capitalist", "workers", "W-alive", "guard.json")),
      false,
      "监工活着时不应留下记账文件",
    );
  } finally {
    if (alive(worker.pid)) process.kill(worker.pid);
  }
});

test("启动时回收孤儿进程：命令行含任务根的遗留 worker 会被清理并记录 worker_reaped", () => {
  const root = sandbox();
  const worker = dummy([root]);
  putWorker(root, { id: "W-orphan", pid: worker.pid, status: "running", supervisor_pid: deadPid() });

  const ident = describePid(worker.pid);
  assert.ok(ident, "应当能查到测试进程的身份");
  assert.ok(ident.cmdline.includes(root), `命令行应带任务根：${ident.cmdline}`);

  try {
    const lines = [];
    const reaped = reapOrphans(root, (s) => lines.push(s));
    assert.equal(reaped.length, 1, `应收掉一个孤儿\n${lines.join("\n")}`);
    assert.equal(reaped[0].via, "cmdline");
    assert.ok(waitGone(worker.pid), "孤儿进程应被结束");

    const events = readFileSync(join(root, ".capitalist", "ledger", "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === "worker_reaped");
    assert.equal(events.length, 1, "应留一条 worker_reaped 事件");
    assert.equal(events[0].pid, worker.pid);
    assert.equal(events[0].worker, "W-orphan");
    assert.match(events[0].reason, /任务根/);

    assert.equal(capitalist.loadWorker(root, "W-orphan").status, "exited", "记录应落终态");
  } finally {
    if (alive(worker.pid)) process.kill(worker.pid);
  }
});

test("启动时回收孤儿进程：命令行与父进程均不匹配时不执行清理（避免 pid 复用导致误清理）", () => {
  const root = sandbox();
  // 命令行里没有任务根，父进程也不是记录里的监工 pid。
  const worker = dummy(["foreign-marker"]);
  putWorker(root, { id: "W-foreign", pid: worker.pid, status: "running", supervisor_pid: 1 });
  try {
    const lines = [];
    const reaped = reapOrphans(root, (s) => lines.push(s));
    assert.equal(reaped.length, 0, "查不清归属就不该结束进程");
    assert.ok(alive(worker.pid), "无关进程必须还活着");
    assert.match(lines.join("\n"), /跳过/);
  } finally {
    if (alive(worker.pid)) process.kill(worker.pid);
  }
});

test("退出清理表：按逆序清理一次，重复清理不产生副作用", () => {
  __resetDisposers();
  const order = [];
  registerDisposer("board", () => order.push("board"));
  registerDisposer("workers", () => order.push("workers"));

  assert.deepEqual(disposeAll("shutdown"), []);
  assert.deepEqual(order, ["workers", "board"], "后登记的先清理");
  assert.deepEqual(disposeAll("beforeExit"), [], "第二次调用是空操作");
  assert.deepEqual(order, ["workers", "board"], "不得重复执行");
  __resetDisposers();
});

test("被强制结束的监工不视为在线：心跳未过期，但 pid 已不存在", () => {
  const root = sandbox();
  const now = new Date().toISOString();
  capitalist.saveSupervisor(root, {
    pid: deadPid(),
    status: "running",
    started_at: now,
    heartbeat_at: now,
    heartbeat_ts: Date.now() / 1000,
    target: "强杀监工后不留孤儿",
    policy: "minimal",
    tick_sec: 5,
    worker_timeout_sec: 900,
    ticks: 3,
    max_workers: 1,
    worker_host: "custom",
  });

  // 只按心跳判定存活时会返回 true，“下次启动时回收孤儿进程”被“已有监工运行中”阻止，用户只能等待存活判定窗口结束或使用 --force，这与“不要求用户手动清理”的约定相悖。
  assert.equal(capitalist.isSupervisorAlive(root), false, "进程不在了就不能算在线");
});

test("启动 worker 时注入监工 pid：记录与子进程环境均包含", async () => {
  const root = sandbox();
  const outFile = join(root, "env.txt");
  const fake = join(root, "fake-worker.js");
  writeFileSync(
    fake,
    `require("fs").writeFileSync(${JSON.stringify(outFile)}, String(process.env.CAPITALIST_SUPERVISOR_PID));\n`,
  );

  const saved = process.env.CAPITALIST_WORKER_BIN;
  process.env.CAPITALIST_WORKER_BIN = fake;
  try {
    const launched = launchWorker({
      root,
      target: "强杀监工后不留孤儿",
      host: "custom",
      dispatch: { id: "D-env", at: new Date().toISOString(), stage: "S0", action: "验注入", status: "open" },
    });
    assert.equal(launched.record.supervisor_pid, process.pid, "记录里应写下监工 pid");

    const deadline = Date.now() + 15000;
    while (!existsSync(outFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(readFileSync(outFile, "utf8"), String(process.pid), "子进程环境里应有 CAPITALIST_SUPERVISOR_PID");
  } finally {
    if (saved === undefined) delete process.env.CAPITALIST_WORKER_BIN;
    else process.env.CAPITALIST_WORKER_BIN = saved;
  }
});
