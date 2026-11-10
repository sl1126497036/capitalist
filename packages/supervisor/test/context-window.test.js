
process.env.CAPITALIST_USAGE_BALANCE = "0";

const test = require("node:test");
const assert = require("node:assert");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const limits = require("../dist/core/limits");
const usage = require("../dist/supervisor/usage");
const reload = require("../dist/supervisor/reload");
const lane = require("../dist/supervisor/sessionLane");

const MODEL = "deepseek-v4.1-flash";

function emptyRoot() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-ctxwin-"));
  mkdirSync(join(root, ".capitalist", "workers"), { recursive: true });
  mkdirSync(join(root, ".capitalist", "inbox"), { recursive: true });
  writeFileSync(
    join(root, ".capitalist", "state.json"),
    JSON.stringify({ version: 2, target: "测试", stage: "U1", contract: "", counters: {} }),
  );
  return root;
}

/** 一个 worker 记录 + 它自己的日志。 */
function withWorker(root, id, log, extra = {}) {
  const file = join(root, ".capitalist", "workers", `${id}.log`);
  writeFileSync(file, log);
  writeFileSync(
    join(root, ".capitalist", "workers", `${id}.json`),
    JSON.stringify({
      id,
      host: "codebuddy",
      pid: 0,
      session: id,
      dispatch: extra.dispatch ?? "",
      shard: "",
      stage: "U1",
      started_at: "2026-11-01T00:00:00.000Z",
      heartbeat_at: "2026-11-01T00:01:00.000Z",
      heartbeat_ts: 1793491260,
      status: "done",
      log: file,
      ...extra,
    }),
  );
  const indexFile = join(root, ".capitalist", "workers", "index.jsonl");
  writeFileSync(indexFile, JSON.stringify({ id }) + "\n");
  return root;
}

function resultLine(model, window, ctxUsed = 100_000) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    duration_ms: 1000,
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {
      [model]: {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        contextWindow: window,
        maxOutputTokens: 8192,
      },
    },
    _meta: { "codebuddy.ai/contextUsed": ctxUsed },
    __timestamp: "2026-11-01T00:00:20.000Z",
  });
}

function assistantLine(model, ctxUsed) {
  return JSON.stringify({
    type: "assistant",
    message: {
      id: "m1",
      model,
      role: "assistant",
      content: [],
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    _meta: { "codebuddy.ai/contextUsed": ctxUsed },
    __timestamp: "2026-11-01T00:00:01.000Z",
  });
}


test("默认表：deepseek-v4.1-flash 记 1M，缺报与 300k 占位值都用它", () => {
  assert.equal(limits.defaultContextWindow(MODEL), 1_000_000);
  assert.equal(limits.resolveContextWindow(MODEL, null), 1_000_000, "宿主没报");
  assert.equal(limits.resolveContextWindow(MODEL, 0), 1_000_000, "宿主报 0 等于没报");
  assert.equal(limits.resolveContextWindow(MODEL, 300_000), 1_000_000, "300k 是宿主占位值");
  assert.equal(limits.resolveContextWindow(" DeepSeek-V4.1-Flash ", 300_000), 1_000_000, "查表不分大小写");
});

test("宿主报更大的窗口时以宿主为准，不压回 1M", () => {
  assert.equal(limits.resolveContextWindow(MODEL, 2_000_000), 2_000_000);
});

test("没有登记在表里的模型按宿主读数；两边都没有才是 null", () => {
  assert.equal(limits.resolveContextWindow("unknown-model", 300_000), 300_000);
  assert.equal(limits.resolveContextWindow("unknown-model", 200_000), 200_000);
  assert.equal(limits.resolveContextWindow("", null), null);
});


test("worker 读数里的窗口经默认表校正：300k 占位值显示 1M", () => {
  usage.__resetUsageCache();
  const root = withWorker(emptyRoot(), "W-a", resultLine(MODEL, 300_000));
  const row = usage.collectWorkerUsage(root)[0];
  assert.equal(row.model, MODEL);
  assert.equal(row.context_used, 100_000);
  assert.equal(row.context_window, 1_000_000);
  // 按模型的原样投影不参与判定，仍是宿主原值。
  assert.equal(row.models[MODEL].context_window, 300_000);
});

test("日志只报 fast-model 别名时，用展示模型校正成 1M", () => {
  usage.__resetUsageCache();
  const log = [assistantLine("fast-model", 50_000), assistantLine(MODEL, 60_000), resultLine("fast-model", 300_000)].join(
    "\n",
  );
  const root = withWorker(emptyRoot(), "W-b", log);
  const row = usage.collectWorkerUsage(root)[0];
  assert.equal(row.model, MODEL, "别名换成具体模型");
  assert.equal(row.context_window, 1_000_000);
});

test("宿主没写窗口（只有 assistant 行）时按模型默认表补", () => {
  usage.__resetUsageCache();
  const root = withWorker(emptyRoot(), "W-c", assistantLine(MODEL, 40_000));
  const row = usage.collectWorkerUsage(root)[0];
  assert.equal(row.context_window, 1_000_000);
});


function supervisorRoot(configLimit) {
  const root = emptyRoot();
  writeFileSync(
    join(root, ".capitalist", "supervisor.json"),
    JSON.stringify({ heartbeat_ts: Date.now() / 1000, supervisor_context_limit: configLimit }),
    "utf8",
  );
  return root;
}

test("监工生效上限仍是 min(配置, 模型窗口)，窗口按默认表取", () => {
  const root = supervisorRoot(1_000_000);
  reload.recordSupervisorContext(root, 250_000, 300_000, MODEL);
  const view = reload.buildSupervisorContextView(root);
  assert.equal(view.window, 1_000_000, "300k 占位值换成 1M");
  assert.equal(view.limit, 1_000_000, "配置 1M 与模型 1M 取小");
  assert.equal(reload.shouldAutoReload(root).hit, false, "250k / 1M = 25%，不到 85%");

  const capped = supervisorRoot(500_000);
  reload.recordSupervisorContext(capped, 250_000, 300_000, MODEL);
  assert.equal(reload.buildSupervisorContextView(capped).limit, 500_000, "配置更小时按配置");
});

test("超限判定用同一个生效上限：900k / 1M = 90% 触发", () => {
  const root = supervisorRoot(1_000_000);
  reload.recordSupervisorContext(root, 900_000, 300_000, MODEL);
  const hit = reload.shouldAutoReload(root);
  assert.equal(hit.hit, true);
  assert.ok(hit.reason.includes("1000000"), hit.reason);
});


test("车道闸门按 1M 的 60% 判断，不再在 180k 就换代", () => {
  const root = emptyRoot();
  const dispatch = { id: "D-1", stage: "U1", shard: "x", action: "做点事" };
  const first = lane.pickLane(root, dispatch);
  assert.equal(first.resume, false);

  lane.recordLaneUsage(root, first.id, {
    context_used: 250_000,
    context_window: 300_000,
    context_model: MODEL,
  });
  const st = lane.readLane(root, "capitalist-u1-x");
  assert.equal(lane.laneContextWindow(st), 1_000_000);
  assert.equal(lane.laneTooFull(st), false, "250k < 1M × 60% = 600k");

  // 同一份要求、同一车道：没满就续接。
  assert.equal(lane.pickLane(root, dispatch).resume, true);

  lane.recordLaneUsage(root, first.id, {
    context_used: 700_000,
    context_window: 300_000,
    context_model: MODEL,
  });
  assert.equal(lane.laneTooFull(lane.readLane(root, "capitalist-u1-x")), true, "700k ≥ 600k");
  const next = lane.pickLane(root, dispatch);
  assert.equal(next.resume, false, "满了就换代");
  assert.equal(next.id, "capitalist-u1-x-g1");
});
