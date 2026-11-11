/** 判定通道不可用时，不能把“已报完成”的单悬空。 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { createTaskRoot } = require(join(PKG, "dist/core/init.js"));
const { appendDispatch, readDispatches, markReported } = require(join(PKG, "dist/core/supervisor.js"));
const { applyVerdict } = require(join(PKG, "dist/supervisor/loop.js"));

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-verdict-fb-"));
  createTaskRoot({ target: "判定兜底", contractSpec: "minimal", root: base });
  return { base, clean: () => rmSync(base, { recursive: true, force: true }) };
}

function seed(base, status) {
  const d = appendDispatch(base, {
    id: "D-fb0001",
    stage: "U1",
    shard: "",
    action: "改点东西",
    status: "claimed",
  });
  if (status === "reported") markReported(base, "D-fb0001", "改了什么：加了 X；怎么验：tsc 通过");
  return d;
}

test("报完成 + 判定不可用：结单，并注明未经复核与具体原因", () => {
  const { base, clean } = sandbox();
  try {
    seed(base, "reported");
    applyVerdict({
      root: base,
      state: {},
      msg: { id: "M-1", kind: "done", dispatch: "D-fb0001", from: "9", text: "" },
      verdict: { decision: "continue", why: "判定通道不可用，按确定性流程走", fallback: true, error: "拿不到模型凭证：已过期" },
      out: () => {},
    });
    const row = readDispatches(base).find((d) => d.id === "D-fb0001");
    assert.strictEqual(row.status, "done", "必须结单，不能悬空在 reported");
    assert.match(String(row.note ?? ""), /未经 AI 复核/, "note 要说明没人审过");
    assert.match(String(row.note ?? ""), /拿不到模型凭证/, "note 要带出 fallback 的真因");
    assert.match(String(row.note ?? ""), /加了 X/, "原报告内容要保留，不能被 note 覆盖掉");
  } finally {
    clean();
  }
});

test("报完成 + 判定不可用但没给原因：也要结单，理由用通用说法", () => {
  const { base, clean } = sandbox();
  try {
    seed(base, "reported");
    applyVerdict({
      root: base,
      state: {},
      msg: { id: "M-2", kind: "done", dispatch: "D-fb0001", from: "9", text: "" },
      verdict: { decision: "continue", why: "判定通道不可用，按确定性流程走", fallback: true },
      out: () => {},
    });
    const row = readDispatches(base).find((d) => d.id === "D-fb0001");
    assert.strictEqual(row.status, "done");
    assert.match(String(row.note ?? ""), /未经 AI 复核/);
  } finally {
    clean();
  }
});

test("非 done 类申报 + 判定不可用：不动状态，只记录", () => {
  const { base, clean } = sandbox();
  try {
    seed(base, "reported");
    applyVerdict({
      root: base,
      state: {},
      msg: { id: "M-3", kind: "stuck", dispatch: "D-fb0001", from: "9", text: "" },
      verdict: { decision: "continue", why: "判定通道不可用", fallback: true, error: "超时" },
      out: () => {},
    });
    const row = readDispatches(base).find((d) => d.id === "D-fb0001");
    assert.strictEqual(row.status, "reported", "卡点类申报判定不了时不许代它结单");
  } finally {
    clean();
  }
});
