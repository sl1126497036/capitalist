
const test = require("node:test");
const assert = require("node:assert");
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const PKG = resolve(__dirname, "..");
/** Windows 下动态 import ESM 必须用 file:// URL，裸盘符路径会被 ESM loader 拒掉。 */
const loadRejectTail = async () => {
  const mod = await import(pathToFileURL(resolve(PKG, "web/src/lib/rejectTail.js")).href);
  return mod.rejectTail;
};

test("rejectTail：reason 优先，空了回落 detail，都空返回空串", async () => {
  const rejectTail = await loadRejectTail();
  assert.equal(rejectTail("模型额度不足", "完整说明"), "模型额度不足");
  assert.equal(rejectTail("", "完整说明"), "完整说明", "reason 为空回落 detail");
  assert.equal(rejectTail(undefined, "detail"), "detail");
  assert.equal(rejectTail("", ""), "", "两者都空不许拼出悬空尾标");
  assert.equal(rejectTail(undefined, undefined), "");
});

test("rejectTail：纯空白串视同空，不产生「被拒 ·  」式尾巴", async () => {
  const rejectTail = await loadRejectTail();
  assert.equal(rejectTail("   ", "detail"), "detail");
  assert.equal(rejectTail("  ", "   "), "");
});

test("sayStatus 的 rejected 分支与 stat() 同源：fmt.js 必须引用 rejectTail，不得另抄回落链", async () => {
  const { readFileSync } = require("node:fs");
  const fmtSrc = readFileSync(resolve(PKG, "web/src/lib/fmt.js"), "utf8");
  const chatSrc = readFileSync(resolve(PKG, "web/src/components/chat-pane/index.vue"), "utf8");
  assert.ok(fmtSrc.includes("rejectTail"), "fmt.js 的 sayStatus 走 rejectTail 回落链");
  assert.ok(chatSrc.includes("rejectTail"), "chat-pane stat() 的 rejected 分支走 rejectTail 回落链");
  /* 两处调用都必须把 reason / detail 传进去，漏传就是又把拒因丢在半路。 */
  assert.match(fmtSrc, /sayStatus\(s,\s*no,\s*reason,\s*detail\)/);
  assert.match(chatSrc, /sayStatus\(v\.m\.status,\s*v\.m\.no,\s*v\.m\.reason,\s*v\.m\.detail\)/);
  assert.match(chatSrc, /rejectTail\(v\.m\.reason,\s*v\.m\.detail\)/);
});
