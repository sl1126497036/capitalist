
const test = require("node:test");
const assert = require("node:assert");
const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { nextRotatingDefaultModel, DEFAULT_MODEL_ROTATION } = require("../dist/core/supervisor");
const {
  keywordsOf,
  loadMemories,
  memoryLines,
  memoriesFor,
  rememberLesson,
  withLessons,
} = require("../dist/supervisor/memory");
const { workerUsage } = require("../dist/supervisor/usage");

function scratch(name = "capitalist-lessons-") {
  const root = mkdtempSync(join(tmpdir(), name));
  mkdirSync(join(root, ".capitalist"), { recursive: true });
  return root;
}

test("卡点记忆：两次同类卡点归并为一条，次数累加且重启后仍在", () => {
  const root = scratch();
  try {
    rememberLesson(root, "worker 提示词里写了「等 A 完成后再改 B」，两个进程互相等死", "D-1");
    rememberLesson(root, "又一单把顺序句写进 worker 提示词，等 A 完成后再改 B，互相等死", "D-2");

    const entries = loadMemories(root);
    assert.equal(entries.length, 1, `同类卡点应归并为一条，实际 ${entries.length}`);
    assert.equal(entries[0].count, 2);
    assert.equal(entries[0].last_dispatch, "D-2");

    /* 重启 = 重新从盘上读：文件在、条目在。 */
    assert.ok(existsSync(join(root, ".capitalist", "memory.json")));
    assert.equal(loadMemories(root)[0].count, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("不同类卡点各记一条；记忆按关键词挑出相关条目", () => {
  const root = scratch();
  try {
    rememberLesson(root, "顺序句写进 worker 提示词导致互相等死", "D-1");
    rememberLesson(root, "派单附件误带：模型从会话历史里挑了旧截图带进新单", "D-2");
    assert.equal(loadMemories(root).length, 2);

    const hit = memoriesFor(root, "这次派单别再把顺序句写进提示词，worker 会互相等死");
    assert.equal(hit.length, 1);
    assert.ok(hit[0].note.includes("顺序句"));
    assert.equal(memoriesFor(root, "一段无关的文字说明").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("withLessons 把相关记忆注入派单正文为硬约束；不重复叠加旧区块", () => {
  const root = scratch();
  try {
    rememberLesson(root, "顺序句写进 worker 提示词导致互相等死", "D-1");
    const action = "这次派单别把顺序句写进提示词，worker 会互相等死";
    const once = withLessons(root, action);
    assert.ok(once.includes("【项目记忆"), `应注入记忆段：${once}`);
    assert.ok(once.includes("顺序句"));

    /* 重派沿用上次的正文（已带记忆段）：再注入不能叠出两段。 */
    const twice = withLessons(root, once);
    assert.equal(twice.split("【项目记忆").length - 1, 1, "重复注入应剥掉旧区块");

    /* 与记忆无关的正文不注入空段。 */
    assert.equal(withLessons(root, "完全无关的一段任务描述"), "完全无关的一段任务描述");

    /* 回复提示词用同一份判据。 */
    assert.equal(memoryLines(root, "顺序句 互相等死").length > 0, true);
    assert.deepEqual(memoryLines(root, "无关文字"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("默认模型轮换：两个 flash 模型交替，计数落盘重启后继续", () => {
  const root = scratch("capitalist-rotate-");
  try {
    assert.deepEqual([...DEFAULT_MODEL_ROTATION], ["deepseek-v4.1-flash", "glm-5.3-flash"]);
    const first = nextRotatingDefaultModel(root);
    const second = nextRotatingDefaultModel(root);
    const third = nextRotatingDefaultModel(root);
    assert.equal(first, "deepseek-v4.1-flash");
    assert.equal(second, "glm-5.3-flash");
    assert.equal(third, "deepseek-v4.1-flash", "第三次应轮回第一个");
    assert.ok(existsSync(join(root, ".capitalist", "model_rotate.json")));
    /* 重启（新调用、同一任务根）从落盘的计数继续，不归零。 */
    assert.equal(nextRotatingDefaultModel(root), "glm-5.3-flash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("用量读数不露 fast-model 别名：日志里出现具体模型后改显具体模型", () => {
  const root = scratch("capitalist-alias-");
  try {
    const dir = join(root, ".capitalist", "workers");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "W-1.json"),
      JSON.stringify({
        id: "W-1",
        host: "codebuddy",
        pid: 0,
        session: "W-1",
        dispatch: "D-1",
        shard: "",
        stage: "U1",
        started_at: "2026-11-03T00:00:00.000Z",
        status: "done",
        log: join(dir, "W-1.log"),
      }),
    );
    writeFileSync(
      join(dir, "W-1.log"),
      [
        JSON.stringify({
          type: "assistant",
          message: { id: "m1", model: "fast-model", usage: { input_tokens: 10, output_tokens: 5 } },
        }),
        JSON.stringify({
          type: "assistant",
          message: { id: "m2", model: "glm-5.3-flash", usage: { input_tokens: 20, output_tokens: 8 } },
        }),
        "",
      ].join("\n"),
    );
    const figs = workerUsage({
      id: "W-1",
      host: "codebuddy",
      pid: 0,
      status: "done",
      dispatch: "D-1",
      shard: "",
      stage: "U1",
      started_at: "2026-11-03T00:00:00.000Z",
      log: join(dir, "W-1.log"),
    });
    assert.equal(figs.model, "glm-5.3-flash", `别名应被具体模型替换，实际 ${figs.model}`);
    assert.equal(figs.model_version, "5.3-flash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("关键词提炼：英文长词与中文二元组都能成为匹配键，停用词不进键", () => {
  const keys = keywordsOf("worker 提示词里写了顺序句，等 A 完成后再改 B");
  assert.ok(keys.length > 0);
  assert.ok(keys.includes("worker"));
  assert.deepEqual(keywordsOf("the and for with this that not"), [], "全是停用词时给空表");
});
