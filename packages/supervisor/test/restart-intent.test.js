/** 收工闸「这是不是重启单」的判据。 */

const test = require("node:test");
const assert = require("node:assert");
const { resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { isRestartSupervisorDispatch } = require(resolve(PKG, "dist/core/restartIntent.js"));

const RESTART = [
  "重启监工，让新构建生效",
  "请重启监工并确认新 pid 与启动时间",
  "重启一下监工",
  "需要重启监工",
  "监工需要重启",
  "监工必须重启后再验证看板",
  "restart supervisor to load the new build",
  "restart the supervisor",
];

const NOT_RESTART = [
  // 真实误挡样本
  "任务卡标题与 worker 消息标题超宽改为阴影渐变淡出\n- 监工重启蒙版改文案并去掉转圈光标",
  "派单提示词与验收口径调整\n凡是改动监工主进程逻辑（调度、派单、提示词等），改完必须重启监工使其生效",
  // 定语式：讲的是按钮/文案/遮罩
  "重启监工的按钮文案改成中文",
  "重启监工蒙版文案与光标样式",
  // 功能描述：自动重启是能力，不是这一单的动作
  "监工上下文超限自动重启与顺序恢复",
  // 时间状语：讲的是重启之后的行为
  "确保这些场景下重启后的派单顺序与启动前完全一致",
  // 否定式
  "本单无需重启监工，只改提示文案",
  "不需要重启监工，改完构建即可",
  // 只出现在正文后段
  "改聊天输入区的引用条\n背景：上一轮是重启监工后才看到新构建的",
  "",
];

test("真正的重启指令仍然认", () => {
  for (const s of RESTART) assert.equal(isRestartSupervisorDispatch(s), true, s);
});

test("顺带提及、定语、否定不算重启单", () => {
  for (const s of NOT_RESTART) assert.equal(isRestartSupervisorDispatch(s), false, s);
});
