/**
 * 终端状态行：启动那一行报“已启动”，不报“暂停中”。
 *
 * 启动即暂停是可预期的常态（上次未完成的派单统一冻结），首行若直接打“暂停中”，
 * 用户看不出监护进程究竟起没起来。启动之后的状态变化仍要各打一行，不能因为首行
 * 改写会丢失后续的恢复与再次暂停记录。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/record/supervisor");
const pause = require("../dist/core/record/pause");
const { createTaskRoot } = require("../dist/core/policy/init");
const { createStatusReporter, describeStatusLine } = require("../dist/supervisor/statusLine");

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-status-line-"));
  createTaskRoot({ target: "状态行", policySpec: "minimal", root });
  return root;
}

function put(root, id) {
  capitalist.appendDispatch(root, {
    id,
    at: new Date(Date.now() - 60_000).toISOString(),
    stage: "S1",
    shard: id,
    action: `做 ${id}`,
    status: "open",
  });
}

test("启动即暂停时首行报已启动，不出现暂停中", () => {
  const root = sandbox();
  put(root, "D-1");
  pause.pauseAll(root, "startup", "监工启动");

  const lines = [];
  const report = createStatusReporter(root, (line) => lines.push(line));
  report(3);
  report(3);

  assert.equal(lines.length, 1, "首轮之后状态未变，不该再打第二行");
  assert.notEqual(lines[0], describeStatusLine(root, 3), "首行不能是当前状态词（暂停中）");
  assert.ok(!/paused|暂停中/.test(lines[0]), `首行不应包含暂停措辞：${lines[0]}`);
  assert.ok(/started|已启动/.test(lines[0]), `首行应报已启动：${lines[0]}`);
});

test("启动无待派单时只报已启动，不补打运行中", () => {
  const root = sandbox();
  const lines = [];
  const report = createStatusReporter(root, (line) => lines.push(line));
  report(3);
  report(3);

  assert.equal(lines.length, 1);
  assert.ok(!/running|运行中/.test(lines[0]), `首行应为启动词：${lines[0]}`);
});

test("启动后恢复调度与再次暂停各打一行", () => {
  const root = sandbox();
  put(root, "D-1");
  pause.pauseAll(root, "startup", "监工启动");

  const lines = [];
  const report = createStatusReporter(root, (line) => lines.push(line));
  report(3);

  pause.resumeAll(root, "user");
  report(3);
  report(3);
  assert.equal(lines.length, 2, "恢复后应补一行，且同状态不重复");
  assert.equal(lines[1], describeStatusLine(root, 3));

  pause.pauseAll(root, "board", "再暂停");
  report(3);
  assert.equal(lines.length, 3, "再次暂停应打一行");
  assert.equal(lines[2], describeStatusLine(root, 3));
});
