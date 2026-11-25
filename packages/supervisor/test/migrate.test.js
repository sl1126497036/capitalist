/**
 * 旧命名迁移的回归测试。
 *
 * 迁移改的是用户既有数据，测试重点不在"改对了没有"，而在三条约束：幂等、可回滚、
 * 不吞掉解析不了的行。
 */

const test = require("node:test");
const assert = require("node:assert");
const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { migrateRoot } = require("../dist/core/record/migrate");
const { writeJson } = require("../dist/core/record/json");

/*
 * 迁移默认会读用户级纳管配置。测试必须把它指到临时位置：否则跑一次测试就改掉了
 * 开发机上的真实 `~/.capitalist/capitalist-watch.json`。
 */
process.env.CAPITALIST_WATCH_CFG = join(tmpdir(), `cap-migrate-watch-${process.pid}.json`);

/** 建一个任务根并返回路径。不清理：`os.tmpdir()` 由系统回收，删目录会被沙箱挡。 */
function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "cap-migrate-"));
}

function dirOf(root, ...parts) {
  const dir = join(root, ".capitalist", ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 造一份旧版任务根：字段、文件名、事件名全是改名前的形态。
 *
 * @returns 任务根路径。
 */
function legacyRoot() {
  const root = tmpRoot();
  mkdirSync(join(root, "policies"), { recursive: true });
  const guard = join(root, "policies", "minimal.contract.json");
  writeFileSync(guard, JSON.stringify({ name: "minimal" }));
  writeJson(join(dirOf(root, "runtime"), "state.json"), {
    version: 2,
    target: "示例目标",
    contract: "minimal",
    contract_path: guard,
    contract_fallback: true,
    stage: "S0",
    stage_entered_at: "2026-11-01T00:00:00.000Z",
    stage_entered_at_ts: 1761955200,
    next_action: "分析",
  });
  writeJson(join(dirOf(root, "runtime"), "supervisor.json"), {
    pid: 123,
    status: "stopped",
    contract: "minimal",
  });
  writeJson(join(dirOf(root, "config"), "contract-prev.json"), { name: "minimal" });
  writeJson(join(dirOf(root, "reload"), "contract-seen.json"), { path: "x", mtime: "y" });
  writeJson(join(dirOf(root, "reload"), "snapshot.json"), {
    policy: "minimal",
    contract_freshness: { path: "x", stale: false },
  });
  const events = [
    { at: "2026-11-01T00:00:00.000Z", event: "contract_reload", kind: "contract_reload" },
    { at: "2026-11-01T00:00:01.000Z", event: "contract_change", kind: "contract_change" },
    { at: "2026-11-01T00:00:02.000Z", event: "dispatch_created", kind: "dispatch_created" },
  ];
  writeFileSync(join(dirOf(root, "ledger"), "events.jsonl"), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return root;
}

test("没有任务根时返回空报告，不报错", () => {
  const root = tmpRoot();
  const rep = migrateRoot(root);
  assert.deepEqual(rep.changed, []);
  assert.deepEqual(rep.errors, []);
});

test("旧结构全量迁移：字段、文件名、事件名、备份", () => {
  const root = legacyRoot();
  const watch = join(root, "watch.json");
  writeJson(watch, { _示例: { match: ["a"], contract: "dev" }, rules: [{ match: ["b"], contract: "ops" }] });

  const rep = migrateRoot(root, { watchFile: watch });
  assert.deepEqual(rep.errors, []);
  assert.ok(rep.changed.length >= 6, `改动项偏少：${rep.changed.join("；")}`);

  const st = JSON.parse(readFileSync(join(root, ".capitalist/runtime/state.json"), "utf8"));
  assert.equal(st.policy, "minimal");
  assert.equal(st.policy_path, join(root, "policies", "minimal.policy.json"));
  assert.equal(st.policy_fallback, true);
  assert.equal("contract" in st, false);
  assert.equal("contract_path" in st, false);
  assert.equal("contract_fallback" in st, false);
  assert.equal("stage" in st, false);
  assert.equal("stage_entered_at" in st, false);

  const sup = JSON.parse(readFileSync(join(root, ".capitalist/runtime/supervisor.json"), "utf8"));
  assert.equal(sup.policy, "minimal");
  assert.equal("contract" in sup, false);

  assert.ok(existsSync(join(root, ".capitalist/config/policy-prev.json")));
  assert.equal(existsSync(join(root, ".capitalist/config/contract-prev.json")), false);
  assert.ok(existsSync(join(root, ".capitalist/reload/policy-seen.json")));

  const snap = JSON.parse(readFileSync(join(root, ".capitalist/reload/snapshot.json"), "utf8"));
  assert.ok(snap.policy_freshness);
  assert.equal("contract_freshness" in snap, false);

  const events = readFileSync(join(root, ".capitalist/ledger/events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.event), ["policy_reload", "policy_change", "dispatch_created"]);
  assert.deepEqual(events.map((e) => e.kind), ["policy_reload", "policy_change", "dispatch_created"]);

  const w = JSON.parse(readFileSync(watch, "utf8"));
  assert.equal(w.rules[0].policy, "ops");
  assert.equal(w["_示例"].policy, "dev");
  assert.equal("contract" in w.rules[0], false);

  /* 备份是回滚的唯一依据：原文件必须按原路径留在备份目录里。 */
  assert.ok(rep.backupDir && existsSync(rep.backupDir), "没有备份目录");
  assert.ok(existsSync(join(rep.backupDir, "runtime/state.json")));
  const saved = JSON.parse(readFileSync(join(rep.backupDir, "runtime/state.json"), "utf8"));
  assert.equal(saved.contract, "minimal");
  assert.ok(existsSync(join(rep.backupDir, "watch-watch.json")));
});

test("幂等：第二次迁移没有改动", () => {
  const root = legacyRoot();
  const watch = join(root, "watch.json");
  writeJson(watch, { rules: [] });
  migrateRoot(root, { watchFile: watch });
  const again = migrateRoot(root, { watchFile: watch });
  assert.deepEqual(again.changed, []);
  assert.equal(again.backupDir, "");
});

test("预演只报告，不落盘也不建备份", () => {
  const root = legacyRoot();
  const before = readFileSync(join(root, ".capitalist/runtime/state.json"), "utf8");
  const rep = migrateRoot(root, { dryRun: true, watchFile: join(root, "none.json") });

  assert.ok(rep.changed.length > 0);
  assert.equal(readFileSync(join(root, ".capitalist/runtime/state.json"), "utf8"), before);
  assert.ok(rep.backupDir, "预演也要报出将备份到哪里");
  assert.equal(existsSync(rep.backupDir), false, "预演不该建备份目录");
  assert.equal(existsSync(join(root, ".capitalist/config/policy-prev.json")), false);
});

test("新旧并存：保留新值并提示，不静默覆盖", () => {
  const root = tmpRoot();
  writeJson(join(dirOf(root, "runtime"), "state.json"), {
    version: 2,
    target: "t",
    policy: "dev",
    contract: "minimal",
    policy_path: "/a",
    contract_path: "/b",
  });
  const rep = migrateRoot(root, { watchFile: join(root, "none.json") });
  const st = JSON.parse(readFileSync(join(root, ".capitalist/runtime/state.json"), "utf8"));
  assert.equal(st.policy, "dev");
  assert.equal(st.policy_path, "/a");
  assert.equal("contract" in st, false);
  assert.ok(rep.kept.some((k) => k.includes("state.json")), "冲突未进 kept");
});

test("目标文件名已存在时保留旧文件，交给人工确认", () => {
  const root = tmpRoot();
  writeJson(join(dirOf(root, "config"), "contract-prev.json"), { name: "old" });
  writeJson(join(dirOf(root, "config"), "policy-prev.json"), { name: "new" });
  const rep = migrateRoot(root, { watchFile: join(root, "none.json") });
  assert.ok(existsSync(join(root, ".capitalist/config/contract-prev.json")), "旧文件不该被覆盖掉");
  assert.ok(rep.kept.some((k) => k.includes("contract-prev.json")));
});

test("任务根内的守卫文件改后缀，state 指向一起改", () => {
  const root = tmpRoot();
  const dir = join(root, "policies");
  mkdirSync(dir, { recursive: true });
  const oldFile = join(dir, "dev.contract.json");
  writeFileSync(oldFile, JSON.stringify({ name: "dev" }));
  writeJson(join(dirOf(root, "runtime"), "state.json"), {
    version: 2,
    target: "t",
    contract: "dev",
    contract_path: oldFile,
  });

  migrateRoot(root, { watchFile: join(root, "none.json") });
  const st = JSON.parse(readFileSync(join(root, ".capitalist/runtime/state.json"), "utf8"));
  assert.equal(st.policy_path, join(dir, "dev.policy.json"));
  assert.ok(existsSync(join(dir, "dev.policy.json")));
  assert.equal(existsSync(oldFile), false);
});

test("安装目录内的守卫文件只置空引用，不动别人的文件", () => {
  const root = tmpRoot();
  const fake = join(root, "node_modules", "capitalist", "contracts");
  mkdirSync(fake, { recursive: true });
  const inPkg = join(fake, "minimal.contract.json");
  writeFileSync(inPkg, "{}");
  writeJson(join(dirOf(root, "runtime"), "state.json"), {
    version: 2,
    target: "t",
    contract: "minimal",
    contract_path: inPkg,
  });

  migrateRoot(root, { watchFile: join(root, "none.json") });
  const st = JSON.parse(readFileSync(join(root, ".capitalist/runtime/state.json"), "utf8"));
  assert.equal(st.policy_path, "");
  assert.ok(existsSync(inPkg), "包内文件不该被改名");
});

test("台账里的坏行原样保留", () => {
  const root = tmpRoot();
  const file = join(dirOf(root, "ledger"), "events.jsonl");
  writeFileSync(
    file,
    `{"at":"a","event":"contract_error","kind":"contract_error"}\n这不是 JSON\n{"at":"b","event":"ok"}\n`,
  );
  migrateRoot(root, { watchFile: join(root, "none.json") });
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes("这不是 JSON"), "坏行被吞了");
  assert.ok(text.includes('"event":"policy_error"'));
  assert.equal(text.includes('"event":"contract_error"'), false);
});

test("单项失败不影响其余项", () => {
  const root = legacyRoot();
  /* 台账路径换成同名目录：读它必失败，其余项仍应迁完。 */
  const ledger = join(root, ".capitalist/ledger/events.jsonl");
  renameSync(ledger, `${ledger}.moved`);
  mkdirSync(ledger);

  const rep = migrateRoot(root, { watchFile: join(root, "none.json") });
  const st = JSON.parse(readFileSync(join(root, ".capitalist/runtime/state.json"), "utf8"));
  assert.equal(st.policy, "minimal", "其他项被一项失败带停了");
  assert.ok(rep.errors.length >= 1, "失败没有被记录");
});

test("备份目录按任务根隔离，外部的纳管配置不落到目录外", () => {
  const root = legacyRoot();
  const outside = join(tmpRoot(), "capitalist-watch.json");
  writeJson(outside, { rules: [{ match: ["x"], contract: "dev" }] });
  const rep = migrateRoot(root, { watchFile: outside });
  const names = readdirSync(rep.backupDir);
  assert.ok(names.includes("runtime") && names.includes("watch-capitalist-watch.json"), `备份内容：${names}`);
  for (const name of names) assert.equal(name.startsWith(".."), false, `备份越界：${name}`);
});
