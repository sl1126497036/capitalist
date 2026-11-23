/**
 * 工作进程日志的 stream 模式判定只升不降。
 *
 * 工作进程先落启动横幅再拉起 CLI，首个事件行晚几秒才到。首读落在横幅上会判成纯文本，
 * 若把该结论固化到增量游标里，此后每个分片都按纯文本处理，正文、工具与思考永远是空，
 * 界面只剩一句“日志 N 秒前更新”。
 */

const test = require("node:test");
const assert = require("node:assert");
const { appendFileSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { readWorkerEvents } = require(join(PKG, "dist/supervisor/board/logs.js"));

const BANNER = [
  "[launch] 2026-11-20T17:11:57.956Z host=codebuddy dispatch=15-1 stage=S0",
  "[launch] bin=/usr/local/bin/codebuddy prompt=argv",
  "[launch] model=glm-5.3-flash session=x new lane=新",
  "serve 0",
  "",
].join("\n");

const EVENT_THINK = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "thinking", thinking: "先读盘点清单" }] },
});
const EVENT_TOOL = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/repo/src/a/b.ts" } }] },
});
const EVENT_TEXT = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "清单读完了，开始改注释" }] },
});

/** 每个用例一份独立日志，避免模块级游标缓存互相干扰。 */
function withLog(body) {
  const dir = mkdtempSync(join(tmpdir(), "worker-log-mode-"));
  const file = join(dir, "output.log");
  writeFileSync(file, body);
  return {
    file,
    append: (text) => appendFileSync(file, text),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("首读只有启动横幅时判为非 stream，事件到达后升级并解析出三个通道", () => {
  const log = withLog(BANNER);
  try {
    const first = readWorkerEvents(log.file);
    assert.strictEqual(first.stream, false, "横幅里没有事件行，此时判不出 stream");
    assert.deepStrictEqual(first.text, [], "横幅属宿主噪声，不进正文");
    assert.strictEqual(first.tools.length, 0);

    log.append([EVENT_THINK, EVENT_TOOL, EVENT_TEXT, ""].join("\n"));
    const second = readWorkerEvents(log.file);

    assert.strictEqual(second.stream, true, "认出事件行后必须升级为 stream");
    assert.deepStrictEqual(second.thinking, ["先读盘点清单"], "思考必须进入 thinking 通道");
    assert.strictEqual(second.tools.length, 1, "工具调用必须进入 tools 通道");
    assert.match(second.tools[0], /读取 .*a\/b\.ts/, "工具摘要保留文件名");
    assert.deepStrictEqual(second.text, ["清单读完了，开始改注释"], "正文必须进入 text 通道");
    assert.deepStrictEqual(second.debug, [], "事件行不再落进调试通道");
  } finally {
    log.done();
  }
});

test("纯文本宿主不会被升级：没有事件行就一直按正文读取", () => {
  const log = withLog("worker 自己说的一句话\n");
  try {
    const first = readWorkerEvents(log.file);
    assert.strictEqual(first.stream, false);
    assert.deepStrictEqual(first.text, ["worker 自己说的一句话"]);

    log.append("第二句，行内带一个 JSON 片段：{ a: 1 }\n");
    const second = readWorkerEvents(log.file);
    assert.strictEqual(second.stream, false, "行首不是事件对象，不得升级");
    assert.strictEqual(second.text.length, 2, "两段正文都要保留");
    assert.strictEqual(second.tools.length, 0);
  } finally {
    log.done();
  }
});

test("已判为 stream 后追加非事件行不降级，正文照常累积", () => {
  const log = withLog([BANNER, EVENT_TEXT, ""].join("\n"));
  try {
    const first = readWorkerEvents(log.file);
    assert.strictEqual(first.stream, true);
    assert.deepStrictEqual(first.text, ["清单读完了，开始改注释"]);

    log.append("[launch error] 认证失败\n");
    const second = readWorkerEvents(log.file);
    assert.strictEqual(second.stream, true, "模式只升不降");
    assert.ok(
      second.text.includes("[launch error] 认证失败"),
      "启动错误无论哪种模式都要上屏",
    );
    assert.strictEqual(second.text.length, 2);
  } finally {
    log.done();
  }
});

test("同一份日志重复读取返回一致结果，不重复累积", () => {
  const log = withLog([BANNER, EVENT_THINK, EVENT_TOOL, ""].join("\n"));
  try {
    const first = readWorkerEvents(log.file);
    const again = readWorkerEvents(log.file);
    assert.deepStrictEqual(again.text, first.text);
    assert.deepStrictEqual(again.tools, first.tools);
    assert.deepStrictEqual(again.thinking, first.thinking);
    assert.strictEqual(again.tools.length, 1, "无新增时不得重复计数");
  } finally {
    log.done();
  }
});
