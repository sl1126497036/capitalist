
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { loadContract } = require(join(PKG, "dist/core/contract/contract.js"));
const {
  CAPITALIST_CTX_RELOAD_RATIO,
  applyResumePlan,
  beginReload,
  buildReloadSnapshot,
  buildResumePlan,
  readSupervisorContext,
  recordSupervisorContext,
  reloadStatus,
  shouldAutoReload,
} = require(join(PKG, "dist/supervisor/context/reload.js"));
const { contextUsageOfResult } = require(join(PKG, "dist/supervisor/channel/llm.js"));


test("读数解析：result 行里的 contextUsed 与 contextWindow 能读出来", () => {
  const line = {
    type: "result",
    _meta: { "example.ai/contextUsed": 172000 },
    modelUsage: { "deepseek-v4.1": { contextWindow: 200000, input_tokens: 1 } },
  };
  const u = contextUsageOfResult(line);
  assert.equal(u.used, 172000);
  assert.equal(u.window, 200000);
});

test("读数解析：没有读数时一律 null，不拿 0 冒充", () => {
  assert.deepEqual(contextUsageOfResult({ type: "result" }), { used: null, window: null });
  assert.deepEqual(contextUsageOfResult(null), { used: null, window: null });
  // 空串 / 负数 / 非数字都算“没有读数”
  assert.equal(contextUsageOfResult({ _meta: { "x.ai/contextUsed": 0 } }).used, null);
  assert.equal(contextUsageOfResult({ _meta: { "x.ai/contextUsed": -5 } }).used, null);
  assert.equal(contextUsageOfResult({ _meta: { "x.ai/contextUsed": "abc" } }).used, null);
  assert.equal(contextUsageOfResult({ modelUsage: { m: { contextWindow: 0 } } }).window, null);
});


test("超限判定：有真实读数、占比达标、已达下限，三者齐备才触发", () => {
  const root = mkdtempSync(join(tmpdir(), "capitalist-ctxreload-"));
  mkdirSync(join(root, ".capitalist"), { recursive: true });
  /* 生效上限 = min(配置, 模型窗口)。这里只配 200k，模型窗口未上报。
     heartbeat_ts 是 loadSupervisor 的存活判据，缺了整份记录会被当成不存在。 */
  writeFileSync(
    join(root, ".capitalist", "supervisor.json"),
    JSON.stringify({ heartbeat_ts: Date.now() / 1000, supervisor_context_limit: 200_000 }),
    "utf8",
  );

  // 没有任何读数：不触发
  assert.equal(shouldAutoReload(root).hit, false);

  // 有读数但已用量低于下限：不触发（避免小会话误报）
  recordSupervisorContext(root, 10_000, 200_000);
  assert.equal(shouldAutoReload(root).hit, false);

  // 占比未达阈值：不触发
  recordSupervisorContext(root, 120_000, 200_000);
  const mid = shouldAutoReload(root);
  assert.equal(mid.hit, false);
  assert.ok(mid.reason.includes("未达阈值"));

  // 占比达标（按配置上限 200k 折算）：触发
  recordSupervisorContext(root, 170_000, 0);
  const hit = shouldAutoReload(root);
  assert.equal(hit.hit, true, `170k / 200k 应达 ${CAPITALIST_CTX_RELOAD_RATIO}`);
  assert.ok(hit.reason.includes("170000"));
  assert.ok(hit.reason.includes("200000"), "判定理由要写出生效上限");

  // 没有真实读数的写入被拒绝：文件保持上一次的内容
  recordSupervisorContext(root, 0, 200_000);
  assert.equal(readSupervisorContext(root).used, 170_000);
});

test("超限判定：已有重载在进行中时不重复触发", () => {
  const root = mkdtempSync(join(tmpdir(), "capitalist-ctxreload2-"));
  recordSupervisorContext(root, 180_000, 200_000);
  assert.equal(shouldAutoReload(root).hit, true);

  mkdirSync(join(root, ".capitalist", "reload"), { recursive: true });
  writeFileSync(
    join(root, ".capitalist", "reload", "active.json"),
    JSON.stringify({ gen: 1, phase: "compress", pid: process.pid, started_at: new Date().toISOString(), at_ts: Date.now() / 1000 }),
    "utf8",
  );
  const again = shouldAutoReload(root);
  assert.equal(again.hit, false, "重载已在进行中，不得重复触发");
});


function makeOrderRoot() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-order-"));
  const capitalist = join(root, ".capitalist");
  mkdirSync(join(capitalist, "inbox"), { recursive: true });
  mkdirSync(join(root, "out"), { recursive: true });
  writeFileSync(join(root, "out", "b.txt"), "done\n", "utf8");

  const contractPath = join(root, "demo.contract.json");
  writeFileSync(
    contractPath,
    JSON.stringify({
      name: "demo",
      domain: "test",
      context: "工作根 demo。",
      stages: [
        {
          id: "S1",
          name: "实施",
          next: "按分片实施",
          parallel: [
            { id: "shard-a", title: "甲片", action: "改 src/a.ts" },
            { id: "shard-b", title: "乙片", action: "改 src/b.ts" },
            { id: "shard-c", title: "丙片", action: "改 src/c.ts" },
          ],
          done: { type: "file_exists", path: "out/b.txt", msg: "缺 b" },
        },
      ],
    }),
    "utf8",
  );
  writeFileSync(
    join(capitalist, "state.json"),
    JSON.stringify({
      version: 2,
      target: "顺序演示",
      contract: "demo",
      contract_path: contractPath,
      stage: "S1",
      next_action: "继续实施",
      created_at: new Date().toISOString(),
      retry_resets: { "*": "" },
    }),
    "utf8",
  );

  // 台账行序 = 原始下发顺序：c 最先，a 最后。c 与 a 都停在 review（报完成待确认）。
  const rows = [
    { id: "D-c1", at: "2026-01-01T00:00:00.000Z", stage: "S1", shard: "shard-c", action: "改 src/c.ts", status: "review", attempt: 1 },
    { id: "D-b1", at: "2026-01-01T00:01:00.000Z", stage: "S1", shard: "shard-b", action: "改 src/b.ts", status: "done", attempt: 1 },
    { id: "D-a1", at: "2026-01-01T00:02:00.000Z", stage: "S1", shard: "shard-a", action: "改 src/a.ts", status: "review", attempt: 1 },
  ];
  writeFileSync(join(capitalist, "inbox", "dispatch.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  // shard-b 已结单且台账四项证据齐全 -> done_verified，不占恢复次序、不进复验清单
  writeFileSync(
    join(capitalist, "ledger.jsonl"),
    JSON.stringify({
      id: "L1",
      claim: "shard-b 已实测核对",
      verdict: "confirmed",
      evidence: { baseline: "b1", probe: "p1", diff: "d1", repro: "r1" },
      at: "2026-01-01T00:05:00.000Z",
    }) + "\n",
    "utf8",
  );

  writeFileSync(join(capitalist, "thread-no.json"), JSON.stringify({ next: 3, ids: { "S1/shard-a": 1, "S1/shard-c": 2, "S1/shard-b": 3 } }), "utf8");

  return { root, contract: loadContract(contractPath) };
}

test("快照记录在途单的原始下发顺序（台账行序），只收在途单", () => {
  const { root, contract } = makeOrderRoot();
  const snap = buildReloadSnapshot(root, contract, 1);

  // dispatch_order：台账行序，且只收在途（review）；done 的 D-b1 不进
  assert.deepEqual(
    snap.dispatch_order.map((d) => d.id),
    ["D-c1", "D-a1"],
  );
  assert.equal(snap.dispatch_order[0].status, "review");
  assert.equal(snap.dispatch_order[1].status, "review");

  // resume_order：按第一张派单的行序，未完成条目在前；已完成的不占恢复次序
  assert.deepEqual(snap.resume_order, ["S1/shard-c", "S1/shard-a"]);
});

test("恢复顺序按原始下发顺序，不按任务编号、不按契约顺序", () => {
  const { root, contract } = makeOrderRoot();
  const snap = buildReloadSnapshot(root, contract, 1);
  const plan = buildResumePlan(snap);

  assert.deepEqual(plan.reverify.map((r) => r.key), ["S1/shard-c", "S1/shard-a"]);
  // 在途单没有被判成 pending：它们已有单，恢复的是复验，不是再派一张业务单
  assert.deepEqual(plan.pending.map((p) => p.key), []);
});

test("applyResumePlan 按原始下发顺序建复验单（台账里 c 的复验单在 a 前面）", () => {
  const { root, contract } = makeOrderRoot();
  const snap = buildReloadSnapshot(root, contract, 1);
  const plan = buildResumePlan(snap);
  mkdirSync(join(root, ".capitalist", "reload"), { recursive: true });
  writeFileSync(join(root, ".capitalist", "reload", "resume.json"), JSON.stringify(plan), "utf8");

  const made = applyResumePlan(root, "S1", () => {});
  assert.equal(made, 2);
  const rows = readFileSync(join(root, ".capitalist", "inbox", "dispatch.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const reverify = rows.filter((r) => r.source === "reverify");
  assert.equal(reverify.length, 2);
  const order = reverify.map((r) => (r.action.includes("shard-c") ? "c" : "a"));
  assert.deepEqual(order, ["c", "a"], "先给最早下发的 shard-c 建复验单");
});


test("重载标记带触发来源；自动重载记 context_overflow，结束后清掉", async () => {
  const root = mkdtempSync(join(tmpdir(), "capitalist-trigger-"));
  const capitalist = join(root, ".capitalist");
  mkdirSync(join(capitalist, "inbox"), { recursive: true });
  mkdirSync(join(root, "out"), { recursive: true });
  writeFileSync(join(root, "out", "b.txt"), "done\n", "utf8");
  /* 配置 200k：180k 已用才够 85% 阈值。 */
  writeFileSync(join(capitalist, "supervisor.json"), JSON.stringify({ supervisor_context_limit: 200_000 }), "utf8");
  const contractPath = join(root, "demo.contract.json");
  writeFileSync(
    contractPath,
    JSON.stringify({
      name: "demo",
      domain: "test",
      context: "工作根 demo。",
      stages: [{ id: "S1", name: "实施", next: "做", done: { type: "file_exists", path: "out/b.txt", msg: "缺 b" } }],
    }),
    "utf8",
  );
  writeFileSync(
    join(capitalist, "state.json"),
    JSON.stringify({
      version: 2,
      target: "触发来源演示",
      contract: "demo",
      contract_path: contractPath,
      stage: "S1",
      next_action: "继续",
      created_at: new Date().toISOString(),
      retry_resets: { "*": "" },
    }),
    "utf8",
  );
  const contract = loadContract(contractPath);

  // 手动重载：trigger = manual
  await beginReload(root, contract, { holdSec: 0 });
  assert.equal(reloadStatus(root).active, false);
  assert.ok(existsSync(join(root, ".capitalist", "reload", "snapshot.json")));
  const events = readFileSync(join(capitalist, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const manual = events.filter((e) => e.event === "supervisor_reload").pop();
  assert.equal(manual.trigger, "manual");

  // 自动重载：trigger = context_overflow
  recordSupervisorContext(root, 180_000, 200_000);
  assert.equal(shouldAutoReload(root).hit, true);
  await beginReload(root, contract, { holdSec: 0, trigger: "context_overflow" });
  const events2 = readFileSync(join(capitalist, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const auto = events2.filter((e) => e.event === "supervisor_reload").pop();
  assert.equal(auto.trigger, "context_overflow");
});
