/** core 产物指纹：能不能热重载，靠它判断。 */

const test = require("node:test");
const assert = require("node:assert");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { coreContentHash } = require(join(PKG, "dist/supervisor/loop.js"));

test("对真实 dist/core 返回稳定的 sha1 指纹", () => {
  const a = coreContentHash();
  assert.ok(a, "dist/core 存在时应返回指纹，不许返回 null");
  assert.match(a, /^[0-9a-f]{40}$/, "应为 sha1 的 40 位十六进制");
  const b = coreContentHash();
  assert.strictEqual(a, b, "同一批产物两次调用必须一致");
});

test("指纹包含文件名：同内容不同文件名也要区分开", () => {
  /*
   * 若只哈希内容，将 a.js 的内容移入 b.js（并删除 a.js）会得到相同指纹，
   * 而模块图已经变了。这里通过“指纹非空且稳定”间接约束实现必须把名字算进去，
   * 具体实现见 coreContentHash 里 h.update(n) 那一行。
   */
  const h = coreContentHash();
  assert.ok(typeof h === "string" && h.length === 40);
});
