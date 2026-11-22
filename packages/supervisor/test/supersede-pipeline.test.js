/**
 * 接替链路：标记行解析 → 指令字段 → 建单校验 → 重派继承。
 *
 * 四个环节各有唯一入口，任何一环漏掉都会出现“写了不生效”。断言覆盖每一环，
 * 不只验证最终落盘字段。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { parseReply, treeDirectiveFields } = require("../dist/supervisor/channel/parseReply");
const { composeDispatch, deriveDispatch } = require("../dist/core/dispatch/newDispatch");
const { resolveSupersede } = require("../dist/supervisor/loop/supersede");

function row(id, status, extra = {}) {
  return { id, at: "2026-11-22T00:00:00.000Z", stage: "S0", action: `做 ${id}`, status, ...extra };
}

function rootWith(rows) {
  const root = mkdtempSync(join(tmpdir(), "capitalist-supersede-"));
  mkdirSync(join(root, ".capitalist", "inbox"), { recursive: true });
  mkdirSync(join(root, ".capitalist", "config"), { recursive: true });
  mkdirSync(join(root, ".capitalist", "ledger"), { recursive: true });
  writeFileSync(
    join(root, ".capitalist", "inbox", "dispatch.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return root;
}

test("标记行解析：SUPERSEDE 跟着最近的 DO 归属", () => {
  const parsed = parseReply(
    [
      "DO: dispatch [a] 补做第一块",
      "GROUP: #G1",
      "PARENT: #5",
      "PARENT_REASON: 与同组成员同父",
      "SUPERSEDE: #9",
      "",
      "DO: dispatch [b] 补做第二块",
      "GROUP: #G1",
      "PARENT: #5",
      "PARENT_REASON: 同上",
    ].join("\n"),
  );
  assert.strictEqual(parsed.acts.length, 2);
  assert.strictEqual(parsed.acts[0].supersede, "#9", "第一单带接替");
  assert.strictEqual(parsed.acts[1].supersede, undefined, "第二单不受影响");
  assert.strictEqual(treeDirectiveFields(parsed.acts[0]).supersede, "#9", "指令字段带出");
  assert.strictEqual(treeDirectiveFields(parsed.acts[1]).supersede, undefined);
});

test("建单组装：supersedes 落盘，重派与重开继承", () => {
  const first = composeDispatch({
    id: "9-1",
    stage: "S0",
    action: "补做",
    group: "G1",
    parent: "5-1",
    supersedes: "1-1",
  });
  assert.strictEqual(first.supersedes, "1-1");

  const next = deriveDispatch(first, { id: "9-2", stage: "S0", action: "补做" });
  assert.strictEqual(next.supersedes, "1-1", "重派继承接替关系");
  assert.strictEqual(next.group, "G1");
  assert.strictEqual(next.parent, "5-1");
});

test("校验：目标可接替时返回台账 id", () => {
  const rows = [row("1-1", "failed", { group: "G1", retry_verdict: "hold" }), row("2-1", "done", { group: "G1" })];
  const root = rootWith(rows);
  const r = resolveSupersede(root, "1-1", { rows, groupId: "G1" });
  assert.deepStrictEqual(r, { ok: true, id: "1-1" });
});

test("校验：五种拒绝各给下一步", () => {
  const rows = [
    row("1-1", "failed", { group: "G1", retry_verdict: "hold" }),
    row("2-1", "done", { group: "G1" }),
    row("3-1", "open", { group: "G1" }),
    row("4-1", "failed", { group: "G2", retry_verdict: "hold" }),
    row("5-1", "failed", { retry_verdict: "hold" }),
  ];
  const root = rootWith(rows);
  const cases = [
    ["9-9", "G1", /找不到/],
    ["1-1", "", /没有加入任何组/],
    ["4-1", "G1", /属于 #G02/],
    ["3-1", "G1", /还没结束/],
    ["2-1", "G1", /已经完成/],
    ["5-1", "G1", /不属任何组/],
  ];
  for (const [ref, groupId, pattern] of cases) {
    const r = resolveSupersede(root, ref, { rows, groupId });
    assert.strictEqual(r.ok, false, `${ref} 应被拒`);
    assert.match(r.error, pattern);
    assert.match(r.error, /：/, `${ref} 的拒绝文案缺少下一步`);
  }
});

test("校验：未声明接替时返回空 id，不读台账", () => {
  const root = rootWith([]);
  assert.deepStrictEqual(resolveSupersede(root, "", { rows: [], groupId: "G1" }), { ok: true, id: "" });
});
