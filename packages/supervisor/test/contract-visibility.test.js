/**
 * 契约是否对用户可见。
 *
 * 默认任务列表（`minimal`）与容器键（`generic`）的阶段是引擎的流程壳子：用户没有
 * “S0”这个概念，界面写出阶段号，他要么忽略，要么去反查，两种都是负担。这条边界
  * 一旦在某处遗漏，界面会重新出现 `阶段推进 S0 到 S1` 这类文案。
 */

const test = require("node:test");
const assert = require("node:assert");
const { join } = require("node:path");

const PKG = join(__dirname, "..");
const { hasCustomContract } = require(join(PKG, "dist/core/contract/customContract.js"));
const { describeEvent, stageViewOf } = require(join(PKG, "dist/supervisor/board/snapshot.js"));

test("默认任务列表不对外描述契约过程", () => {
  for (const name of ["minimal", "generic", "", "  ", null, undefined]) {
    assert.strictEqual(hasCustomContract(name), false, `${String(name)} 不该被当成用户自定义任务列表`);
  }
});

test("用户自己写了任务列表才描述阶段", () => {
  for (const name of ["web", "quant", "my-flow"]) {
    assert.strictEqual(hasCustomContract(name), true, `${name} 是用户定义的任务列表，阶段对他有意义`);
  }
});

test("默认任务列表下阶段读数整体置空，不留半截", () => {
  assert.deepStrictEqual(stageViewOf("minimal", "S0", "需求确认", 0, 3), {
    stage: "",
    stage_name: "",
    stage_index: -1,
    stage_total: 0,
  });
  /* 自定义任务列表原样给出，一个字段都不省略。 */
  assert.deepStrictEqual(stageViewOf("web", "S1", "接口联调", 1, 4), {
    stage: "S1",
    stage_name: "接口联调",
    stage_index: 1,
    stage_total: 4,
  });
});

test("阶段推进在默认任务列表下按中性说法上屏，自定义时保留阶段号", () => {
  const advance = { event: "supervisor_advance", from: "S0", to: "S1" };
  assert.strictEqual(describeEvent(advance, { customContract: false }), "进入下一步");
  assert.strictEqual(describeEvent(advance, { customContract: true }), "阶段推进 S0 到 S1");
  /* 缺省按自定义处理：历史记录与只读视图保持原文案，不因当前配置改写。 */
  assert.strictEqual(describeEvent(advance), "阶段推进 S0 到 S1");
});

test("完成不带阶段号，门槛评估不上面板", () => {
  assert.strictEqual(describeEvent({ event: "supervisor_done", stage: "S0" }, { customContract: false }), "任务完成");
  assert.strictEqual(
    describeEvent({ event: "supervisor_done", stage: "S0" }, { customContract: true }),
    "任务完成（S0）",
  );

  const gate = { event: "gate_eval", stage: "S0", ok: false, missing: ["未登记需求"] };
  /* 门槛评估是契约判据，默认任务列表下整条不显示，避免为它另造一个用户说法。 */
  assert.strictEqual(describeEvent(gate, { customContract: false }), "");
  assert.strictEqual(describeEvent(gate, { customContract: true }), "门槛评估 S0：未达标（未登记需求）");
});

test("监工消息编号里的 S0 不受影响：那是监工面板的伪任务号，不是契约阶段", () => {
  const { SUPERVISOR_NO, msgId, msgTaskNo } = require(join(PKG, "dist/core/message/msgId.js"));
  assert.strictEqual(SUPERVISOR_NO, "S0");
  const id = msgId("S0", "S");
  assert.match(id, /^S0-S-\d+$/, `监工全局消息编号保持原样：${id}`);
  assert.strictEqual(msgTaskNo(id), "S0");
});
