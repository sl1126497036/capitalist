
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { parseReply } = require("../dist/supervisor/channel/llm");
const { brainSessionOf } = require("../dist/supervisor/judge/brainLane");
const { recordEventThrottled, eventsPath } = require("../dist/core/record/ledger");
const { readJsonl } = require("../dist/core/record/json");

function tmpRoot(tag) {
  const root = mkdtempSync(join(tmpdir(), `capitalist-${tag}-`));
  mkdirSync(join(root, ".capitalist"), { recursive: true });
  return root;
}


test("一条消息三件事：三个动作，各带自己的图", () => {
  const r = parseReply(
    [
      "三件事分开派了。",
      "DO: dispatch 1. 首屏加载慢：首屏改成骨架屏",
      "ATT: 1",
      "DO: dispatch 2. 表格列宽：按内容自适应",
      "ATT: 2",
      "DO: dispatch 3. 标题：字号减 2px",
      "ATT: none",
    ].join("\n"),
  );
  assert.equal(r.acts.length, 3);
  assert.deepEqual(r.acts[0].shots, [1]);
  assert.deepEqual(r.acts[1].shots, [2]);
  assert.deepEqual(r.acts[2].shots, [], "明确不带图要落成空数组，不能当成没写");
  assert.equal(r.act.action, "dispatch", "兼容字段取第一个动作");
  assert.equal(r.reply, "三件事分开派了。", "动作行与 ATT 行都不进气泡");
});

test("单动作：ATT 语义与改动前一致（没写=undefined，none=[]）", () => {
  const none = parseReply("DO: dispatch 修一下\nATT: none");
  assert.deepEqual(none.shots, []);
  assert.equal(none.acts.length, 1);

  const plain = parseReply("DO: dispatch 修一下");
  assert.equal(plain.shots, undefined, "没写 ATT 时不能凭空造一个空数组");

  const picked = parseReply("DO: dispatch 修一下\nATT: 3");
  assert.deepEqual(picked.shots, [3]);
});

test("ATT 写在第一个 DO 之前：挂到第一单上", () => {
  const r = parseReply("ATT: 2\nDO: dispatch 甲\nDO: dispatch 乙");
  assert.deepEqual(r.acts[0].shots, [2]);
  assert.equal(r.acts[1].shots, undefined);
});

test("树边只在单动作时生效：多单里写 PARENT 会被丢掉", () => {
  const multi = parseReply(
    ["DO: dispatch 甲", "DO: dispatch 乙", "PARENT: #01", "PARENT_REASON: 接着做"].join("\n"),
  );
  assert.equal(multi.parent, undefined, "一条消息里的几件事是并行的，给它们串链会把并行压成单列");
  assert.equal(multi.parentReason, undefined);

  const single = parseReply(["DO: dispatch 甲", "PARENT: #01", "PARENT_REASON: 接着做"].join("\n"));
  assert.equal(single.parent, "#01");
  assert.equal(single.parentReason, "接着做");
});


test("节流：窗口内只落一条，到期后的第一条带上累计次数", () => {
  const root = tmpRoot("throttle");
  const hit1 = recordEventThrottled(root, "board_reload_blocked", { reason: "core 变了" }, { key: "k", windowMs: 60_000 });
  const hit2 = recordEventThrottled(root, "board_reload_blocked", { reason: "core 变了" }, { key: "k", windowMs: 60_000 });
  assert.equal(hit1, true);
  assert.equal(hit2, false, "窗口内不该再写");

  let rows = readJsonl(eventsPath(root));
  assert.equal(rows.length, 1);

  /* windowMs=0：下一次调用已在窗口外，把攒下的 1 次一并写上。 */
  const hit3 = recordEventThrottled(root, "board_reload_blocked", { reason: "core 变了" }, { key: "k", windowMs: 0 });
  assert.equal(hit3, true);
  rows = readJsonl(eventsPath(root));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].repeat, 2, "连续发生的次数要留下痕迹，不能看起来只发生过一次");
});

test("节流按 key 分开：不同单据各自记一条", () => {
  const root = tmpRoot("throttle2");
  recordEventThrottled(root, "duplicate_launch_refused", { dispatch: "D-1" }, { key: "D-1", windowMs: 60_000 });
  recordEventThrottled(root, "duplicate_launch_refused", { dispatch: "D-2" }, { key: "D-2", windowMs: 60_000 });
  const rows = readJsonl(eventsPath(root));
  assert.equal(rows.length, 2);
});


test("判定脑车道：首轮 fresh，之后同一条会话，轮次累加", () => {
  const root = tmpRoot("brainlane");
  /*
   * 车道名带随机后缀：占用估算按会话 id 去宿主的 projects 目录找记录，
   * 用固定名会读到这台机器上真实跑过的同一条会话（几 MB），测试就变成看环境脸色。
   */
  const base = `capitalist-brain-t-${Date.now().toString(36)}`;
  const first = brainSessionOf(root, base);
  assert.equal(first.id, base);
  assert.equal(first.gen, 0);
  assert.equal(first.fresh, true, "首次要发全量规范");

  const second = brainSessionOf(root, base);
  assert.equal(second.id, first.id, "没超限不换代");
  assert.equal(second.fresh, false, "同一代里只发一次规范");
  assert.equal(second.gen, 0);

  const lane = JSON.parse(readFileSync(join(root, ".capitalist", "brain", `${base}.json`), "utf8"));
  assert.equal(lane.turns, 2, "每调一次记一轮，占用估不出来时靠它兜底换代");
});

test("判定脑车道：不同车道互不影响", () => {
  const root = tmpRoot("brainlane2");
  const tag = Date.now().toString(36);
  brainSessionOf(root, `capitalist-brain-triage-${tag}`);
  const retry = brainSessionOf(root, `capitalist-brain-retry-${tag}`);
  assert.equal(retry.id, `capitalist-brain-retry-${tag}`);
  assert.equal(retry.fresh, true);
});
