
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const {
  MEMORY_MAX,
  MEMORY_NOTE_MAX,
  MEMORY_TTL_DAYS,
  addMemory,
  deleteMemory,
  isMemoryKind,
  loadMemories,
  memoryPath,
  memorySnapshot,
  memoriesFor,
  primeMemory,
  rememberLesson,
  updateMemory,
  withLessons,
} = require(join(PKG, "dist/supervisor/memory.js"));
const { clearRuntimeLedger } = require(join(PKG, "dist/supervisor/board.js"));

const DAY = 24 * 60 * 60 * 1000;

function sandbox(name = "capitalist-mem-") {
  const root = mkdtempSync(join(tmpdir(), name));
  mkdirSync(join(root, ".capitalist"), { recursive: true });
  return root;
}

test("只收两类：习惯与环境、项目踩坑，第三类被拒", () => {
  assert.equal(isMemoryKind("habit"), true);
  assert.equal(isMemoryKind("blocker"), true);
  assert.equal(isMemoryKind("other"), false);

  const root = sandbox();
  const made = addMemory(root, "用户要求回复里先给结论再展开", "preference");
  assert.ok(made);
  assert.equal(made.kind, "blocker", "非法类别按卡点收，不允许产生第三类");
  assert.equal(loadMemories(root).length, 1);
});

test("收录范围不只有卡点：默认按习惯/环境收，无关键词也不拒，可改可删", () => {
  const root = sandbox();
  /* 面板新增不传类别：运行环境这类内容不能默认写成卡点。 */
  const env = addMemory(root, "运行环境：Windows 11 + Node 22，包管理用 pnpm，工作目录在 D 盘");
  assert.ok(env, "运行环境内容必须能保存");
  assert.equal(env.kind, "habit", "默认按习惯/环境收，不是卡点");
  assert.equal(env.keys.length > 0, true, "有实词时仍要能提炼关键词");

  /* 纯符号 / 纯数字这种提不出关键词的内容：非空就收，不按「不是卡点」拒绝。 */
  const bare = addMemory(root, "！！");
  assert.ok(bare, "提不出关键词也应保存");
  assert.equal(bare.kind, "habit");
  assert.deepEqual(bare.keys, [], "提不出关键词时 keys 为空，只是不参与自动注入");

  const listed = memorySnapshot(root);
  assert.equal(listed.stats.count, 2, "写入后能在快照（面板列表）里正常列出");
  assert.equal(listed.stats.habit, 2);

  /* 编辑：正文与类别都能改，改完仍是同一条。 */
  const edited = updateMemory(root, bare.id, { note: "项目约定：不要动 .capitalist 下的文件" });
  assert.ok(edited);
  assert.equal(edited.id, bare.id);
  assert.equal(edited.note, "项目约定：不要动 .capitalist 下的文件");
  assert.ok(edited.keys.length > 0, "改成有实词的内容后要重算关键词");

  /* 删除：写了就删得掉。 */
  assert.equal(deleteMemory(root, env.id), true);
  assert.equal(deleteMemory(root, bare.id), true);
  assert.equal(loadMemories(root).length, 0);
});

test("同类卡点合并更新，不同类不合并", () => {
  const root = sandbox();
  const a = rememberLesson(root, "派单附件误带：用户没贴图，模型从历史里挑了旧图", "D-1");
  const b = rememberLesson(root, "派单附件误带：从会话历史挑了旧图，用户没贴图", "D-2");
  assert.equal(b.id, a.id, "同一类卡点应合并到同一条");
  assert.equal(b.count, 2);
  assert.equal(b.last_dispatch, "D-2");

  const habit = rememberLesson(root, "用户习惯：回复先给结论", "D-3", "habit");
  assert.notEqual(habit.id, a.id, "不同类别的条目不能合并");
  assert.equal(loadMemories(root).length, 2);
});

test("上限：条数、单条字数都裁到位", () => {
  const root = sandbox();
  for (let i = 0; i < MEMORY_MAX + 5; i += 1) {
    addMemory(root, `卡点样本 ${i}：第 ${i} 次观测到的排队超时`, "blocker");
  }
  const entries = loadMemories(root);
  assert.ok(entries.length <= MEMORY_MAX, `条数应不超过 ${MEMORY_MAX}，实际 ${entries.length}`);

  const long = "长".repeat(MEMORY_NOTE_MAX + 40);
  const made = addMemory(root, long, "habit");
  assert.ok(made);
  assert.equal(made.note.length, MEMORY_NOTE_MAX, "单条描述应按上限截断");
});

test("时效淘汰：超过 TTL 的条目读到就清掉", () => {
  const root = sandbox();
  const old = new Date(Date.now() - (MEMORY_TTL_DAYS + 1) * DAY).toISOString();
  writeFileSync(
    memoryPath(root),
    JSON.stringify({
      at: old,
      entries: [
        { id: "mem-old", kind: "blocker", keys: ["发霉卡点"], note: "发霉卡点", count: 1, first_at: old, last_at: old, last_dispatch: "" },
      ],
    }),
    "utf8",
  );
  assert.deepEqual(loadMemories(root), []);
  assert.deepEqual(JSON.parse(readFileSync(memoryPath(root), "utf8")).entries, [], "淘汰结果要落盘");
});

test("条目可编辑可删除，关键词随正文重算", () => {
  const root = sandbox();
  const made = addMemory(root, "看板指标条上下文无读数时显示为 0", "blocker");
  assert.ok(made);

  const edited = updateMemory(root, made.id, { note: "看板指标条在无读数时必须显示破折号而不是 0", kind: "habit" });
  assert.ok(edited);
  assert.equal(edited.kind, "habit");
  assert.ok(edited.keys.some((k) => k.includes("读数")) || edited.keys.length > 0);
  assert.equal(updateMemory(root, made.id, { note: "   " }), null, "空正文不能保存");
  assert.equal(updateMemory(root, "no-such-id", { note: "x" }), null);

  assert.equal(deleteMemory(root, made.id), true);
  assert.equal(deleteMemory(root, made.id), false, "重复删除返回 false");
  assert.equal(loadMemories(root).length, 0);
});

test("删除留痕：同文正文不再被自动记录复活，人工新增可解除", () => {
  const root = sandbox();
  const text = "本机装 node-gyp 依赖失败：缺 python3-dev，需先装系统包";
  const made = addMemory(root, text, "blocker");
  assert.ok(made);
  assert.equal(deleteMemory(root, made.id), true);
  assert.equal(loadMemories(root).length, 0, "删除后条目落盘消失");

  const again = rememberLesson(root, text);
  assert.equal(again, null, "已删正文不再自动记录");
  assert.equal(loadMemories(root).length, 0);

  /* 留痕要随文件落盘：模拟重启（primeMemory 重读文件）后同样生效。 */
  primeMemory(root);
  assert.equal(rememberLesson(root, text), null, "重启后留痕仍生效");

  /* 人工在面板重新新增同文条目：视为解除留痕，之后自动记录恢复。 */
  const remade = addMemory(root, text, "blocker");
  assert.ok(remade, "人工新增不受留痕拦截");
  const rehit = rememberLesson(root, "本机装 node-gyp 依赖失败：缺 python3-dev，需先装系统包");
  assert.ok(rehit, "解除留痕后自动记录恢复");
  assert.equal(rehit.id, remade.id);
});

test("派单前只注入相关条目，重复调用不叠加旧区块", () => {
  const root = sandbox();
  rememberLesson(root, "本机缺 python3-dev，装 node-gyp 依赖会失败");
  rememberLesson(root, "清理临时目录时不要动别人的构建产物", "D-9");
  primeMemory(root);

  const relevant = memoriesFor(root, "装依赖又失败了，是不是缺 python3-dev");
  assert.equal(relevant.length, 1, "只挑关键词命中的那一条");

  const once = withLessons(root, "做这一单：装依赖");
  assert.match(once, /【项目记忆/);
  assert.match(once, /python3-dev/);
  assert.doesNotMatch(once, /构建产物/, "不相关条目不该进提示词");

  const twice = withLessons(root, once);
  assert.equal(twice, once, "同一段正文重复注入应幂等");
});

test("与任务台账解耦：清空任务后记忆文件与条目数不变", () => {
  const root = sandbox("capitalist-mem-clear-");
  addMemory(root, "用户习惯：报告先给结论", "habit");
  addMemory(root, "踩坑记录：清理临时目录时不要动别人的构建产物", "blocker");
  const before = readFileSync(memoryPath(root), "utf8");
  const snapshotBefore = memorySnapshot(root);
  assert.equal(snapshotBefore.stats.count, 2);

  writeFileSync(join(root, ".capitalist", "tasks.jsonl"), '{"id":"D-1"}\n', "utf8");
  writeFileSync(join(root, ".capitalist", "events.jsonl"), '{"kind":"tick"}\n', "utf8");

  const res = clearRuntimeLedger(root);
  assert.ok(res.moved >= 1, "任务与事件记录应被清走");
  assert.equal(existsSync(join(root, ".capitalist", "tasks.jsonl")), false);
  assert.equal(existsSync(memoryPath(root)), true, "记忆文件必须保留");
  assert.equal(readFileSync(memoryPath(root), "utf8"), before, "清空任务不许改写记忆");
  assert.equal(memorySnapshot(root).stats.count, 2, "条目数不变");
  assert.deepEqual(
    memorySnapshot(root).entries.map((e) => e.note).sort(),
    snapshotBefore.entries.map((e) => e.note).sort(),
  );
});
