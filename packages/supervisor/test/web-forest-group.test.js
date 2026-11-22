/**
 * 组布局守卫：组成员数不再直接决定组框宽度。
 *
 * 11 个成员的组曾把组框撑到 2540px，远超树容器宽度，卡片画到边框之外被裁掉。
 * 判据五条：组宽公式只读列数变量、列数变量受上限约束、成员容器允许换行、
 * 树容器裁剪横向溢出并作为容器查询参照、树容器不参与纵向收缩。
 * 缺任一条都会让溢出重现，或让连线中线与组框错位，或让树被压扁。
 */

const test = require("node:test");
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const NODE_CSS = join(PKG, "web/src/components/forest-pane/node.css");
const PANE_CSS = join(PKG, "web/src/components/forest-pane/styles.css");

/** 取单个选择器的声明体；选择器内的点号按字面量匹配。 */
function ruleBody(src, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "m").exec(src);
  assert.ok(m, `缺少规则 ${selector}`);
  return m[1];
}

/** 取声明体里某个自定义属性的值。 */
function customProp(body, name) {
  const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(body);
  assert.ok(m, `缺少声明 ${name}`);
  return String(m[1]).trim();
}

test("组宽按列数计算，不按成员数", () => {
  const body = ruleBody(readFileSync(NODE_CSS, "utf8"), ".fv-col.has-group");
  const selfW = customProp(body, "--fv-self-w");
  assert.match(selfW, /var\(--fv-gcols\)/, "--fv-self-w 应读列数变量 --fv-gcols");
  assert.doesNotMatch(
    selfW,
    /var\(--fv-gn\)/,
    `--fv-self-w 不得直接读成员数 --fv-gn，否则成员多的组会撑破树边框：${selfW}`,
  );
});

test("列数受上限约束", () => {
  const body = ruleBody(readFileSync(NODE_CSS, "utf8"), ".fv-col.has-group");
  const cols = customProp(body, "--fv-gcols");
  assert.match(
    cols,
    /^min\(\s*var\(--fv-gn\)\s*,\s*var\(--fv-group-cols\)\s*\)$/,
    `--fv-gcols 应取成员数与上限的较小值：${cols}`,
  );
  const cap = customProp(body, "--fv-group-cols");
  assert.match(cap, /^[1-9]\d*$/, `列数上限应为正整数：${cap}`);
});

test("成员容器允许换行", () => {
  const body = ruleBody(readFileSync(NODE_CSS, "utf8"), ".fv-gmembers");
  assert.match(body, /flex-wrap\s*:\s*wrap/, "组框宽度已被列数固定，成员不换行时会溢出组框");
});

test("窄面板按树宽降列数", () => {
  const src = readFileSync(NODE_CSS, "utf8");
  const breakpoints = [...src.matchAll(/@container\s*\(max-width:\s*(\d+)px\)\s*\{([^}]*)\}/g)];
  assert.ok(breakpoints.length > 0, "缺少容器查询断点，面板收窄后末列会被树边框裁掉");
  for (const [, width, rule] of breakpoints) {
    assert.match(
      rule,
      /--fv-group-cols\s*:\s*[1-9]\d*/,
      `断点 ${width}px 应下调 --fv-group-cols`,
    );
  }
});

test("树容器裁剪横向溢出并作为容器查询参照", () => {
  const body = ruleBody(readFileSync(PANE_CSS, "utf8"), ".fv-tree");
  assert.match(body, /overflow-x\s*:\s*auto/, "树容器需横向滚动，否则溢出会画到边框之外");
  assert.match(
    body,
    /container-type\s*:\s*inline-size/,
    "树容器需声明 container-type，否则 @container 断点不生效",
  );
});

test("树容器不参与纵向收缩", () => {
  const body = ruleBody(readFileSync(PANE_CSS, "utf8"), ".fv-tree");
  assert.match(
    body,
    /flex\s*:\s*0\s+0\s+auto/,
    "树容器需固定为内容高度：overflow-x 为 auto 时 flex 自动最小高度归零，" +
      "树多时每棵都会被压扁到只剩标题行",
  );
});
