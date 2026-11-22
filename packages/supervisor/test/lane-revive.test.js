/**
 * 会话可用性闸门：续接过一次仍找不到宿主会话文件时换代，不再续接一条不存在的会话。
 *
 * 宿主目录用环境变量 `CAPITALIST_HOST_PROJECTS` 指向临时目录，避免读到本机真实会话。
 * 事故形状：首派被额度挡住，会话文件从未创建，此后每次重派都续接同一条不存在的会话。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const lane = require("../dist/supervisor/judge/sessionLane");

const BASE = "capitalist-s0-65";
const DISPATCH = { id: "65-1", stage: "S0", shard: "", tags: ["src-worker"], action: "校验文案" };

function setup() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-lane-revive-"));
  mkdirSync(join(root, ".capitalist", "sessions"), { recursive: true });
  mkdirSync(join(root, ".capitalist", "ledger"), { recursive: true });
  const host = join(root, "host-projects");
  mkdirSync(join(host, "proj"), { recursive: true });
  process.env.CAPITALIST_HOST_PROJECTS = host;
  return { root, host };
}

/** 让该代续接过一次（resumes = 1），模拟“重派过一次、仍未产出读数”。 */
function warmLane(root) {
  const first = lane.pickLane(root, DISPATCH);
  assert.strictEqual(first.resume, false, "首次分配新会话");
  const second = lane.pickLane(root, DISPATCH);
  assert.strictEqual(second.resume, true, "首次续接不校验文件，沿用刚分配的会话");
  return lane.readLane(root, BASE);
}

test("宿主没有这条会话文件：第二次续接改为换代", () => {
  const { root } = setup();
  const st = warmLane(root);
  assert.strictEqual(st.gen, 0);
  assert.strictEqual(st.resumes, 1);

  const next = lane.pickLane(root, DISPATCH);
  assert.strictEqual(next.resume, false, "不再续接一条不存在的会话");
  assert.notStrictEqual(next.id, st.current);
  const after = lane.readLane(root, BASE);
  assert.strictEqual(after.gen, 1, "换代一次");
  assert.strictEqual(after.current, next.id);
});

test("宿主已有这条会话文件：继续续接，不换代", () => {
  const { root, host } = setup();
  const st = warmLane(root);
  writeFileSync(join(host, "proj", `${st.current}.jsonl`), "{}\n");

  const next = lane.pickLane(root, DISPATCH);
  assert.strictEqual(next.resume, true, "文件在，续接同一会话");
  assert.strictEqual(next.id, st.current);
  assert.strictEqual(lane.readLane(root, BASE).gen, 0, "不换代");
});

test("有用量读数的会话不因文件缺失被换掉", () => {
  const { root } = setup();
  const first = lane.pickLane(root, DISPATCH);
  lane.recordLaneUsage(root, first.id, { context_used: 1000, context_window: 300_000 });
  /* 再续接一次，让 resumes 达到 1，仍然不应触发文件校验。 */
  assert.strictEqual(lane.pickLane(root, DISPATCH).resume, true);
  const next = lane.pickLane(root, DISPATCH);
  assert.strictEqual(next.resume, true, "跑过的会话按可用处理");
  assert.strictEqual(next.id, first.id);
});
