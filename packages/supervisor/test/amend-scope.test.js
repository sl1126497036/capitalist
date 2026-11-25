/**
 * 线程内追加的作用域与正文记录身份。
 *
 * 钉住三件事：
 *   1. `direct.jsonl` 里监工产生的记录带自己的消息编号，方向 `S`；`msg_id` 仍是触发它的
 *      用户消息编号，两者不相等。读侧不再把用户的 `U2S` 当成监工消息的身份。
 *   2. 线程内 `amend` 的正文编号指向别的单时被拒，不落盘。
 *   3. 同一单的追加仍能正常写入，且正文与目标一致。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/record/supervisor");
const cmds = require("../dist/core/dispatch/commands");
const { createTaskRoot } = require("../dist/core/policy/init");
const { loadState } = require("../dist/core/record/state");
const { appendSupervisorDirective, listSupervisorDirectives } = require("../dist/supervisor/channel/direct");
const { directiveOwnId } = require("../dist/core/message/msgIdentity");
const loop = require("../dist/supervisor/loop");

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-amend-scope-"));
  createTaskRoot({ target: "追加作用域测试", policySpec: "minimal", root: base });
  return base;
}

function seedDispatch(root, extra) {
  capitalist.appendDispatch(root, {
    at: new Date().toISOString(),
    stage: "S0",
    action: "改一版",
    status: "open",
    ...extra,
  });
}

async function runDirectives(root) {
  await loop.__testing.applySupervisorDirectives({
    root,
    policy: { data: {} },
    state: loadState(root),
    wopts: {},
    concurrency: null,
    out: () => {},
  });
}

test("自身编号：监工来源带 S2W 方向，用户来源为空", () => {
  assert.match(directiveOwnId("capitalist", "17-1"), /^17-S2W-\d+(?:-\d+)?$/);
  assert.match(directiveOwnId("capitalist", ""), /^S0-S2W-\d+(?:-\d+)?$/);
  assert.equal(directiveOwnId(undefined, "17-1"), "");
  assert.equal(directiveOwnId("user", "17-1"), "");
});

test("自身编号：同毫秒连续生成不重复", () => {
  const now = 1795194741636;
  const a = directiveOwnId("capitalist", "17-1", now);
  const b = directiveOwnId("capitalist", "17-1", now);
  assert.notEqual(a, b, "同毫秒两次生成必须是不同编号");
});

test("追加越界：正文编号不是当前单时被拒，且不落盘", async () => {
  const root = sandbox();
  seedDispatch(root, { id: "17-1", shard: "a", lineage: "17-1" });
  seedDispatch(root, { id: "18-1", shard: "b", lineage: "18-1" });

  const w = appendSupervisorDirective(root, {
    action: "amend",
    arg: "#18 把修改依据写成具体编号",
    target: "17-1",
    msg_id: "17-U2S-1795194741636",
    via: "capitalist",
  });
  assert.ok(w.ok, "指令本身应写入调度通道，由执行侧裁决");

  await runDirectives(root);

  assert.equal(cmds.listDirectives(root).length, 0, "越界追加不应写入 direct.jsonl");
  const rec = listSupervisorDirectives(root).find((r) => r.id === w.rec.id);
  assert.equal(rec?.result?.ok, false, "执行结果应为被拒");
  assert.match(String(rec?.result?.reason ?? ""), /不属本次对话的单 #17/);
});

test("追加本单：正文记录带自身编号，msg_id 保持触发消息编号", async () => {
  const root = sandbox();
  seedDispatch(root, { id: "17-1", shard: "a", lineage: "17-1" });

  const w = appendSupervisorDirective(root, {
    action: "amend",
    arg: "#17 把校验对象写成具体编号 #16",
    target: "17-1",
    msg_id: "17-U2S-1795194741636",
    via: "capitalist",
  });
  assert.ok(w.ok);

  await runDirectives(root);

  const rows = cmds.listDirectives(root);
  assert.equal(rows.length, 1, "本单追加应写入一条正文记录");
  assert.match(String(rows[0].id ?? ""), /^17-S2W-\d+(?:-\d+)?$/, "正文记录应带自己的监工方向编号");
  assert.equal(String(rows[0].msg_id ?? ""), "17-U2S-1795194741636", "msg_id 仍是触发它的用户消息编号");
  assert.notEqual(String(rows[0].id), String(rows[0].msg_id), "两条编号不得混为一条");
});
