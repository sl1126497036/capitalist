
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/record/supervisor");
const { createTaskRoot } = require("../dist/core/contract/init");
const { recordEvent } = require("../dist/core/record/ledger");
const {
  buildSupervisorLog,
  buildThreadMessages,
  buildSupervisorStatus,
} = require("../dist/supervisor/board");

const HEARTBEAT = [
  "supervisor_tick",
  "tick_window",
  "dispatch_orphan",
  "dispatch_retry",
  "dispatch_forced_finished",
  "dispatch_reaped",
  "redispatch_capped",
  "worker_gone",
  "worker_killed",
  "worker_looping_killed",
  "worker_heartbeat_rescued",
  "worker_reaped",
  "stage_stalled",
];

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-iso-"));
  createTaskRoot({ target: "会话隔离", contractSpec: "minimal", root: base });
  mkdirSync(join(base, ".capitalist", "workers"), { recursive: true });
  return base;
}

/** 三个 worker，各自一份能认出来的日志正文。 */
function threeWorkers(root) {
  const now = new Date().toISOString();
  const made = [];
  for (const [shard, mark] of [
    ["a", "ONLY-A-正文"],
    ["b", "ONLY-B-正文"],
    ["c", "ONLY-C-正文"],
  ]) {
    const id = `W-iso-${shard}`;
    const dispatch = `D-iso-${shard}`;
    const log = join(root, ".capitalist", "workers", `${id}.log`);
    writeFileSync(log, `${mark}：这一片只做 ${shard}\n${mark}：第二行\n`, "utf8");
    capitalist.appendDispatch(root, {
      id: dispatch,
      at: now,
      stage: "S0",
      shard,
      action: `ACTION-${shard} 这一片只做 ${shard}`,
      status: "claimed",
      worker: id,
    });
    capitalist.registerWorker(root, {
      id,
      host: "generic",
      pid: 4000 + made.length,
      session: id,
      dispatch,
      stage: "S0",
      shard,
      started_at: now,
      heartbeat_at: now,
      heartbeat_ts: Date.now() / 1000,
      status: "running",
      log,
    });
    made.push({ id, shard, mark, dispatch });
  }
  return made;
}

function supervisorMessages(root) {
  return buildSupervisorLog(root, { limit: 400, hours: 6 }).messages;
}

test("监工流里没有 worker 的过程消息：带 thread 的对话按进程归位", () => {
  const root = sandbox();
  threeWorkers(root);
  recordEvent(root, "supervisor_chat_ask", { text: "SUPERVISOR-ONLY：这是对监工说的", thread: "" });
  recordEvent(root, "supervisor_reply", { reply: "SUPERVISOR-ONLY：监工的回答", thread: "" });
  /* 三个 worker 会话里各自的对话，故意带同样的正文，只有 thread 不同。 */
  for (const shard of ["a", "b", "c"]) {
    recordEvent(root, "supervisor_chat_ask", {
      text: `WORKER-ONLY-${shard}：只在 ${shard} 这一片`,
      thread: `s0/${shard}`,
      from: "user",
    });
    recordEvent(root, "supervisor_reply", {
      reply: `WORKER-ONLY-${shard}：只在 ${shard} 这一片的回话`,
      thread: `s0/${shard}`,
      from: "supervisor",
    });
  }

  const msgs = supervisorMessages(root);
  const text = msgs.map((m) => m.text).join("\n");
  assert.ok(text.includes("SUPERVISOR-ONLY"), "监工自己的对话必须留在监工流");
  for (const shard of ["a", "b", "c"]) {
    assert.ok(!text.includes(`WORKER-ONLY-${shard}`), `worker ${shard} 的对话不得串进监工流`);
  }
  /* 任何一条带 worker 线程 id 的消息都不该出现。 */
  for (const m of msgs) {
    const t = String(m.thread || "");
    assert.ok(t === "" || t === "capitalist" || t === "capitalist:main", `监工流混进了线程 ${t} 的消息`);
  }
});

test("三个 worker 会话各自只看到自己的日志", () => {
  const root = sandbox();
  const made = threeWorkers(root);
  for (const w of made) {
    const r = buildThreadMessages(root, `s0/${w.shard}`, w.shard, { limit: 400 });
    const text = r.messages.map((m) => m.text).join("\n");
    assert.ok(text.includes(w.mark), `${w.shard} 应当看到自己的日志`);
    for (const other of made) {
      if (other.shard === w.shard) continue;
      assert.ok(!text.includes(other.mark), `${w.shard} 看到了 ${other.shard} 的日志`);
    }
  }
});

test("心跳链路一条都不进监工流，异常只留台账", () => {
  const root = sandbox();
  threeWorkers(root);
  for (const name of HEARTBEAT) {
    recordEvent(root, name, { shard: "a", dispatch: "D-iso-a", worker: "W-iso-a", stale: true, limit: 3 });
  }
  recordEvent(root, "dispatch_failed", { dispatch: "D-iso-b", shard: "b", note: "真的失败了" });

  const msgs = supervisorMessages(root);
  const seen = new Set(msgs.map((m) => String(m.event || "")));
  for (const name of HEARTBEAT) {
    assert.ok(!seen.has(name), `心跳事件 ${name} 不得出现在监工流（含过程日志档）`);
  }
  /* 真失败要留：收口的是心跳，不是所有坏消息。 */
  assert.ok(seen.has("dispatch_failed"), "真实的派单失败仍要上报");
  assert.ok(
    msgs.every((m) => m.tier !== "log" || !HEARTBEAT.includes(String(m.event || ""))),
    "过程日志档也不得有心跳事件",
  );
});

test("心跳异常合并成状态行的一行摘要", () => {
  const root = sandbox();
  recordEvent(root, "worker_gone", { worker: "W-x", stale: true });
  recordEvent(root, "dispatch_orphan", { dispatch: "D-x" });
  recordEvent(root, "dispatch_orphan", { dispatch: "D-y" });
  recordEvent(root, "redispatch_capped", { shard: "a", limit: 3 });
  recordEvent(root, "stage_stalled", { stage: "S0" });

  const st = buildSupervisorStatus(root);
  assert.match(st.heartbeat_note, /心跳超时 1/);
  assert.match(st.heartbeat_note, /重派 4/);
  assert.ok(!st.heartbeat_note.includes("\n"), "摘要必须是一行");
});
