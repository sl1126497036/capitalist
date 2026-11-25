/**
 * `capitalist tree group` 冒烟：命令行是用户实际入口，校验与写盘都要走通。
 *
 * 这里直接调用 `cmdTreeGroup` 并抓 stdout，不经过进程拉起：
 * 断言的是"命令给出的结论"与"台账里的事实"两件事是否一致。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { cmdTreeGroup } = require("../dist/cli/cmd/treeGroup");
const { composeDispatch, commitDispatch } = require("../dist/core/dispatch/newDispatch");
const { readDispatches } = require("../dist/core/record/supervisor");
const { readGroups, groupIndexOf } = require("../dist/core/record/groups");

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-cli-group-"));
  fs.mkdirSync(path.join(root, ".capitalist", "inbox"), { recursive: true });
  return root;
}
function dropRoot(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* 删除 shim 可能拦下清理 */
  }
}
function put(root, id, extra = {}) {
  commitDispatch(
    root,
    composeDispatch({
      id,
      stage: "S0",
      title: id,
      action: `做 ${id}`,
      status: extra.status ?? "open",
      source: "adhoc",
      attempt: 1,
      ...(extra.parent ? { parent: extra.parent, parentReason: "测试" } : {}),
    }),
  );
}

/** 跑一条命令并收集 stdout。`positional` 不含命令名本身：`["group","new",...]`。 */
function run(root, positional) {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    out += String(s);
    return true;
  };
  let code = 0;
  try {
    code = cmdTreeGroup({ cmd: "tree", positional, flags: {} }, root);
  } finally {
    process.stdout.write = orig;
  }
  return { code, out };
}

test("tree group new：建组并把成员收进去", () => {
  const root = makeRoot();
  try {
    put(root, "1-1");
    put(root, "1-2");
    const r = run(root, ["group", "new", "前后端并行", "1-1", "1-2"]);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /#G01/);
    const groups = readGroups(root);
    assert.strictEqual(groups.length, 1);
    const idx = groupIndexOf(readDispatches(root), groups);
    assert.deepStrictEqual(idx.members.get("G1"), ["1-1", "1-2"]);
  } finally {
    dropRoot(root);
  }
});

test("tree group new：只有一单时拒绝，理由说明不需要分组", () => {
  const root = makeRoot();
  try {
    put(root, "1-1");
    const r = run(root, ["group", "new", "单条", "1-1"]);
    assert.strictEqual(r.code, 2);
    assert.match(r.out, /至少需要两条派单/);
    assert.strictEqual(readGroups(root).length, 0, "被拒时不留空组");
  } finally {
    dropRoot(root);
  }
});

test("tree group new：成员父节点不一致时拒绝挂载，但仍保留空组并说明原因", () => {
  const root = makeRoot();
  try {
    put(root, "0-1");
    put(root, "1-1", { parent: "0-1" });
    put(root, "1-2"); // 无父
    const r = run(root, ["group", "new", "父不一致", "1-1", "1-2"]);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /父节点/);
    /* 组号已发行，成员一个都没挂上：如实显示，不假装成功。 */
    assert.strictEqual(readGroups(root).length, 1);
    const idx = groupIndexOf(readDispatches(root), readGroups(root));
    assert.deepStrictEqual(idx.members.get("G1"), []);
  } finally {
    dropRoot(root);
  }
});

test("tree group ls：列出成员、完成数与状态", () => {
  const root = makeRoot();
  try {
    put(root, "1-1", { status: "done" });
    put(root, "1-2");
    run(root, ["group", "new", "并行", "1-1", "1-2"]);
    const r = run(root, ["group", "ls"]);
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /#G01/);
    assert.match(r.out, /1\/2 完成/);
    assert.match(r.out, /1-1/);
    assert.match(r.out, /1-2/);
  } finally {
    dropRoot(root);
  }
});

test("tree group rm：成员移出后不再属于该组", () => {
  const root = makeRoot();
  try {
    put(root, "1-1");
    put(root, "1-2");
    run(root, ["group", "new", "并行", "1-1", "1-2"]);
    const r = run(root, ["group", "rm", "#G01", "1-2"]);
    assert.strictEqual(r.code, 0, r.out);
    const idx = groupIndexOf(readDispatches(root), readGroups(root));
    assert.deepStrictEqual(idx.members.get("G1"), ["1-1"]);
  } finally {
    dropRoot(root);
  }
});

test("tree group add：用 #G01 与 G1 都能加成员", () => {
  const root = makeRoot();
  try {
    for (const id of ["1-1", "1-2", "1-3"]) put(root, id);
    run(root, ["group", "new", "并行", "1-1", "1-2"]);
    const a = run(root, ["group", "add", "#G01", "1-3"]);
    assert.strictEqual(a.code, 0, a.out);
    const idx = groupIndexOf(readDispatches(root), readGroups(root));
    assert.deepStrictEqual(idx.members.get("G1"), ["1-1", "1-2", "1-3"]);
  } finally {
    dropRoot(root);
  }
});

test("tree group close：解散后 ls 显示已解散", () => {
  const root = makeRoot();
  try {
    put(root, "1-1");
    put(root, "1-2");
    run(root, ["group", "new", "并行", "1-1", "1-2"]);
    const c = run(root, ["group", "close", "#G01"]);
    assert.strictEqual(c.code, 0, c.out);
    assert.strictEqual(readGroups(root)[0].state, "closed");
    const ls = run(root, ["group", "ls"]);
    assert.match(ls.out, /已解散/);
  } finally {
    dropRoot(root);
  }
});

test("tree group attach：整组改挂到新父节点", () => {
  const root = makeRoot();
  try {
    put(root, "0-1");
    put(root, "9-9");
    put(root, "1-1", { parent: "0-1" });
    put(root, "1-2", { parent: "0-1" });
    run(root, ["group", "new", "并行", "1-1", "1-2"]);
    const r = run(root, ["group", "attach", "#G01", "9-9", "--reason", "换上游"]);
    assert.strictEqual(r.code, 0, r.out);
    const byId = new Map(readDispatches(root).map((d) => [d.id, d]));
    assert.strictEqual(byId.get("1-1").parent, "9-9");
    assert.strictEqual(byId.get("1-2").parent, "9-9");
  } finally {
    dropRoot(root);
  }
});

test("tree group：未知子命令给出用法，不误改台账", () => {
  const root = makeRoot();
  try {
    put(root, "1-1");
    const r = run(root, ["group", "frobnicate"]);
    assert.strictEqual(r.code, 2);
    assert.match(r.out, /用法/);
    assert.strictEqual(readGroups(root).length, 0);
  } finally {
    dropRoot(root);
  }
});

// ---------------------------------------------------------------- 单点改挂

const { cmdTreeMove } = require("../dist/cli/cmd/treeGroup");

/** 跑 move / detach 并收集 stdout。 */
function runMove(root, positional, flags = {}, detach = false) {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    out += String(s);
    return true;
  };
  let code = 0;
  try {
    code = cmdTreeMove({ cmd: "tree", positional, flags }, root, detach);
  } finally {
    process.stdout.write = orig;
  }
  return { code, out };
}

test("tree move：改挂到组，父节点与理由一起落盘", () => {
  const root = makeRoot();
  try {
    put(root, "1-1");
    put(root, "1-2");
    run(root, ["group", "new", "并行", "1-1", "1-2"]);
    put(root, "2-1");

    const r = runMove(root, ["move", "2-1"], { under: "#G01", reason: "等两边都落地" });
    assert.strictEqual(r.code, 0, r.out);
    const d = readDispatches(root).find((x) => x.id === "2-1");
    assert.strictEqual(d.parent, "G1", "落盘写归一后的组号");
    assert.strictEqual(d.parent_reason, "等两边都落地");
  } finally {
    dropRoot(root);
  }
});

test("tree move：--under 接受派单编号", () => {
  const root = makeRoot();
  try {
    put(root, "1-1");
    put(root, "2-1");
    const r = runMove(root, ["move", "2-1"], { under: "#01", reason: "等 #01" });
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual(readDispatches(root).find((x) => x.id === "2-1").parent, "1-1");
  } finally {
    dropRoot(root);
  }
});

test("tree move：组内成员单点改挂被拒，并给出两条出路", () => {
  const root = makeRoot();
  try {
    put(root, "1-1");
    put(root, "1-2");
    run(root, ["group", "new", "并行", "1-1", "1-2"]);
    put(root, "9-1");

    const r = runMove(root, ["move", "1-1"], { under: "9-1", reason: "试试" });
    assert.strictEqual(r.code, 1, "拆散组要被拒");
    assert.match(r.out, /是 #G01 的成员/);
    assert.match(r.out, /tree group attach/);
    assert.match(r.out, /tree group rm/);
    /* 台账不许被改动。 */
    assert.strictEqual(readDispatches(root).find((x) => x.id === "1-1").parent, undefined);
  } finally {
    dropRoot(root);
  }
});

test("tree move：成环被拒", () => {
  const root = makeRoot();
  try {
    put(root, "1-1");
    put(root, "2-1", { parent: "1-1" });
    const r = runMove(root, ["move", "1-1"], { under: "2-1", reason: "改挂" });
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /成环/);
  } finally {
    dropRoot(root);
  }
});

test("tree detach：摘成根，父与理由一并清掉", () => {
  const root = makeRoot();
  try {
    put(root, "1-1");
    put(root, "2-1", { parent: "1-1" });
    const r = runMove(root, ["detach", "2-1"], {}, true);
    assert.strictEqual(r.code, 0, r.out);
    const d = readDispatches(root).find((x) => x.id === "2-1");
    assert.strictEqual(d.parent, undefined);
    assert.strictEqual(d.parent_reason, undefined);
  } finally {
    dropRoot(root);
  }
});

test("tree move：缺 --under 时拒绝，不做默认挂载", () => {
  const root = makeRoot();
  try {
    put(root, "1-1");
    const r = runMove(root, ["move", "1-1"], {});
    assert.strictEqual(r.code, 2);
    assert.match(r.out, /--under/);
  } finally {
    dropRoot(root);
  }
});

// ---------------------------------------------------------------- 改挂时的遗留前置清理

const { appendDispatch } = require("../dist/core/record/supervisor");

/** 直接写一条带 `after` 的派单：建单入口会把十个编号写成一条前置，这里按同一形态造数据。 */
function putWithAfter(root, id, after, extra = {}) {
  appendDispatch(root, {
    id,
    at: new Date().toISOString(),
    stage: "S0",
    lineage: id,
    title: id,
    action: `做 ${id}`,
    status: extra.status ?? "open",
    after,
    ...(extra.parent ? { parent: extra.parent, parent_reason: "测试" } : {}),
  });
}

test("tree move：挂组时清掉指向组内成员的遗留前置，组外前置保留", () => {
  const root = makeRoot();
  try {
    put(root, "1-1");
    put(root, "1-2");
    run(root, ["group", "new", "并行", "1-1", "1-2"]);
    put(root, "9-1");
    putWithAfter(root, "2-1", ["1-1", "1-2", "9-1"]);

    const r = runMove(root, ["move", "2-1"], { under: "#G01", reason: "整组完成才放行" });
    assert.strictEqual(r.code, 0, r.out);
    const d = readDispatches(root).find((x) => x.id === "2-1");
    assert.strictEqual(d.parent, "G1");
    assert.deepStrictEqual(d.after, ["9-1"], "成员边被组边覆盖，组外前置不动");
  } finally {
    dropRoot(root);
  }
});

test("tree detach：摘成根时遗留前置一并清掉，不再原地等待", () => {
  const root = makeRoot();
  try {
    put(root, "1-1");
    putWithAfter(root, "2-1", ["1-1"], { parent: "1-1" });
    const before = readDispatches(root).find((x) => x.id === "2-1");
    assert.deepStrictEqual(before.after, ["1-1"], "前提：摘根前留着遗留前置");

    const r = runMove(root, ["detach", "2-1"], {}, true);
    assert.strictEqual(r.code, 0, r.out);
    const d = readDispatches(root).find((x) => x.id === "2-1");
    assert.strictEqual(d.parent, undefined);
    assert.strictEqual(d.after, undefined, "摘根后不应再等任何前置");
  } finally {
    dropRoot(root);
  }
});

test("tree move：先摘根再挂组，记录里只剩组边", () => {
  const root = makeRoot();
  try {
    put(root, "1-1");
    put(root, "1-2");
    run(root, ["group", "new", "并行", "1-1", "1-2"]);
    putWithAfter(root, "2-1", ["1-1", "1-2"]);

    assert.strictEqual(runMove(root, ["detach", "2-1"], {}, true).code, 0);
    assert.strictEqual(runMove(root, ["move", "2-1"], { under: "#G01", reason: "重新挂组" }).code, 0);
    const d = readDispatches(root).find((x) => x.id === "2-1");
    assert.strictEqual(d.parent, "G1");
    assert.strictEqual(d.after, undefined);
  } finally {
    dropRoot(root);
  }
});
