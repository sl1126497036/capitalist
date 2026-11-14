
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { resolveModel, normalizeModelName, modelRulesOf } = require("../dist/supervisor/judge/modelPolicy");

const DEFAULT = "deepseek-v4.1-flash";

function rootWith(supervisor) {
  const root = mkdtempSync(join(tmpdir(), "capitalist-model-"));
  mkdirSync(join(root, ".capitalist"), { recursive: true });
  if (supervisor) writeFileSync(join(root, ".capitalist", "supervisor.json"), JSON.stringify(supervisor), "utf8");
  return root;
}

test("名字归一化：大小写、空格、下划线都吃掉", () => {
  assert.equal(normalizeModelName("  DeepSeek-V4.1-Flash "), "deepseek-v4.1-flash");
  assert.equal(normalizeModelName("deepseek v4 pro"), "deepseek-v4-pro");
  assert.equal(normalizeModelName("MiniMax_M3.1_Flash"), "minimax-m3.1-flash");
});

test("没指定模型：用平台默认档，绝不留给宿主自选", () => {
  const r = resolveModel({ host: "codebuddy" });
  assert.equal(r.model, DEFAULT);
  assert.equal(r.denied, undefined);
  assert.match(r.why, /默认档/);
});

test("指定了禁用模型：回退默认档，并把原值交回调用方记事件", () => {
  for (const bad of ["fast-model", "glm-5.3-flash", "glm-5.3-flashx", "minimax-m3.1-flash", "xiaomi", "hy4", "hy4-free", "deepseek-v4-pro"]) {
    const r = resolveModel({ host: "codebuddy", wanted: bad });
    assert.equal(r.model, DEFAULT, `${bad} 应被挡下`);
    assert.equal(r.denied, bad, `${bad} 的原值要留痕`);
  }
});

test("写法不同也认：带空格 / 大小写混写同样命中名单", () => {
  assert.equal(resolveModel({ host: "codebuddy", wanted: "deepseek v4 pro" }).denied, "deepseek v4 pro");
  assert.equal(resolveModel({ host: "workbuddy", wanted: "GLM-5.3-Flash" }).denied, "GLM-5.3-Flash");
});

test("指定了合法模型：原样透传", () => {
  const r = resolveModel({ host: "codebuddy", wanted: "deepseek-v4.1-flash" });
  assert.equal(r.model, "deepseek-v4.1-flash");
  assert.equal(r.denied, undefined);
});

test("没有模型策略的宿主：保持原样，不硬塞默认值", () => {
  assert.equal(resolveModel({ host: "generic", wanted: "" }).model, undefined);
  assert.equal(resolveModel({ host: "generic", wanted: "some-model" }).model, "some-model");
});

test("配置能改默认档", () => {
  const root = rootWith({ default_model: "deepseek-v4.1-flash" });
  assert.equal(resolveModel({ root, host: "codebuddy" }).model, "deepseek-v4.1-flash");
  assert.match(resolveModel({ root, host: "codebuddy" }).why, /配置覆盖/);
});

test("配置能追加禁用名单（并集，不能减）", () => {
  const root = rootWith({ model_denylist: ["some-new-model"] });
  /* 追加项被挡住 */
  assert.equal(resolveModel({ root, host: "codebuddy", wanted: "some-new-model" }).denied, "some-new-model");
  /* 平台原有名单仍然生效 */
  assert.equal(resolveModel({ root, host: "codebuddy", wanted: "glm-5.3-flash" }).denied, "glm-5.3-flash");
});

test("平台声明的默认档自己不在禁用名单里（否则会绕死自己）", () => {
  const rules = modelRulesOf(undefined, "codebuddy");
  assert.ok(rules);
  assert.ok(!rules.deny.includes(normalizeModelName(rules.def)), "默认档被自己禁用会让每次调用都回落到一个禁用值");
});

test("从日志里认出实际用过的模型（用来核对有没有回退）", () => {
  const { modelsInLog, deniedModelsUsed } = require("../dist/supervisor/judge/modelPolicy");
  const log = [
    '{"type":"assistant","message":{"model":"deepseek-v4.1-flash"}}',
    '{"type":"assistant","message":{"model":"glm-5.3-flash"}}',
    '{"type":"assistant","message":{"model":"deepseek-v4.1-flash"}}',
  ].join("\n");
  assert.deepEqual(modelsInLog(log), ["deepseek-v4.1-flash", "glm-5.3-flash"], "去重且保持顺序");
  assert.deepEqual(deniedModelsUsed(undefined, "codebuddy", log), ["glm-5.3-flash"]);
  /* 干净日志不该误报 */
  assert.deepEqual(deniedModelsUsed(undefined, "codebuddy", '{"model":"deepseek-v4.1-flash"}'), []);
});
