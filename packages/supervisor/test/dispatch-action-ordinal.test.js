/**
 * 派单正文的列表序号：建单时去掉行首的“第几条”编号。
 *
 * 这里守护两处容易出错的判据：
 *
 * 1. 只去掉“这条消息里的编号”。派单按单分发给各自的工作进程，进程之间上下文隔离，
 *    仅拿到 `2.` 的进程无法确认前面是否还有派单。编号是书写格式，不是内容。
 * 2. 不去掉“这张单自己的分步清单”。整段每行都带序号的，是内容本身的结构，
 *    删掉第一项编号会让剩下的 2./3. 失去参照。
 */

const test = require("node:test");
const assert = require("node:assert");
const { join } = require("node:path");

const PKG = join(__dirname, "..");
const { stripListMark, stripLeadOrdinal } = require(join(PKG, "dist/core/text.js"));
const { composeDispatch, deriveDispatch } = require(join(PKG, "dist/core/dispatch/newDispatch.js"));

test("行首序号三种写法都去掉", () => {
  assert.strictEqual(stripListMark("2. 盘点 web/src 下所有含中文的文件"), "盘点 web/src 下所有含中文的文件");
  assert.strictEqual(stripListMark("3、盘点 src 下的源码文件"), "盘点 src 下的源码文件");
  assert.strictEqual(stripListMark("1) 盘点配置文件"), "盘点配置文件");
});

test("只处理行首：正文中间的序号与“第 1 张单”都不改动", () => {
  assert.strictEqual(stripListMark("盘点 1. 所有文件"), "盘点 1. 所有文件");
  assert.strictEqual(stripListMark("校验第 1 张单的清单"), "校验第 1 张单的清单");
});

test("以数字开头的正文不是序号：年份、小数、倍数都保留", () => {
  assert.strictEqual(stripListMark("2026. 年度盘点"), "2026. 年度盘点");
  assert.strictEqual(stripListMark("3.5 倍的阈值按新口径重算"), "3.5 倍的阈值按新口径重算");
  assert.strictEqual(stripListMark("1. 3 个模块拆开重写"), "1. 3 个模块拆开重写");
});

test("首个非空行之前的空行不吞掉，序号从第二行开始也不剥", () => {
  /* 除序号外一个字节都不改：正文前导空行是原文格式，去掉会改动落库内容。 */
  assert.strictEqual(stripLeadOrdinal("\n\n2. 盘点文件"), "\n\n盘点文件");
  assert.strictEqual(stripLeadOrdinal("盘点文件\n1. 先看目录"), "盘点文件\n1. 先看目录");
});

test("整段每行都带序号：这是分步清单，保留", () => {
  const list = "1. 读 contracts 目录\n2. 读 src 目录\n3. 汇总问题清单";
  assert.strictEqual(stripLeadOrdinal(list), list);
});

test("多行正文只有第一行带序号：按外部编号去掉", () => {
  const text = "2. 盘点 packages/supervisor/web/src 下所有含中文的文件\n按 wording-guard 规范逐条列出。";
  assert.strictEqual(
    stripLeadOrdinal(text),
    "盘点 packages/supervisor/web/src 下所有含中文的文件\n按 wording-guard 规范逐条列出。",
  );
});

test("建单时正文已去掉序号，标题与正文都不再带编号", () => {
  const d = composeDispatch({
    id: "4-1",
    stage: "s1",
    action: "2. 盘点下所有含中文的文件（组件模板与脚本）",
    title: "盘点下所有含中文的文件",
  });
  assert.strictEqual(d.action, "盘点下所有含中文的文件（组件模板与脚本）");
});

test("重派沿用正文：已去过的不会再去，分步清单也不会被削", () => {
  const first = composeDispatch({ id: "4-1", stage: "s1", action: "3、盘点配置文件" });
  assert.strictEqual(first.action, "盘点配置文件");

  const again = deriveDispatch(first, { id: "4-2", stage: "s1", action: first.action });
  assert.strictEqual(again.action, "盘点配置文件");
  assert.strictEqual(again.lineage, first.lineage);

  const steps = "1. 读目录\n2. 逐个文件过一遍";
  const held = deriveDispatch(first, { id: "4-3", stage: "s1", action: steps });
  assert.strictEqual(held.action, steps);
});
