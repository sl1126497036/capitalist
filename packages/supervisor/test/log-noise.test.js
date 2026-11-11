/** 引擎调试块只留“值得展开”的内容。 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { parseWorkerLog } = require(join(PKG, "dist/supervisor/workerLog.js"));
const { buildThreadMessages } = require(join(PKG, "dist/supervisor/board.js"));

const POLICY = [
  '[WB-Policy] keep base safe: "echo"',
  '[WB-Policy] keep base safe: "cd"',
  '[WB-Policy] keep base safe: "date"',
  '[WB-Policy] keep base safe: "ls"',
  '[WB-Policy] unknown cmd -> low: "timeout" (isUnknown=true, hasSandboxCtx=false)',
];

test("纯 [WB-Policy] 噪声：不计数成可展开内容，展开也没有原文", () => {
  const parts = parseWorkerLog(POLICY, { stream: true });
  assert.deepStrictEqual(parts.debug, [], "运维噪声不许进展开块");
  assert.deepStrictEqual(parts.text, [], "也不许落进正文");
  assert.strictEqual(parts.hidden, POLICY.length, "丢弃仍然计数，便于排查");
});

test("混合日志：噪声丢掉，真诊断留着", () => {
  const real = "TypeError: cannot read properties of undefined (reading 'x')";
  const parts = parseWorkerLog([...POLICY, real, "    at foo (bar.js:1:2)"], { stream: true });
  assert.deepStrictEqual(parts.debug, [real, "    at foo (bar.js:1:2)"], "真错误与堆栈要留下");
  assert.ok(
    !parts.debug.some((l) => l.startsWith("[WB-Policy]")),
    "噪声不许混进展开块",
  );
});

test("非 stream 模式同样不把噪声写进展开块", () => {
  const parts = parseWorkerLog(['[CliMemWatch] pid=1 heapUsed=2MB', '[WB-Policy] keep base safe: "ls"', "worker 自己说的一句话"], {
    stream: false,
  });
  assert.deepStrictEqual(parts.debug, []);
  assert.deepStrictEqual(parts.text, ["worker 自己说的一句话"], "正文不受影响");
});

test("消息流里真诊断走折叠块：整块只有噪声时不发，混了真告警发折叠块", () => {
  const run = (lines) => {
    const root = mkdtempSync(join(tmpdir(), "capitalist-noise-"));
    try {
      mkdirSync(join(root, ".capitalist", "inbox"), { recursive: true });
      mkdirSync(join(root, ".capitalist", "workers"), { recursive: true });
      const now = Date.now();
      const id = "W-noise";
      const log = join(root, ".capitalist", "workers", `${id}.log`);
      writeFileSync(log, lines.join("\n") + "\n");
      const iso = new Date(now - 60_000).toISOString();
      writeFileSync(
        join(root, ".capitalist", "workers", `${id}.json`),
        JSON.stringify({
          id,
          dispatch: "D-noise",
          stage: "U6",
          shard: "noise",
          status: "running",
          pid: process.pid,
          started_at: iso,
          heartbeat_at: new Date(now - 1000).toISOString(),
          heartbeat_ts: now / 1000,
          log,
        }),
      );
      writeFileSync(join(root, ".capitalist", "workers", "index.jsonl"), JSON.stringify({ id }) + "\n");
      writeFileSync(
        join(root, ".capitalist", "inbox", "dispatch.jsonl"),
        JSON.stringify({
          id: "D-noise",
          at: iso,
          stage: "U6",
          shard: "noise",
          title: "t",
          action: "干活",
          status: "claimed",
          worker: id,
          source: "stage",
          attempt: 1,
          lineage: "D-noise",
        }) + "\n",
      );
      return buildThreadMessages(root, "shard:noise", "noise", {}).messages;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  const pure = run(['[WB-Policy] keep base safe: "cd"', '[WB-Policy] unknown cmd -> low: "timeout"']);
  assert.ok(!pure.some((m) => m.kind === "engine"), "整块只有噪声：不许出引擎块");
  assert.ok(
    !pure.some((m) => /已隐藏 \d+ 行引擎调试输出/.test(String(m.text || ""))),
    "连“已隐藏 N 行”的入口都不该出现",
  );

  const mixed = run([
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "我在改附件绑定" }] } }),
    '[WB-Policy] keep base safe: "cd"',
    "Warning: unknown field in config",
  ]);
  const engineMsg = mixed.find((m) => m.kind === "engine");
  assert.ok(engineMsg, "混了真告警：出引擎调试折叠块");
  assert.ok(
    String(engineMsg.text).includes("Warning: unknown field in config"),
    "真告警原文留在折叠块里，展开可见",
  );
  assert.ok(
    !String(engineMsg.text).includes("[WB-Policy]"),
    "运维噪声不混进折叠块",
  );
  assert.strictEqual(engineMsg.lines, 1, "折叠条上的 N 与块内行数同源");
  assert.ok(
    mixed.some((m) => m.kind === "output" && String(m.text).includes("我在改附件绑定")),
    "LLM 说的话照常进流",
  );
});

test("宿主事件 JSON 行（file-history-snapshot）不进正文", () => {
  const hostEvent = JSON.stringify({
    type: "file-history-snapshot",
    messageId: "m-1",
    snapshot: { trackedFileBackups: { "a.ts": { backupFileName: "b" } } },
  });
  const parts = parseWorkerLog([hostEvent, "worker 自己说的一句话"], { stream: false });
  assert.deepStrictEqual(parts.text, ["worker 自己说的一句话"], "系统事件不得进正文");
  assert.ok(!parts.text.join("\n").includes("trackedFileBackups"), "原始 JSON 字段不上屏");
});
