/**
 * 守卫是否对用户可见。
 *
 * 默认守卫（`minimal`）与容器键（`generic`）只有通用红线与本机边界，没有领域判据。
 * 界面据此决定是否展开边界细节：没写过领域判据的用户看到一堆路径规则只会反查，
 * 而不是去读。
 */

const test = require("node:test");
const assert = require("node:assert");
const { join } = require("node:path");

const PKG = join(__dirname, "..");
const { hasCustomPolicy } = require(join(PKG, "dist/core/policy/customPolicy.js"));

test("默认守卫不对外展开边界细节", () => {
  for (const name of ["minimal", "generic", "", "  ", null, undefined]) {
    assert.strictEqual(hasCustomPolicy(name), false, `${String(name)} 不该被当成用户自定义守卫`);
  }
});

test("用户自己写了守卫才展开边界细节", () => {
  for (const name of ["web", "quant", "my-flow"]) {
    assert.strictEqual(hasCustomPolicy(name), true, `${name} 是用户定义的守卫，红线对他有意义`);
  }
});

test("监工消息编号里的 S0 不受影响：那是监工面板的伪任务号，不是流程阶段", () => {
  const { SUPERVISOR_NO, msgId, msgTaskNo } = require(join(PKG, "dist/core/message/msgId.js"));
  assert.strictEqual(SUPERVISOR_NO, "S0");
  const id = msgId("S0", "S");
  assert.match(id, /^S0-S-\d+$/, `监工全局消息编号保持原样：${id}`);
  assert.strictEqual(msgTaskNo(id), "S0");
});
