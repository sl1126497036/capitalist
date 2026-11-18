/**
 * 插话后的思考占位。
 *
 * 守的是一个具体的观感缺陷：插话发出、工作进程还没产出新一轮思考时，会话流里最后一张
 * 思考卡仍是插话前的内容。刷新后前后对不上，用户会以为插话没发出去。
 *
 * 判据是「块序号 = 已越过几次插话」：最后一段（越过全部插话的那块）为空，就说明插话后
 * 还没有新思考，此时补一条占位块。反过来，新思考一到，占位必须自动让位，不能变成常驻
 * 的假消息。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, writeFileSync, statSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/record/supervisor");
const { createTaskRoot } = require("../dist/core/contract/init");
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
  createTaskRoot({ target: "思考占位测试", contractSpec: "minimal", root });

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
  mkdirSync(join(root, ".capitalist", "workers"), { recursive: true });
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

const pending = (messages) => messages.filter((m) => String(m.id).endsWith("#think-pending"));
const thinks = (messages) => messages.filter((m) => m.kind === "thinking");

test("插话刚发出、还没有新思考：补一条占位，且排在所有思考之后", () => {
  /* 插话时间晚于日志 mtime —— 正是「刚按下发送、日志还没更新」的那一刻。 */
  const s = scenario({ thinking: ["先看结构", "再改代码"], sayOffsets: [75] });
  const p = pending(s.messages);
  assert.equal(p.length, 1, "应补一条占位");
  assert.equal(p[0].kind, "thinking", "占位要走思考过程这一档");
  assert.ok(String(p[0].text).includes("插话已送达"), `文案要说明插话已送达：${p[0].text}`);
  assert.ok(String(p[0].text).includes("重新思考"), `运行中要说在重新思考：${p[0].text}`);

  const all = thinks(s.messages);
  assert.equal(all.length, 2, "两段真思考 + 一条占位");
  assert.ok(String(all[all.length - 1].id).endsWith("#think-pending"), "占位必须排在最后一张思考卡");
});

test("插话落在两段思考之间：最后一段已有新思考，不出占位", () => {
  /* 两段思考插值在 t0+20、t0+40；插话在 t0+10，两段都算「插话之后」，并成同一块。 */
  const s = scenario({ thinking: ["先看结构", "再改代码"], sayOffsets: [10] });
  assert.equal(pending(s.messages).length, 0, "已有插话后的思考，占位不该出现");
  const all = thinks(s.messages);
  assert.equal(all.length, 1, "两段同属插话之后的块，合成一条");
  assert.ok(String(all[0].text).includes("先看结构") && String(all[0].text).includes("再改代码"));
});

test("插话晚于全部思考：补占位，但真思考内容一条不少", () => {
  const s = scenario({ thinking: ["先看结构", "再改代码"], sayOffsets: [50] });
  assert.equal(pending(s.messages).length, 1, "插话后没有新思考，应补占位");
  const bodies = thinks(s.messages).map((m) => String(m.text));
  assert.ok(bodies.some((b) => b.includes("先看结构")), "原有思考不能被占位顶掉");
  assert.ok(bodies.some((b) => b.includes("再改代码")), "原有思考不能被占位顶掉");
});

test("没有插话时不补占位", () => {
  const s = scenario({ thinking: ["先看结构"] });
  assert.equal(pending(s.messages).length, 0, "没有插话就不该凭空多一张思考卡");
  assert.equal(thinks(s.messages).length, 1);
});

test("进程已结束：文案改成下一轮生效，不说还在思考", () => {
  const s = scenario({ thinking: ["先看结构"], sayOffsets: [75], status: "exited" });
  const p = pending(s.messages);
  assert.equal(p.length, 1);
  assert.ok(String(p[0].text).includes("下一轮"), `已结束进程要说下一轮生效：${p[0].text}`);
  assert.ok(!String(p[0].text).includes("正在"), "已结束就不能说正在思考");
});

test("多次插话：只补一条，不按次数堆叠", () => {
  const s = scenario({ thinking: ["先看结构"], sayOffsets: [30, 50, 75] });
  assert.equal(pending(s.messages).length, 1, "占位只表达「最新一次插话后还没动」，不该堆三条");
});

test("增量请求也要带回思考块：时间是插值，不能按游标过滤", () => {
  /*
   * 思考块的 `at` 是按段序号插值出来的，可能早于游标。按 `> since` 过滤会让界面上永远
   * 看不到它（只剩工具行），只有整页刷新才出现——这正是「这一段没有思考过程」的来源。
   */
  const s = scenario({ thinking: ["先看结构", "再改代码"], sayOffsets: [75] });
  const since = s.page.next_since;
  const inc = buildThreadMessages(s.root, TID, SHARD, { limit: 400, since });

  const think = inc.messages.filter((m) => m.kind === "thinking");
  assert.ok(think.length > 0, "增量结果必须包含思考块");
  assert.ok(
    inc.messages.every((m) => m.kind === "thinking"),
    "除思考块外不该重复下发旧消息",
  );
  assert.equal(inc.next_since, since, "思考块的插值时间不能推进游标");
});
