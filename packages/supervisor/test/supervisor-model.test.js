/**
 * 监工模型：对话层与派单执行层共用一个模型，且与看板显示同源。
 *
 * 这里只验取值与显示，不发起模型调用。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { supervisorModelOf, supervisorModelEffective } = require("../dist/supervisor/judge/supervisorModel");

function root(cfg) {
  const dir = mkdtempSync(join(tmpdir(), "capitalist-supmodel-"));
  mkdirSync(join(dir, ".capitalist"), { recursive: true });
  if (cfg) writeFileSync(join(dir, ".capitalist", "supervisor.json"), JSON.stringify(cfg));
  return dir;
}

test("显式选定的监工模型：解析值与显示值都用它", () => {
  const dir = root({ host: "codebuddy", supervisor_model: "glm-5.3-flash" });
  assert.strictEqual(supervisorModelOf(dir), "glm-5.3-flash");
  assert.strictEqual(supervisorModelEffective(dir), "glm-5.3-flash");
});

test("没显式选定：显示并实际使用平台默认档，不留“宿主默认”这种空口径", () => {
  const dir = root({ host: "codebuddy", supervisor_model: "" });
  assert.strictEqual(supervisorModelOf(dir), "deepseek-v4.1-flash");
  assert.strictEqual(supervisorModelEffective(dir), "deepseek-v4.1-flash");
});

test("监工未运行时也能读到配置：不因缺心跳字段退回未配置", () => {
  /* 只有配置字段、没有 heartbeat_ts 这类运行字段。 */
  const dir = root({ host: "codebuddy", supervisor_model: "glm-5.3-flash" });
  assert.strictEqual(supervisorModelOf(dir), "glm-5.3-flash");
});

test("没有模型策略的宿主：不编造档名", () => {
  const dir = root({ host: "claude", supervisor_model: "" });
  assert.strictEqual(supervisorModelOf(dir), undefined);
  assert.strictEqual(supervisorModelEffective(dir), "");
});

test("看板监工结构带出实际监工模型，供面板显示", () => {
  const dir = root({ host: "codebuddy", supervisor_model: "" });
  const views = require("../dist/supervisor/board/views");
  const sup = views.buildSupervisorStatus(dir);
  assert.strictEqual(sup.supervisor_model, "");
  assert.strictEqual(
    sup.supervisor_model_effective,
    "deepseek-v4.1-flash",
    "显式值为空时，面板要能拿到实际档名，而不是回落到派单模型",
  );
});
