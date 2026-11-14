/** 附件只属于“带它的那条消息”。 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { buildThreadMessages } = require(join(PKG, "dist/supervisor/board"));
const { appendDirective, listDirectives } = require(join(PKG, "dist/core/commands.js"));
const { appendDispatch, readDispatches } = require(join(PKG, "dist/core/supervisor.js"));
const { createTaskRoot } = require(join(PKG, "dist/core/init.js"));
const { loadState } = require(join(PKG, "dist/core/state.js"));
const { readJsonl } = require(join(PKG, "dist/core/json.js"));
const { eventsPath } = require(join(PKG, "dist/core/ledger.js"));
const loop = require(join(PKG, "dist/supervisor/loop.js"));
const { appendSupervisorDirective } = require(join(PKG, "dist/supervisor/direct.js"));

const IMG = ".capitalist/attachments/a.png";

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-attach-"));
  mkdirSync(join(root, ".capitalist", "inbox"), { recursive: true });
  mkdirSync(join(root, ".capitalist", "workers"), { recursive: true });
  return root;
}

test("连发两条消息：第二条只有文字，读回来的消息不带附件", () => {
  const root = scratch();
  try {
    writeFileSync(
      join(root, ".capitalist", "direct.jsonl"),
      [
        {
          at: "2026-11-01T10:00:00.000Z",
          at_ts: 1,
          type: "direct",
          text: `第一条：看这张图\n\n[附件] ${IMG}`,
          shard: "attach-probe",
          stage: "U6",
          consumed: true,
          atts: [IMG],
        },
        {
          at: "2026-11-01T10:01:00.000Z",
          at_ts: 2,
          type: "direct",
          text: "第二条：只有文字",
          shard: "attach-probe",
          stage: "U6",
          consumed: true,
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );

    const { messages } = buildThreadMessages(root, "shard:attach-probe", "attach-probe", {});
    const said = messages.filter((m) => m.role === "user");
    assert.strictEqual(said.length, 2, "两条用户消息都要在");
    assert.deepStrictEqual(said[0].atts, [IMG], "第一条带自己的图");
    assert.strictEqual(said[1].atts, undefined, "第二条是纯文字：不许带上一条的图");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("老记录没有 atts 字段时，只从自己正文里解，不跨条借", () => {
  const root = scratch();
  try {
    writeFileSync(
      join(root, ".capitalist", "direct.jsonl"),
      [
        { at: "2026-11-01T10:00:00.000Z", at_ts: 1, type: "direct", text: `图\n\n[附件] ${IMG}`, shard: "legacy" },
        { at: "2026-11-01T10:01:00.000Z", at_ts: 2, type: "direct", text: "纯文字", shard: "legacy" },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    const { messages } = buildThreadMessages(root, "shard:legacy", "legacy", {});
    const said = messages.filter((m) => m.role === "user");
    assert.deepStrictEqual(said[0].atts, [IMG]);
    assert.strictEqual(said[1].atts, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appendDirective 把附件写进自己的记录", () => {
  const root = scratch();
  try {
    const rec = appendDirective(root, { text: `看这张\n\n[附件] ${IMG}`, shard: "s1" });
    assert.ok(rec, "记录要落盘");
    assert.deepStrictEqual(rec.atts, [IMG]);
    const back = listDirectives(root).pop();
    assert.deepStrictEqual(back.atts, [IMG], "读回来的记录里也有自己那份附件");
    const plain = appendDirective(root, { text: "纯文字", shard: "s1" });
    assert.strictEqual(plain.atts, undefined, "纯文字记录不写 atts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("派单不继承上一条消息的附件；同一条重派链仍然接手", () => {
  const root = scratch();
  try {
    const base = { at: new Date().toISOString(), stage: "U6", status: "failed" };
    appendDispatch(root, { id: "A", ...base, shard: "", source: "adhoc", attempt: 1, lineage: "A", action: `看这张\n\n[附件] ${IMG}` });
    appendDispatch(root, { id: "B", ...base, shard: "", source: "adhoc", attempt: 1, lineage: "B", action: "另一条消息，只有文字" });
    appendDispatch(root, { id: "C", ...base, shard: "", source: "stage", attempt: 1, lineage: "C", action: "阶段派单" });

    const rows = readDispatches(root);
    const byId = Object.fromEntries(rows.map((d) => [d.id, d]));
    assert.ok(!String(byId.B.action).includes("[附件]"), "新消息不许继承上一条的图");
    assert.ok(!String(byId.C.action).includes("[附件]"), "阶段派单同样不许继承");

    /* 重派：同一血缘、上一张没结单，用户交的图必须跟过去（另一条既有要求）。 */
    appendDispatch(root, { id: "A2", ...base, shard: "", source: "requeue", attempt: 2, lineage: "A", action: "重派同一件事" });
    const a2 = readDispatches(root).find((d) => d.id === "A2");
    assert.ok(String(a2.action).includes(`[附件] ${IMG}`), "重派要接手这张图");
    assert.deepStrictEqual(a2.atts_inherited, [IMG]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


/** 附件在组单那一刻绑定：只把选中的截图写进工作进程的消息。 */
const MINE = ".capitalist/attachments/mine.png";
const OTHER = ".capitalist/attachments/other.png";

function bindSandbox() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-bind-"));
  createTaskRoot({ target: "附件绑定", contractSpec: "minimal", root });
  return root;
}

async function runDirectives(root) {
  await loop.__testing.applySupervisorDirectives({
    root,
    contract: { stages: [], data: {} },
    state: loadState(root),
    wopts: {},
    concurrency: null,
    out: () => {},
  });
}

function eventNames(root) {
  return readJsonl(eventsPath(root)).map((e) => String(e.event ?? ""));
}

test("dispatch 组单只注入选中的图：未选中的路径不进正文、不记丢弃事件", async () => {
  const root = bindSandbox();
  try {
    appendSupervisorDirective(root, {
      action: "dispatch",
      arg: `[ui] 修这个按钮\n\n[附件] ${OTHER}`,
      atts: [MINE],
    });
    await runDirectives(root);

    const d = readDispatches(root).find((x) => x.source === "adhoc");
    assert.ok(d, "单已建");
    assert.deepStrictEqual(d.atts, [MINE], "字段只记选中的那张");
    assert.ok(String(d.action).includes(`[附件] ${MINE}`), "选中的图写进正文");
    assert.ok(!String(d.action).includes(OTHER), "模型抄进来的未选路径不进正文");
    assert.ok(!eventNames(root).includes("attachments_foreign_dropped"), "不再记“丢弃附件”事件");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("amend 组单只注入选中的图：追加记录里也只留选中的那张", async () => {
  const root = bindSandbox();
  try {
    appendDispatch(root, {
      id: "D-live",
      at: new Date().toISOString(),
      stage: "S0",
      shard: "",
      action: "在途的这一单",
      status: "open",
      source: "adhoc",
      attempt: 1,
      lineage: "D-live",
    });
    appendSupervisorDirective(root, {
      action: "amend",
      arg: `补一句说明\n\n[附件] ${OTHER}`,
      atts: [MINE],
      target: "D-live",
    });
    await runDirectives(root);

    const rec = listDirectives(root).find((x) => String(x.target ?? "") === "D-live");
    assert.ok(rec, "追加记录已落盘");
    assert.deepStrictEqual(rec.atts, [MINE], "追加记录只带选中的图");
    assert.ok(String(rec.text).includes(`[附件] ${MINE}`), "选中的图在追加话术里");
    assert.ok(!String(rec.text).includes(OTHER), "未选中的路径不进追加话术");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
