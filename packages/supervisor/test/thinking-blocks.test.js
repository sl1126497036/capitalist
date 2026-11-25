/**
 * 思考块的切分口径：按插话边界切块，不按段落切。
 *
 * 一次连续推理合成一块，越过一次插话才另起一块。切分依据是“块序号 = 已越过几次插话”，
 * 不做时间比较：思考段本身没有真实时间戳，`at` 是在 `t0..t1` 之间按序号插值出来的。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, writeFileSync, statSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/record/supervisor");
const { createTaskRoot } = require("../dist/core/policy/init");
const { directPath } = require("../dist/core/dispatch/commands");
const { buildThreadMessages } = require("../dist/supervisor/board");

const SHARD = "a";
const TID = "shard:a";
const DISPATCH = "D-think1";
const WORKER = "W-think1";

/** 一段思考事件：workerLog 按 assistant.message.content[].type === "thinking" 识别。 */
const think = (text) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: text }] } });

/**
 * 造一个任务根：派单 + 工作进程 + 日志 + 指定时间的插话。
 *
 * `t1` 取日志 mtime，`t0` 定为 `t1 - 60`，于是思考段按序号插值到
 * `t0 + 60/3`、`t0 + 120/3`…… 插话时间用相对 `t0` 的秒数表达，便于精确定位。
 */
function scenario({ thinking = [], sayOffsets = [], status = "running" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "capitalist-think-"));
  createTaskRoot({ target: "思考切块测试", policySpec: "minimal", root });

  const startedAt = new Date(Date.now() - 60_000).toISOString();
  capitalist.appendDispatch(root, {
    id: DISPATCH,
    at: startedAt,
    stage: "S0",
    shard: SHARD,
    action: "改 A",
    status,
    lineage: DISPATCH,
  });

  const log = capitalist.workerLogPath(root, WORKER);
  for (const d of [
    "runtime", "ledger", "model", "board", "config", "meta", "workers",
    "sessions", "inbox", "mq", "guard", "brain", "reload", "locks", "archive", ".root",
  ]) {
    mkdirSync(join(root, ".capitalist", d), { recursive: true });
  }
  mkdirSync(join(root, ".capitalist", "workers", WORKER), { recursive: true });
  writeFileSync(log, thinking.map((t) => think(t)).join("\n") + "\n");
  const t1 = statSync(log).mtimeMs / 1000;
  const t0 = t1 - 60;

  capitalist.registerWorker(root, {
    id: WORKER,
    host: "generic",
    pid: process.pid,
    session: "sess-think",
    dispatch: DISPATCH,
    shard: SHARD,
    stage: "S0",
    started_at: new Date(t0 * 1000).toISOString(),
    heartbeat_at: new Date(t1 * 1000).toISOString(),
    heartbeat_ts: t1,
    status,
    log,
  });

  if (sayOffsets.length) {
    const rows = sayOffsets.map((off, i) => ({
      at: new Date((t0 + off) * 1000).toISOString(),
      at_ts: t0 + off,
      type: "direct",
      text: `第 ${i + 1} 次插话`,
      shard: SHARD,
      target: DISPATCH,
      consumed: false,
    }));
    writeFileSync(directPath(root), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  const page = buildThreadMessages(root, TID, SHARD, { limit: 400 });
  return { root, t0, t1, messages: page.messages, page };
}

const thinks = (messages) => messages.filter((m) => m.kind === "thinking");

test("没有插话：连续推理合成一块", () => {
  const s = scenario({ thinking: ["先看结构", "再改代码"] });
  const all = thinks(s.messages);
  assert.equal(all.length, 1, "同一段推理不按段落拆卡");
  assert.ok(String(all[0].text).includes("先看结构") && String(all[0].text).includes("再改代码"));
});

test("两段思考都在插话之后：仍属同一块", () => {
  /* 两段插值在 t0+20、t0+40；插话在 t0+10，两段都算插话之后。 */
  const s = scenario({ thinking: ["先看结构", "再改代码"], sayOffsets: [10] });
  const all = thinks(s.messages);
  assert.equal(all.length, 1, "两段同属插话之后的块，合成一条");
  assert.ok(String(all[0].text).includes("先看结构") && String(all[0].text).includes("再改代码"));
});

test("插话落在两段思考之间：切成两块，各归各的", () => {
  /* 两段插值在 t0+20、t0+40；插话在 t0+30，第二段越过插话，另起一块。 */
  const s = scenario({ thinking: ["先看结构", "再改代码"], sayOffsets: [30] });
  const all = thinks(s.messages);
  assert.equal(all.length, 2, "越过插话才另起一块");
  assert.ok(String(all[0].text).includes("先看结构"));
  assert.ok(String(all[1].text).includes("再改代码"));
  assert.ok(
    Date.parse(String(all[1].at)) > Date.parse(String(all[0].at)),
    "后一块排在插话之后的思考位置",
  );
});

test("增量请求也要带回思考块：时间是插值，不能按游标过滤", () => {
  /*
   * 思考块的 `at` 是按段序号插值出来的，可能早于游标。按 `> since` 过滤会让界面上永远
   * 看不到它（只剩工具行），只有整页刷新才出现：这是“这一段没有思考过程”的来源。
   */
  const s = scenario({ thinking: ["先看结构", "再改代码"], sayOffsets: [30] });
  const since = s.page.next_since;
  const inc = buildThreadMessages(s.root, TID, SHARD, { limit: 400, since });

  const all = inc.messages.filter((m) => m.kind === "thinking");
  assert.ok(all.length > 0, "增量结果必须包含思考块");
  assert.ok(
    inc.messages.every((m) => m.kind === "thinking"),
    "除思考块外不该重复下发旧消息",
  );
  assert.equal(inc.next_since, since, "思考块的插值时间不能推进游标");
});
