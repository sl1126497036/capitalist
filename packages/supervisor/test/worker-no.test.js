
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/record/supervisor");
const cmds = require("../dist/core/dispatch/commands");
const { createTaskRoot } = require("../dist/core/contract/init");

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-wno-"));
  createTaskRoot({ target: "进程编号测试", contractSpec: "minimal", root: base });
  return base;
}

test("新进程 id 是纯数字，且自增不重复", () => {
  const root = sandbox();
  const a = capitalist.newWorkerId(root);
  const b = capitalist.newWorkerId(root);
  assert.match(a, /^\d+$/, `进程号应是纯数字：${a}`);
  assert.match(b, /^\d+$/);
  assert.notEqual(a, b, "两次分配不能撞号");
  assert.equal(Number(b), Number(a) + 1, "自增必须连号");
});

test("跳过已被占用的号，不复用台账里已存在的进程", () => {
  const root = sandbox();
  const first = capitalist.newWorkerId(root);
  /* 伪造一个“这个名字已经被写进台账”的局面。 */
  capitalist.saveWorker(root, {
    id: String(Number(first) + 1),
    host: "codebuddy",
    pid: process.pid,
    session: "x",
    dispatch: "",
    stage: "S0",
    shard: "",
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    heartbeat_ts: Date.now() / 1000,
    status: "running",
    log: "",
  });
  const next = capitalist.newWorkerId(root);
  assert.equal(Number(next), Number(first) + 2, "占用的号要跳过");
});

test("进程判定同时认新号与老台账的 W- 前缀", () => {
  assert.equal(cmds.isWorkerRef("1"), true);
  assert.equal(cmds.isWorkerRef("77"), true);
  assert.equal(cmds.isWorkerRef("W-mw1ux2pdm5"), true);
  assert.equal(cmds.isWorkerRef("w-3"), true);
  /* 任务号与派单 id 都不是进程。 */
  assert.equal(cmds.isWorkerRef("#77"), false);
  assert.equal(cmds.isWorkerRef("D-mw1uokpxhw0"), false);
  assert.equal(cmds.isWorkerRef("u1/xkpxhw0"), false);
});
