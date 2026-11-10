
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const capitalist = require("../dist/core/supervisor");
const cmds = require("../dist/core/commands");
const { createTaskRoot } = require("../dist/core/init");

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-outcome-"));
  createTaskRoot({ target: "插话落实测试", contractSpec: "minimal", root: base });
  return base;
}

function seed(root, id) {
  capitalist.appendDispatch(root, {
    id,
    at: new Date().toISOString(),
    stage: "S0",
    shard: "",
    action: `做 ${id}`,
    status: "claimed",
    lineage: id,
  });
}

function put(root, text, extra = {}) {
  const rec = cmds.appendDirective(root, { text, stage: "S0", ...extra });
  assert.ok(rec, "插话应落盘成功");
  return rec;
}

function claim(root, dispatchId, extra = {}) {
  return cmds.claimDirectives(root, {
    shard: "",
    stage: "S0",
    dispatchId,
    lineage: dispatchId,
    ...extra,
  });
}


test("同一单能一次领走多条：不再被 FIFO 卡在队尾", () => {
  const root = sandbox();
  seed(root, "D-a");
  put(root, "第一条要求");
  put(root, "第二条要求");
  put(root, "第三条要求");

  const taken = claim(root, "D-a");
  assert.equal(taken.length, 3, "三条都该被同一单领走");
});

test("执行中送达（limit=1）只领一条，其余留在队列里", () => {
  const root = sandbox();
  seed(root, "D-b");
  put(root, "第一条");
  put(root, "第二条");

  const one = claim(root, "D-b", { limit: 1, via: "hook" });
  assert.equal(one.length, 1, "hook 通道一次只能铺一条");

  /*
   * 判据用「还在不在队列里」而不是 isDirectiveOpen：后者问的是「落实了没有」，
   * 领走但没结论的那条对收工闸仍然是「没落实」，两个问题不能混。
   */
  const rest = cmds.listDirectives(root).filter((x) => x.consumed !== true);
  assert.equal(rest.length, 1, "没送到的那条不许被标成已送达");
  assert.equal(rest[0].text, "第二条");
  assert.equal(cmds.isDirectiveOpen(rest[0]), true);
});

test("领的时候先领明确写给这一单的，不被无归属的旧积压挤到后面", () => {
  const root = sandbox();
  seed(root, "D-p");
  put(root, "一天前的旧要求 A");
  put(root, "一天前的旧要求 B");
  const mine = put(root, "写给这一单的", { target: "D-p" });

  const taken = claim(root, "D-p", { limit: 1 });
  assert.equal(taken.length, 1);
  assert.equal(cmds.directiveRef(taken[0]), cmds.directiveRef(mine), "精确归属的要排在最前");
});

test("字数上限只约束第二条起：单条超长也得送，否则它永远卡在队首", () => {
  const root = sandbox();
  seed(root, "D-c");
  const long = "长".repeat(500);
  put(root, long);
  put(root, "短的一条");

  const taken = claim(root, "D-c", { maxChars: 100 });
  assert.equal(taken.length, 1, "第一条本身超长，仍要送出去");
  assert.equal(taken[0].text, long);
});


test("送达不等于落实：领走之后仍然算「没落实」", () => {
  const root = sandbox();
  seed(root, "D-d");
  const rec = put(root, "改了没");

  claim(root, "D-d");
  const after = cmds.directiveByRef(root, cmds.directiveRef(rec));
  assert.equal(after.delivered, true, "应记下已送达");
  assert.equal(after.consumed, true, "队列语义不变：仍在队里为假");
  assert.equal(after.outcome, undefined);
  assert.equal(cmds.isDirectiveOpen(after), true, "没结论就是没落实");
});

test("老台账（只有 consumed、没有 delivered）按原口径读，不许集体复活", () => {
  const legacyDone = { at: "2026-11-01T00:00:00.000Z", at_ts: 0, type: "direct", text: "老要求", consumed: true };
  const legacyOpen = { at: "2026-11-01T00:00:00.000Z", at_ts: 0, type: "direct", text: "老要求", consumed: false };
  assert.equal(cmds.isDirectiveOpen(legacyDone), false);
  assert.equal(cmds.isDirectiveOpen(legacyOpen), true);
});

test("给了结论就算落实", () => {
  const root = sandbox();
  seed(root, "D-e");
  const rec = put(root, "这条做完了");
  claim(root, "D-e");

  const r = cmds.markDirectiveOutcome(root, cmds.directiveRef(rec), "done", { note: "改了 styles.css", by: "D-e" });
  assert.equal(r.ok, true);
  const after = cmds.directiveByRef(root, cmds.directiveRef(rec));
  assert.equal(after.outcome, "done");
  assert.equal(after.outcome_note, "改了 styles.css");
  assert.equal(cmds.isDirectiveOpen(after), false);
});


test("不是这一单送出的插话，改不了它的结论", () => {
  const root = sandbox();
  seed(root, "D-f");
  seed(root, "D-g");
  const rec = put(root, "送给 D-f 的话");
  claim(root, "D-f");

  const bad = cmds.markDirectiveOutcome(root, cmds.directiveRef(rec), "done", { by: "D-g" });
  assert.equal(bad.ok, false, "别的单不能替它结项");
  assert.match(bad.reason, /送达给/);
});

test("编号写错要报错，不静默吞掉", () => {
  const root = sandbox();
  seed(root, "D-h");
  put(root, "随便一条");

  const r = cmds.markDirectiveOutcome(root, "M-不存在", "done", { by: "D-h" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /找不到/);
});

test("结论只认 done / not_mine / blocked", () => {
  const root = sandbox();
  seed(root, "D-i");
  const rec = put(root, "一条要求");
  claim(root, "D-i");

  const r = cmds.markDirectiveOutcome(root, cmds.directiveRef(rec), "whatever", { by: "D-i" });
  assert.equal(r.ok, false);
});

test("not_mine / blocked 不带说明要拒：不许给它一条比「说句收到过」更省事的甩掉通道", () => {
  const root = sandbox();
  seed(root, "D-i2");
  const a = put(root, "一条要求");
  const b = put(root, "另一条要求");
  claim(root, "D-i2");

  const badA = cmds.markDirectiveOutcome(root, cmds.directiveRef(a), "not_mine", { by: "D-i2" });
  assert.equal(badA.ok, false);
  assert.match(badA.reason, /该归哪一单/);

  const badB = cmds.markDirectiveOutcome(root, cmds.directiveRef(b), "blocked", { by: "D-i2" });
  assert.equal(badB.ok, false);
  assert.match(badB.reason, /卡在哪/);

  const okA = cmds.markDirectiveOutcome(root, cmds.directiveRef(a), "not_mine", {
    by: "D-i2",
    note: "该归 #36",
  });
  assert.equal(okA.ok, true);
});


test("openDirectivesOf 只列本单送出、且还没有结论的", () => {
  const root = sandbox();
  seed(root, "D-j");
  seed(root, "D-k");
  const a = put(root, "给 D-j 的第一条");
  const b = put(root, "给 D-j 的第二条");
  const c = put(root, "给 D-k 的一条");

  claim(root, "D-j", { maxChars: 20 });
  claim(root, "D-k");

  const open = cmds.openDirectivesOf(root, "D-j");
  assert.ok(open.length >= 1, "本单送出的没结论的应被列出");
  for (const x of open) assert.equal(x.delivered_by, "D-j");

  /* 结掉一条之后它就不该再出现。 */
  cmds.markDirectiveOutcome(root, cmds.directiveRef(a), "done", { by: "D-j" });
  const after = cmds.openDirectivesOf(root, "D-j").map(cmds.directiveRef);
  assert.ok(!after.includes(cmds.directiveRef(a)), "已结项的不再挡收工");
  assert.ok(cmds.directiveRef(c).length > 0 && cmds.directiveRef(b).length > 0);
});


const { spawnSync } = require("node:child_process");

function runCli(args) {
  const r = spawnSync(process.execPath, [join(__dirname, "..", "dist", "cli", "main.js"), ...args], {
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function refPattern(ref) {
  return new RegExp(String(ref).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

test("收工闸：送到了但没给结论，不许结单，并直接给出可复制的命令行", () => {
  const root = sandbox();
  seed(root, "D-cli");
  const rec = put(root, "这条要回报");
  claim(root, "D-cli");

  const denied = runCli(["report", "D-cli", "--status", "done", "--note", "做完了", "--root", root]);
  assert.equal(denied.code, 1, `没结论必须挡住：${denied.out}`);
  assert.match(denied.out, /没给结论/);
  assert.match(denied.out, /--outcome/, "要给出可直接复制的命令行，否则挡一次就要来回猜格式");
  assert.match(denied.out, refPattern(cmds.directiveRef(rec)), "要点明是哪一条");
});

test("收工闸：给了结论就放行", () => {
  const root = sandbox();
  seed(root, "D-cli2");
  const rec = put(root, "这条已做完");
  claim(root, "D-cli2");

  const ok = runCli([
    "report",
    "D-cli2",
    "--status",
    "done",
    "--note",
    "改完了 styles.css",
    "--outcome",
    `${cmds.directiveRef(rec)}=done`,
    "--root",
    root,
  ]);
  assert.equal(ok.code, 0, ok.out);
});

test("收工闸：结论写成 not_mine 也算给了结论，不再挡", () => {
  const root = sandbox();
  seed(root, "D-cli3");
  const rec = put(root, "这条其实属于别的单");
  claim(root, "D-cli3");

  const ok = runCli([
    "report",
    "D-cli3",
    "--status",
    "done",
    "--note",
    "该归 #36",
    "--outcome",
    `${cmds.directiveRef(rec)}=not_mine:该归 #36`,
    "--root",
    root,
  ]);
  assert.equal(ok.code, 0, ok.out);
  const after = cmds.directiveByRef(root, cmds.directiveRef(rec));
  assert.equal(after.outcome, "not_mine");
  assert.equal(after.outcome_note, "该归 #36");
});

test("收工闸：outcome 格式写错当场报错，不静默当成没写", () => {
  const root = sandbox();
  seed(root, "D-cli4");
  put(root, "一条要求");
  claim(root, "D-cli4");

  const bad = runCli([
    "report",
    "D-cli4",
    "--status",
    "done",
    "--note",
    "x",
    "--outcome",
    "随便写的",
    "--root",
    root,
  ]);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /格式不对/);
});
