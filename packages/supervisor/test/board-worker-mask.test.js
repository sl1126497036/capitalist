/**
 * 界面文本的进程号改写。
 *
 * 界面只发行任务号与派单号。进程号通过监工分诊的自由文本、工作进程的叙述与工具摘要、
 * 工作进程目录路径三条途径进入界面，源头无法穷举，故统一在出口改写。
 *
 * 本文件验证两点：
 *   1. 改写规则本身，包括不误匹配与不二次处理；
 *   2. 出口唯一：消息对象整体经 maskThreadMessage 处理，字段规则不散落在调用方。
 */

const test = require("node:test");
const assert = require("node:assert");
const { maskBoardText, maskThreadMessage } = require("../dist/supervisor/board/render");

test("正文里的进程号换成任务号", () => {
  /* 取自实际现场：监工分诊结论作为插话注入线程，曾原样显示。 */
  assert.equal(maskBoardText("6-P1退场，结论写日志，由6-P2上报"), "#06退场，结论写日志，由#06上报");
});

test("路径里的进程号同样改写，路径形状保持可读", () => {
  assert.equal(maskBoardText("读取 .capitalist/workers/6-P1/brief.md"), "读取 .capitalist/workers/#06/brief.md");
});

test("已带 # 的编号不二次处理", () => {
  assert.equal(maskBoardText("#06-P1 已在界面口径内"), "#06-P1 已在界面口径内");
});

test("不误匹配长串与相邻字符", () => {
  assert.equal(maskBoardText("a6-P1"), "a6-P1", "前一位是字母，不视为进程号");
  assert.equal(maskBoardText("6-P1x"), "6-P1x", "后一位是字母，不视为进程号");
  assert.equal(maskBoardText("16-P1"), "#16", "多位任务号整体取用");
});

test("派单号经编号表补 #", () => {
  const nos = new Map([["6-2", "06-2"]]);
  assert.equal(maskBoardText("派单 6-2 的说明", nos), "派单 #06-2 的说明");
});

test("消息对象整体过出口：正文与可读字段改写，命令保留派单号原文", () => {
  const m = {
    id: "x",
    at: "2026-11-20T00:00:00.000Z",
    role: "worker",
    kind: "tool",
    text: "6-P1 读了 6-P2 的说明",
    tool: "Read",
    cmd: "ls .capitalist/workers/6-P1/ && capitalist retry 6-2",
    status: "running",
    thread: "s0/x6-1",
    reason: "由 6-P1 登记",
    detail: "6-P2 已退出",
    quote_text: "6-P3 的话",
    debug: ["6-P3 报错"],
  };
  const nos = new Map([["6-2", "06-2"]]);
  const out = maskThreadMessage(m, nos);
  assert.equal(out.text, "#06 读了 #06 的说明");
  assert.equal(out.reason, "由 #06 登记");
  assert.equal(out.detail, "#06 已退出");
  assert.equal(out.quote_text, "#06 的话");
  assert.deepEqual(out.debug, ["#06 报错"]);
  /*
   * 命令是操作原文：进程号需替换，派单号保持原样。
   * 改写派单号会使按界面内容抄写的命令因 `#06-2` 执行失败。
   */
  assert.equal(out.cmd, "ls .capitalist/workers/#06/ && capitalist retry 6-2");
  /* 未被改写的字段原样透传，出口不做多余重建。 */
  assert.equal(out.thread, "s0/x6-1");
  assert.equal(out.status, "running");
  assert.equal(m.text, "6-P1 读了 6-P2 的说明", "入口对象不被就地修改");
});

test("没有编号的消息原样返回", () => {
  const m = { id: "y", at: "", role: "worker", kind: "output", text: "普通文本", tool: "", cmd: "", status: "", thread: "" };
  assert.deepEqual(maskThreadMessage(m), m);
});

test("流式增量：跨块被切开的进程号也要被识别", () => {
  const { maskStream } = require("../dist/supervisor/board/render");
  const frames = [];
  const st = maskStream((d) => frames.push(d));
  /* 模拟模型逐字输出，编号恰被切成两块。 */
  for (const piece of ["由 6-", "P1", " 接手"]) st.onDelta({ kind: "text", text: piece });
  st.flush();
  const all = frames.map((f) => String(f.text ?? "")).join("");
  assert.equal(all, "由 #06 接手");
});

test("流式增量：切换类型前先吐出上一段的尾巴，不串行", () => {
  const { maskStream } = require("../dist/supervisor/board/render");
  const frames = [];
  const st = maskStream((d) => frames.push(d));
  st.onDelta({ kind: "thinking", text: "想一想" });
  st.onDelta({ kind: "text", text: "正文" });
  st.flush();
  /* 两段尾部内容各带自己的 kind，不可合并。 */
  assert.deepEqual(
    frames.map((f) => `${f.kind}:${f.text}`),
    ["thinking:想一想", "text:正文"],
  );
});

test("流式增量：工具帧原样转发，不进缓冲", () => {
  const { maskStream } = require("../dist/supervisor/board/render");
  const frames = [];
  const st = maskStream((d) => frames.push(d));
  st.onDelta({ kind: "tool", name: "Read" });
  st.flush();
  assert.deepEqual(frames, [{ kind: "tool", name: "Read" }]);
});
