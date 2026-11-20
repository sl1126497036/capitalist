/**
 * 组号归一：`#G01` 与 `G1` 必须是同一个组。
 *
 * 为什么单独立一个测试文件：组号有两种形态同时在系统里流动。显示形态带 `#` 且补零
 * （`#G01`，看板与命令行给用户看的），落盘形态不带 `#` 且不补零（`G1`，台账里的）。
 * LLM 与人都会照抄显示形态。只要有一处只做大小写归一而不管前导零，`G01` 与 `G1`
 * 就变成两个键，后果是静默的：
 *
 *   - 成员 `group` 写 `G01` 时查不到组 `G1`，成员被记成 `dangling`，组少算一名成员，
 *     未跑完就可能放行下游；
 *   - `PARENT: #G01` 找不到组时，判定层按"孤立前置"放行，下游在组还没做完时启动。
 *
 * 两种后果都不会抛错，只会让树的顺序错掉。所以这里把"写法的所有变体"与
 * "每一条使用路径"都逐一断言，而不只测一个 normalize 函数。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { normalizeGroupId, groupNoLabel } = require("../dist/core/record/idMap");
const { parseRef, label, isGroupRef } = require("../dist/core/record/nodeRef");
const { readGroups, resolveGroupRef, groupIndexOf, looksLikeGroupRef, groupNoOf } =
  require("../dist/core/record/groups");
const { groupStatusOf, groupSettled } = require("../dist/core/dispatch/groupGraph");
const { splitPrerequisites, pendingOf } = require("../dist/core/dispatch/deps");

function d(id, status, extra = {}) {
  return { id, at: "2026-11-20T00:00:00.000Z", stage: "S0", action: `做 ${id}`, status, lineage: id, ...extra };
}
function g(id, extra = {}) {
  return { id, title: `组 ${id}`, at: "2026-11-20T00:00:00.000Z", state: "open", ...extra };
}

/** 一个最小可读组台账：只写 groups.jsonl，其余目录不存在也能读。 */
function withGroupsFile(rows, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-group-norm-"));
  const dir = path.join(root, ".capitalist", "inbox");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "groups.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  try {
    return fn(root);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* 环境里的删除 shim 可能拦下清理，残留不影响结论 */
    }
  }
}

test("normalizeGroupId：显示形态与落盘形态归一到同一个值", () => {
  for (const input of ["G1", "g1", "#G1", "#g1", "G01", "#G01", "G001", "#g001", " G1 "]) {
    assert.strictEqual(normalizeGroupId(input), "G1", `输入 ${JSON.stringify(input)}`);
  }
  /* 内部带空格不是合法写法：归一化只吸收"前导零与大小写"，不替调用方纠错。 */
  assert.strictEqual(normalizeGroupId("#G 1"), "");
  for (const input of ["G12", "#G012", "g0012"]) {
    assert.strictEqual(normalizeGroupId(input), "G12", `输入 ${JSON.stringify(input)}`);
  }
});

test("normalizeGroupId：不是组号的一律给出空串，不猜", () => {
  for (const input of ["", "#", "G", "G-1", "1-1", "#01", "02", "G1x", "xG1", null, undefined, 1]) {
    assert.strictEqual(normalizeGroupId(input), "", `输入 ${JSON.stringify(input)}`);
  }
});

test("groupNoLabel：任何写法都显示成补零的 #G0N", () => {
  for (const input of ["G1", "G01", "#G01", "g001"]) {
    assert.strictEqual(groupNoLabel(input), "#G01", `输入 ${JSON.stringify(input)}`);
  }
  assert.strictEqual(groupNoLabel("G12"), "#G12");
  assert.strictEqual(groupNoLabel("#G012"), "#G12");
});

test("parseRef / isGroupRef / label：三个入口对同一种写法给同一个结论", () => {
  for (const input of ["G1", "#G1", "G01", "#G01", "#g001"]) {
    assert.deepStrictEqual(parseRef(input), { kind: "group", id: "G1", raw: input });
    assert.strictEqual(isGroupRef(input), true, input);
  }
  /* 派单号与任务号不得被误认成组号。 */
  for (const input of ["1-1", "#01", "2-P1"]) {
    assert.notStrictEqual(parseRef(input).kind, "group", input);
    assert.strictEqual(isGroupRef(input), false, input);
  }
  assert.strictEqual(label("G01"), "#G01");
  assert.strictEqual(label("#G001"), "#G01");
  assert.strictEqual(looksLikeGroupRef("#G01"), true);
  assert.strictEqual(groupNoOf("#G01"), 1);
});

test("groupIndexOf：成员写 #G01 也归到 G1 组，不落 dangling", () => {
  const rows = [d("1-1", "done", { group: "#G01" }), d("1-2", "open", { group: "G01" }), d("1-3", "open", { group: "g1" })];
  const idx = groupIndexOf(rows, [g("G1")]);
  assert.deepStrictEqual(idx.members.get("G1"), ["1-1", "1-2", "1-3"]);
  assert.deepStrictEqual(idx.dangling, []);
  assert.strictEqual(idx.groupOf.get("1-2"), "G1");
});

test("groupIndexOf：组里的成员混写大小写，重派不会缺员", () => {
  const rows = [d("1-1", "done", { group: "G1" }), d("1-1", "failed", { group: "G01" })];
  const idx = groupIndexOf(rows, [g("G01")]);
  /* 组记录本身写 G01 也归一，否则 byId 与 members 的键会对不上。 */
  assert.deepStrictEqual(idx.members.get("G1"), ["1-1", "1-1"]);
  assert.ok(idx.byId.has("G1"));
});

test("groupStatusOf：用 #G01 查 G1 组，与用 G1 查结果一致", () => {
  const rows = [d("1-1", "done", { group: "G1" }), d("1-2", "open", { group: "G1" })];
  const idx = groupIndexOf(rows, [g("G1")]);
  const a = groupStatusOf("G1", rows, idx);
  const b = groupStatusOf("#G01", rows, idx);
  const c = groupStatusOf("G01", rows, idx);
  assert.deepStrictEqual(b, a);
  assert.deepStrictEqual(c, a);
  assert.strictEqual(a.id, "G1");
  assert.strictEqual(a.total, 2);
});

test("放行判定：成员写 #G01 时不能因为查不到而提前放行", () => {
  /*
   * 这是归一化最要紧的一条。若 `#G01` 的成员没被算进组，组只剩零名成员，
   * `pending` 为空 → 判定为 done → 下游在成员还在排队时就启动。
   */
  const rows = [d("1-1", "open", { group: "#G01" }), d("1-2", "open", { group: "#G01" })];
  const idx = groupIndexOf(rows, [g("G1")]);
  const st = groupSettled("G1", rows, idx);
  assert.strictEqual(st.settled, false, "两名成员都在排队，组不得放行");
  assert.deepStrictEqual(st.pending.sort(), ["1-1", "1-2"]);
});

test("splitPrerequisites：parent / after 里的组号统一归一", () => {
  const split = splitPrerequisites({ parent: "#G01", after: ["g002", "1-1", "#G01"] });
  assert.deepStrictEqual(split.groupIds, ["G1", "G2"]);
  assert.deepStrictEqual(split.dispatchIds, ["1-1"]);
});

test("pendingOf：组前置混写形态，判定与落盘形态完全一致", () => {
  const rows = [d("1-1", "done", { group: "G1" }), d("1-2", "open", { group: "G1" })];
  const idx = groupIndexOf(rows, [g("G1")]);
  const a = pendingOf({ id: "2-1", parent: "G1" }, rows, idx);
  const b = pendingOf({ id: "2-1", parent: "#G01" }, rows, idx);
  const c = pendingOf({ id: "2-1", after: ["#g001"] }, rows, idx);
  assert.deepStrictEqual(b, a);
  assert.deepStrictEqual(c, a);
  assert.deepStrictEqual(a, ["G1"], "组未完成时给出归一后的组号");
});

test("readGroups：旧档里写成 G01 与 G1 的两条记录归并成同一个组", () => {
  withGroupsFile(
    [g("G01", { title: "先写的" }), g("G1", { title: "后写的" })],
    (root) => {
      const rows = readGroups(root);
      assert.strictEqual(rows.length, 1, "同名组只保留一条");
      assert.strictEqual(rows[0].id, "G1");
      assert.strictEqual(rows[0].title, "先写的", "保留台账顺序在前的一条");
    },
  );
});

test("resolveGroupRef：四种写法都能取到同一条组记录", () => {
  withGroupsFile([g("G1", { title: "前后端并行" })], (root) => {
    for (const ref of ["G1", "#G1", "G01", "#G01"]) {
      const hit = resolveGroupRef(root, ref);
      assert.ok(hit, `ref=${ref} 应能取到组`);
      assert.strictEqual(hit.id, "G1");
    }
    assert.strictEqual(resolveGroupRef(root, "#G2"), null, "不存在的组返回 null");
    assert.strictEqual(resolveGroupRef(root, "1-1"), null, "派单号不是组号");
  });
});
