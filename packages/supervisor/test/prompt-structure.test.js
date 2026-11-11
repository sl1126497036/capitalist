
const test = require("node:test");
const assert = require("node:assert");

const { buildPrompt, buildResumePrompt, buildGroundingBlock } = require("../dist/supervisor/worker");

const CN = ["一", "二", "三", "四", "五", "六", "七", "八"];
const DISPATCH = {
  id: "D-test1",
  stage: "S1",
  shard: "",
  action: "把列表的偶数行加一层很淡的隔行底色，其它样式不动。",
  at: "2026-11-06T00:00:00.000Z",
  atts: [],
};
const ARGS = { root: "/tmp/demo", target: "演示", id: "W-test", dispatch: DISPATCH };

/** 只认顶层区块：`【三、边界】` 这种带中文序号的。子块标题没有序号，不会被算进来。 */
function blocks(text) {
  return text
    .split("\n")
    .filter((l) => /^【[一二三四五六七八]、/.test(l))
    .map((l) => /^【[一二三四五六七八]、(.+?)】/.exec(l)[1]);
}

/** 顶层区块的序号序列（用于断言连续）。 */
function seq(text) {
  return text
    .split("\n")
    .map((l) => /^【([一二三四五六七八])、/.exec(l)?.[1])
    .filter(Boolean);
}

test("首次派单：七块，序号连续不重复", () => {
  const text = buildPrompt(ARGS);
  const s = seq(text);
  assert.equal(s.length, 7, `实际区块：${blocks(text).join(" / ")}`);
  assert.deepEqual(s, CN.slice(0, 7), "序号必须从“一”连续排到“七”，不能跳号或撞号");
});

test("续跑：与首次派单同一套块序", () => {
  const fresh = buildPrompt(ARGS);
  const resume = buildResumePrompt(ARGS);
  assert.deepEqual(blocks(resume), blocks(fresh), "两个入口的块序必须一致，否则同一单在两条路径上阅读顺序不同");
});

test("修复单：七块；诊断单（只读）少一块核对现状，序号仍连续", () => {
  const fix = buildPrompt({ ...ARGS, dispatch: { ...DISPATCH, role: "fix" } });
  const diag = buildPrompt({ ...ARGS, dispatch: { ...DISPATCH, role: "diagnose" } });

  assert.equal(seq(fix).length, 7, `修复单区块：${blocks(fix).join(" / ")}`);
  assert.deepEqual(seq(fix), CN.slice(0, 7));

  assert.equal(seq(diag).length, 6, `诊断单区块：${blocks(diag).join(" / ")}`);
  assert.deepEqual(seq(diag), CN.slice(0, 6), "诊断单没有“核对现状”，后面的序号要整体前移");
  assert.ok(!blocks(diag).some((n) => n.includes("核对现状")), "只读进程不该有动手前核对这一段");
});

test("不再有重复的核对现状：只有一块，且合并了两边独有的内容", () => {
  const text = buildPrompt(ARGS);
  const headings = text.split("\n").filter((l) => /^【/.test(l) && l.includes("核对现状"));
  assert.equal(headings.length, 1, `“核对现状”只该有一个区块标题，实际：${headings.join(" / ")}`);
  assert.ok(text.includes("mtime 晚于本单创建时刻"), "preflight 独有的 mtime 比对要保留");
  assert.ok(text.includes("与已验收的做法相反"), "preflight 独有的口径核对要保留");
  assert.ok(text.includes("相关模块现在怎么做的"), "grounding 独有的理解现状要保留");
});

test("“带超时”只写一遍：结单口径里说完，不再在动作清单里重复", () => {
  const text = buildPrompt(ARGS);
  const hits = text.split("\n").filter((l) => l.includes("带超时与无输出判定"));
  assert.equal(hits.length, 1, `实际出现 ${hits.length} 处：\n${hits.join("\n")}`);
});

test("旧标题不再出现（已被合并或重命名）", () => {
  const text = buildPrompt(ARGS);
  for (const gone of ["【只认这一单】", "【动手前先对齐现状】", "【碰到问题就申报", "做这几件事："]) {
    assert.ok(!text.includes(gone), `“${gone}”已被合并，不该还在`);
  }
});

test("核对现状块可以指定标题：修复单传自己的序号", () => {
  assert.equal(buildGroundingBlock(DISPATCH, "【三、动手前先核对现状】")[0], "【三、动手前先核对现状】");
  assert.equal(buildGroundingBlock(DISPATCH)[0], "【二、动手前先核对现状】", "默认值给业务单用");
});
