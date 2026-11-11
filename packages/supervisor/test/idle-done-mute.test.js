/** 空转时的“任务完成”不上任何用户可见的入口。 */

const test = require("node:test");
const assert = require("node:assert");
const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const board = require(join(PKG, "dist/supervisor/board.js"));
const { createTaskRoot } = require(join(PKG, "dist/core/init.js"));
const { recordEvent } = require(join(PKG, "dist/core/ledger.js"));

const STAGE = "WORK";

/** 建一个任务根；传 contract 时预置到 <root>/contracts 下。 */
function sandbox(contract) {
  const root = mkdtempSync(join(tmpdir(), "capitalist-idle-done-"));
  const dirs = [join(root, "contracts")];
  if (contract) {
    mkdirSync(dirs[0], { recursive: true });
    writeFileSync(join(dirs[0], `${contract.name}.contract.json`), JSON.stringify(contract, null, 2), "utf8");
  }
  createTaskRoot({
    target: "空转静默",
    contractSpec: contract ? contract.name : "generic",
    root,
    supervisor: false,
    contractDirs: dirs,
  });
  return root;
}

/** 台账里铺一批空转拍子：supervisor_tick / supervisor_done 成对，外加一条别的派单事件。 */
function seedIdleTicks(root, times = 3) {
  for (let i = 0; i < times; i += 1) {
    recordEvent(root, "supervisor_tick", { n: i + 1, stage: STAGE });
    recordEvent(root, "supervisor_done", { stage: STAGE, target: "空转静默" });
  }
  recordEvent(root, "dispatch_done", { dispatch: "D-x", stage: STAGE });
}

const singleStage = {
  name: "ledgeronly",
  version: 1,
  description: "只按派单干活，没有工序",
  stages: [{ id: STAGE, name: "执行", goal: "", next: "", parallel: [], done: { type: "none" } }],
  redlines: [],
};

const multiStage = {
  name: "twostage",
  version: 1,
  description: "两阶段",
  stages: [
    { id: "S1", name: "一", goal: "", next: "S2", parallel: [], done: { type: "none" } },
    { id: "S2", name: "二", goal: "", next: "", parallel: [], done: { type: "none" } },
  ],
  redlines: [],
};

test("单阶段契约：空转的 supervisor_done 不进监工流", () => {
  const root = sandbox(singleStage);
  try {
    seedIdleTicks(root);
    const log = board.buildSupervisorLog(root, { hours: 0, limit: 400 });
    const done = log.messages.filter((m) => m.event === "supervisor_done");
    assert.deepStrictEqual(done, [], "单阶段契约没有收工这一刻，不许上屏");
    assert.ok(
      !log.messages.some((m) => String(m.text ?? "").includes("任务完成")),
      "更不许出现“任务完成”气泡",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("单阶段契约：空转的 supervisor_done 不进告警", () => {
  const root = sandbox(singleStage);
  try {
    seedIdleTicks(root);
    const { alerts } = board.buildAlerts(root, {});
    assert.ok(
      !alerts.some((a) => a.event === "supervisor_done"),
      "每拍一条 P1 会把未读与通知刷满",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("单阶段契约：空转的 supervisor_done 不进事件流水，其余事件照旧", () => {
  const root = sandbox(singleStage);
  try {
    seedIdleTicks(root);
    const feed = board.buildFeed(root, 40);
    assert.ok(!feed.some((e) => e.event === "supervisor_done"), "流水里不许有收工");
    assert.ok(feed.some((e) => e.event === "dispatch_done"), "别的派单事件不能被一起吞掉");

    const snap = board.buildSnapshot(root);
    assert.ok(!snap.feed.some((e) => e.event === "supervisor_done"), "快照流水同样不许有");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("多阶段契约：收工照旧上屏（回归守卫）", () => {
  const root = sandbox(multiStage);
  try {
    seedIdleTicks(root);
    const log = board.buildSupervisorLog(root, { hours: 0, limit: 400 });
    assert.ok(
      log.messages.some((m) => m.event === "supervisor_done"),
      "多阶段契约的收工是真实结论，不能被静默规则吞掉",
    );
    const { alerts } = board.buildAlerts(root, {});
    assert.ok(alerts.some((a) => a.event === "supervisor_done"), "多阶段收工仍要告警");
    assert.ok(
      board.buildFeed(root, 40).some((e) => e.event === "supervisor_done"),
      "多阶段收工仍进流水",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("台账仍保留记录：静默只发生在投影层", () => {
  const root = sandbox(singleStage);
  try {
    seedIdleTicks(root);
    const events = join(root, ".capitalist", "events.jsonl");
    assert.ok(existsSync(events), "事件台账还在");
    const raw = require("node:fs").readFileSync(events, "utf8");
    assert.ok(raw.includes('"supervisor_done"'), "台账里的收工记录不许被删");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("恢复调度且空闲：不再生成任何空闲提示", () => {
  const root = sandbox(singleStage);
  try {
    seedIdleTicks(root);
    recordEvent(root, "pause_cleared", { by: "user" });

    const log = board.buildSupervisorLog(root, { hours: 0, limit: 400 });
    assert.strictEqual(
      log.messages.filter((m) => m.event === "supervisor_idle").length,
      0,
      "空闲提示整条撤掉，不许再生成",
    );
    assert.ok(
      !log.messages.some((m) => String(m.text ?? "").includes("监工空闲")),
      "也不许换个 id 继续发同一句话",
    );
    assert.ok(
      !log.messages.some((m) => String(m.text ?? "").includes("AI 多进程智能调度工具")),
      "能力介绍那版文案同样不许出现",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("恢复之后又派过单 / 仍有排队：照样没有空闲提示（静默是常态）", () => {
  const root = sandbox(singleStage);
  try {
    seedIdleTicks(root);
    recordEvent(root, "pause_cleared", { by: "user" });
    recordEvent(root, "dispatch_open", { dispatch: "D-later", stage: STAGE });

    const log = board.buildSupervisorLog(root, { hours: 0, limit: 400 });
    assert.strictEqual(log.messages.filter((m) => m.event === "supervisor_idle").length, 0);
    assert.ok(!log.messages.some((m) => String(m.text ?? "").includes("监工空闲")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
