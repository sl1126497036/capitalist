/**
 * 结构插入：把新单插到锚点之前或之后。
 *
 * 这一层最容易错的是"插入后原有下游的去向"：
 *   - `before` 时锚点改挂新单，锚点自己的下游不动；
 *   - `after` 时锚点不动，锚点的原有下游改挂新单。未调整时，新单仅多出一个同级项。
 *
 * 锚点是组时还有一条：组没有自己的父字段，位置由成员父推导，所以改成员即改位置，
 * 挂在组上的下游不受影响。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { composeDispatch, commitDispatch } = require("../dist/core/dispatch/newDispatch");
const { readDispatches } = require("../dist/core/record/supervisor");
const { issueGroupNo, readGroups, groupIndexOf } = require("../dist/core/record/groups");
const { insertNode } = require("../dist/core/dispatch/treeOps");
const { parseInsert, parseInsertMode } = require("../dist/supervisor/channel/treeLines");
const { buildForestView } = require("../dist/supervisor/view/forestView");

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-insert-"));
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
  const d = composeDispatch({
    id,
    stage: "S0",
    title: id,
    action: `做 ${id}`,
    status: extra.status ?? "open",
    source: "adhoc",
    attempt: 1,
    ...(extra.parent ? { parent: extra.parent, parentReason: extra.reason ?? "测试用" } : {}),
    ...(extra.group ? { group: extra.group } : {}),
  });
  commitDispatch(root, d);
}

const byId = (root) => new Map(readDispatches(root).map((d) => [String(d.id), d]));
const parentOfId = (root, id) => String(byId(root).get(id)?.parent ?? "");

test("解析：INSERT 的四种写法与 now 修饰", () => {
  assert.deepStrictEqual(parseInsert("before #03"), { where: "before", anchor: "#03", now: false });
  assert.deepStrictEqual(parseInsert("after #G1 now"), { where: "after", anchor: "#G1", now: true });
  assert.deepStrictEqual(parseInsert("之前 #03 立即"), { where: "before", anchor: "#03", now: true });
  assert.strictEqual(parseInsert("sometime #03"), null, "无法识别的位置不作推测");
  assert.strictEqual(parseInsertMode("halt"), "halt");
  assert.strictEqual(parseInsertMode("KEEP"), "keep");
  assert.strictEqual(parseInsertMode("nonsense"), "");
});

test("insert before 派单：新单接管位置，锚点改挂新单，锚点的下游不动", () => {
  const root = makeRoot();
  try {
    put(root, "P");
    put(root, "A", { parent: "P" });
    put(root, "C", { parent: "A" });
    put(root, "N"); // 新单，建单时还没有父

    const r = insertNode(root, { newId: "N", anchor: "A", where: "before" });
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
    assert.strictEqual(parentOfId(root, "N"), "P", "新单接管锚点原来的位置");
    assert.strictEqual(parentOfId(root, "A"), "N", "锚点改挂新单");
    assert.strictEqual(parentOfId(root, "C"), "A", "锚点的下游不动");
  } finally {
    dropRoot(root);
  }
});

test("insert after 派单：新单挂到锚点下，锚点原有下游改挂新单", () => {
  const root = makeRoot();
  try {
    put(root, "P");
    put(root, "A", { parent: "P" });
    put(root, "C", { parent: "A" });
    put(root, "D", { parent: "A" });
    put(root, "N");

    const r = insertNode(root, { newId: "N", anchor: "A", where: "after" });
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
    assert.strictEqual(parentOfId(root, "N"), "A", "新单挂在锚点下");
    assert.strictEqual(parentOfId(root, "C"), "N", "原下游改挂新单");
    assert.strictEqual(parentOfId(root, "D"), "N");
  } finally {
    dropRoot(root);
  }
});

test("insert before 组：全部成员改挂新单，挂在组上的下游不动", () => {
  const root = makeRoot();
  try {
    put(root, "P");
    const g = issueGroupNo(root, { title: "并行改造" });
    put(root, "A", { parent: "P", group: g.group.id });
    put(root, "B", { parent: "P", group: g.group.id });
    put(root, "D", { parent: g.group.id });
    put(root, "N");

    const r = insertNode(root, { newId: "N", anchor: "#G1", where: "before" });
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
    assert.strictEqual(parentOfId(root, "N"), "P", "新单接管组的父");
    assert.strictEqual(parentOfId(root, "A"), "N", "成员改挂新单");
    assert.strictEqual(parentOfId(root, "B"), "N");
    assert.strictEqual(parentOfId(root, "D"), g.group.id, "挂在组上的下游不动");

    /* 组的树位置由成员推导：现在组的父是新单。 */
    const view = buildForestView(root);
    const gnode = view.trees.flatMap((t) => t.nodes).find((n) => n.kind === "group");
    assert.strictEqual(gnode.parent, "N");
  } finally {
    dropRoot(root);
  }
});

test("insert after 组：只改挂在组上的下游，成员不动", () => {
  const root = makeRoot();
  try {
    const g = issueGroupNo(root, { title: "并行改造" });
    put(root, "A", { group: g.group.id });
    put(root, "B", { group: g.group.id });
    put(root, "D", { parent: g.group.id });
    put(root, "N");

    const r = insertNode(root, { newId: "N", anchor: "#G1", where: "after" });
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
    assert.strictEqual(parentOfId(root, "N"), g.group.id, "新单挂在组下");
    assert.strictEqual(parentOfId(root, "A"), "", "成员不动（本来就无父）");
    assert.strictEqual(parentOfId(root, "D"), "N", "组的下游改挂新单");
  } finally {
    dropRoot(root);
  }
});

test("在途处置 halt：退回 open 并写 restructured_at，返回要结束的派单", () => {
  const root = makeRoot();
  try {
    put(root, "P");
    put(root, "A", { parent: "P", status: "claimed" });
    put(root, "N");

    const r = insertNode(root, { newId: "N", anchor: "A", where: "before", mode: "halt" });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.stopDispatches, ["A"]);
    const a = byId(root).get("A");
    assert.strictEqual(a.status, "open");
    assert.ok(String(a.restructured_at ?? ""), "写了结构变更标记");
    assert.ok(!a.yield_rank, "不写让位标记：结构变更与抢槽是两套语义");
  } finally {
    dropRoot(root);
  }
});

test("在途处置 keep：一个都不动，也不返回要结束的派单", () => {
  const root = makeRoot();
  try {
    put(root, "P");
    put(root, "A", { parent: "P", status: "claimed" });
    put(root, "N");
    const r = insertNode(root, { newId: "N", anchor: "A", where: "before", mode: "keep" });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.stopDispatches, []);
    assert.strictEqual(byId(root).get("A").status, "claimed");
    assert.strictEqual(parentOfId(root, "A"), "N", "结构仍然变了");
  } finally {
    dropRoot(root);
  }
});

test("在途处置 drop：转 closed 并写明作废原因", () => {
  const root = makeRoot();
  try {
    put(root, "P");
    put(root, "A", { parent: "P", status: "claimed" });
    put(root, "N");
    const r = insertNode(root, { newId: "N", anchor: "A", where: "before", mode: "drop" });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.stopDispatches, ["A"]);
    const a = byId(root).get("A");
    assert.strictEqual(a.status, "closed");
    assert.match(String(a.note ?? ""), /结构变更作废/);
  } finally {
    dropRoot(root);
  }
});

test("锚点已收尾：拒绝插入，台账不动", () => {
  const root = makeRoot();
  try {
    put(root, "A", { status: "done" });
    put(root, "N");
    const r = insertNode(root, { newId: "N", anchor: "A", where: "before" });
    assert.strictEqual(r.ok, false);
    assert.match(r.errors[0].reason, /已收尾/);
    assert.strictEqual(parentOfId(root, "N"), "", "被拒时不改任何父节点");
  } finally {
    dropRoot(root);
  }
});

test("锚点不存在：拒绝，且不把新单变成根之外的野节点", () => {
  const root = makeRoot();
  try {
    put(root, "N");
    const r = insertNode(root, { newId: "N", anchor: "nope", where: "before" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(parentOfId(root, "N"), "");
  } finally {
    dropRoot(root);
  }
});

test("插入后组不因改挂缺员：成员仍是原组的成员", () => {
  const root = makeRoot();
  try {
    const g = issueGroupNo(root, { title: "并行改造" });
    put(root, "A", { group: g.group.id });
    put(root, "B", { group: g.group.id });
    put(root, "N");
    insertNode(root, { newId: "N", anchor: "#G1", where: "before" });
    const idx = groupIndexOf(readDispatches(root), readGroups(root));
    assert.deepStrictEqual(idx.members.get(g.group.id), ["A", "B"]);
    assert.deepStrictEqual(idx.dangling, []);
  } finally {
    dropRoot(root);
  }
});
