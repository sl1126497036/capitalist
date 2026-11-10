
const test = require("node:test");
const assert = require("node:assert");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { parseWorkerLog } = require(join(PKG, "dist/supervisor/workerLog.js"));
const {
  doingOfAction,
  supervisorActivityOf,
  enterSupervisorAction,
  currentSupervisorAction,
  isTestCommand,
  isBuildCommand,
} = require(join(PKG, "dist/supervisor/activity.js"));

const line = (ev) => JSON.stringify(ev);
const assistant = (content) => line({ type: "assistant", message: { role: "assistant", content } });
const toolResult = () => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });

test("模型正在写正文 → reply", () => {
  const parts = parseWorkerLog([assistant([{ type: "text", text: "这一单已经改完。" }])], { stream: true });
  assert.deepStrictEqual(parts.lastAction, { phase: "reply", tool: "", command: "" });
  assert.strictEqual(doingOfAction(parts.lastAction), "reply");
});

test("命令类工具正在跑 → command，并按命令区分测试 / 构建", () => {
  const run = (cmd) =>
    parseWorkerLog(
      [assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: cmd } }])],
      { stream: true },
    ).lastAction;

  const testing = run("cd /repo && npm test");
  assert.strictEqual(testing.phase, "command");
  assert.strictEqual(doingOfAction(testing), "test");

  const building = run("npm run build");
  assert.strictEqual(doingOfAction(building), "build");

  const plain = run("git status --short");
  assert.strictEqual(doingOfAction(plain), "command");
});

test("联网 / 子代理类工具 → waiting", () => {
  const parts = parseWorkerLog(
    [assistant([{ type: "tool_use", id: "t1", name: "WebFetch", input: { url: "https://example.com" } }])],
    { stream: true },
  );
  assert.strictEqual(parts.lastAction.phase, "waiting");
  assert.strictEqual(doingOfAction(parts.lastAction), "waiting");
});

test("本地读写工具不硬塞动作：判不出来就回空，交给界面回退", () => {
  const parts = parseWorkerLog(
    [assistant([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }])],
    { stream: true },
  );
  assert.strictEqual(parts.lastAction, null);
  assert.strictEqual(doingOfAction(parts.lastAction), "");
});

test("工具结果已回 / 本回合已 result → 明确没有在跑的动作（null），不沿用旧命令", () => {
  const afterTool = parseWorkerLog(
    [assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }]), toolResult()],
    { stream: true },
  );
  assert.strictEqual(afterTool.lastAction, null);
  assert.strictEqual(doingOfAction(afterTool.lastAction), "");

  const afterResult = parseWorkerLog(
    [assistant([{ type: "text", text: "做完了" }]), line({ type: "result", result: "done" })],
    { stream: true },
  );
  assert.strictEqual(afterResult.lastAction, null);
});

test("只有思考的事件不算在生成回复", () => {
  const parts = parseWorkerLog(
    [assistant([{ type: "thinking", thinking: "先看一遍文件" }])],
    { stream: true },
  );
  assert.strictEqual(parts.lastAction, null);
  assert.strictEqual(doingOfAction(parts.lastAction), "");
});

test("测试 / 构建命令的识别只认明确入口，不把普通脚本猜成构建", () => {
  assert.strictEqual(isTestCommand("vitest run"), true);
  assert.strictEqual(isTestCommand("go test ./..."), true);
  assert.strictEqual(isTestCommand("npm run lint"), false);
  assert.strictEqual(isBuildCommand("tsc -p tsconfig.json"), true);
  assert.strictEqual(isBuildCommand("npm run build"), true);
  assert.strictEqual(isBuildCommand("npm run dev"), false);
});

test("监工活动：回执优先于监管，监管优先于思考", () => {
  assert.deepStrictEqual(supervisorActivityOf({ action: "triage", running: 3 }), { kind: "receipt", action: "triage" });
  assert.deepStrictEqual(supervisorActivityOf({ action: "chat", hasPendingReceipt: true, running: 0 }), {
    kind: "supervising",
    action: "chat",
  });
  assert.deepStrictEqual(supervisorActivityOf({ action: "", hasPendingReceipt: true, running: 0 }), {
    kind: "receipt",
    action: "triage",
  });
  assert.deepStrictEqual(supervisorActivityOf({ action: "", hasPendingReceipt: false, running: 2 }), {
    kind: "supervising",
    action: "dispatch",
  });
  assert.deepStrictEqual(supervisorActivityOf({ action: "", hasPendingReceipt: false, running: 0 }), {
    kind: "thinking",
    action: "",
  });
});

test("正在执行的动作可重入，计数归零才退出", () => {
  const leaveA = enterSupervisorAction("chat");
  const leaveB = enterSupervisorAction("chat");
  assert.strictEqual(currentSupervisorAction(), "chat");
  leaveA();
  assert.strictEqual(currentSupervisorAction(), "chat", "还有一个同名动作在跑，不能提前退出");
  leaveB();
  assert.strictEqual(currentSupervisorAction(), "");
  leaveB();
  assert.strictEqual(currentSupervisorAction(), "", "重复收尾不破坏状态");
});
