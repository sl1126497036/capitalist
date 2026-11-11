
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
