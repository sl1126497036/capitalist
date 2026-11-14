/**
 * 积分台账：账号级已用积分的增量按时间窗摊给当时有动作的工作进程。
 *
 * 这一组测的是归因判据：
 *   - 首次快照只立基线，不把账号历史累计当成一笔增量摊出去；
 *   - 没有进程有动作时增量进 capitalist 独立桶，不落到已停止的进程；
 *   - 进程记录停在 running 但心跳与日志都陈旧时，仍按无动作处理；
 *   - 窗口内日志有新输出（心跳可能没跟上）时，增量记给该进程；
 *   - 多个进程只有部分有动作时，只摊给有动作的那些。
 *
 * 全部用临时目录，不碰真实任务根。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdirSync, mkdtempSync, writeFileSync, utimesSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const ledger = require("../dist/supervisor/usage/creditLedger");
const { clearFsCache } = require("../dist/core/record/fsCache");

const now = Date.now();
const isoAgo = (ms) => new Date(now - ms).toISOString();

/**
 * 建一个任务根：上次快照 60 秒前、已用 100；每个进程一条记录与其日志。
 * `beatAgoMs` / `logAgoMs` 控制心跳与日志的陈旧程度。
 */
function makeRoot(workers, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "capitalist-credit-"));
  mkdirSync(join(root, ".capitalist", "workers"), { recursive: true });
  const lastAt = opts.firstSnapshot ? "" : isoAgo(opts.windowMs ?? 60e3);
  writeFileSync(
    join(root, ".capitalist", "credits.json"),
    JSON.stringify({
      at: lastAt,
      last_used: opts.firstSnapshot ? null : 100,
      last_at: lastAt,
      unit: "积分",
      uid: opts.uid ?? "acct-1",
      by_worker: {},
    }),
  );
  const index = [];
  for (const w of workers) {
    const log = join(root, ".capitalist", "workers", `${w.id}.log`);
    writeFileSync(log, "line\n");
    const mt = new Date(now - w.logAgoMs);
    utimesSync(log, mt, mt);
    index.push({ id: w.id });
    writeFileSync(
      join(root, ".capitalist", "workers", `${w.id}.json`),
      JSON.stringify({
        id: w.id,
        host: "codebuddy",
        pid: 0,
        session: w.id,
        dispatch: "D-1",
        shard: "",
        stage: "S1",
        started_at: isoAgo(3600e3),
        heartbeat_at: isoAgo(w.beatAgoMs),
        heartbeat_ts: (now - w.beatAgoMs) / 1000,
        status: w.status,
        log,
      }),
    );
  }
  writeFileSync(join(root, ".capitalist", "workers", "index.jsonl"), index.map((r) => JSON.stringify(r)).join("\n") + "\n");
  ledger.__resetCreditLedger();
  clearFsCache();
  return root;
}

function readLedger(root) {
  return JSON.parse(require("node:fs").readFileSync(join(root, ".capitalist", "credits.json"), "utf8"));
}

test("首次快照只立基线，不摊账号历史累计", () => {
  const root = makeRoot([{ id: "9", status: "running", beatAgoMs: 5e3, logAgoMs: 5e3 }], { firstSnapshot: true });
  ledger.noteCreditUsed(root, 571.09, "积分", "acct-1");
  const f = readLedger(root);
  assert.deepEqual(f.by_worker, {}, "没有上次快照时刻时不摊增量");
  assert.equal(f.last_used, 571.09, "基线取本次读数");
});

test("没有工作进程时增量进 capitalist 独立桶", () => {
  const root = makeRoot([]);
  ledger.noteCreditUsed(root, 105, "积分", "acct-1");
  assert.equal(readLedger(root).by_worker[ledger.CAPITALIST_BUCKET], 5);
});

test("进程记录停在 running、心跳与日志都陈旧时按无动作处理", () => {
  const root = makeRoot([{ id: "9", status: "running", beatAgoMs: 3600e3, logAgoMs: 3600e3 }]);
  ledger.noteCreditUsed(root, 105, "积分", "acct-1");
  const f = readLedger(root);
  assert.equal(f.by_worker[ledger.CAPITALIST_BUCKET], 5);
  assert.equal(f.by_worker["9"], undefined, "陈旧记录不参与分摊");
});

test("窗口内日志有新输出时记给该进程", () => {
  const root = makeRoot([{ id: "9", status: "running", beatAgoMs: 3600e3, logAgoMs: 5e3 }]);
  ledger.noteCreditUsed(root, 105, "积分", "acct-1");
  const f = readLedger(root);
  assert.equal(f.by_worker["9"], 5, "心跳未更新不影响日志作为动作判据");
  assert.equal(f.by_worker[ledger.CAPITALIST_BUCKET], undefined);
});

test("多个进程只有部分有动作时只摊给有动作的", () => {
  const root = makeRoot([
    { id: "8", status: "exited", beatAgoMs: 1800e3, logAgoMs: 1800e3 },
    { id: "9", status: "running", beatAgoMs: 5e3, logAgoMs: 5e3 },
  ]);
  ledger.noteCreditUsed(root, 105, "积分", "acct-1");
  const f = readLedger(root);
  assert.equal(f.by_worker["9"], 5);
  assert.equal(f.by_worker["8"], undefined);
});

test("窗口外的旧输出不参与分摊", () => {
  const root = makeRoot([{ id: "9", status: "exited", beatAgoMs: 120e3, logAgoMs: 120e3 }]);
  ledger.noteCreditUsed(root, 105, "积分", "acct-1");
  assert.equal(readLedger(root).by_worker[ledger.CAPITALIST_BUCKET], 5);
});

test("换账号后只重置基线，不摊另一个账号的增量", () => {
  const root = makeRoot([{ id: "9", status: "running", beatAgoMs: 5e3, logAgoMs: 5e3 }], { uid: "acct-1" });
  ledger.noteCreditUsed(root, 900, "积分", "acct-2");
  const f = readLedger(root);
  assert.deepEqual(f.by_worker, {}, "换账号后的第一笔读数不作为增量");
  assert.equal(f.last_used, 900);
  assert.equal(f.uid, "acct-2");
});
