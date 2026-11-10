
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { recordEvent } = require("../dist/core/ledger");
const { appendSupervisorDirective } = require("../dist/supervisor/direct");
const { buildSupervisorLog } = require("../dist/supervisor/board");

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-replydedup-"));
  mkdirSync(join(root, ".capitalist", "inbox"), { recursive: true });
  mkdirSync(join(root, ".capitalist", "workers"), { recursive: true });
  return root;
}

function supervisorTexts(root) {
  return buildSupervisorLog(root, { limit: 400, hours: 6 }).messages.map((m) => m.text);
}

test("对话层落成调度指令：只保留结构记录，叙述条不下发", () => {
  const root = scratch();
  try {
    const w = appendSupervisorDirective(root, {
      action: "dispatch",
      arg: "修任务卡两处显示问题",
      confirm: true,
      via: "capitalist",
    });
    assert.ok(w.ok, `指令应落成：${w.ok ? "" : w.error}`);
    recordEvent(root, "supervisor_reply", {
      ask: "开一单修任务卡",
      reply: "叙述：已开一单修任务卡两处显示问题",
      want: "",
      applied: "已加入队列",
      acted: true,
      directive: w.ok ? w.rec.id : "",
      from: "supervisor",
    });

    const msgs = buildSupervisorLog(root, { limit: 400, hours: 6 }).messages;
    const card = msgs.find((m) => m.text.includes("调度指令："));
    const narr = msgs.find((m) => m.text.includes("叙述：已开一单"));
    assert.ok(card, "指令回显必须留在消息流里");
    assert.equal(narr, undefined, `叙述条不得下发，实际：${msgs.map((m) => m.text).join("｜")}`);
    assert.equal(card.link, w.rec.id, "指令卡的归属标识应为指令 id");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("回复含解释文字与复述句：叙述条同样不下发（D-mw1utcgk0v2 覆盖 D-mw1hrm5eesb）", () => {
  const root = scratch();
  try {
    recordEvent(root, "supervisor_reply", {
      ask: "开一单修任务卡，带上截图",
      reply: "这一单按面板定的模型派发。修复两处读数显示并核对单位口径，相关的两张截图一起带上。已加入队列",
      want: "开一单修任务卡",
      applied: "已加入队列",
      acted: true,
      from: "supervisor",
    });

    const texts = supervisorTexts(root);
    assert.ok(
      texts.every((t) => !t.includes("修复两处读数显示") && !t.includes("这一单按面板定的模型派发")),
      `落成指令的叙述不得上屏，实际：${texts.join("｜")}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("回复整条只是派单复述：同样只留结构记录", () => {
  const root = scratch();
  try {
    const w = appendSupervisorDirective(root, {
      action: "dispatch",
      arg: "修任务卡两处显示问题",
      confirm: true,
      via: "capitalist",
    });
    assert.ok(w.ok, `指令应落成：${w.ok ? "" : w.error}`);
    recordEvent(root, "supervisor_reply", {
      ask: "开一单修任务卡",
      reply: "已开一单修任务卡",
      want: "开一单修任务卡",
      applied: "已加入队列",
      acted: true,
      directive: w.ok ? w.rec.id : "",
      from: "supervisor",
    });

    const msgs = buildSupervisorLog(root, { limit: 400, hours: 6 }).messages;
    const card = msgs.find((m) => m.text.includes("调度指令："));
    const narr = msgs.find((m) => m.text.includes("已开一单修任务卡"));
    assert.ok(card, "指令回显必须留在消息流里");
    assert.equal(narr, undefined, `整条复述也不得单独上屏，实际：${msgs.map((m) => m.text).join("｜")}`);
    assert.equal(card.link, w.rec.id, "结构记录的归属标识为指令 id");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("动作没落成：叙述回执照旧上屏（它是唯一的失败说明）", () => {  const root = scratch();
  try {
    recordEvent(root, "supervisor_reply", {
      ask: "停掉所有任务",
      reply: "这个动作需要确认",
      want: "",
      applied: "未执行：动作不在白名单内",
      from: "supervisor",
    });

    const texts = supervisorTexts(root);
    assert.ok(
      texts.some((t) => t.includes("这个动作需要确认（未执行：动作不在白名单内）")),
      `无指令可回显时叙述必须保留，实际：${texts.join("｜")}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("消息流不出现时间承诺文案：队列回执只陈述实际状态", () => {
  const root = scratch();
  try {
    recordEvent(root, "supervisor_reply", {
      ask: "开一单",
      reply: "叙述回复",
      want: "",
      applied: "已加入队列",
      from: "supervisor",
    });
    recordEvent(root, "supervisor_cmd", {
      ok: true,
      action: "dispatch",
      arg: "X",
      detail: "已插入队列优先执行 D-x：X｜当拍拉起进程",
    });

    const texts = supervisorTexts(root);
    assert.ok(
      texts.every((t) => !t.includes("5 秒内")),
      `消息流不得出现时间承诺文案，实际：${texts.join("｜")}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
