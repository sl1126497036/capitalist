
const test = require("node:test");
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const WEB = join(__dirname, "..", "web", "src", "components", "chat-pane");
const tpl = readFileSync(join(WEB, "template.html"), "utf8");
const css = readFileSync(join(WEB, "styles.css"), "utf8");

test("标题行结构：中断 / 关闭 排在模型名与用量格之后", () => {
  const usage = tpl.indexOf('class="urow"');
  const stop = tpl.indexOf('class="stopbtn"');
  const close = tpl.indexOf('class="stopbtn close"');
  assert.ok(usage > 0, "模板里应当有 .urow 用量格（指标条同款小标签 + 数值）");
  assert.ok(stop > usage, "“中断”必须在用量格之后（行尾），不能插到中间");
  assert.ok(close > stop, "“关闭”必须紧随“中断”，同为行尾动作");
  assert.ok(tpl.indexOf("中断", stop) > 0 && tpl.indexOf("关闭", close) > 0, "文案保持原样");
});

test("标题行样式：动作按钮不缩，前置元素依次让位", () => {
  const block = (sel) => {
    const i = css.indexOf(sel + " {");
    assert.ok(i > 0, `样式里应当有 ${sel}`);
    return css.slice(i, css.indexOf("}", i));
  };

  /* 按钮：不缩，宽度不够时不参与压缩，它们是“必须在”的那一组。 */
  assert.match(block(".stopbtn"), /flex:\s*0 0 auto/);

  /* 用量格：shrink 权重远高于其它可缩项，先压成省略号。 */
  const usage = block(".chat.mode-worker > .chead > .urow");
  const weight = Number((usage.match(/flex-shrink:\s*(\d+)/) || [])[1]);
  assert.ok(weight >= 100, `用量串必须先让位，实际 flex-shrink=${weight}`);

  /* 模型名与验收项文字：可缩，不再把行尾按钮顶出去。 */
  for (const sel of [".chat.mode-worker > .chead > .cmwrap", ".chat.mode-worker > .chead > .ptoggle"]) {
    const rule = block(sel);
    assert.match(rule, /flex:\s*0 1 auto/, `${sel} 必须允许收缩`);
  }

  /* 监工面板的指标条与按钮排布不归本单一管，不许在这里被改成可缩。 */
  assert.match(block(".hmetrics"), /flex:\s*0 1 auto/);
});

/**
 * 引用与复制按钮只跟着消息编号走。
 *
 * 引用条上的编号就是被引消息的编号；没有编号的卡片（派单卡、思考块、输出分块、
 * 进程提醒）一旦也能点引用，引用出去只能落一个内容指纹，模型会照抄成 `#hhs87c`
 * 这种体系外编号回流到界面。判据在前端 `lib/no.js` 的 `refableOf`，模板负责执行。
 */
test("引用与复制按钮：逐卡片都要有编号判据，不得无条件渲染", () => {
  const buttons = [...tpl.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((m) => m[0]);
  const quoteBtns = buttons.filter((b) => b.includes("quoteOf("));
  assert.ok(quoteBtns.length >= 2, `引用按钮应覆盖气泡与块两类卡片，实际 ${quoteBtns.length} 个`);
  for (const b of quoteBtns) {
    assert.match(b, /v-if="v\.refable"/, `引用按钮缺少编号判据：\n${b}`);
  }

  const copyBtns = buttons.filter((b) => b.includes("复制这一段") || b.includes("复制这条"));
  assert.ok(copyBtns.length >= 2, `复制按钮应覆盖气泡与块两类卡片，实际 ${copyBtns.length} 个`);
  for (const b of copyBtns) {
    assert.match(b, /v-if="v\.refable"/, `复制按钮缺少编号判据：\n${b}`);
  }

  /* 引擎调试全文的复制不是消息引用，保留无条件；此处只钉住它别被误加判据。 */
  const dbgCopy = buttons.filter((b) => b.includes("复制引擎调试全文"));
  assert.equal(dbgCopy.length, 1, "引擎调试全文复制按钮应有且只有一个");
  assert.doesNotMatch(dbgCopy[0], /v-if="v\.refable"/, "引擎调试卡没有消息编号，不套引用判据");
});
