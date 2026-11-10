
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/supervisor");
const { createTaskRoot } = require("../dist/core/init");
const { appendMq } = require("../dist/core/mq");
const { recordEvent } = require("../dist/core/ledger");
const { buildThreadMessages } = require("../dist/supervisor/board");

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-mq-"));
  createTaskRoot({ target: "申报面板", contractSpec: "minimal", root: base });
  mkdirSync(join(base, ".capitalist", "workers"), { recursive: true });
  return base;
}

function seed(root) {
  const now = new Date().toISOString();
  const dispatch = "D-mq-full-1";
  const worker = "W-mq-full-1";
  const log = join(root, ".capitalist", "workers", `${worker}.log`);
  writeFileSync(log, "这一片只做 a\n", "utf8");
  capitalist.appendDispatch(root, {
    id: dispatch,
    at: now,
    stage: "S0",
    shard: "a",
    action: "按原文显示申报与回执",
    status: "claimed",
    worker,
  });
  capitalist.registerWorker(root, {
    id: worker,
    host: "generic",
    pid: 4101,
    session: worker,
    dispatch,
    stage: "S0",
    shard: "a",
    started_at: now,
    heartbeat_at: now,
    heartbeat_ts: Date.now() / 1000,
    status: "running",
    log,
  });
  return { dispatch, worker, now };
}

test("申报按 reports.jsonl 原文整篇下发，事件台账的 400 字截断不再是上限", () => {
  const root = sandbox();
  const { dispatch, worker } = seed(root);
  const tail = "TAIL-申报正文末尾";
  const full = `${"长".repeat(600)}${tail}`;
  const msg = appendMq(root, {
    from: worker,
    dispatch,
    stage: "S0",
    shard: "a",
    kind: "stuck",
    severity: "warn",
    text: full,
    evidence: "EVIDENCE-证据原文",
    needs: "none",
  });
  /* 生产侧记事件时只留前 400 字，这里照原样模拟，验证面板不吃这份截断。 */
  recordEvent(root, "mq_message", {
    id: msg.id,
    from: worker,
    dispatch,
    stage: "S0",
    shard: "a",
    kind: "stuck",
    severity: "warn",
    needs: "none",
    text: full.slice(0, 400),
    evidence: "",
  });

  const rows = buildThreadMessages(root, "s0/a", "a", { limit: 400 }).messages;
  const hit = rows.find((m) => m.event === "mq_message");
  assert.ok(hit, "申报必须出现在任务消息面板");
  assert.doesNotMatch(hit.text, /申报类型：/);
  assert.doesNotMatch(hit.text, /来自进程/);
  assert.ok(hit.text.startsWith("长"), `申报正文应直接从内容开始，实际开头 ${hit.text.slice(0, 12)}`);
  assert.ok(hit.text.length > 600, `申报正文应超过事件里的 400 字，实际 ${hit.text.length}`);
  assert.ok(hit.text.includes(tail), "申报末尾必须完整下发");
  assert.ok(hit.text.includes("EVIDENCE-证据原文"), "证据也要完整下发");
  assert.strictEqual(hit.status, "pending");
  assert.strictEqual(hit.kind, "verdict");
});

test("回执按 msg 回查所属派单进入任务面板，并标成已回执", () => {
  const root = sandbox();
  const { dispatch, worker } = seed(root);
  const msg = appendMq(root, {
    from: worker,
    dispatch,
    stage: "S0",
    shard: "a",
    kind: "question",
    severity: "warn",
    text: "要求自相矛盾，需要方向",
    needs: "decision",
  });
  recordEvent(root, "mq_message", {
    id: msg.id,
    from: worker,
    dispatch,
    stage: "S0",
    shard: "a",
    kind: "question",
    severity: "warn",
    needs: "decision",
    text: "要求自相矛盾，需要方向",
  });
  recordEvent(root, "mq_triage", {
    msg: msg.id,
    from: worker,
    decision: "nudge",
    why: "WHY-判定理由原文",
    say: "SAY-回给进程的话",
    fallback: false,
  });

  const rows = buildThreadMessages(root, "s0/a", "a", { limit: 400 }).messages;
  const said = rows.find((m) => m.event === "mq_message");
  const receipt = rows.find((m) => m.event === "mq_triage");
  assert.ok(receipt, "回执必须出现在任务消息面板（mq_triage 自带 msg，不带 dispatch）");
  assert.match(receipt.text, /处理结论：已纠正方向/);
  assert.match(receipt.text, /WHY-判定理由原文/);
  assert.match(receipt.text, /SAY-回给进程的话/);
  assert.strictEqual(said.status, "done", "已有回执的申报应标成已回执");
});
