/** 档位判定的不变量。 */

const test = require("node:test");
const assert = require("node:assert");
const { decide, normalizeMode, modeNames, severity, resolveMode } = require("../dist/core/permission");

test("未知档位名 fail-closed 到 deny，不回落 default", () => {
  assert.equal(decide("plan_mode_typo", "allow", "write"), "deny");
  assert.equal(decide("", "allow", "write"), "deny");
  assert.equal(decide(null, "allow", "read"), "deny");
  assert.equal(normalizeMode("PLAN"), "plan");
  assert.equal(normalizeMode("accept-edits"), "accept_edits");
  assert.equal(normalizeMode("nope"), null);
});

test("红线强度不被档位放宽：除 bypass 外 deny 仍是 deny", () => {
  for (const mode of modeNames()) {
    if (mode === "bypass") continue;
    assert.equal(decide(mode, "BLOCK", "command"), "deny", `${mode} 不应放宽 BLOCK`);
    assert.equal(decide(mode, "deny", "write"), "deny", `${mode} 不应放宽写入的 deny`);
  }
  // bypass 是显式例外：不拦，但仍由调用方记账
  assert.equal(decide("bypass", "BLOCK", "command"), "allow");
});

test("plan 只禁改不禁读", () => {
  assert.equal(decide("plan", "allow", "write"), "deny");
  assert.equal(decide("plan", "allow", "delete"), "deny");
  assert.equal(decide("plan", "allow", "read"), "allow");
  // 命令类按规则原判：红线本身就是底线，无需档位再收紧
  assert.equal(decide("plan", "PASS", "command"), "allow");
});

test("accept_edits 只放宽写入的 ask，不放宽写入的 deny", () => {
  assert.equal(decide("accept_edits", "ask", "write"), "allow");
  assert.equal(decide("accept_edits", "deny", "write"), "deny");
  assert.equal(decide("accept_edits", "ask", "read"), "ask");
  assert.equal(decide("accept_edits", "ask", "command"), "ask");
});

test("旧名兼容：BLOCK/NEED_USER/WARN/justify 都能识别", () => {
  assert.equal(severity("BLOCK"), "deny");
  assert.equal(severity("NEED_USER"), "ask");
  assert.equal(severity("WARN"), "allow");
  assert.equal(severity("justify"), "ask");
  // 未知动作按最严处理
  assert.equal(severity("whatever"), "deny");
});

test("档位优先级：命令行 > 环境变量 > 会话 > 契约", () => {
  assert.equal(resolveMode({ cli: "plan", env: "bypass" }), "plan");
  assert.equal(resolveMode({ env: "bypass", session: "plan" }), "bypass");
  assert.equal(resolveMode({ session: "plan", contract: { mode: "bypass" } }), "plan");
  assert.equal(resolveMode({ contract: { mode: "accept_edits" } }), "accept_edits");
  assert.equal(resolveMode({}), "default");
  // 非法值不得遮蔽后面的合法来源
  assert.equal(resolveMode({ cli: "bogus", session: "plan" }), "plan");
});
