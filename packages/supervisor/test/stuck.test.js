
const test = require("node:test");
const assert = require("node:assert");
const { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/record/supervisor");
const { createTaskRoot } = require("../dist/core/contract/init");
const { listDirectives } = require("../dist/core/dispatch/commands");
const stuckMod = require("../dist/supervisor/worker/stuck");
const loop = require("../dist/supervisor/loop");

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-stuck-"));
  createTaskRoot({ target: "卡点判定", contractSpec: "minimal", root: base });
  return base;
}

function openClaimed(root, id = "D-stuck1") {
  capitalist.appendDispatch(root, {
    id,
    at: new Date().toISOString(),
    stage: "S0",
    action: "把重试改成指数退避",
    status: "open",
  });
  capitalist.claimDispatch(root, id, "W-stuck");
  return capitalist.readDispatches(root).find((d) => d.id === id);
}

/** 造一条运行中 worker 记录；日志内容与 mtime 都由调用方决定。 */
function workerWithLog(root, lines, ageSec) {
  const dir = join(root, ".capitalist", "workers");
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "W-stuck.log");
  writeFileSync(log, lines.join("\n") + "\n");
  const t = new Date(Date.now() - ageSec * 1000);
  utimesSync(log, t, t);
  const now = new Date().toISOString();
  const rec = {
    id: "W-stuck",
    host: "claude",
    pid: process.pid,
    session: "W-stuck",
    dispatch: "D-stuck1",
    shard: "",
    stage: "S0",
    started_at: now,
    heartbeat_at: now,
    heartbeat_ts: Date.now() / 1000 - ageSec - 1000,
    status: "running",
    log,
    mode: "background",
  };
  capitalist.registerWorker(root, rec);
  return capitalist.loadWorker(root, "W-stuck");
}


test("判活：心跳过期但日志仍在写，算存活", () => {
  const root = sandbox();
  const rec = workerWithLog(root, ["正在执行 npm test", "测试通过 12 项"], 5);
  const live = capitalist.workerLivenessOf(rec, { heartbeatSec: 900, logStallSec: 300, nowMs: Date.now() });
  assert.equal(live.alive, true);
  assert.equal(live.via, "log");
});

test("判活：心跳仍在续写、日志长时间没有新增，也算存活", () => {
  const root = sandbox();
  const rec = workerWithLog(root, ["[launch] 已启动"], 1200);
  rec.heartbeat_ts = Date.now() / 1000 - 10;
  capitalist.saveWorker(root, rec);
  const live = capitalist.workerLivenessOf(rec, { heartbeatSec: 900, logStallSec: 300, nowMs: Date.now() });
  assert.equal(live.alive, true);
  assert.equal(live.via, "heartbeat");
});

test("判活：心跳与日志都超过窗口，判为不存活", () => {
  const root = sandbox();
  const rec = workerWithLog(root, ["[launch] 已启动"], 1200);
  const live = capitalist.workerLivenessOf(rec, { heartbeatSec: 900, logStallSec: 300, nowMs: Date.now() });
  assert.equal(live.alive, false);
  assert.equal(live.via, "none");
});


test("分类：日志没有新增且没有明确线索 -> 空转等待", () => {
  const ev = stuckMod.classifyStuck(["开始处理这一单", "读取了 src/index.ts"]);
  assert.equal(ev.kind, "idle");
  assert.match(ev.why, /没有新增/);
});

test("分类：登录/验证码/配额提示 -> 等外部条件", () => {
  const ev = stuckMod.classifyStuck([
    "执行 npm login",
    "等待用户完成登录授权",
    "验证码已发送，请输入验证码",
  ]);
  assert.equal(ev.kind, "external");
  assert.match(ev.why, /登录|验证码|授权/);
});

test("分类：同一段报错反复出现 -> 报错循环", () => {
  const line = "TypeError: Cannot read properties of undefined (reading 'billing')";
  const ev = stuckMod.classifyStuck([line, line, line, line, "执行 node scripts/check.js"]);
  assert.equal(ev.kind, "error_loop");
  assert.match(ev.why, /重复/);
});

test("分类：同一句命令反复刷且不是报错 -> 重复无效重试", () => {
  const line = "执行 pytest tests/test_billing.py -q，结果没有任何变化";
  const ev = stuckMod.classifyStuck([line, line, line, "读取 tests/test_billing.py"]);
  assert.equal(ev.kind, "retry");
});

test("四类各有不同的跳出办法，且都给出可执行动作", () => {
  const kinds = ["idle", "retry", "external", "error_loop"];
  const seen = new Set();
  for (const kind of kinds) {
    const text = stuckMod.stuckGuidance(
      { kind, label: stuckMod.STUCK_LABEL[kind], why: "判据" },
      600,
    );
    assert.match(text, /跳出办法/);
    assert.match(text, /capitalist (block|notify)/);
    seen.add(text);
  }
  assert.equal(seen.size, 4, "四类不能给同一句话");
});

test("原地打转：日志持续增长也会判卡点，并在本轮写入指导；领取后留下送达记录", async () => {
  const root = sandbox();
  openClaimed(root);
  const line = "执行 pytest tests/test_billing.py -q，结果没有任何变化";
  const rec = workerWithLog(root, Array.from({ length: 130 }, () => line), 1);
  /* 心跳也保持新鲜：这一类卡点的特征正是“两个信号都正常，但只在重复同一件事”。 */
  rec.heartbeat_ts = Date.now() / 1000;
  capitalist.saveWorker(root, rec);

  const act = await loop.handleStuckWorker(root, capitalist.loadWorker(root, "W-stuck"), {
    heartbeatSec: 900,
    stuckSec: 300,
    nowSec: Date.now() / 1000,
    out: () => {},
  });
  assert.equal(act, "kept");
  let after = capitalist.loadWorker(root, "W-stuck");
  assert.equal(after.stuck.kind, "retry");
  assert.equal(after.stuck.channel, "hook");
  assert.equal(listDirectives(root).length, 1);

  /* 模拟 hook 在下一个工具调用前领走这条指导。 */
  const taken = require("../dist/core/dispatch/commands").claimDirectives(root, {
    dispatchId: "D-stuck1",
    shard: "",
    stage: "S0",
    lineage: "D-stuck1",
    workerId: "W-stuck",
    via: "hook",
  });
  assert.equal(taken.length, 1, "指导应当能被这一单领走");

  await loop.handleStuckWorker(root, capitalist.loadWorker(root, "W-stuck"), {
    heartbeatSec: 900,
    stuckSec: 300,
    nowSec: Date.now() / 1000 + 1,
    out: () => {},
  });
  after = capitalist.loadWorker(root, "W-stuck");
  assert.equal(after.stuck.delivered, true);
  assert.equal(after.stuck.channel, "consumed");
  const { readJsonl } = require("../dist/core/record/json");
  const { eventsPath } = require("../dist/core/record/ledger");
  const events = readJsonl(eventsPath(root));
  assert.ok(
    events.some((e) => e.event === "stuck_guidance_delivered"),
    "送达要有台账记录",
  );
});


test("任务卡：日志仍在写时标为存活，不因心跳过期显示无响应", () => {
  const root = sandbox();
  openClaimed(root);
  workerWithLog(root, ["读取 src/index.ts", "执行 npm test"], 5);
  const { buildThreadsPage } = require("../dist/supervisor/board");
  const page = buildThreadsPage(root, 100);
  const t = page.threads.find((x) => x.dispatch === "D-stuck1");
  assert.ok(t, "应当有一条线程");
  assert.equal(t.status, "running");
  assert.equal(t.alive, true);
  assert.ok(t.log_idle_sec >= 0 && t.log_idle_sec < 300);
});

test("任务卡：心跳与日志都过期时标为无响应", () => {
  const root = sandbox();
  openClaimed(root);
  workerWithLog(root, ["读取 src/index.ts"], 1200);
  const { buildThreadsPage } = require("../dist/supervisor/board");
  const page = buildThreadsPage(root, 100);
  const t = page.threads.find((x) => x.dispatch === "D-stuck1");
  assert.ok(t);
  assert.equal(t.alive, false);
});


test("卡点：当轮写入送达通道，两次无效后判卡死并写明卡点与已试手段", async () => {
  const root = sandbox();
  openClaimed(root);
  workerWithLog(root, ["读取 src/index.ts", "执行 npm test"], 600);
  const noop = () => {};

  const t0 = Date.now();
  const first = await loop.handleStuckWorker(root, capitalist.loadWorker(root, "W-stuck"), {
    heartbeatSec: 900,
    stuckSec: 300,
    nowSec: t0 / 1000,
    out: noop,
  });
  assert.equal(first, "kept");

  let rec = capitalist.loadWorker(root, "W-stuck");
  assert.equal(rec.stuck.kind, "idle");
  assert.equal(rec.stuck.attempts, 1);
  assert.equal(rec.stuck.channel, "hook", "指导应当写进 direct.jsonl 等待领取");
  assert.equal(rec.stuck.delivered, false, "写入不等于送达");
  const directs = listDirectives(root);
  assert.equal(directs.length, 1);
  assert.equal(directs[0].target, "D-stuck1");
  assert.match(directs[0].text, /【监工干预 · 空转等待 · 第 1 次】/);

  const t1 = t0 + 301_000;
  const second = await loop.handleStuckWorker(root, capitalist.loadWorker(root, "W-stuck"), {
    heartbeatSec: 900,
    stuckSec: 300,
    nowSec: t1 / 1000,
    out: noop,
  });
  assert.equal(second, "kept");
  rec = capitalist.loadWorker(root, "W-stuck");
  assert.equal(rec.stuck.attempts, 2);
  assert.equal(listDirectives(root).length, 2);

  const t2 = t1 + 301_000;
  const third = await loop.handleStuckWorker(root, capitalist.loadWorker(root, "W-stuck"), {
    heartbeatSec: 900,
    stuckSec: 300,
    nowSec: t2 / 1000,
    out: noop,
  });
  assert.equal(third, "killed", "同类指导两次无效后应判卡死");

  rec = capitalist.loadWorker(root, "W-stuck");
  assert.equal(rec.status, "failed");
  const d = capitalist.readDispatches(root).find((x) => x.id === "D-stuck1");
  assert.equal(d.status, "failed");
  assert.match(d.note, /卡死（空转等待）/);
  assert.match(d.note, /同类指导 2 次均未生效/);
  assert.match(d.note, /已试手段/);
});

test("卡点解除：进程恢复输出后清掉标记，不再追加指导", async () => {
  const root = sandbox();
  openClaimed(root);
  const rec = workerWithLog(root, ["读取 src/index.ts"], 600);
  await loop.handleStuckWorker(root, rec, {
    heartbeatSec: 900,
    stuckSec: 300,
    nowSec: Date.now() / 1000,
    out: () => {},
  });
  assert.ok(capitalist.loadWorker(root, "W-stuck").stuck);

  /* 日志重新开始增长：mtime 回到当前，心跳也续上。 */
  const log = capitalist.loadWorker(root, "W-stuck").log;
  writeFileSync(log, "读取 src/index.ts\n执行 npm test\n测试通过\n");
  const fresh = capitalist.loadWorker(root, "W-stuck");
  fresh.heartbeat_ts = Date.now() / 1000;
  capitalist.saveWorker(root, fresh);

  const act = await loop.handleStuckWorker(root, capitalist.loadWorker(root, "W-stuck"), {
    heartbeatSec: 900,
    stuckSec: 300,
    nowSec: Date.now() / 1000,
    out: () => {},
  });
  assert.equal(act, "kept");
  assert.equal(capitalist.loadWorker(root, "W-stuck").stuck, undefined);
  assert.equal(listDirectives(root).length, 1, "恢复后不应再写第二条指导");
});


test("输出续心跳：每段输出后刷新心跳，状态从 starting 置为 running", async () => {
  const base = mkdtempSync(join(tmpdir(), "capitalist-stuck-out-"));
  createTaskRoot({ target: "输出续心跳", contractSpec: "minimal", root: base });
  const script = join(base, "fake-out.js");
  writeFileSync(
    script,
    [
      "const lines = ['第一条输出', '第二条输出', '第三条输出'];",
      "let i = 0;",
      "const timer = setInterval(() => {",
      "  if (i >= lines.length) { clearInterval(timer); process.exit(0); }",
      "  process.stdout.write(lines[i] + '\\n');",
      "  i += 1;",
      "}, 400);",
    ].join("\n"),
  );
  const d = {
    id: "D-out1",
    at: new Date().toISOString(),
    stage: "S0",
    action: "输出续心跳",
    status: "open",
  };
  capitalist.appendDispatch(base, d);
  capitalist.claimDispatch(base, "D-out1", "W-out");

  const { launchWorker } = require("../dist/supervisor/worker/worker");
  const launched = launchWorker({
    root: base,
    target: "输出续心跳",
    host: "custom",
    dispatch: capitalist.readDispatches(base).find((x) => x.id === "D-out1"),
    cmd: `${process.execPath} "${script}" {prompt}`,
  });
  assert.equal(launched.record.status, "starting");

  const baseline = launched.record.heartbeat_ts;
  const deadline = Date.now() + 10_000;
  let rec = capitalist.loadWorker(base, launched.record.id);
  while (Date.now() < deadline && rec && rec.status === "starting") {
    await new Promise((r) => setTimeout(r, 100));
    rec = capitalist.loadWorker(base, launched.record.id);
  }
  assert.equal(rec.status, "running", "首次输出后状态应为运行态");
  assert.ok(rec.heartbeat_ts > baseline, "输出后心跳应比启动时更新");
});

test("送达失败：direct.jsonl 写不进去时卡点记录标 failed，任务卡据此提示人工介入", async () => {
  const root = sandbox();
  openClaimed(root);
  const rec = workerWithLog(root, ["读取 src/index.ts"], 600);
  /* 把 direct.jsonl 变成目录，append 必然失败；不改 .capitalist 下其他文件。 */
  const direct = join(root, ".capitalist", "direct.jsonl");
  if (existsSync(direct)) throw new Error("测试前置不符：direct.jsonl 已存在");
  mkdirSync(direct, { recursive: true });

  const act = await loop.handleStuckWorker(root, rec, {
    heartbeatSec: 900,
    stuckSec: 300,
    nowSec: Date.now() / 1000,
    out: () => {},
  });
  assert.equal(act, "kept");
  const after = capitalist.loadWorker(root, "W-stuck");
  assert.equal(after.stuck.delivered, false);
  assert.equal(after.stuck.channel, "failed");
});
