
process.env.CAPITALIST_USAGE_BALANCE = "0";

const test = require("node:test");
const assert = require("node:assert");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const usage = require("../dist/supervisor/usage/usage");
const reload = require("../dist/supervisor/context/reload");

const MODEL = "deepseek-v4.1-flash";

function emptyRoot() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-ctxest-"));
  mkdirSync(join(root, ".capitalist", "workers"), { recursive: true });
  mkdirSync(join(root, ".capitalist", "inbox"), { recursive: true });
  writeFileSync(
    join(root, ".capitalist", "state.json"),
    JSON.stringify({ version: 2, target: "测试", stage: "U1", contract: "", counters: {} }),
  );
  return root;
}

/** 一个 worker 记录 + 它自己的日志。 */
function withWorker(root, log, status = "done") {
  const id = "W-est";
  const file = join(root, ".capitalist", "workers", `${id}.log`);
  writeFileSync(file, log);
  writeFileSync(
    join(root, ".capitalist", "workers", `${id}.json`),
    JSON.stringify({
      id,
      host: "codebuddy",
      pid: 0,
      session: id,
      dispatch: "",
      shard: "",
      stage: "U1",
      started_at: "2026-11-01T00:00:00.000Z",
      heartbeat_at: "2026-11-01T00:01:00.000Z",
      heartbeat_ts: 1793491260,
      status,
      log: file,
    }),
  );
  writeFileSync(join(root, ".capitalist", "workers", "index.jsonl"), JSON.stringify({ id }) + "\n");
  return root;
}

function assistantText(text) {
  return JSON.stringify({
    type: "assistant",
    __timestamp: "2026-11-01T00:00:01.000Z",
    message: {
      id: `m-${text.length}`,
      role: "assistant",
      model: MODEL,
      content: [{ type: "text", text }],
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
}

function toolResultText(text) {
  return JSON.stringify({
    type: "user",
    __timestamp: "2026-11-01T00:00:02.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text }] }] },
  });
}

/**
 * result 行：usage 是整个 turn 的累计值（4.8M 这种），没有 contextUsed。
 * 累计值被当作已用值的情形。
 */
function resultNoCtx(window = 300_000) {
  return JSON.stringify({
    type: "result",
    __timestamp: "2026-11-01T00:00:20.000Z",
    duration_ms: 1000,
    num_turns: 10,
    total_cost_usd: 0,
    usage: { input_tokens: 4_862_393, output_tokens: 100, cache_read_input_tokens: 4_720_576, cache_creation_input_tokens: 0 },
    modelUsage: { [MODEL]: { inputTokens: 4_862_393, outputTokens: 100, contextWindow: window } },
  });
}

function resultWithCtx(used, window = 300_000) {
  return JSON.stringify({
    type: "result",
    __timestamp: "2026-11-01T00:00:20.000Z",
    duration_ms: 1000,
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { [MODEL]: { inputTokens: 1000, outputTokens: 100, contextWindow: window } },
    _meta: { "example.ai/contextUsed": used },
  });
}

test("估算口径：中文 3 字符/token、其余 4 字符/token", () => {
  assert.equal(usage.estimateTextTokens("a".repeat(400)), 100, "400 个非中文字符 = 100 token");
  assert.equal(usage.estimateTextTokens("中".repeat(300)), 100, "300 个中文字符 = 100 token");
  assert.equal(usage.estimateTextTokens("a".repeat(400) + "中".repeat(300)), 200);
  assert.equal(usage.estimateTextTokens(""), 0);

  const acc = usage.newTextTally();
  usage.tallyMessage(acc, {
    content: [
      { type: "thinking", thinking: "aa" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "中中中" }] },
    ],
  });
  assert.equal(acc.cjk, 3, "工具结果里的中文计入");
  assert.equal(acc.other, 8, "thinking 与工具参数计入（aa + Bash + ls）");
  assert.equal(usage.estimateContextTokens(acc), 3, "3/3 + 8/4");
});

test("长会话：无宿主 contextUsed 时按消息估算，不拿 result 的累计 usage", () => {
  usage.__resetUsageCache();
  const root = withWorker(
    emptyRoot(),
    [
      assistantText("a".repeat(400)),
      toolResultText("中".repeat(300)),
      resultNoCtx(300_000),
    ].join("\n"),
  );
  const row = usage.collectWorkerUsage(root)[0];
  assert.equal(row.input_tokens, 4_862_393, "累计 usage 仍如实显示在消耗口径");
  assert.equal(row.context_used, 200, "上下文已用取消息估算值，不是 result 累计值");
  assert.equal(row.context_estimate, true, "估算值必须带标记");
  assert.equal(row.context_over, false);
  assert.equal(row.context_window, 1_000_000, "300k 占位值按默认表校正为 1M");
  assert.ok(row.context_used <= row.context_window, "已用不能大于分母");
});

test("超长会话：已用夹到生效上限，并标超限", () => {
  usage.__resetUsageCache();
  /* 4,000,012 个非中文 = 1,000,003 token > 1M */
  const root = withWorker(emptyRoot(), [assistantText("a".repeat(4_000_012)), resultNoCtx(300_000)].join("\n"));
  const row = usage.collectWorkerUsage(root)[0];
  assert.equal(row.context_estimate, true);
  assert.equal(row.context_over, true, "原始估算超过上限");
  assert.equal(row.context_used, 1_000_000, "显示值夹到上限");
  assert.ok(row.context_used <= row.context_window, "绝不允许已用大于分母");
});

test("宿主 contextUsed 优先：有真读数就不估算；超过上限同样夹取", () => {
  usage.__resetUsageCache();
  const normal = withWorker(emptyRoot(), [assistantText("a".repeat(400)), resultWithCtx(120_000)].join("\n"));
  const n = usage.collectWorkerUsage(normal)[0];
  assert.equal(n.context_used, 120_000);
  assert.equal(n.context_estimate, false, "宿主读数不是估算");

  usage.__resetUsageCache();
  const over = withWorker(emptyRoot(), [resultWithCtx(1_200_000, 300_000)].join("\n"));
  const o = usage.collectWorkerUsage(over)[0];
  assert.equal(o.context_window, 1_000_000);
  assert.equal(o.context_used, 1_000_000, "宿主读数超过上限也夹到上限");
  assert.equal(o.context_over, true);
  assert.equal(o.context_estimate, false);
});

test("监工链路：估算标记落盘，视图夹到生效上限并标超限", () => {
  const root = emptyRoot();
  writeFileSync(
    join(root, ".capitalist", "supervisor.json"),
    JSON.stringify({ heartbeat_ts: Date.now() / 1000, supervisor_context_limit: 1_000_000 }),
    "utf8",
  );
  /* 估算 1.2M > 模型窗口 1M；视图必须显示 1M / 1M，而不是 1.2M / 1M。 */
  reload.recordSupervisorContext(root, 1_200_000, 300_000, MODEL, true);
  const view = reload.buildSupervisorContextView(root);
  assert.equal(view.limit, 1_000_000);
  assert.equal(view.used, 1_000_000);
  assert.equal(view.over, true);
  assert.equal(view.estimate, true);
  assert.ok(view.used <= view.limit);
  assert.equal(view.ratio, 1);

  const hit = reload.shouldAutoReload(root);
  assert.equal(hit.hit, true);
  assert.ok(!hit.reason.includes("1200000"), `超限理由也不能写超过分母的读数：${hit.reason}`);
});

test("监工与 worker 共用估算函数：会话记录按同一口径折算", () => {
  const home = mkdtempSync(join(tmpdir(), "capitalist-home-"));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const dir = join(home, ".codebuddy", "projects", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "capitalist-chat-t.jsonl"),
      [
        JSON.stringify({ type: "message", role: "user", content: [{ type: "input_text", text: "a".repeat(400) }] }),
        JSON.stringify({
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "中".repeat(300) },
            { type: "function_call", name: "Bash", arguments: '{"command":"ls"}' },
          ],
        }),
      ].join("\n"),
    );
    const estimated = reload.estimateSessionContextTokens("capitalist-chat-t");
    /* 400/4 + 300/3 + 工具调用（name "Bash" 4 + arguments 15）/4 ≈ 205 */
    assert.equal(estimated, 205);
    assert.equal(estimated, usage.estimateTextTokens("a".repeat(400) + "中".repeat(300) + "Bash" + '{"command":"ls"}'));
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
  }
});
