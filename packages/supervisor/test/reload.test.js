/**
 * 监工上下文重载的回归测试。
 *
 * 钉住四件事，任何一条破了都会让“重载”变成“失忆”：
 *
 * 1. 快照里该有的都在：阶段、已达标验收项、每片状态、未消费插话、未裁决提问、重派计数；
 * 2. 压缩真的在压：心跳/tick 不进简报，需求原文一字不改地留下；
 * 3. done_verified 不重派，done_unverified 必须派复验，且重复调用不重复派；
 * 4. 重载标记会自己清掉（进程崩了不能把看板永久钉在“重载中”）。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { loadContract } = require(join(PKG, "dist/core/contract.js"));
const {
  applyResumePlan,
  beginReload,
  buildReloadContext,
  buildReloadSnapshot,
  buildResumePlan,
  readResumePlan,
  reloadSessionId,
  reloadStatus,
  sessionPath,
  snapshotPath,
} = require(join(PKG, "dist/supervisor/reload.js"));
const { readDispatches } = require(join(PKG, "dist/core/supervisor.js"));

const CONTRACT_CONTEXT = "工作根 D:/demo。禁止 git 写操作。只改 src/ 下的文件。";

/** 建一个带真实台账形状的沙箱任务根。 */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-reload-"));
  const capitalist = join(root, ".capitalist");
  mkdirSync(join(capitalist, "inbox"), { recursive: true });
  mkdirSync(join(root, "out"), { recursive: true });
  writeFileSync(join(root, "out", "b.txt"), "done\n", "utf8");

  const contractPath = join(root, "demo.contract.json");
  writeFileSync(
    contractPath,
    JSON.stringify(
      {
        name: "demo",
        domain: "test",
        context: CONTRACT_CONTEXT,
        env_notes: { summary: "禁止删除文件；只改自己的分片。" },
        stages: [
          {
            id: "S0",
            name: "准备",
            next: "把准备做完",
            done: { type: "file_exists", path: "out/b.txt", msg: "缺 b" },
          },
          {
            id: "S1",
            name: "实施",
            next: "按分片实施",
            parallel: [
              { id: "shard-a", title: "甲片", action: "改 src/a.ts，只动这个文件" },
              { id: "shard-b", title: "乙片", action: "改 src/b.ts" },
              { id: "shard-c", title: "丙片", action: "改 src/c.ts" },
            ],
            done: {
              type: "all_of",
              checks: [
                { type: "file_exists", path: "out/b.txt", msg: "缺 b" },
                { type: "file_exists", path: "out/a.txt", msg: "缺 a" },
              ],
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  writeFileSync(
    join(capitalist, "state.json"),
    JSON.stringify({
      version: 2,
      target: "演示任务",
      contract: "demo",
      contract_path: contractPath,
      stage: "S1",
      next_action: "继续实施",
      created_at: new Date().toISOString(),
      retry_resets: { "*": "" },
    }),
    "utf8",
  );

  /*
   * 三片三种状态：
   *   shard-a  done 但台账里没有确认 -> done_unverified
   *   shard-b  done 且有四项证据齐全的 confirmed -> done_verified
   *   shard-c  review（报完成待确认）-> done_unverified
   */
  const rows = [
    { id: "D-a1", at: "2026-01-01T00:00:00.000Z", stage: "S1", shard: "shard-a", action: "改 src/a.ts", status: "done", attempt: 1, note: "改好了" },
    { id: "D-b1", at: "2026-01-01T00:01:00.000Z", stage: "S1", shard: "shard-b", action: "改 src/b.ts", status: "done", attempt: 1, note: "改好了" },
    { id: "D-c1", at: "2026-01-01T00:02:00.000Z", stage: "S1", shard: "shard-c", action: "改 src/c.ts", status: "review", attempt: 1 },
    { id: "D-a2", at: "2026-01-01T00:03:00.000Z", stage: "S1", shard: "shard-a", action: "改 src/a.ts", status: "failed", attempt: 2 },
    { id: "D-a3", at: "2026-01-01T00:04:00.000Z", stage: "S1", shard: "shard-a", action: "改 src/a.ts", status: "done", attempt: 3, note: "重派后完成" },
  ];
  writeFileSync(join(capitalist, "inbox", "dispatch.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

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

  writeFileSync(
    join(capitalist, "direct.jsonl"),
    [
      JSON.stringify({ at: "2026-01-01T00:06:00.000Z", at_ts: 1, type: "direct", text: "把按钮放到框内", shard: "shard-a", stage: "S1", consumed: false }),
      JSON.stringify({ at: "2026-01-01T00:07:00.000Z", at_ts: 2, type: "direct", text: "这条已经做过了", shard: null, stage: "S1", consumed: true, consumed_by: "D-a1" }),
    ].join("\n") + "\n",
    "utf8",
  );

  writeFileSync(
    join(capitalist, "inbox", "qa.jsonl"),
    JSON.stringify({ id: "Q1", type: "ask", status: "open", at: "2026-01-01T00:08:00.000Z", text: "右栏这两条归谁？", stage: "S1", shard: "" }) + "\n",
    "utf8",
  );

  // 噪声 + 一条决策（推进）
  const events = [];
  for (let i = 0; i < 40; i += 1) {
    events.push({ at: "2026-01-01T00:09:00.000Z", event: "supervisor_tick", n: i, stage: "S1" });
  }
  events.push({ at: "2026-01-01T00:00:00.000Z", event: "supervisor_advance", from: "S0", to: "S1" });
  events.push({ at: "2026-01-01T00:10:00.000Z", event: "heartbeat", pid: 1 });
  events.push({ at: "2026-01-01T00:11:00.000Z", event: "dispatch_open", dispatch: "D-b1", stage: "S1", shard: "shard-b", action: "改 src/b.ts" });
  writeFileSync(join(capitalist, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

  return { root, contract: loadContract(contractPath), contractPath };
}

test("快照：阶段、验收项、每片状态、插话、提问、重派计数都在", () => {
  const { root, contract } = makeRoot();
  const snap = buildReloadSnapshot(root, contract, 1);

  assert.equal(snap.stage, "S1");
  assert.equal(snap.stage_name, "实施");
  assert.equal(snap.target, "演示任务");

  // 需求原文逐字保留（契约 context 与每片 action）
  const ctxReq = snap.requirements.find((r) => r.source === "contract.context");
  assert.equal(ctxReq.text, CONTRACT_CONTEXT);
  assert.ok(snap.requirements.some((r) => r.source === "shard S1/shard-a" && r.text.includes("只动这个文件")));

  // 已达标 / 未达标验收项
  assert.ok(snap.gates.some((g) => g.stage === "S0" && g.ok), "S0 的验收项应达标");
  assert.ok(snap.gates.some((g) => g.stage === "S1" && g.label === "缺 a" && !g.ok), "S1 缺 a 应未达标");

  const byKey = Object.fromEntries(snap.items.map((i) => [i.key, i]));
  assert.equal(byKey["S1/shard-a"].state, "done_unverified", "done 但无台账确认 -> 未验证");
  assert.equal(byKey["S1/shard-b"].state, "done_verified", "有四项证据的 confirmed -> 已验证");
  assert.equal(byKey["S1/shard-c"].state, "done_unverified", "review -> 未验证");
  assert.equal(byKey["S1/shard-a"].retries, 2, "派过三次 -> 重派两次");
  assert.equal(byKey["S1/shard-a"].failures, 0, "最后一张 done 后连续失败清零");

  // 只留未消费的插话；已消费的不再带过去
  assert.equal(snap.directives.length, 1);
  assert.ok(snap.directives[0].text.includes("按钮"));

  // 未裁决提问原样保留
  assert.equal(snap.asks.length, 1);
  assert.equal(snap.asks[0].id, "Q1");

  // 决策结论里有阶段推进
  assert.ok(snap.decisions.some((d) => d.kind === "advance" && d.text === "S0 -> S1"));

  // 文件边界与禁止事项（原文行）
  assert.ok(snap.boundaries.some((b) => b.includes("禁止删除文件")));
});

test("压缩：丢心跳与 tick，留需求原文与待复验清单", () => {
  const { root, contract } = makeRoot();
  const snap = buildReloadSnapshot(root, contract, 1);
  const out = buildReloadContext(snap);

  assert.ok(out.text.includes("禁止 git 写操作"), "需求原文必须原样出现");
  assert.ok(out.text.includes("待复验"), "待复验清单要有独立小节");
  assert.ok(out.text.includes("S1/shard-a"), "未验证的条目要点名");
  assert.ok(!out.text.includes("supervisor_tick"), "心跳/tick 不得进简报");
  assert.ok(!out.text.includes("心跳"), "心跳不得进简报");
  assert.ok(snap.metrics.events_dropped >= 41, "40 条 tick + 1 条心跳应被丢弃");
  assert.ok(out.chars < snap.metrics.before_chars, "压缩后必须比原始台账小");
});

test("恢复计划：已验证跳过，未验证必派复验，且不重复派", () => {
  const { root, contract } = makeRoot();
  const snap = buildReloadSnapshot(root, contract, 1);
  const plan = buildResumePlan(snap);

  assert.deepEqual(plan.skip.map((s) => s.key), ["S1/shard-b"]);
  assert.deepEqual(plan.reverify.map((r) => r.key).sort(), ["S1/shard-a", "S1/shard-c"]);

  mkdirSync(join(root, ".capitalist", "reload"), { recursive: true });
  writeFileSync(join(root, ".capitalist", "reload", "resume.json"), JSON.stringify(plan), "utf8");
  const first = applyResumePlan(root, "S1", () => {});
  assert.equal(first, 2, "两片未验证 -> 两张复验单");

  const rows = readDispatches(root);
  const reverify = rows.filter((d) => d.source === "reverify");
  assert.equal(reverify.length, 2);
  assert.ok(reverify.every((d) => d.action.includes("复验（不是重做）")));

  const second = applyResumePlan(root, "S1", () => {});
  assert.equal(second, 0, "已有在途复验单时不得重复派");

  // 复验单结单后：条目转为已验证，不再派
  const rows2 = readDispatches(root).map((d) => (d.source === "reverify" ? { ...d, status: "done", done_at: new Date().toISOString() } : d));
  writeFileSync(join(root, ".capitalist", "inbox", "dispatch.jsonl"), rows2.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const third = applyResumePlan(root, "S1", () => {});
  assert.equal(third, 0);
  const after = readResumePlan(root);
  assert.equal(after.state["S1/shard-a"].state, "verified");
  assert.equal(after.state["S1/shard-c"].state, "verified");
});

test("复验结单后，新一次重载把它记为已验证（不重复复验）", () => {
  const { root, contract } = makeRoot();
  const snap1 = buildReloadSnapshot(root, contract, 1);
  const plan = buildResumePlan(snap1);
  mkdirSync(join(root, ".capitalist", "reload"), { recursive: true });
  writeFileSync(join(root, ".capitalist", "reload", "resume.json"), JSON.stringify(plan), "utf8");
  applyResumePlan(root, "S1", () => {});

  const rows = readDispatches(root).map((d) =>
    d.source === "reverify" ? { ...d, status: "done", done_at: new Date().toISOString() } : d,
  );
  writeFileSync(join(root, ".capitalist", "inbox", "dispatch.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  applyResumePlan(root, "S1", () => {});

  const snap2 = buildReloadSnapshot(root, contract, 2);
  const byKey = Object.fromEntries(snap2.items.map((i) => [i.key, i]));
  assert.equal(byKey["S1/shard-a"].state, "done_verified", "复验单结单 -> 已验证");
  assert.equal(byKey["S1/shard-c"].state, "done_verified");
  const plan2 = buildResumePlan(snap2);
  assert.equal(plan2.reverify.length, 0, "已验证的不得再进复验清单");
});

test("重载：代次递增、换会话、结束清标记、active 会被看到", async () => {
  const { root, contract } = makeRoot();

  const sum1 = await beginReload(root, contract);
  assert.equal(sum1.gen, 1);
  assert.equal(sum1.session_id, "capitalist-chat-r1");
  assert.equal(sum1.skip, 1);
  assert.equal(sum1.reverify, 2);
  assert.ok(existsSync(snapshotPath(root)));
  const ctxText = readFileSync(join(root, ".capitalist", "reload", "context.md"), "utf8");
  assert.ok(ctxText.includes("阶段目标"), "简报要把契约原文标成阶段目标，不是待办清单");
  assert.ok(ctxText.includes("以派单为准"), "简报要声明冲突时以派单为准");
  assert.equal(reloadStatus(root).active, false, "重载结束后标记必须清掉");
  assert.equal(reloadSessionId(root), "capitalist-chat-r1");

  const sum2 = await beginReload(root, contract);
  assert.equal(sum2.gen, 2);
  assert.equal(reloadSessionId(root), "capitalist-chat-r2", "换代次必须换会话");
});

test("旧阶段的待确认单只记录、不派复验（派了会被当过期单作废）", () => {
  const { root, contract } = makeRoot();
  const file = join(root, ".capitalist", "inbox", "dispatch.jsonl");
  const rows = readDispatches(root);
  rows.push({ id: "D-old", at: "2026-01-01T00:00:00.000Z", stage: "S0", shard: "old", action: "旧阶段的活", status: "review", attempt: 1 });
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  const snap = buildReloadSnapshot(root, contract, 1);
  const item = snap.items.find((i) => i.key === "S0/old");
  assert.ok(item, "旧阶段的待确认单也要进快照");
  assert.equal(item.state, "done_unverified");
  assert.equal(item.in_contract, false);

  const plan = buildResumePlan(snap);
  assert.equal(plan.reverify.some((r) => r.key === "S0/old"), false, "旧阶段不派复验");
  assert.ok(plan.deferred.some((d) => d.key === "S0/old"), "但必须留在 deferred 里，不许悄悄丢");
});

test("崩溃留下的 active 标记会过期清理", () => {
  const { root } = makeRoot();
  mkdirSync(join(root, ".capitalist", "reload"), { recursive: true });
  const marker = join(root, ".capitalist", "reload", "active.json");
  writeFileSync(marker, JSON.stringify({ gen: 3, phase: "compress", pid: 1, started_at: "2020-01-01T00:00:00.000Z", at_ts: 1 }), "utf8");
  const st = reloadStatus(root);
  assert.equal(st.active, false, "过期标记不能算重载中");
  assert.equal(existsSync(marker), false, "过期标记应被清掉");

  writeFileSync(marker, JSON.stringify({ gen: 4, phase: "compress", pid: process.pid, started_at: new Date().toISOString(), at_ts: Date.now() / 1000 }), "utf8");
  assert.equal(reloadStatus(root).active, true);
  assert.equal(reloadStatus(root).phase, "compress");
});
