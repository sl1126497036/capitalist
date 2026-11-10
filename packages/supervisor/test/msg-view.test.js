/** 监工叙述上屏规则：实时推送与刷新重建必须给出同一句话。 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { supervisorReplyView } = require(join(PKG, "dist/supervisor/msgView.js"));
const { recordEvent } = require(join(PKG, "dist/core/ledger.js"));
const { appendSupervisorDirective } = require(join(PKG, "dist/supervisor/direct.js"));
const { buildSupervisorLog } = require(join(PKG, "dist/supervisor/board.js"));

const BODY =
  "调整聊天输入框正下方滚动提示文案的水平对齐：该行文字目前靠左，改为水平居中，与上方高度调节手柄的居中位置一致；确认轮换文案长短变化时不换行。";
const REPLY =
  "输入框下方的滚动提示文案靠左排，和上方居中的高度调节手柄明显错位。顺带把这次改动记进样式变量，方便下一轮复用。DO: dispatch [ui] " +
  BODY;

test("落成指令：叙述条不下发", () => {
  const out = supervisorReplyView({ reply: REPLY, acted: true, applied: "已加入队列", dispatch_text: BODY });
  assert.equal(out, "", "叙述不能单独成条，结构记录已经在流里");
});

test("整条都是复述：同样不下发", () => {
  const out = supervisorReplyView({ reply: BODY, acted: true, dispatch_text: BODY });
  assert.equal(out, "");
});

test("动作没落成：叙述是唯一说明，照旧上屏", () => {
  const out = supervisorReplyView({ reply: "这个动作需要确认", applied: "未执行：动作不在白名单内" });
  assert.equal(out, "这个动作需要确认（未执行：动作不在白名单内）");
});

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-msgview-"));
  mkdirSync(join(root, ".capitalist", "inbox"), { recursive: true });
  mkdirSync(join(root, ".capitalist", "workers"), { recursive: true });
  return root;
}

test("一次派单只有一条结构记录，补充说明并入它；实时与重建一致", () => {
  const root = scratch();
  try {
    const w = appendSupervisorDirective(root, { action: "dispatch", arg: BODY, confirm: true, via: "capitalist" });
    assert.ok(w.ok, w.ok ? "" : w.error);
    const directiveId = w.ok ? w.rec.id : "";
    recordEvent(root, "supervisor_reply", {
      ask: "改一下对齐",
      reply: REPLY,
      want: "",
      applied: "已加入队列",
      acted: true,
      dispatch_text: BODY,
      directive: directiveId,
      thread: "",
      from: "supervisor",
    });

    const live = supervisorReplyView({
      reply: REPLY,
      acted: true,
      applied: "已加入队列",
      dispatch_text: BODY,
      directive: directiveId,
    });
    assert.equal(live, "", "实时路径同样不能再冒一条叙述");

    const first = buildSupervisorLog(root, { limit: 100, hours: 1 });
    const second = buildSupervisorLog(root, { limit: 100, hours: 1 });

    const says = first.messages.filter(
      (m) =>
        m.role === "supervisor" &&
        m.kind === "say" &&
        !m.text.startsWith("调度指令：") &&
        m.text.includes("顺带"),
    );
    assert.equal(says.length, 0, `叙述条不得下发，实际 ${says.map((m) => m.text).join("｜")}`);

    /* 结构记录有一条，正文只在它身上出现一次。 */
    const card = first.messages.filter((m) => m.text.startsWith("调度指令："));
    assert.equal(card.length, 1, `指令卡应有且只有一条，实际 ${card.length} 条`);
    const bodyHits = first.messages.filter((m) => m.text.includes("水平居中"));
    assert.equal(bodyHits.length, 1, `完整派单正文只应出现在指令卡上，实际 ${bodyHits.length} 条`);
    assert.ok(bodyHits[0].text.startsWith("调度指令："), "带完整正文的是指令卡");

    /* 补充说明并入结构记录，不能因为去掉气泡就把话丢了。 */
    assert.ok(
      card[0].text.includes("顺带把这次改动记进样式变量"),
      `补充说明应并入指令卡，实际「${card[0].text}」`,
    );
    assert.equal(card[0].link, directiveId, "指令卡的归属标识应为指令 id");

    assert.deepStrictEqual(
      first.messages.map((m) => m.id),
      second.messages.map((m) => m.id),
      "两次重建的消息 id 必须稳定，否则前端会累积幽灵气泡",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
