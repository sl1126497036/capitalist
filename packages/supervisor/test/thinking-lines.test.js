
const test = require("node:test");
const assert = require("node:assert");

const { isThinkingOnlyLine, withoutThinking, tailWithinChars } = require("../dist/supervisor/workerLog");

const thinkingEv = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "thinking", thinking: "Let me check the file first..." }] },
});
const textEv = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "改完了" }] },
});
const mixedEv = JSON.stringify({
  type: "assistant",
  message: {
    content: [
      { type: "thinking", thinking: "想一下" },
      { type: "text", text: "正文在这里" },
    ],
  },
});
const toolEv = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
});

test("纯思考事件被认出来", () => {
  assert.equal(isThinkingOnlyLine(thinkingEv), true);
  assert.equal(isThinkingOnlyLine("[thinking] 随手写的一段"), true);
});

test("带正文或工具调用的事件不当作思考", () => {
  assert.equal(isThinkingOnlyLine(textEv), false);
  assert.equal(isThinkingOnlyLine(toolEv), false);
  assert.equal(isThinkingOnlyLine(mixedEv), false, "思考 + 正文混在一条里，正文要留下");
});

test("普通行与坏 JSON 不动", () => {
  assert.equal(isThinkingOnlyLine("npm test 跑了 12 秒"), false);
  assert.equal(isThinkingOnlyLine('{"type":"assistant","message":{'), false);
  assert.equal(isThinkingOnlyLine(""), false);
});

test("剥离后行序不变，只删思考行", () => {
  const rows = ["$ npm test", thinkingEv, "FAIL board.test.js", textEv, thinkingEv, "$ git status"];
  const r = withoutThinking(rows);
  assert.equal(r.dropped, 2);
  assert.deepEqual(r.lines, ["$ npm test", "FAIL board.test.js", textEv, "$ git status"]);
});

test("全是思考行时返回空表（调用方据此换判据，而不是看到半截 JSON）", () => {
  const r = withoutThinking([thinkingEv, thinkingEv]);
  assert.equal(r.lines.length, 0);
  assert.equal(r.dropped, 2);
});


test("尾巴按整行累加：不把一行从中间切开", () => {
  const rows = ["a".repeat(100), "b".repeat(100), "c".repeat(100), "d".repeat(100)];
  const out = tailWithinChars(rows, 250);
  /* 从后往前：d(100) + c(100) 装得下，b 会超预算。 */
  assert.equal(out, `${"c".repeat(100)}\n${"d".repeat(100)}`);
  assert.ok(!out.startsWith("b"), "不能出现半行");
});

test("单行就超预算：留它的末尾并标明截断", () => {
  const long = `{"type":"result","result":"${"x".repeat(5000)}"}`;
  const out = tailWithinChars([long], 300);
  assert.ok(out.startsWith("…（该行共"), "要说明这行被截过");
  assert.ok(out.length <= 320);
  assert.ok(out.endsWith('"}'), "留末尾才有结尾的引号与括号");
});

test("空行忽略，全空返回空串", () => {
  assert.equal(tailWithinChars(["", "  ", ""], 500), "");
});
