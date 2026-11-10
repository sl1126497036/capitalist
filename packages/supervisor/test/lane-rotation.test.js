
process.env.CAPITALIST_USAGE_BALANCE = "0";

const test = require("node:test");
const assert = require("node:assert");
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const lane = require("../dist/supervisor/sessionLane");
const loop = require("../dist/supervisor/loop");

function emptyRoot() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-lane-rot-"));
  mkdirSync(join(root, ".capitalist", "sessions"), { recursive: true });
  mkdirSync(join(root, ".capitalist", "workers"), { recursive: true });
  return root;
}

function aDispatch() {
  return { id: "D-1", stage: "U1", shard: "x", action: "把这件事做完" };
}

function laneEvents(root) {
  let text = "";
  try {
    text = readFileSync(join(root, ".capitalist", "events.jsonl"), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e) => e.event === "lane_rotated");
}


test("运行中写回的占用超过 0.6：下一次派单换新代且不续接", () => {
  const root = emptyRoot();
  const d = aDispatch();
  const first = lane.pickLane(root, d);
  assert.strictEqual(first.resume, false, "首次没有可续接的会话");

  // 进程还活着时刷新出来的读数（limit = 300k × 0.6 = 180k）。
  lane.recordLaneUsage(root, first.id, {
    context_used: 200_000,
    context_window: 300_000,
  });
  assert.strictEqual(lane.laneTooFull(lane.readLane(root, "capitalist-u1-x")), true);

  const next = lane.pickLane(root, d);
  assert.strictEqual(next.resume, false, "已满的会话不许再接新单");
  assert.strictEqual(next.id, "capitalist-u1-x-g1", "必须换一代，而不是续接旧会话");

  const st = lane.readLane(root, "capitalist-u1-x");
  assert.strictEqual(st.gen, 1);
  assert.strictEqual(st.ctx_used, null, "新一代的占用读数从零开始");

  const [ev] = laneEvents(root);
  assert.ok(ev, "换代必须留下 lane_rotated 事件");
  assert.strictEqual(ev.base, "capitalist-u1-x");
  assert.strictEqual(ev.from_gen, 0);
  assert.strictEqual(ev.to_gen, 1);
  assert.strictEqual(ev.ctx_used, 200_000, "事件里要带上一代的最终占用");
  assert.strictEqual(ev.limit, 180_000, "事件里要带判定用的阈值");
  assert.strictEqual(ev.why, "ctx_full");
});

test("刚好 0.6 就算满（阈值是 >=，不是 >）", () => {
  const root = emptyRoot();
  const d = aDispatch();
  const first = lane.pickLane(root, d);
  lane.recordLaneUsage(root, first.id, {
    context_used: 180_000,
    context_window: 300_000,
  });
  assert.strictEqual(lane.laneTooFull(lane.readLane(root, "capitalist-u1-x")), true);
  const next = lane.pickLane(root, d);
  assert.strictEqual(next.resume, false);
  assert.strictEqual(next.id, "capitalist-u1-x-g1");
});

test("读数低于 0.6 仍然续接，闸门没有把正常会话也换掉", () => {
  const root = emptyRoot();
  const d = aDispatch();
  const first = lane.pickLane(root, d);
  lane.recordLaneUsage(root, first.id, {
    context_used: 179_999,
    context_window: 300_000,
  });
  const next = lane.pickLane(root, d);
  assert.strictEqual(next.resume, true);
  assert.strictEqual(next.id, "capitalist-u1-x");
});

test("进程还活着（busy）且已满：同样换代，不往同一条会话上排新单", () => {
  const root = emptyRoot();
  const d = aDispatch();
  const first = lane.pickLane(root, d, () => true);
  lane.recordLaneUsage(root, first.id, {
    context_used: 250_000,
    context_window: 300_000,
  });
  const next = lane.pickLane(root, d, (id) => id === first.id);
  assert.strictEqual(next.resume, false);
  assert.strictEqual(next.id, "capitalist-u1-x-g1");
});

test("换代后老代晚到的读数不会把新代闸门带偏", () => {
  const root = emptyRoot();
  const d = aDispatch();
  const first = lane.pickLane(root, d);
  lane.recordLaneUsage(root, first.id, { context_used: 200_000, context_window: 300_000 });
  const next = lane.pickLane(root, d);
  lane.recordLaneUsage(root, first.id, { context_used: 290_000, context_window: 300_000 });
  const st = lane.readLane(root, "capitalist-u1-x");
  assert.strictEqual(st.current, next.id);
  assert.strictEqual(st.ctx_used, null, "老代的终值不能算到新代头上");
});


test("运行中按日志增量刷新占用：不用等进程退出，闸门就能判满并换代", () => {
  const root = emptyRoot();
  const d = aDispatch();
  const first = lane.pickLane(root, d);

  // 一个还在跑的 worker：记录里 status=running，日志里有宿主上下文读数。
  const workers = join(root, ".capitalist", "workers");
  const id = "7";
  const log = join(workers, `${id}.log`);
  writeFileSync(join(workers, "index.jsonl"), `${JSON.stringify({ id })}\n`);
  writeFileSync(
    join(workers, `${id}.json`),
    JSON.stringify({
      id,
      host: "claude",
      pid: process.pid,
      session: id,
      dispatch: d.id,
      stage: "U1",
      shard: "x",
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      heartbeat_ts: Date.now() / 1000,
      status: "running",
      log,
      ai_session: first.id,
    }),
  );
  writeFileSync(
    log,
    `${JSON.stringify({
      type: "assistant",
      __timestamp: "2026-11-04T10:00:00Z",
      _meta: { "vendor.ai/contextUsed": 400_000 },
      message: { id: "m1", model: "deepseek-v4.1-flash", usage: { input_tokens: 10 } },
    })}\n`,
  );

  // 进程没有退出，只有日志增长，这就是「运行中」的现场。
  loop.refreshLaneUsage(root, []);

  const st = lane.readLane(root, "capitalist-u1-x");
  assert.strictEqual(st.current, first.id);
  assert.strictEqual(st.ctx_used, 400_000, "运行中的读数必须落到车道上");
  assert.strictEqual(lane.laneTooFull(st), true, "400k ≥ 600k × 60% = 360k");

  const next = lane.pickLane(root, d, (sessionId) => sessionId === first.id);
  assert.strictEqual(next.resume, false, "进程还活着但已满：不许再接新单");
  assert.strictEqual(next.id, "capitalist-u1-x-g1", "下一次派单必须换新代");

  const [ev] = laneEvents(root);
  assert.ok(ev, "换代要留事件");
  assert.strictEqual(ev.ctx_used, 400_000);
  assert.strictEqual(ev.limit, 360_000);
});


test("占用一直未知：不会无限续接，到上限就换代", () => {
  const root = emptyRoot();
  const d = aDispatch();
  const first = lane.pickLane(root, d);

  // 宿主不写 usage 的进程：ctx_used 始终是 null（退出回调也拿不到读数）。
  let resumes = 0;
  let rotated = null;
  for (let i = 0; i < 12; i += 1) {
    const got = lane.pickLane(root, d);
    if (got.resume) {
      resumes += 1;
      continue;
    }
    rotated = got;
    break;
  }

  assert.ok(rotated, "ctx_used=null 不能成为永远续接的理由");
  assert.ok(resumes <= 3, `同一代最多续接 3 次，实际 ${resumes}`);
  assert.strictEqual(rotated.id, "capitalist-u1-x-g1");
  assert.strictEqual(lane.readLane(root, "capitalist-u1-x").gen, 1);

  const [ev] = laneEvents(root);
  assert.ok(ev);
  assert.strictEqual(ev.ctx_used, null, "未知占用也照样记事件，ctx_used 写 null");
  assert.strictEqual(ev.why, "ctx_unknown");
});

test("未知占用的续接上限按代重置：新一代重新计数", () => {
  const root = emptyRoot();
  const d = aDispatch();
  lane.pickLane(root, d);
  let gen = 0;
  let sinceRotate = 0;
  let maxRun = 0;
  for (let i = 0; i < 30; i += 1) {
    const got = lane.pickLane(root, d);
    if (got.resume) {
      sinceRotate += 1;
      maxRun = Math.max(maxRun, sinceRotate);
      continue;
    }
    gen += 1;
    assert.strictEqual(got.id, `capitalist-u1-x-g${gen}`);
    sinceRotate = 0;
  }
  assert.ok(maxRun <= 3, `每代续接次数必须有界，实际最长 ${maxRun}`);
  assert.ok(gen >= 6, `30 次派单里必须换过很多代，实际 ${gen}`);
  assert.strictEqual(lane.readLane(root, "capitalist-u1-x").gen, gen);
});
