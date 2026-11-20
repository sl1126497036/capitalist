/**
 * 归档与结构变更标记：两处"组进了台账、却没人负责收尾"的地方。
 *
 * 这两处不会在功能测试里暴露，因为它们的后果都是"下次启动才看见"：
 *   - `restructured_at` 不清：退回重做的单跑完了，界面还标"待重做"；
 *   - 归档不管组：成员都进了归档，`tree group ls` 还列着一个 0/0 的幽灵组。
 *
 * 归档这里有一条必须守住的边界：**台账里还有单挂着这个组时不能移组记录**。
 * 移了以后那些单的父节点就指向不存在的节点，从"等整组做完"变成永久等待。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { composeDispatch, commitDispatch } = require("../dist/core/dispatch/newDispatch");
const { claimDispatch, finishDispatch, readDispatches } = require("../dist/core/record/supervisor");
const { issueGroupNo, readGroups } = require("../dist/core/record/groups");
const { archiveFinished } = require("../dist/core/record/archive");

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-archive-"));
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
      ...(extra.parent ? { parent: extra.parent, parentReason: extra.reason ?? "测试用" } : {}),
      ...(extra.group ? { group: extra.group } : {}),
    }),
  );
}

/** 直接把一单改成 `done`：归档只认状态，不关心怎么到的。 */
function markDone(root, id) {
  claimDispatch(root, id, "W1");
  finishDispatch(root, id, "done");
}

test("结构退回的标记：领走时清除", () => {
  const root = makeRoot();
  try {
    /* 锚点本身在途：插入要改挂它，`halt` 把它退回重做。 */
    put(root, "1-1");
    claimDispatch(root, "1-1", "W1");
    put(root, "9-1");

    const { insertNode } = require("../dist/core/dispatch/treeOps");
    const r = insertNode(root, { newId: "9-1", anchor: "1-1", where: "before", mode: "halt" });
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
    assert.deepStrictEqual(r.stopDispatches, ["1-1"], "退回的在途单要交给调用方结束进程");

    const halted = readDispatches(root).find((d) => d.id === "1-1");
    assert.strictEqual(halted.status, "open", "halt 应退回排队");
    assert.ok(halted.restructured_at, "应写结构变更标记");

    /* 重新领走：标记到此为止，否则界面一直标"待重做"。 */
    const claimed = claimDispatch(root, "1-1", "W2");
    assert.ok(claimed);
    assert.strictEqual(claimed.restructured_at, undefined);
  } finally {
    dropRoot(root);
  }
});

test("让位标记与结构标记同时存在时，领走一并清除", () => {
  const root = makeRoot();
  try {
    put(root, "1-1");
    /* 直接写两个标记，模拟"先被插队、后被结构退回"的单。 */
    const { writeJsonl } = require("../dist/core/record/json");
    const { dispatchPath } = require("../dist/core/record/supervisor");
    writeJsonl(
      dispatchPath(root),
      readDispatches(root).map((d) => ({
        ...d,
        yielded_at: new Date().toISOString(),
        yield_rank: 1,
        restructured_at: new Date().toISOString(),
      })),
    );
    const claimed = claimDispatch(root, "1-1", "W1");
    assert.strictEqual(claimed.yielded_at, undefined);
    assert.strictEqual(claimed.yield_rank, undefined);
    assert.strictEqual(claimed.restructured_at, undefined);
  } finally {
    dropRoot(root);
  }
});

test("归档：成员全部归档且无下游时，组随之归档", () => {
  const root = makeRoot();
  try {
    const g = issueGroupNo(root, { title: "并行改造", created_by: "llm" });
    put(root, "1-1", { group: g.group.id });
    put(root, "1-2", { group: g.group.id });
    markDone(root, "1-1");
    markDone(root, "1-2");

    const r = archiveFinished(root, "done");
    assert.strictEqual(r.dispatches, 2);
    assert.deepStrictEqual(readGroups(root), [], "成员走光后组不该留在台账");

    /* 组记录进归档目录，便于追溯。 */
    const archived = path.join(r.dir, "groups.jsonl");
    assert.ok(fs.existsSync(archived), "归档目录应有 groups.jsonl");
    const rows = fs
      .readFileSync(archived, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepStrictEqual(
      rows.map((x) => x.id),
      [g.group.id],
    );
  } finally {
    dropRoot(root);
  }
});

test("归档：还有单挂在组上时，组必须保留", () => {
  const root = makeRoot();
  try {
    const g = issueGroupNo(root, { title: "并行改造", created_by: "llm" });
    put(root, "1-1", { group: g.group.id });
    put(root, "1-2", { group: g.group.id });
    put(root, "2-1", { parent: g.group.id, reason: "等整组" });
    markDone(root, "1-1");
    markDone(root, "1-2");

    /* 只归档已完成：成员走了，下游还排着。 */
    const r = archiveFinished(root, "done");
    assert.strictEqual(r.dispatches, 2);
    assert.deepStrictEqual(
      readGroups(root).map((x) => x.id),
      [g.group.id],
      "移走组记录会让下游的 parent 指向不存在的节点",
    );
    assert.strictEqual(readDispatches(root).length, 1, "下游仍在台账");
  } finally {
    dropRoot(root);
  }
});

test("归档：没加过成员的空组是合法中间态，不归档", () => {
  const root = makeRoot();
  try {
    const empty = issueGroupNo(root, { title: "刚建还没加人", created_by: "user" });
    put(root, "1-1");
    markDone(root, "1-1");

    archiveFinished(root, "done");
    assert.deepStrictEqual(
      readGroups(root).map((x) => x.id),
      [empty.group.id],
      "空组不是"成员走光"，用户可能正要加人",
    );
  } finally {
    dropRoot(root);
  }
});
