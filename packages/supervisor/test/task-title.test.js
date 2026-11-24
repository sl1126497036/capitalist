/**
 * 任务标题中文化：契约里的每个分片都必须能拿到中文名，两张映射表必须同键。
 *
 * 本测试守的是两件容易退化的东西：
 *
 * 1. 不许出现英文代号。分片 id（`ux-chat`）是内部编号，左栏、会话头部、消息署名只显示
 *    中文名。新加一个分片却忘了进映射表时，这里会报出来，契约里那个 `title` 是中文，
 *    真到了老派单（没有 title 字段）就只剩映射表一条路。
 * 2. 映射表只许有一份。前端 `web/src/lib/taskTitle.js` 直接从服务端
 *    `src/supervisor/usage/taskTitle.ts` 导入（与 `lib/fmt.js` 引 `context/terms.ts` 同一条路径），
 *    一旦有人在 web 侧重新复制一份映射表，键就会在下次改表时漂移，前端在某个分片上退回“未命名任务”。
 */

const test = require("node:test");
const assert = require("node:assert");
const { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve, dirname } = require("node:path");

const PKG = resolve(__dirname, "..");
const { SHARD_TITLES, TITLE_MAX_CHARS, shardTitle, summarizeTitle, taskTitle } = require(join(PKG, "dist/supervisor/usage/taskTitle.js"));
const { parseReply } = require(join(PKG, "dist/supervisor/channel/parseReply.js"));
const capitalist = require(join(PKG, "dist/core/record/supervisor.js"));
const { loadState } = require(join(PKG, "dist/core/record/state.js"));
const { createTaskRoot } = require(join(PKG, "dist/core/contract/init.js"));
const loop = require(join(PKG, "dist/supervisor/loop.js"));
const { appendSupervisorDirective } = require(join(PKG, "dist/supervisor/channel/direct.js"));

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

test("前端只有一份分片映射表，且取自服务端", () => {
  const src = readFileSync(WEB_TABLE, "utf8");
  /*
   * 原先这里比对两张表是否同键同名。前端改为直接引用服务端模块后，第二份表已不存在，
   * 比对失去对象；判据随之升级为“不许再有第二份”：只要有人在 web 侧重新复制一份映射表，
   * 哪怕内容当时是对的，也会在下次改表时静默漂移，这条断言会立刻拦下。
   */
  const copied = /export\s+const\s+SHARD_TITLES\s*=\s*Object\.freeze\(\{/.test(src);
  assert.strictEqual(copied, false, "web/src/lib/taskTitle.js 里又出现了独立的 SHARD_TITLES，请改为从服务端导入");

  /*
   * 判据只要求 SHARD_TITLES 出现在从服务端导入的符号表里：同一行还导入摘要函数是正常写法
   * （前端需要与服务端同一份算法），正则不能因为多出一个逗号就判成“没有导入”。
   */
  const imported = src.match(/import\s*\{[^}]*\bSHARD_TITLES\b[^}]*\}\s*from\s*"([^"]+)"/);
  assert.ok(imported, "web/src/lib/taskTitle.js 未从服务端导入 SHARD_TITLES");
  assert.match(imported[1], /usage\/taskTitle(\.ts)?$/, `导入来源不是服务端的分片映射模块：${imported[1]}`);

  /* 路径写错不会在 node 侧报错，只会让前端打包时才发现；这里直接在文件系统上验证。 */
  const abs = resolve(dirname(WEB_TABLE), imported[1]);
  assert.ok(existsSync(abs), `导入路径不存在：${abs}`);

  /* 目标文件必须导出该符号，否则前端取得 undefined，映射表会整体失效。 */
  const target = readFileSync(abs, "utf8");
  assert.match(target, /export\s+const\s+SHARD_TITLES\b/, `${abs} 未导出 SHARD_TITLES`);
});

test("前端摘要算法取自服务端，不在 web 侧另写一份", () => {
  const src = readFileSync(WEB_TABLE, "utf8");
  /*
   * 前端曾复制过一整份 `summarizeTitle` / `cjkCount` / `shardTitle`。服务端后来修掉
   * “删数字”的缺陷（`校验第 1 张单` → `校验第张单`），前端副本没跟上，同一个任务
   * 在左栏与看板显示成两个标题。判据因此是双向的：必须导入服务端实现，且不得自带
   * 摘要所需的汉字正则。本地复写无论怎么写都绕不开最后这条。
   */
  const imported = src.match(/import\s*\{[^}]*\bsummarizeTitle\b[^}]*\}\s*from\s*"([^"]+)"/);
  assert.ok(imported, "web/src/lib/taskTitle.js 未从服务端导入 summarizeTitle");
  assert.match(imported[1], /usage\/taskTitle(\.ts)?$/, `摘要来源不是服务端模块：${imported[1]}`);

  /*
   * 前端不再加显示字数上限：标题由派单方按 `TITLE:` 行给出，服务端已定过长度。
   * 前端再切一刀会把英文标识切成半个（`校验 componen`），同一批单又出现同名。
   */
  assert.doesNotMatch(src, /MAX_TITLE_CHARS/, "前端不应再按字数截断，显示宽度交给 CSS");
  assert.doesNotMatch(src, /\.slice\(\s*0\s*,/, "前端不应再对标题做 slice 截断");
  assert.doesNotMatch(src, /const\s+CJK\s*=/, "web/src/lib/taskTitle.js 自带汉字正则，说明又在本地实现了一遍摘要");
});

test("标题取值顺序：契约 title -> 分片映射 -> 正文摘要，不回退到 id", () => {
  assert.strictEqual(taskTitle({ contractTitle: "任务标题中文化", shard: "ux-chat" }), "任务标题中文化");
  assert.strictEqual(taskTitle({ shard: "ux-chat" }), "对话修复");
  assert.strictEqual(taskTitle({ shard: "no-such-shard", action: "把左栏的行名改成中文，别显示代号" }), "把左栏的行名改成中文");
  assert.strictEqual(taskTitle({}), "");
  // 分片 id 永远不是标题：未查到且正文无中文时返回空串，而不原样返回 id。
  assert.strictEqual(taskTitle({ shard: "no-such-shard", action: "Only modify the left column" }), "");
});

test("正文摘要取首个含中文的句读段，不按字数截断短标题", () => {
  assert.strictEqual(summarizeTitle("改 packages/supervisor/web/src/components/ChatPane.vue，做这几条："), "做这几条");
  const long = summarizeTitle("这一句话特别长需要被截断到十个汉字以内才行");
  assert.strictEqual(long, "这一句话特别长需要被截断到十个汉字以内才行");
  assert.ok(CJK.test(long), long);
  // 线上实例：任务卡标题被截成“撤掉看板聊天区的未建”，这里要求整句落库。
  assert.strictEqual(summarizeTitle("撤掉看板聊天区的未建单标记按钮，含模板与样式"), "撤掉看板聊天区的未建单标记按钮");
  assert.strictEqual(taskTitle({ shard: "", action: "撤掉看板聊天区的未建单标记按钮" }), "撤掉看板聊天区的未建单标记按钮");
});

test("正文摘要保留原文，只剥行首列表序号", () => {
  /*
   * 派单写“2. 校验第 1 张单产出的文案问题与改法清单”时，任务卡标题会变成“校验第张单产出的文案问题与改法清单”：数字被当作非中文删掉，“第几张单”的指代随之消失，且从标题上无法看出被删过。
   * 现在只去格式，不动词：数字、小数点、百分比、英文标识都留在标题里。
   */
  assert.strictEqual(
    summarizeTitle("2. 校验第 1 张单产出的文案问题与改法清单：逐条核对"),
    "校验第 1 张单产出的文案问题与改法清单",
  );
  /* 行首序号是书写格式，不该进标题；紧跟着的数字是内容，要留。 */
  assert.strictEqual(
    summarizeTitle("1. 按 wording-guard 技能规范逐文件盘点项目代码中的中文文案，找出口水话"),
    "按 wording-guard 技能规范逐文件盘点项目代码中的中文文案",
  );
  assert.strictEqual(summarizeTitle("把 3 个模块拆开，其余不动"), "把 3 个模块拆开");
  /* 按逗号切段后取第一段：`%` 保留，后半句不并入标题。 */
  assert.strictEqual(summarizeTitle("阈值从 4 调到 5%，观察一周"), "阈值从 4 调到 5%");
  assert.strictEqual(summarizeTitle("v57.22 的阈值校准"), "v57.22 的阈值校准");
});

test("顿号不是句读边界，路径与并列项原样保留", () => {
  /*
   * 线上实例：并发派单里覆盖多个目录的那一单，正文写成
   * “盘点 packages/…/test、packages/…/scripts、.github 下所有含中文的文件”，
   * 顿号连接的是并列项，不是句子边界；路径也不能删，它是这一单唯一的处理对象。
   */
  const listed = summarizeTitle(
    "3. 盘点 packages/supervisor/test、packages/supervisor/scripts、.github 下所有含中文的文件（测试用例名等），按技能规范核对",
  );
  /* 路径与顿号都在标题里，只是整体超过落盘上限时截断，读者仍能看出处理对象。 */
  assert.ok(listed.startsWith("盘点 packages/supervisor/test、packages/supervisor/scripts"), listed);
  assert.ok(listed.endsWith("…"), "超长标题截断并留省略号，不静默变短");

  const withSkill = summarizeTitle(
    "用 code-craft 技能盘点 packages/supervisor/test、packages/scripts 下所有含中文的文件",
  );
  assert.ok(withSkill.startsWith("用 code-craft 技能盘点 packages/supervisor/test"), withSkill);

  assert.strictEqual(summarizeTitle("盘点 .github 下的中文文件"), "盘点 .github 下的中文文件");
});

test("不判断从句是前提还是本体，首段即标题", () => {
  /*
   * 判断依据只有词面：“按…”“依据…”既可能是条件从句，也可能是任务本体。
   * 猜错的代价高于标题多带几个字，这类判断交给派单方在 `TITLE:` 行给出。
   */
  assert.strictEqual(
    summarizeTitle("按第 3 单的审查结论，逐处修改项目代码中的中文文案。只替换文字"),
    "按第 3 单的审查结论",
  );
  assert.strictEqual(
    summarizeTitle("按前面各轮已验收的盘点清单以及第 14 单的校验报告里列出的文案问题，逐处修改"),
    "按前面各轮已验收的盘点清单以及第 14 单的校验报告里列出的文案问题",
  );
  assert.strictEqual(summarizeTitle("按第 3 单的结论，改文案"), "按第 3 单的结论");
});

test("单号与 # 原样保留", () => {
  assert.strictEqual(summarizeTitle("对照 #14 的清单逐处替换中文文案"), "对照 #14 的清单逐处替换中文文案");
});


/**
 * 清理临时任务根。
 *
 * 本机安全策略会拦 `rmSync` 的删除动作并抛 EPERM。清理发生在断言之后，
 * 失败不影响结论，因此不冒泡成测试失败；残留目录交给系统临时目录回收。
 */
function cleanup(root) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* 删除被安全策略拦截，忽略。 */
  }
}

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

test("TITLE 行：标题按派单取值，不从正文摘要推测", async () => {
  /*
   * 13 张单的正文都以“加载 code-craft 技能”开头时，摘要取首从句并删掉英文与路径，会把它们全部命名为“加载技能”。标题是派单方最清楚的信息，
   * 由它在 `TITLE:` 行给出，摘要只作兜底。
   */
  const root = titleSandbox();
  try {
    appendSupervisorDirective(root, {
      action: "dispatch",
      arg: "加载 code-craft 技能，按其文案规范校验 packages/supervisor/src/cli 下的中文文案",
      title: "校验 cli 目录的中文文案",
    });
    await runDirectives(root);

    const d = capitalist.readDispatches(root).find((x) => x.source === "adhoc");
    assert.ok(d, "派单已建");
    assert.strictEqual(d.title, "校验 cli 目录的中文文案", "标题取 TITLE 行，不取正文摘要");
    assert.ok(String(d.action).startsWith("加载 code-craft 技能"), "正文原样下发，标题不改正文");
  } finally {
    cleanup(root);
  }
});

test("TITLE 行按 DO 归属，一条消息多单各取各的标题", () => {
  const r = parseReply(
    ["DO: dispatch [a] 甲", "TITLE: 甲的对象", "DO: dispatch [b] 乙", "TITLE: 乙的对象"].join("\n"),
  );
  assert.deepStrictEqual(
    r.acts.map((a) => a.title),
    ["甲的对象", "乙的对象"],
  );
  /* 多动作时顶层不给标题：整条消息共用一个标题会让读者以为两单是同一件事。 */
  assert.strictEqual(r.title, undefined);
  /* 未写 TITLE 时不落字段，建单侧据 undefined 走摘要兜底。 */
  assert.strictEqual(parseReply("DO: dispatch 甲").title, undefined);
});

test("TITLE 行写的是空值或纯符号时按未写处理", () => {
  const r = parseReply(["DO: dispatch 甲", "TITLE: none"].join("\n"));
  assert.strictEqual(r.title, undefined);
});

test("标题落盘：略超建议字数原样保留，异常长文按上限截断", async () => {
  /* 31 字、35 字都是正常标题，不按字数砍；上限只拦把整段正文塞进标题的写法。 */
  const root = titleSandbox();
  try {
    const long = "校验".padEnd(TITLE_MAX_CHARS + 10, "文");
    appendSupervisorDirective(root, { action: "dispatch", arg: "正文", title: long });
    await runDirectives(root);
    const d = capitalist.readDispatches(root).find((x) => x.source === "adhoc");
    assert.ok(d, "派单已建");
    assert.strictEqual(Array.from(String(d.title)).length, TITLE_MAX_CHARS + 1, "截断到上限并加省略号");
    assert.ok(String(d.title).endsWith("…"), "被截断时留标记，读者能看出不是原文结尾");
  } finally {
    cleanup(root);
  }
});

test("新建派单：标题落库保留完整语句，不按字数截断", async () => {
  /* 契约取版本库里已有的那份：指向未入库的文件时，干净检出跑不通。 */
  const root = mkdtempSync(join(tmpdir(), "capitalist-title-full-"));
  createTaskRoot({ target: "标题完整", contractSpec: join(PKG, "contracts/minimal.contract.json"), root });
  try {
    const body = "撤掉看板聊天区的未建单标记按钮";
    appendSupervisorDirective(root, { action: "dispatch", arg: body });
    await runDirectives(root);

    const d = capitalist.readDispatches(root).find((x) => x.source === "adhoc");
    assert.ok(d, "派单已建");
    assert.strictEqual(d.title, body, "派单记录里的标题是完整语句");
    assert.ok(String(d.action).includes(body), "正文未被改动");
  } finally {
    cleanup(root);
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
    cleanup(root);
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
    cleanup(root);
  }
});
