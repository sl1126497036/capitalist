
process.env.CAPITALIST_USAGE_BALANCE = "0";

const test = require("node:test");
const assert = require("node:assert");
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const lane = require("../dist/supervisor/judge/sessionLane");
const loop = require("../dist/supervisor/loop");

function emptyRoot() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-lane-rot-"));
  mkdirSync(join(root, ".capitalist", "sessions"), { recursive: true });
  mkdirSync(join(root, ".capitalist", "workers"), { recursive: true });
  mkdirSync(join(root, ".capitalist", "runtime"), { recursive: true });
  mkdirSync(join(root, ".capitalist", "ledger"), { recursive: true });
  mkdirSync(join(root, ".capitalist", ".root"), { recursive: true });
  return root;
}

/* 会话按派单隔离：基名带派单标识（去掉 `D-` 前缀后 slug 化），所有断言以此为准。 */
const BASE = "capitalist-mwkqez4me4j";
/* 会话 id 是 v4 UUID，与 base 无字符串包含关系。断言用正则匹配 UUID，不假设具体取值。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const idOf = () => UUID_RE;

function aDispatch() {
  return { id: "D-mwkqez4me4j", shard: "x", action: "把这件事做完" };
}

function laneEvents(root) {
  let text = "";
  try {
    text = readFileSync(join(root, ".capitalist", "ledger", "events.jsonl"), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e) => e.event === "lane_rotated");
}


test("运行中写回的占用超过 0.5：下一次派单换新代且不续接", () => {
  const root = emptyRoot();
  const d = aDispatch();
  const first = lane.pickLane(root, d);
  assert.strictEqual(first.resume, false, "首次没有可续接的会话");

  // 进程还活着时刷新出来的读数（limit = 300k × 0.5 = 150k）。
  lane.recordLaneUsage(root, first.id, {
    context_used: 200_000,
    context_window: 300_000,
  });
  assert.strictEqual(lane.laneTooFull(lane.readLane(root, BASE)), true);

  const next = lane.pickLane(root, d);
  assert.strictEqual(next.resume, false, "已满的会话不许再接新单");
  assert.match(next.id, idOf(), "必须换一代，而不是续接旧会话");

  const st = lane.readLane(root, BASE);
  assert.strictEqual(st.gen, 1);
  assert.strictEqual(st.ctx_used, null, "新一代的占用读数从零开始");

  const [ev] = laneEvents(root);
  assert.ok(ev, "换代必须留下 lane_rotated 事件");
  assert.strictEqual(ev.base, BASE);
  assert.strictEqual(ev.from_gen, 0);
  assert.strictEqual(ev.to_gen, 1);
  assert.strictEqual(ev.ctx_used, 200_000, "事件里要带上一代的最终占用");
  assert.strictEqual(ev.limit, 150_000, "事件里要带判定用的阈值");
  assert.strictEqual(ev.why, "ctx_full");
});

test("刚好 0.5 就算满（阈值是 >=，不是 >）", () => {
  const root = emptyRoot();
  const d = aDispatch();
  const first = lane.pickLane(root, d);
  lane.recordLaneUsage(root, first.id, {
    context_used: 150_000,
    context_window: 300_000,
  });
  assert.strictEqual(lane.laneTooFull(lane.readLane(root, BASE)), true);
  const next = lane.pickLane(root, d);
  assert.strictEqual(next.resume, false);
  assert.match(next.id, idOf());
});

test("读数低于 0.5 仍然续接，闸门没有把正常会话也换掉", () => {
  const root = emptyRoot();
  const d = aDispatch();
  const first = lane.pickLane(root, d);
  lane.recordLaneUsage(root, first.id, {
    context_used: 149_999,
    context_window: 300_000,
  });
  const next = lane.pickLane(root, d);
  assert.strictEqual(next.resume, true);
  assert.match(next.id, idOf());
  assert.strictEqual(next.id, first.id, "续接沿用同一会话 id，不换新后缀");
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
  assert.match(next.id, idOf());
});

test("换代后老代晚到的读数不会把新代闸门带偏", () => {
  const root = emptyRoot();
  const d = aDispatch();
  const first = lane.pickLane(root, d);
  lane.recordLaneUsage(root, first.id, { context_used: 200_000, context_window: 300_000 });
  const next = lane.pickLane(root, d);
  lane.recordLaneUsage(root, first.id, { context_used: 290_000, context_window: 300_000 });
  const st = lane.readLane(root, BASE);
  assert.strictEqual(st.current, next.id);
  assert.strictEqual(st.ctx_used, null, "老代的终值不能算到新代头上");
});


test("运行中按日志增量刷新占用：不用等进程退出，闸门就能判满并换代", () => {
  const root = emptyRoot();
  const d = aDispatch();
  const first = lane.pickLane(root, d);

  // 一个还运行中的 worker：记录里 status=running，日志里有宿主上下文读数。
  // per-worker 目录结构：workers/<id>/record.json + output.log，索引在 .root/index.jsonl。
  const id = "7";
  const workerDir = join(root, ".capitalist", "workers", id);
  const log = join(workerDir, "output.log");
  mkdirSync(workerDir, { recursive: true });
  mkdirSync(join(root, ".capitalist", ".root"), { recursive: true });
  writeFileSync(join(root, ".capitalist", ".root", "index.jsonl"), `${JSON.stringify({ id })}\n`);
  writeFileSync(
    join(workerDir, "record.json"),
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
      _meta: { "vendor.ai/contextUsed": 700_000 },
      message: { id: "m1", model: "deepseek-v4.1-flash", usage: { input_tokens: 10 } },
    })}\n`,
  );

  // 进程未退出，仅有日志增长，此即“运行中”的表现。
  loop.refreshLaneUsage(root, []);

  const st = lane.readLane(root, BASE);
  assert.strictEqual(st.current, first.id);
  assert.strictEqual(st.ctx_used, 700_000, "运行中的读数必须落到会话上");
  assert.strictEqual(lane.laneTooFull(st), true, "700k 必须超过本代阈值（1M 窗口的五成）");

  const next = lane.pickLane(root, d, (sessionId) => sessionId === first.id);
  assert.strictEqual(next.resume, false, "进程还活着但已满：不许再接新单");
  assert.match(next.id, idOf(), "下一次派单必须换新代");

  const [ev] = laneEvents(root);
  assert.ok(ev, "换代要留事件");
  assert.strictEqual(ev.ctx_used, 700_000);
  assert.strictEqual(ev.limit, 500_000);
});


test("会话闲置超过 1 小时：即使占用未满也换代，不续接陈旧上下文", () => {
  const root = emptyRoot();
  const d = aDispatch();
  const first = lane.pickLane(root, d);
  assert.strictEqual(first.resume, false);

  lane.recordLaneUsage(root, first.id, {
    context_used: 10_000,
    context_window: 300_000,
  });

  const st = lane.readLane(root, BASE);
  st.at = new Date(Date.now() - 7200_000).toISOString();
  writeFileSync(join(root, ".capitalist", "sessions", `${BASE}.json`), JSON.stringify(st, null, 1));

  const next = lane.pickLane(root, d);
  assert.strictEqual(next.resume, false, "闲置过久不许续接");
  assert.match(next.id, idOf(), "闲置过久必须换新代");

  const [ev] = laneEvents(root);
  assert.ok(ev, "换代要留事件");
  assert.strictEqual(ev.why, "ctx_stale", "换代原因记为闲置过久");
});

test("会话在 1 小时窗内且占用未满：正常续接", () => {
  const root = emptyRoot();
  const d = aDispatch();
  const first = lane.pickLane(root, d);
  lane.recordLaneUsage(root, first.id, {
    context_used: 10_000,
    context_window: 300_000,
  });
  const next = lane.pickLane(root, d);
  assert.strictEqual(next.resume, true);
  assert.match(next.id, idOf());
  assert.strictEqual(next.id, first.id);
});

test("占用一直未知：不会无限续接，到上限就换代", () => {
  const root = emptyRoot();
  const d = aDispatch();
  const first = lane.pickLane(root, d);

  // 宿主不写 usage 的进程：ctx_used 始终为 null（退出回调也无法取得读数）。
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
  assert.match(rotated.id, idOf());
  assert.strictEqual(lane.readLane(root, BASE).gen, 1);

  const [ev] = laneEvents(root);
  assert.ok(ev);
  assert.strictEqual(ev.ctx_used, null, "未知占用也照样记事件，ctx_used 写 null");
  /*
   * 换代原因分两类：续接次数到达上限记 `ctx_unknown`；续接过一次仍未找到宿主会话文件
   * 记 `session_missing`。后者更早拦住“续接一条不存在的会话”，同样满足本用例要守的
   * “ctx_used=null 不能成为永远续接的理由”。
   */
  assert.ok(
    ev.why === "ctx_unknown" || ev.why === "session_missing",
    `换代原因应为占用未知或会话缺失，实际 ${ev.why}`,
  );
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
    assert.match(got.id, idOf());
    sinceRotate = 0;
  }
  assert.ok(maxRun <= 3, `每代续接次数必须有界，实际最长 ${maxRun}`);
  assert.ok(gen >= 6, `30 次派单里必须换过很多代，实际 ${gen}`);
  assert.strictEqual(lane.readLane(root, BASE).gen, gen);
});


test("同阶段、同标签、无分片的两张单：会话必须互相独立", () => {
  const root = emptyRoot();
  /* 这是线上出问题的形态：同一阶段下多张单，分片为空，分类标签相同。 */
  const a = { id: "D-mwkqez4me4j", stage: "T", shard: "", tags: ["supervisor-copy"], action: "第一件事" };
  const b = { id: "D-mwkqvjqpf2a", stage: "T", shard: "", tags: ["supervisor-copy"], action: "第二件事" };

  const sa = lane.pickLane(root, a);
  const sb = lane.pickLane(root, b);
  assert.notStrictEqual(sa.id, sb.id, "不同派单不能落到同一条会话");
  assert.match(sa.id, idOf());
  assert.match(sb.id, idOf());
  assert.strictEqual(sb.resume, false, "另一张单的会话不能被续接");
});

test("同一张单重开续接自己的会话，不因隔离而丢上下文", () => {
  const root = emptyRoot();
  const d = aDispatch();
  const first = lane.pickLane(root, d);
  const again = lane.pickLane(root, d);
  assert.strictEqual(again.id, first.id, "同一单重开必须续接原会话");
  assert.strictEqual(again.resume, true);
});

test("派单 id 缺失时才退回阶段与分片派生（兼容旧档）", () => {
  const root = emptyRoot();
  const got = lane.pickLane(root, { stage: "U1", shard: "x", action: "无 id 的历史单" });
  assert.match(got.id, idOf());
});

test("清理 .capitalist 后重建：会话 id 带全新后缀，不沿用旧会话", () => {
  // 两个独立任务根等价于“清理 .capitalist 后重建”：会话映射表各自独立，base 相同但须生成不同后缀。
  const rootA = emptyRoot();
  const rootB = emptyRoot();
  const d = aDispatch();

  const first = lane.pickLane(rootA, d);
  const again = lane.pickLane(rootB, d);

  assert.match(first.id, idOf());
  assert.match(again.id, idOf());
  assert.notStrictEqual(again.id, first.id, "重建后必须生成全新会话 id，不沿用旧会话");
  assert.strictEqual(again.resume, false, "重建后视为首次，不续接");
});

test("同任务重派（派发序 4-1 → 4-2）复用同一会话，派发序不进基名", () => {
  const root = emptyRoot();
  const a = { id: "4-1", stage: "S0", shard: "", action: "把这件事做完" };
  const b = { id: "4-2", stage: "S0", shard: "", action: "把这件事做完" };

  const sa = lane.pickLane(root, a);
  const sb = lane.pickLane(root, b);

  // 派发序不进基名：两次派发落在同一 base（capitalist-s0-4），续接同一会话。
  assert.strictEqual(sa.resume, false, "首次派发新开");
  assert.strictEqual(sb.resume, true, "重派续接同一会话");
  assert.strictEqual(sb.id, sa.id, "重派沿用同一会话 id，不新开文件");
});
