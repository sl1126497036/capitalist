/**
 * 要求归属：新建单不得被折算成对已有单的追加。
 *
 * 钉住四处行为：
 *   1. 监工全局对话里的新建单保持 dispatch，树字段原样下发，落在新任务号上。
 *   2. 线程内说「另开一单 / 新派一个单 / 追加派单 / 补一张」同样新建。
 *   3. 线程内明确的补充要求仍归到原单（amend），且不再附带一条重开。
 *   4. 一条要求只产生一条动作：线程内补充不额外下发 redo。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { createTaskRoot } = require("../dist/core/policy/init");
const { loadState } = require("../dist/core/record/state");
const { appendDispatch, listWorkers, newDispatchId, readDispatches } = require("../dist/core/record/supervisor");
const { taskNoOfDispatchId } = require("../dist/core/record/tasks");
const { appendSupervisorDirective, listSupervisorDirectives } = require("../dist/supervisor/channel/direct");
const { resolveThreadAction } = require("../dist/supervisor/board/threadAction");
const loop = require("../dist/supervisor/loop");

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-thread-action-"));
  createTaskRoot({ target: "派单归属测试", policySpec: "minimal", root: base });
  return base;
}

function seedDispatch(root, extra) {
  appendDispatch(root, {
    at: new Date().toISOString(),
    stage: "S0",
    action: "父单",
    status: "claimed",
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

const base = {
  text: "",
  talkTarget: "",
  talkNo: "",
  action: "dispatch",
  arg: "做一件新事",
  status: "done",
};

test("全局对话：新建单保持 dispatch，不改动作与正文", () => {
  const r = resolveThreadAction({
    ...base,
    text: "把列表页的排序改成按时间倒序",
    structural: true,
  });
  assert.strictEqual(r.action, "dispatch");
  assert.strictEqual(r.arg, "做一件新事");
  assert.ok(!("reopenFirst" in r), "不再产出 reopenFirst，避免重开与追加两条动作");
});

test("线程内：明确说另开一单时新建", () => {
  for (const text of ["另开一单处理导出", "新派一个单看日志", "追加派单：把缓存清掉", "再补一张单做回归"]) {
    const r = resolveThreadAction({ ...base, text, talkTarget: "17-1", talkNo: "17", status: "done" });
    assert.strictEqual(r.action, "dispatch", `「${text}」应按新建处理`);
    assert.strictEqual(r.arg, "做一件新事");
  }
});

test("线程内：带树字段的要求按新建处理，不折算追加", () => {
  const r = resolveThreadAction({
    ...base,
    text: "补充一下这个小问题",
    talkTarget: "17-1",
    talkNo: "17",
    structural: true,
  });
  assert.strictEqual(r.action, "dispatch", "带 PARENT / GROUP / ACCEPTANCE 的要求折算会丢字段");
});

test("线程内：明确的补充要求归到原单", () => {
  for (const text of ["补充一下：按钮改小一点", "这里改成蓝色", "更正：验收标准是两条都要过"]) {
    const r = resolveThreadAction({ ...base, text, talkTarget: "17-1", talkNo: "17", status: "done" });
    assert.strictEqual(r.action, "amend", `「${text}」应归到原单`);
    assert.match(String(r.arg), /^#17 /);
    assert.ok(!("reopenFirst" in r), "折算后不再额外下发重开");
  }
});

test("线程内：判不出来时按新建，不猜成追加", () => {
  const r = resolveThreadAction({ ...base, text: "加一个按钮", talkTarget: "17-1", talkNo: "17" });
  assert.strictEqual(r.action, "dispatch");
});

test("全局对话：模型误写的 amend 按新建处理，并去掉寻址编号", () => {
  const r = resolveThreadAction({
    ...base,
    action: "amend",
    arg: "#29 把导出改成异步",
    text: "把导出改成异步",
  });
  assert.strictEqual(r.action, "dispatch");
  assert.strictEqual(r.arg, "把导出改成异步");
});

test("全局对话：用户点名某张单并要求补充时才 amend", () => {
  const r = resolveThreadAction({
    ...base,
    action: "amend",
    arg: "#29 把导出改成异步",
    text: "#29 补充：把导出改成异步",
  });
  assert.strictEqual(r.action, "amend");
});

test("带 PARENT / GROUP / ACCEPTANCE 的新建单落在新任务号且不提前启动", async () => {
  const root = sandbox();
  try {
    /* 父单占用第一个任务号（#1），后续新建应从 #2 起。 */
    const parentId = newDispatchId(root);
    seedDispatch(root, { id: parentId, shard: "a", lineage: parentId });
    const w = appendSupervisorDirective(root, {
      action: "dispatch",
      arg: "把列表页的排序改成按时间倒序",
      title: "列表页排序",
      acceptance: "打开列表页，最新记录排在最前",
      parent: "#1",
      parent_reason: "等数据迁移完成后才能改排序字段",
      group: "new 列表改造",
      msg_id: "65-U2S-1795613055066",
      via: "capitalist",
    });
    assert.ok(w.ok);

    await runDirectives(root);

    const rows = readDispatches(root);
    const child = rows.find((d) => d.id !== parentId && String(d.action ?? "").includes("按时间倒序"));
    assert.ok(child, "应新建一张单");
    assert.notStrictEqual(String(child.id), parentId, "不得落到父单或某张已完成单上");
    assert.strictEqual(taskNoOfDispatchId(String(child.id)), 2, "应落在新任务号 #2");
    assert.strictEqual(String(child.parent), parentId, "父节点必须保留");
    assert.match(String(child.acceptance ?? ""), /最新记录排在最前/, "验收判据必须保留");
    assert.ok(String(child.group ?? ""), "分组必须保留");
    assert.strictEqual(String(child.status), "open", "有父节点时不得提前启动");
    assert.strictEqual(listWorkers(root).length, 0, "只应用指令，不应拉起进程");

    const directs = listSupervisorDirectives(root).filter((d) => d.msg_id === "65-U2S-1795613055066");
    assert.strictEqual(directs.length, 1, "一条要求只下发一条动作");
    assert.strictEqual(String(directs[0].action), "dispatch");
  } finally {
    /* 临时目录随进程结束回收，不在此清理，避免删除 shim 干扰。 */
  }
});

test("线程内补充已结束的单：只下发 amend 一条动作，不额外重开", async () => {
  const root = sandbox();
  try {
    const srcId = newDispatchId(root);
    seedDispatch(root, { id: srcId, shard: "a", lineage: srcId, status: "done" });
    const w = appendSupervisorDirective(root, {
      action: "amend",
      arg: "#1 补充：按钮改小一点",
      target: srcId,
      msg_id: "65-U2S-1795613055067",
      via: "capitalist",
    });
    assert.ok(w.ok);

    await runDirectives(root);

    const directs = listSupervisorDirectives(root).filter((d) => d.msg_id === "65-U2S-1795613055067");
    assert.strictEqual(directs.length, 1, "一条要求只下发一条动作");
    assert.strictEqual(String(directs[0].action), "amend", "不得同时再下发 redo");
    assert.ok(
      !listSupervisorDirectives(root).some((d) => String(d.action) === "redo"),
      "线程内补充不应产生重开动作",
    );

    const rows = readDispatches(root);
    const fresh = rows.filter((d) => d.id !== srcId);
    assert.strictEqual(fresh.length, 1, "已结束单只开一张新单承接追加，不是两张");
    assert.strictEqual(String(fresh[0].status), "open", "新单等待调度，不在应用指令时直接启动");
  } finally {
    /* 临时目录随进程结束回收。 */
  }
});
