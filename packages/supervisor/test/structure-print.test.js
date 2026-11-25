/**
 * 文件结构打印测试。
 *
 * 用统一入口（core/record/locations.ts）与真实调度逻辑生成一个 `.capitalist` 任务根，
 * 把目录树打印出来供人工核查，并断言结构满足设计约定：
 *   - 根级归零：`.capitalist/` 下只有 `.root` 目录与业务子目录，没有散落文件。
 *   - 会话映射：`sessions/<base>.json` 记录 base → 当前 UUID 会话 id。
 *   - worker per-worker：`workers/<id>/` 一个目录收 record/output/brief。
 *   - 重派复用：同任务重派续接同一会话 UUID；清理映射表后生成全新 UUID。
 */

process.env.CAPITALIST_USAGE_BALANCE = "0";

const test = require("node:test");
const assert = require("node:assert");
const { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const lane = require("../dist/supervisor/judge/sessionLane");
const locations = require("../dist/core/record/locations");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function emptyRoot() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-structure-"));
  mkdirSync(locations.rootDir(root), { recursive: true });
  mkdirSync(locations.sessions.dir(root), { recursive: true });
  mkdirSync(locations.workers.dir(root), { recursive: true });
  mkdirSync(join(root, ".capitalist", "ledger"), { recursive: true });
  return root;
}

/** 递归打印目录树（相对路径缩进），返回字符串数组。 */
function tree(dir, prefix = "") {
  const lines = [];
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
    }));
  } catch {
    return lines;
  }
  names.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const n of names) {
    if (n.name === ".DS_Store") continue;
    lines.push(`${prefix}${n.name}${n.isDir ? "/" : ""}`);
    if (n.isDir) lines.push(...tree(join(dir, n.name), `${prefix}  `));
  }
  return lines;
}

test("打印 .capitalist 目录结构，根级归零、子目录归类", () => {
  const root = emptyRoot();
  const d = { id: "4-1", shard: "", action: "做一件事" };

  // 建立会话映射（基名 capitalist-4：会话按任务号续接，重派不换会话）。
  const s = lane.pickLane(root, d);
  assert.strictEqual(s.resume, false, "首次新开会话");
  assert.match(s.id, UUID_RE, "会话 id 是 v4 UUID");

  // 建一个 worker 目录（per-worker：record + output + brief）。
  const wid = "4-P1";
  mkdirSync(locations.workers.of(root, wid), { recursive: true });
  writeFileSync(locations.workers.record(root, wid), JSON.stringify({ id: wid, status: "done" }));
  writeFileSync(locations.workers.output(root, wid), "log line\n");
  writeFileSync(locations.workers.brief(root, wid), "# brief\n");
  writeFileSync(locations.rootIndex.worker(root), JSON.stringify({ id: wid }) + "\n");

  // 建一个台账文件（ledger/events.jsonl）。
  writeFileSync(locations.ledger.events(root), JSON.stringify({ event: "tick" }) + "\n");

  const printed = tree(join(root, ".capitalist")).join("\n");
  console.log("\n=== .capitalist 目录结构 ===\n.capitalist/\n" + printed + "\n===========================\n");

  // 根级归零：.capitalist 根下不应有散落文件（只有目录）。
  const topLevel = readdirSync(join(root, ".capitalist"), { withFileTypes: true });
  const rootFiles = topLevel.filter((e) => e.isFile()).map((e) => e.name);
  assert.deepStrictEqual(rootFiles, [], "根级不应有散落文件");

  // 关键目录都在。
  assert.ok(topLevel.some((e) => e.isDirectory() && e.name === ".root"), ".root 目录存在");
  assert.ok(topLevel.some((e) => e.isDirectory() && e.name === "sessions"), "sessions 目录存在");
  assert.ok(topLevel.some((e) => e.isDirectory() && e.name === "workers"), "workers 目录存在");
  assert.ok(topLevel.some((e) => e.isDirectory() && e.name === "ledger"), "ledger 目录存在");

  // worker per-worker：record/output/brief 都在 workers/<id>/ 下。
  assert.ok(existsSync(locations.workers.record(root, wid)), "record.json 在 per-worker 目录");
  assert.ok(existsSync(locations.workers.output(root, wid)), "output.log 在 per-worker 目录");
  assert.ok(existsSync(locations.workers.brief(root, wid)), "brief.md 在 per-worker 目录");
  assert.ok(existsSync(locations.rootIndex.worker(root)), "worker 索引在 .root/index.jsonl");

  // 会话映射：sessions/<base>.json 存在，current 是 UUID。
  const base = "capitalist-4";
  const laneFile = locations.sessions.lane(root, base);
  assert.ok(existsSync(laneFile), "会话映射文件存在");
  const st = JSON.parse(readFileSync(laneFile, "utf8"));
  assert.strictEqual(st.base, base, "映射 base 正确");
  assert.match(st.current, UUID_RE, "映射 current 是 UUID");
});

test("重派复用同一会话 UUID，清理映射表后生成全新 UUID", () => {
  const root = emptyRoot();
  const a = { id: "5-1", stage: "S0", shard: "", action: "做一件事" };
  const b = { id: "5-2", stage: "S0", shard: "", action: "做一件事" };

  const sa = lane.pickLane(root, a);
  const sb = lane.pickLane(root, b);
  assert.strictEqual(sb.resume, true, "重派（5-2）续接同一会话");
  assert.strictEqual(sb.id, sa.id, "重派沿用同一 UUID，不新开文件");

  // 清理映射表（等价于清理 .capitalist）：新建一个空 root，同一任务号，应生成全新 UUID。
  const root2 = emptyRoot();
  const sc = lane.pickLane(root2, a);
  assert.match(sc.id, UUID_RE);
  assert.notStrictEqual(sc.id, sa.id, "清理后重建生成全新 UUID，不撞旧会话");
  assert.strictEqual(sc.resume, false, "清理后视为首次");
});

test("统一入口覆盖所有顶层子目录，路径不散落", () => {
  const root = emptyRoot();
  // 逐个断言 locations 的顶层命名空间返回的路径都以 .capitalist 开头且落在对应子目录。
  const cap = join(root, ".capitalist");
  const checks = [
    [locations.runtime.state(root), "runtime", "state.json"],
    [locations.runtime.supervisor(root), "runtime", "supervisor.json"],
    [locations.runtime.pause(root), "runtime", "pause.json"],
    [locations.ledger.tasks(root), "ledger", "tasks.jsonl"],
    [locations.ledger.events(root), "ledger", "events.jsonl"],
    [locations.model.rotate(root), "model", "rotate.json"],
    [locations.model.next(root), "model", "next.json"],
    [locations.board.key(root), "board", "key"],
    [locations.config.idMap(root), "config", "id-map.json"],
    [locations.meta.preempt(root), "meta", "preempt.json"],
    [locations.sessions.dir(root), "sessions", ""],
    [locations.workers.dir(root), "workers", ""],
    [locations.inbox.dispatch(root), "inbox", "dispatch.jsonl"],
    [locations.mq.reports(root), "mq", "reports.jsonl"],
    [locations.guard.requests(root), "guard", "requests.jsonl"],
    [locations.brain.dir(root), "brain", ""],
    [locations.reload.dir(root), "reload", ""],
    [locations.locks.dir(root), "locks", ""],
    [locations.archive.dir(root), "archive", ""],
    [locations.rootDir(root), ".root", ""],
  ];
  for (const [p, sub, file] of checks) {
    const expected = join(cap, sub, file);
    assert.strictEqual(p, expected, `${sub}/${file} 路径应由统一入口派生`);
  }
});
