
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const PKG = resolve(__dirname, "..");
const {
  CTX_COMPACT_DROP_RATIO,
  beginReload,
  ctxDropIsCompaction,
  recordSupervisorContext,
  readSupervisorContext,
} = require(join(PKG, "dist/supervisor/reload.js"));
const { loadContract } = require(join(PKG, "dist/core/contract.js"));
const { zhEvent } = require(join(PKG, "dist/supervisor/terms.js"));
const { supervisorActivityOf } = require(join(PKG, "dist/supervisor/activity.js"));
const { buildSupervisorLog } = require(join(PKG, "dist/supervisor/board.js"));

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-compact-"));
  mkdirSync(join(root, ".capitalist"), { recursive: true });
  writeFileSync(
    join(root, ".capitalist", "supervisor.json"),
    JSON.stringify({ heartbeat_ts: Date.now() / 1000, supervisor_context_limit: 1_000_000 }),
    "utf8",
  );
  return root;
}

function eventsOf(root) {
  const file = join(root, ".capitalist", "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function compactedEvents(root) {
  return eventsOf(root).filter((e) => (e.event ?? e.kind) === "context_compacted");
}

function setSessionGen(root, gen, sessionId) {
  mkdirSync(join(root, ".capitalist", "reload"), { recursive: true });
  writeFileSync(
    join(root, ".capitalist", "reload", "session.json"),
    JSON.stringify({ gen, session_id: sessionId, at: new Date().toISOString(), brief_chars: 0 }),
    "utf8",
  );
}


test("骤降判定：刚好腰斩才算，稍高于一半不算", () => {
  assert.equal(CTX_COMPACT_DROP_RATIO, 0.5);
  assert.equal(ctxDropIsCompaction(200_000, 100_000), true, "刚好 50% 是压缩");
  assert.equal(ctxDropIsCompaction(200_000, 100_001), false, "只掉 49.9995% 不算");
  assert.equal(ctxDropIsCompaction(200_000, 190_000), false, "正常波动不算");
  assert.equal(ctxDropIsCompaction(200_000, 0), false, "掉到 0 不是读数，不能当压缩");
  assert.equal(ctxDropIsCompaction(0, 0), false);
  assert.equal(ctxDropIsCompaction(null, 100_000), false);
  assert.equal(ctxDropIsCompaction(200_000, null), false);
});


test("同代同口径骤降 → 一条 inferred 事件，字段齐全", () => {
  const root = sandbox();
  recordSupervisorContext(root, 240_000, 600_000, "model-a");
  recordSupervisorContext(root, 120_000, 600_000, "model-a");

  const hits = compactedEvents(root);
  assert.equal(hits.length, 1, `应记录一条压缩事件，实际 ${hits.length} 条`);
  const e = hits[0];
  assert.equal(e.kind, "context_compacted", "kind 与 event 双写");
  assert.equal(e.event, "context_compacted");
  assert.equal(e.scope, "capitalist");
  assert.equal(e.session, "capitalist-chat", "未重载过时是默认会话");
  assert.equal(e.before_used, 240_000);
  assert.equal(e.after_used, 120_000);
  assert.equal(e.limit, 600_000, "生效上限 = min(配置 1M, 读数窗口 600k)");
  assert.equal(e.source, "inferred", "推断必须与重载区分");
  assert.ok(e.at, "事件自带时刻");

  /* 再掉一点点（100k 仍低于 60k? 不：100k > 60k），不是腰斩，不重复记。 */
  recordSupervisorContext(root, 100_000, 600_000, "model-a");
  assert.equal(compactedEvents(root).length, 1, "未腰斩的下降不记第二条");
});

test("换代不推断：重载换会话由 reload 来源负责", () => {
  const root = sandbox();
  recordSupervisorContext(root, 300_000, 600_000, "model-a");
  setSessionGen(root, 1, "capitalist-chat-r1");
  recordSupervisorContext(root, 40_000, 600_000, "model-a");
  assert.equal(compactedEvents(root).length, 0, "新会话第一次读数不能与老会话比较");
});

test("读数口径切换不推断：估算值换真读数不是压缩", () => {
  const root = sandbox();
  recordSupervisorContext(root, 400_000, 600_000, "model-a", true);
  recordSupervisorContext(root, 80_000, 600_000, "model-a", false);
  assert.equal(compactedEvents(root).length, 0, "估算与真读数互换只说明口径变了");
});


function reloadSandbox() {
  const root = sandbox();
  const contractPath = join(root, "demo.contract.json");
  writeFileSync(
    contractPath,
    JSON.stringify({
      name: "demo",
      domain: "test",
      context: "工作根 D:/demo。只改 src/ 下的文件。",
      stages: [{ id: "S1", name: "实施", next: "继续实施", parallel: [{ id: "a", title: "甲片", action: "改 a" }] }],
      redlines: [],
    }),
    "utf8",
  );
  writeFileSync(
    join(root, ".capitalist", "state.json"),
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
  return { root, contract: loadContract(contractPath) };
}

test("重载 → reload 来源的压缩事件，进入监工流并显示「已压缩」", async () => {
  const { root, contract } = reloadSandbox();
  recordSupervisorContext(root, 520_000, 600_000, "model-a");

  const summary = await beginReload(root, contract, { holdSec: 0, trigger: "context_overflow", out: () => {} });

  const hits = compactedEvents(root);
  assert.equal(hits.length, 1, "一次重载只记一条压缩事件");
  const e = hits[0];
  assert.equal(e.scope, "capitalist");
  assert.equal(e.source, "reload");
  assert.equal(e.before_used, 520_000);
  assert.equal(e.after_used, null, "新会话还没有读数，不能拿 0 冒充");
  assert.equal(e.session, "capitalist-chat", "压缩发生在被换掉的会话上");
  assert.equal(e.next_session, summary.session_id);
  assert.equal(e.limit, 600_000, "生效上限 = min(配置 1M, 读数窗口 600k)");
  assert.ok(e.at);

  /* 卡片标签与正文：标签来自 terms.ts 的同一张表，正文说明来源是重载。 */
  assert.equal(zhEvent("context_compacted"), "已压缩");
  const log = buildSupervisorLog(root, { limit: 50, hours: 1 });
  const card = log.messages.find((m) => m.event === "context_compacted");
  assert.ok(card, "压缩卡片必须进入监工流");
  assert.equal(card.tier, "main", "压缩是会话层事实，不收进过程日志");
  assert.match(card.text, /监工对话上下文已压缩/);
  assert.match(card.text, /520k token → 新会话/);
  assert.match(card.text, /来源：上下文重载/);
  assert.doesNotMatch(card.text, /推断/, "重载是事实，不能写成推断");
});

test("推断事件进监工流：正文标明「读数骤降推断，不是宿主事件」", () => {
  const root = sandbox();
  recordSupervisorContext(root, 240_000, 600_000, "model-a");
  recordSupervisorContext(root, 90_000, 600_000, "model-a");

  const log = buildSupervisorLog(root, { limit: 50, hours: 1 });
  const card = log.messages.find((m) => m.event === "context_compacted");
  assert.ok(card, "推断出来的压缩同样上屏");
  assert.match(card.text, /240k → 90k token/);
  assert.match(card.text, /读数骤降推断，不是宿主事件/, "推断不能被写成已确认的事实");
});


test("状态气泡：重载中 compacting → 「压缩中」，结束后回到原口径", async () => {
  assert.deepStrictEqual(supervisorActivityOf({ reloading: true }), { kind: "compacting", action: "reload" });
  assert.deepStrictEqual(supervisorActivityOf({ reloading: true, action: "chat", running: 2 }), {
    kind: "compacting",
    action: "reload",
  }, "重载是此刻的真实动作，优先于对话/调度");
  assert.deepStrictEqual(supervisorActivityOf({ reloading: false, action: "chat", running: 2 }), {
    kind: "supervising",
    action: "chat",
  });
  assert.deepStrictEqual(supervisorActivityOf({ reloading: false, hasPendingReceipt: true, running: 0 }), {
    kind: "receipt",
    action: "triage",
  });

  /* 界面语言取自运行环境：Node 22 起 `navigator.language` 为 en-US，不显式设中文会让这张表返回英文。
     直接改 `lang`：`setLang` 末尾要写 `<html lang>`，测试环境没有 document。 */
  const i18n = await import(pathToFileURL(join(PKG, "web/src/lib/i18n.js")).href);
  i18n.lang.value = "zh";

  const doing = await import(pathToFileURL(join(PKG, "web/src/lib/doing.js")).href);
  assert.equal(doing.supervisorActivityText({ kind: "compacting" }), "压缩中");
  assert.equal(doing.CAPITALIST_ACTIVITY_TEXT.receipt, "回执中");
  assert.equal(doing.CAPITALIST_ACTIVITY_TEXT.supervising, "监管中");
  assert.equal(doing.CAPITALIST_ACTIVITY_TEXT.thinking, "思考中");
});
