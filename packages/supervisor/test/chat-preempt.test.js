/**
 * 监工对话的抢占语义。
 *
 * 用户追加新内容时，正在提交的回执或报告不应继续占着通道：新消息要立刻被处理。
 * 但中断的是过程，不是要求——排队中的消息一条都不能丢。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { serializeSupervisorChat } = require("../dist/supervisor/board/commands");
const { askModelStream } = require("../dist/supervisor/channel/llm");
const { rememberPreemptedAsk, takePreemptedAsks } = require("../dist/supervisor/board/chatPreempt");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 模拟一次会响应中断的模型调用：收到中止即结束，不等自然到期。 */
function obey(signal, ms = 400) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("finished"), ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve("aborted");
      },
      { once: true },
    );
  });
}

test("新消息打断正在提交的那一轮", async () => {
  let firstSignal = null;
  const first = serializeSupervisorChat(async (signal) => {
    firstSignal = signal;
    return await obey(signal);
  });
  await sleep(20);
  assert.equal(firstSignal.aborted, false, "刚开跑的一轮不该自己被打断");

  const second = serializeSupervisorChat(async () => "second");
  assert.equal(firstSignal.aborted, true, "新消息进来时，正在跑的那一轮必须被中止");
  assert.equal(await first, "aborted", "被中止的一轮按中断收尾，不按正常完成");
  assert.equal(await second, "second");
});

test("排队中的消息不会被后来者吞掉", async () => {
  const seen = [];
  const first = serializeSupervisorChat(async (signal) => {
    seen.push("A");
    return await obey(signal);
  });
  await sleep(10);
  /* 第二条在 A 还在跑时入队：它只排队，不该被中断。 */
  const second = serializeSupervisorChat(async (signal) => {
    seen.push("B");
    assert.equal(signal.aborted, false, "排队中的消息不该在开跑前就被中止");
    await obey(signal, 20);
    return "B";
  });
  /* 第三条入队时，正在跑的仍是 A；B 只是排队，必须保留。 */
  const third = serializeSupervisorChat(async (signal) => {
    seen.push("C");
    assert.equal(signal.aborted, false, "排队中的消息不该在开跑前就被中止");
    await obey(signal, 20);
    return "C";
  });

  assert.deepEqual(await Promise.all([first, second, third]), ["aborted", "B", "C"]);
  assert.deepEqual(seen, ["A", "B", "C"], "三条消息都要轮到，顺序按发送序");
});

test("单条消息不被打断，正常跑完", async () => {
  const out = await serializeSupervisorChat(async (signal) => {
    assert.equal(signal.aborted, false);
    return await obey(signal, 30);
  });
  assert.equal(out, "finished");
});

test("抢占之后通道仍可用，不进入失败态", async () => {
  const first = serializeSupervisorChat(async (signal) => await obey(signal));
  await sleep(10);
  const second = serializeSupervisorChat(async () => "after");
  assert.equal(await first, "aborted");
  assert.equal(await second, "after");
  /* 再来一轮：链没有被中止留下的残状态卡住。 */
  assert.equal(await serializeSupervisorChat(async () => "again"), "again");
});

test("信号已处于中止状态时不发起模型调用", async () => {
  const ctl = new AbortController();
  ctl.abort();
  const startedAt = Date.now();
  const r = await askModelStream({ prompt: "不会被发出去", signal: ctl.signal, onDelta: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.aborted, true, "已中止的信号要直接返回 aborted");
  assert.ok(Date.now() - startedAt < 200, "不该起进程，也不该等超时");
});

test("被打断的要求只提醒一轮", () => {
  const root = "/tmp/preempt-once";
  rememberPreemptedAsk(root, "把编号统一成图号");
  assert.deepEqual(takePreemptedAsks(root), ["把编号统一成图号"]);
  assert.deepEqual(takePreemptedAsks(root), [], "取过一次后不再重复提醒");
});

test("连续打断保留最近五条，空文本不入列", () => {
  const root = "/tmp/preempt-keep";
  for (let i = 1; i <= 7; i += 1) rememberPreemptedAsk(root, `要求 ${i}`);
  rememberPreemptedAsk(root, "   ");
  assert.deepEqual(takePreemptedAsks(root), ["要求 3", "要求 4", "要求 5", "要求 6", "要求 7"]);
});

test("不同任务根的打断记录互不干扰", () => {
  rememberPreemptedAsk("/tmp/preempt-a", "A 的要求");
  rememberPreemptedAsk("/tmp/preempt-b", "B 的要求");
  assert.deepEqual(takePreemptedAsks("/tmp/preempt-a"), ["A 的要求"]);
  assert.deepEqual(takePreemptedAsks("/tmp/preempt-b"), ["B 的要求"]);
});
