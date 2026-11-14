/**
 * 用量台账：从 worker 日志里读真实 token / 成本 / 耗时 / 模型，并按三个维度汇总。
 *
 * 这一组测的都是“读出来的数对不对、缺数据时是不是真的空着”：
 *   - assistant 行按 message.id 去重（流式分片会重复下发同一条消息）；
 *   - 有 `type=result` 时以官方汇总为准，不叠加逐条求和（否则会翻倍）；
 *   - 没有 usage 的日志必须是 null + 原因，不能是 0；
 *   - 追写日志后增量解析出的数要继续往上涨，不重不漏；
 *   - 三个维度的合计互相对得上；
 *   - 余额查询关闭时接口仍然给得出原因，且不编一个 0。
 *
 * 全部用临时目录里的假日志，不碰真实任务根，也不打网络。
 */

process.env.CAPITALIST_USAGE_BALANCE = "0";

const test = require("node:test");
const assert = require("node:assert");
const { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const usage = require("../dist/supervisor/usage/usage");
const board = require("../dist/supervisor/board");

/** 建一个最小任务根：state.json + workers/index.jsonl + 若干 worker 记录与日志。 */
function makeRoot(workers) {
  const root = mkdtempSync(join(tmpdir(), "capitalist-usage-"));
  mkdirSync(join(root, ".capitalist", "workers"), { recursive: true });
  mkdirSync(join(root, ".capitalist", "inbox"), { recursive: true });
  writeFileSync(
    join(root, ".capitalist", "state.json"),
    JSON.stringify({ version: 2, target: "测试", stage: "U1", contract: "", counters: {} }),
  );
  const index = [];
  for (const w of workers) {
    const id = w.id;
    index.push({ id });
    writeFileSync(
      join(root, ".capitalist", "workers", `${id}.json`),
      JSON.stringify({
        id,
        host: "codebuddy",
        pid: 0,
        session: id,
        dispatch: w.dispatch,
        shard: w.shard ?? "",
        stage: w.stage,
        started_at: w.started_at ?? "2026-11-01T00:00:00.000Z",
        heartbeat_at: "2026-11-01T00:01:00.000Z",
        heartbeat_ts: 1793491260,
        status: w.status ?? "done",
        log: join(root, ".capitalist", "workers", `${id}.log`),
      }),
    );
    writeFileSync(join(root, ".capitalist", "workers", `${id}.log`), w.log ?? "");
  }
  writeFileSync(join(root, ".capitalist", "workers", "index.jsonl"), index.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const dispatches = workers
    .filter((w) => w.dispatch)
    .map((w) => ({ id: w.dispatch, at: "2026-11-01T00:00:00.000Z", stage: w.stage, action: "做点事", status: "done", shard: w.shard ?? "", model: "deepseek-v4.1-flash", done_at: "2026-11-01T00:01:00.000Z" }));
  if (dispatches.length) {
    writeFileSync(
      join(root, ".capitalist", "inbox", "dispatch.jsonl"),
      dispatches.map((d) => JSON.stringify(d)).join("\n") + "\n",
    );
  }
  return root;
}

function assistant(id, input, output, cacheRead, extra = {}) {
  return JSON.stringify({
    type: "assistant",
    uuid: id,
    session_id: "s",
    message: {
      id,
      model: "deepseek-v4.1-flash",
      role: "assistant",
      content: [],
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: 0,
      },
    },
    ...extra,
  });
}

function result(input, output, cacheRead, ctxUsed) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 12345,
    num_turns: 2,
    total_cost_usd: 0,
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: 0,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
    },
    modelUsage: {
      "deepseek-v4.1-flash": {
        inputTokens: 600,
        outputTokens: 100,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: 0,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
    },
    _meta: { "codebuddy.ai/contextUsed": ctxUsed },
    __timestamp: "2026-11-01T00:00:20.000Z",
  });
}

test("result 行是官方汇总：同一消息的流式分片只算一次，且不再叠加逐条求和", () => {
  usage.__resetUsageCache();
  const log = [
    "[launch] 2026-11-01T00:00:00.000Z host=codebuddy",
    assistant("m1", 100, 10, 50, { __timestamp: "2026-11-01T00:00:01.000Z" }),
    // 同一条消息的第二次下发（流式分片）：必须被去重
    assistant("m1", 100, 10, 50, { __timestamp: "2026-11-01T00:00:02.000Z" }),
    assistant("m2", 200, 20, 100, {
      __timestamp: "2026-11-01T00:00:03.000Z",
      _meta: { "codebuddy.ai/contextUsed": 160000 },
    }),
    result(1000, 100, 400, 123456),
  ].join("\n");
  const root = makeRoot([{ id: "W-a", dispatch: "D-a", stage: "U1", log }]);
  const rows = usage.collectWorkerUsage(root);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.source, "result");
  assert.equal(r.reported, true);
  assert.equal(r.input_tokens, 1000, "以 result 的 usage 为准，不是 100+200");
  assert.equal(r.output_tokens, 100);
  assert.equal(r.cache_read_tokens, 400);
  assert.equal(r.total_tokens, 1100);
  assert.equal(r.duration_ms, 12345, "时长取 result.duration_ms");
  assert.equal(r.num_turns, 2);
  assert.equal(r.context_used, 123456);
  assert.equal(r.context_window, 200000);
  assert.equal(r.model, "deepseek-v4.1-flash");
  assert.equal(r.model_version, "v4.1-flash");
  assert.equal(r.billing_unit, "token", "total_cost_usd=0 -> 按 token 计费");
  assert.equal(r.cost_usd, 0);
});

test("没有 result 时用去重后的逐条求和，时长按起止时间算", () => {
  usage.__resetUsageCache();
  const log = [
    assistant("m1", 100, 10, 50, { __timestamp: "2026-11-01T00:00:01.000Z" }),
    assistant("m1", 100, 10, 50, { __timestamp: "2026-11-01T00:00:02.000Z" }),
    assistant("m2", 200, 20, 100, { __timestamp: "2026-11-01T00:00:10.000Z" }),
  ].join("\n");
  const root = makeRoot([{ id: "W-b", dispatch: "D-b", stage: "U1", log }]);
  const r = usage.collectWorkerUsage(root)[0];
  assert.equal(r.source, "stream");
  assert.equal(r.input_tokens, 300, "m1 只算一次：100 + 200");
  assert.equal(r.output_tokens, 30);
  assert.equal(r.total_tokens, 330);
  assert.equal(r.started_at, "2026-11-01T00:00:00.000Z");
  assert.equal(r.ended_at, "2026-11-01T00:00:10.000Z");
  assert.equal(r.duration_ms, 10000);
});

test("日志里没有 usage：数值全空、reported=false、原因写明未上报", () => {
  usage.__resetUsageCache();
  const root = makeRoot([
    { id: "W-c", dispatch: "D-c", stage: "U1", log: "普通文本输出，不是 stream-json\n[launch] 开头\n" },
  ]);
  const r = usage.collectWorkerUsage(root)[0];
  assert.equal(r.reported, false);
  assert.equal(r.source, "none");
  assert.equal(r.input_tokens, null);
  assert.equal(r.total_tokens, null);
  assert.equal(r.cost_usd, null);
  assert.equal(r.credit, null);
  assert.equal(r.context_used, null);
  assert.match(r.unavailable_reason, /^未上报/);
});

test("追写日志：增量解析只读新增的整行，数继续上涨且不重复计", () => {
  usage.__resetUsageCache();
  const root = makeRoot([
    {
      id: "W-d",
      dispatch: "D-d",
      stage: "U2",
      log: assistant("m1", 100, 10, 0, { __timestamp: "2026-11-01T00:00:01.000Z" }) + "\n",
    },
  ]);
  const file = join(root, ".capitalist", "workers", "W-d.log");
  assert.equal(usage.collectWorkerUsage(root)[0].input_tokens, 100);
  appendFileSync(file, assistant("m2", 400, 40, 0, { __timestamp: "2026-11-01T00:00:05.000Z" }) + "\n");
  assert.equal(usage.collectWorkerUsage(root)[0].input_tokens, 500);
  assert.equal(usage.collectWorkerUsage(root)[0].output_tokens, 50);
});

test("三个维度的合计对得上：by_worker -> by_dispatch -> by_stage -> totals", () => {
  usage.__resetUsageCache();
  const root = makeRoot([
    { id: "W-1", dispatch: "D-1", stage: "U1", shard: "a", log: assistant("m1", 100, 10, 0) },
    { id: "W-2", dispatch: "D-1", stage: "U1", shard: "a", log: assistant("m1", 200, 20, 0) },
    { id: "W-3", dispatch: "D-2", stage: "U2", shard: "b", log: "没有用量\n" },
  ]);
  const ledger = usage.buildUsageLedger(root);
  const sum = (rows, k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
  assert.equal(ledger.by_worker.length, 3);
  assert.equal(ledger.by_dispatch.length, 2);
  assert.equal(ledger.by_stage.length, 2);
  assert.equal(sum(ledger.by_worker, "total_tokens"), 330);
  assert.equal(sum(ledger.by_dispatch, "total_tokens"), 330);
  assert.equal(sum(ledger.by_stage, "total_tokens"), 330);
  assert.equal(ledger.totals.total_tokens, 330);
  assert.equal(ledger.totals.reported_runs, 2);
  assert.equal(ledger.totals.unreported_runs, 1);
  const d1 = ledger.by_dispatch.find((r) => r.id === "D-1");
  assert.equal(d1.total_tokens, 330, "同一派单的两个 worker 相加（输入 300 + 输出 30）");
  assert.equal(d1.runs, 2);
});

test("/api/metrics 与 /api/threads 的用量字段：有读数填数，无读数留空并给原因", () => {
  usage.__resetUsageCache();
  const root = makeRoot([
    { id: "W-e", dispatch: "D-e", stage: "U1", shard: "x", log: result(1000, 100, 400, 9000) },
    { id: "W-f", dispatch: "D-f", stage: "U1", shard: "y", log: "纯文本\n" },
  ]);
  const m = board.buildMetrics(root);
  assert.equal(m.usage.total_tokens, 1100);
  assert.equal(m.usage.reported_runs, 1);
  assert.equal(m.usage.unreported_runs, 1);
  assert.equal(m.usage.billing_unit, "token");
  assert.equal(m.credit, null, "余额查询关闭时不编数");
  assert.match(m.credit_unavailable_reason, /^无法获取/);
  assert.equal(typeof m.context.used, "number", "上下文取有读数的那条");
  assert.equal(m.context.used, 9000);

  const threadE = m.threads.find((t) => t.id === "W-e");
  assert.equal(threadE.usage.total_tokens, 1100);
  assert.equal(threadE.usage.model_version, "v4.1-flash");
  const threadF = m.threads.find((t) => t.id === "W-f");
  assert.equal(threadF.usage.reported, false);

  const page = board.buildThreadsPage(root, 50);
  assert.equal(page.totals.total_tokens, 1100);
  assert.equal(page.totals.usage_reported, 1);
  assert.equal(page.totals.usage_unreported, 1);
  assert.equal(page.threads.find((t) => t.stage === "U1" && t.shard === "x").usage.context_window, 200000);
});

test("总看板：跨根累加 token，余额仍是同一个账号口径", () => {
  usage.__resetUsageCache();
  const a = makeRoot([{ id: "W-g", dispatch: "D-g", stage: "U1", log: result(1000, 100, 0, 1000) }]);
  const b = makeRoot([{ id: "W-h", dispatch: "D-h", stage: "U1", log: result(2000, 200, 0, 2000) }]);
  const ov = board.buildOverview([a, b]);
  assert.equal(ov.usage.total_tokens, 3300);
  assert.equal(ov.usage.reported_runs, 2);
  assert.equal(ov.credit_left, null);
  assert.match(ov.credit_unavailable_reason, /^无法获取/);
});
