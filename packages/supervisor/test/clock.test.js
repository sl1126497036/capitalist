/** 给人看的时刻必须是本地时间。 */

const test = require("node:test");
const assert = require("node:assert");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { clockOf, hhmmOf } = require(join(PKG, "dist/core/clock.js"));

/* 用本地时区构造期望值，测试本身不绑定跑在哪个时区（CI 可能是 UTC）。 */
function localExpect(date) {
  const p2 = (n) => String(n).padStart(2, "0");
  return {
    clock: `${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}`,
    hhmm: `${p2(date.getHours())}:${p2(date.getMinutes())}`,
  };
}

test("ISO 字符串转成本地钟点，而不是 UTC 钟点", () => {
  const iso = "2026-11-04T12:20:32.918Z";
  const d = new Date(iso);
  const want = localExpect(d);
  assert.strictEqual(clockOf(iso), want.clock);
  /* 关键断言：只要本机不在 UTC，就不该等于 UTC 钟点。 */
  if (d.getTimezoneOffset() !== 0) {
    assert.notStrictEqual(clockOf(iso), "12:20:32", "还是 UTC 钟点，等于没改");
  }
});

test("两位补零：个位数小时/分/秒也要有前导零", () => {
  const d = new Date(2026, 0, 2, 3, 4, 5); // 本地时间 03:04:05
  assert.strictEqual(clockOf(d.toISOString()), "03:04:05");
});

test("hhmmOf 只给到分钟", () => {
  const d = new Date(2026, 5, 1, 9, 7, 45);
  assert.strictEqual(hhmmOf(d.toISOString()), "09:07");
});

test("空值与非法值返回空串，不抛异常、不编时间", () => {
  assert.strictEqual(clockOf(""), "");
  assert.strictEqual(clockOf(null), "");
  assert.strictEqual(clockOf(undefined), "");
  assert.strictEqual(clockOf("不是时间"), "");
  assert.strictEqual(hhmmOf(""), "");
});
