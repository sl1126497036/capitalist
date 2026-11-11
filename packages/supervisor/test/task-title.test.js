/**
 * 任务标题中文化：契约里的每个分片都必须能拿到中文名，两张映射表必须同键。
 *
 * 这条测试守的是两件容易退化的东西：
 *
 * 1. 不许出现英文代号。分片 id（`ux-chat`）是内部编号，左栏、会话头部、消息署名只显示
 *    中文名。新加一个分片却忘了进映射表时，这里会报出来，契约里那个 `title` 是中文，
 *    真到了老派单（没有 title 字段）就只剩映射表一条路。
 * 2. 两份表不许漂移。服务端 `src/supervisor/taskTitle.ts` 与前端
 *    `web/src/lib/taskTitle.js` 各存一份（前端是独立打包的静态产物，不引后端模块），
 *    键对不上时前端就会在某个分片上退回“未命名任务”。
 */

const test = require("node:test");
const assert = require("node:assert");
const { readFileSync, readdirSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { SHARD_TITLES, shardTitle, summarizeTitle, taskTitle } = require(join(PKG, "dist/supervisor/taskTitle.js"));
const capitalist = require(join(PKG, "dist/core/supervisor.js"));
const { loadState } = require(join(PKG, "dist/core/state.js"));
const { createTaskRoot } = require(join(PKG, "dist/core/init.js"));
const loop = require(join(PKG, "dist/supervisor/loop.js"));
const { appendSupervisorDirective } = require(join(PKG, "dist/supervisor/direct.js"));

const CJK = /[\u4e00-\u9fa5]/;
const CONTRACT_DIR = join(PKG, "contracts");
const WEB_TABLE = join(PKG, "web/src/lib/taskTitle.js");

/** 契约文件里出现过的全部分片 id。 */
function contractShards() {
  const ids = new Set();
  for (const f of readdirSync(CONTRACT_DIR)) {
    if (!f.endsWith(".contract.json")) continue;
    const c = JSON.parse(readFileSync(join(CONTRACT_DIR, f), "utf8"));
    for (const stage of c.stages ?? []) {
      for (const shard of stage.parallel ?? []) {
        if (shard && typeof shard.id === "string") ids.add(shard.id);
      }
    }
  }
  return [...ids];
}

test("契约里的每个分片都有中文短名，且不超过 10 个汉字", () => {
  const missing = contractShards().filter((id) => !shardTitle(id));
  assert.deepStrictEqual(missing, [], `这些分片没有中文名：${missing.join("、")}`);
  for (const [id, title] of Object.entries(SHARD_TITLES)) {
    assert.ok(CJK.test(title), `${id} 的中文名里没有汉字：${title}`);
    assert.ok(title.length <= 10, `${id} 的中文名超过 10 个字：${title}`);
  }
});

test("前端映射表与服务端同键同名", () => {
  const src = readFileSync(WEB_TABLE, "utf8");
  const body = src.slice(src.indexOf("export const SHARD_TITLES"));
  const pairs = [...body.matchAll(/^\s*"?(?<key>[a-zA-Z0-9_-]+)"?:\s*"(?<title>[^"]+)",?\s*$/gm)].map((m) => [
    m.groups.key,
    m.groups.title,
  ]);
  const web = Object.fromEntries(pairs);
  assert.ok(pairs.length > 0, "前端映射表解析为空");
  assert.deepStrictEqual(web, { ...SHARD_TITLES }, "两张表的键或值不一致，改表时两边要一起改");
});

test("标题取值顺序：契约 title -> 分片映射 -> 正文摘要，永不回落到 id", () => {
  assert.strictEqual(taskTitle({ contractTitle: "任务标题中文化", shard: "ux-chat" }), "任务标题中文化");
  assert.strictEqual(taskTitle({ shard: "ux-chat" }), "对话修复");
  assert.strictEqual(taskTitle({ shard: "no-such-shard", action: "把左栏的行名改成中文，别显示代号" }), "把左栏的行名改成中文");
  assert.strictEqual(taskTitle({}), "");
  // 分片 id 永远不是标题：查不到、正文也没中文时返回空串，而不是把 id 原样吐出来。
  assert.strictEqual(taskTitle({ shard: "no-such-shard", action: "Only modify the left column" }), "");
});

test("正文摘要只留中文，保留整句不再按字数截断", () => {
  assert.strictEqual(summarizeTitle("改 packages/supervisor/web/src/components/ChatPane.vue，做这几条："), "做这几条");
  const long = summarizeTitle("这一句话特别长需要被截断到十个汉字以内才行");
  assert.strictEqual(long, "这一句话特别长需要被截断到十个汉字以内才行");
  assert.ok(CJK.test(long), long);
  // 线上实例：任务卡标题被截成“撤掉看板聊天区的未建”，这里要求整句落库。
  assert.strictEqual(summarizeTitle("撤掉看板聊天区的未建单标记按钮，含模板与样式"), "撤掉看板聊天区的未建单标记按钮");
  assert.strictEqual(taskTitle({ shard: "", action: "撤掉看板聊天区的未建单标记按钮" }), "撤掉看板聊天区的未建单标记按钮");
});


/** 标题只在派单第一次登记时生成：之后的追加、合并、重派一律沿用。 */
function titleSandbox() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-title-"));
  createTaskRoot({ target: "标题固定", contractSpec: "minimal", root });
  return root;
}

async function runDirectives(root) {
  await loop.__testing.applySupervisorDirectives({
    root,
    contract: { stages: [], data: {} },
    state: loadState(root),
    wopts: {},
    concurrency: null,
    out: () => {},
  });
}

test("新建派单：标题落库保留完整语句，不按字数截断", async () => {
  /* 自成一体：直接指到仓库里现存的 generic 契约，不依赖 tests 沙箱用的 minimal。 */
  const root = mkdtempSync(join(tmpdir(), "capitalist-title-full-"));
  createTaskRoot({ target: "标题完整", contractSpec: join(PKG, "contracts/generic.contract.json"), root });
  try {
    const body = "撤掉看板聊天区的未建单标记按钮";
    appendSupervisorDirective(root, { action: "dispatch", arg: body });
    await runDirectives(root);

    const d = capitalist.readDispatches(root).find((x) => x.source === "adhoc");
    assert.ok(d, "派单已建");
    assert.strictEqual(d.title, body, "派单记录里的标题是完整语句");
    assert.ok(String(d.action).includes(body), "正文未被改动");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("同类合并追加内容：沿用原单标题，不改成“批次”", async () => {
  const root = titleSandbox();
  try {
    appendSupervisorDirective(root, { action: "dispatch", arg: "[core] 第一条要求" });
    await runDirectives(root);
    const first = capitalist.readDispatches(root).find((d) => d.source === "adhoc");
    assert.ok(first, "第一张单已建");
    const before = first.title;
    assert.ok(before, "建单时写了标题");

    appendSupervisorDirective(root, { action: "dispatch", arg: "[core] 补一条要求" });
    await runDirectives(root);

    const rows = capitalist.readDispatches(root).filter((d) => d.source === "adhoc");
    assert.strictEqual(rows.length, 1, "同类合并成一张单");
    assert.strictEqual(rows[0].title, before, "合并只加内容，不改标题");
    assert.ok(String(rows[0].action).includes("补一条要求"), "追加内容进了正文");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("重派建新单：沿用这一片第一次登记时的标题，契约改名也不换", () => {
  const root = titleSandbox();
  try {
    const first = { id: "core", title: "核心层整改", action: "做核心层的事" };
    loop.__testing.createOpenShardDispatch(root, { stages: [], data: {} }, loadState(root), first, {}, () => {}, 1);
    const second = { id: "core", title: "后来改过的名字", action: "再做一次核心层的事" };
    loop.__testing.createOpenShardDispatch(root, { stages: [], data: {} }, loadState(root), second, {}, () => {}, 2);

    const rows = capitalist.readDispatches(root).filter((d) => d.shard === "core");
    assert.strictEqual(rows.length, 2, "重派产出一张新单");
    assert.strictEqual(rows[0].title, "核心层整改");
    assert.strictEqual(rows[1].title, rows[0].title, "重派沿用原单标题，不按新契约重算");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
