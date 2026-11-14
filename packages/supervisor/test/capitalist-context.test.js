
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const {
  CAPITALIST_CTX_RELOAD_RATIO,
  buildSupervisorContextView,
  effectiveSupervisorContextLimit,
  recordSupervisorContext,
  shouldAutoReload,
} = require(join(PKG, "dist/supervisor/context/reload.js"));

function sandbox(capitalist) {
  const root = mkdtempSync(join(tmpdir(), "capitalist-ctxlimit-"));
  mkdirSync(join(root, ".capitalist"), { recursive: true });
  /* loadSupervisor 只认带 heartbeat_ts 的记录，缺了整份配置会被当成不存在。 */
  if (capitalist) {
    writeFileSync(
      join(root, ".capitalist", "supervisor.json"),
      JSON.stringify({ heartbeat_ts: Date.now() / 1000, ...capitalist }),
      "utf8",
    );
  }
  return root;
}

test("生效上限取 min(配置, 模型窗口)", () => {
  assert.equal(effectiveSupervisorContextLimit(1_000_000, 300_000), 300_000, "模型更小时取模型");
  assert.equal(effectiveSupervisorContextLimit(1_000_000, 2_000_000), 1_000_000, "模型更大时取配置");
  assert.equal(effectiveSupervisorContextLimit(1_000_000, 0), 1_000_000, "模型未上报时按配置");
  assert.equal(effectiveSupervisorContextLimit(0, 2_000_000), 2_000_000, "未配置时按模型");
  assert.equal(effectiveSupervisorContextLimit(0, 0), 0, "两边都没有就是没有上限，不编数");
});

test("看板视图：已用与生效上限同源，缺失字段为 null", () => {
  const root = sandbox({ supervisor_context_limit: 1_000_000 });

  // 没有读数
  const empty = buildSupervisorContextView(root);
  assert.equal(empty.used, null);
  assert.equal(empty.limit, 1_000_000, "未上报模型窗口时，配置值就是唯一依据");
  assert.equal(empty.source, "none");
  assert.match(empty.reason, /还没和监工对话/);

  // 模型 300K、配置 1M -> 显示 300K
  recordSupervisorContext(root, 135_000, 300_000, "model-a");
  const small = buildSupervisorContextView(root);
  assert.equal(small.used, 135_000);
  assert.equal(small.window, 300_000);
  assert.equal(small.config_limit, 1_000_000);
  assert.equal(small.limit, 300_000, "模型只有 300K 时不能显示 1M");
  assert.ok(Math.abs(small.ratio - 135000 / 300000) < 1e-9);
  assert.equal(small.threshold, CAPITALIST_CTX_RELOAD_RATIO);

  // 同一根换一个更大的模型：配置 1M 仍然封顶
  recordSupervisorContext(root, 135_000, 2_000_000, "model-b");
  const big = buildSupervisorContextView(root);
  assert.equal(big.limit, 1_000_000, "模型支持 2M 时仍按配置 1M");
});

test("超限判定用的分母就是面板显示的生效上限", () => {
  const root = sandbox({ supervisor_context_limit: 1_000_000 });
  recordSupervisorContext(root, 260_000, 300_000, "model-a");
  assert.equal(buildSupervisorContextView(root).limit, 300_000);
  const hit = shouldAutoReload(root);
  assert.equal(hit.hit, true, "260k / 300k = 86.7%，应触发");
  assert.ok(hit.reason.includes("300000"));

  // 同样的已用量，模型 2M -> 生效上限 1M，占比 26%，不触发
  recordSupervisorContext(root, 260_000, 2_000_000, "model-b");
  const miss = shouldAutoReload(root);
  assert.equal(miss.hit, false);
  assert.ok(miss.reason.includes("1000000"));
});

test("重载换代后旧读数不再触发，也不会显示成当前占用", () => {
  const root = sandbox({ supervisor_context_limit: 300_000 });
  recordSupervisorContext(root, 280_000, 300_000, "model-a");
  assert.equal(shouldAutoReload(root).hit, true);

  // 模拟 beginReload：会话代次 +1（gen 0 -> 1），旧读数仍躺在文件里
  mkdirSync(join(root, ".capitalist", "reload"), { recursive: true });
  writeFileSync(
    join(root, ".capitalist", "reload", "session.json"),
    JSON.stringify({ gen: 1, session_id: "capitalist-chat-r1", at: new Date().toISOString(), brief_chars: 0 }),
    "utf8",
  );
  const after = shouldAutoReload(root);
  assert.equal(after.hit, false, "旧代次的读数不能触发第二次压缩");
  assert.match(after.reason, /第 0 代/);

  const view = buildSupervisorContextView(root);
  assert.equal(view.used, null, "换代后旧读数不该再显示成当前占用");
  assert.match(view.reason, /刚优化过/);
});
