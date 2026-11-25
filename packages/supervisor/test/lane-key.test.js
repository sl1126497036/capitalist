/**
 * 线程键的形状：有分片取分片名，无分片取 `x` 加派生链尾号，两者都没有才落 `main`。
 *
 * 键里不带阶段号：任务树是唯一的编排结构，线程属于任务而不是某个执行阶段，
 * 重派出来的新单要沿用同一个键。
 */

const test = require("node:test");
const assert = require("node:assert");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { laneKeyOf } = require(join(PKG, "dist/core/dispatch/commands.js"));

test("lineage 为空串时回退到派单 id，不落 main", () => {
  const key = laneKeyOf({ shard: "", lineage: "", id: "D-mw24vv03ykh" });
  assert.strictEqual(key, "xv03ykh");
  assert.notStrictEqual(key, "main");
});

test("lineage 缺省（undefined）时同样回退到派单 id", () => {
  const key = laneKeyOf({ shard: "", id: "D-mw24vv03ykh" });
  assert.strictEqual(key, "xv03ykh");
});

test("lineage 有值时用 lineage，不用 id", () => {
  const key = laneKeyOf({ shard: "", lineage: "D-mw244poqqm2", id: "D-mw99999999" });
  assert.strictEqual(key, "xpoqqm2");
});

test("有分片时优先按分片，不看派生链", () => {
  const key = laneKeyOf({ shard: "parity-audit-b", lineage: "D-mw244poqqm2", id: "D-x" });
  assert.strictEqual(key, "parity-audit-b");
});

test("lineage 与 id 都为空才落 main", () => {
  assert.strictEqual(laneKeyOf({ shard: "" }), "main");
  assert.strictEqual(laneKeyOf({ shard: "", lineage: "", id: "" }), "main");
});

test("两个不同派单不会得到同一个键", () => {
  const a = laneKeyOf({ shard: "", lineage: "", id: "D-mw24vv03ykh" });
  const b = laneKeyOf({ shard: "", lineage: "", id: "D-mw24fafjujg" });
  assert.notStrictEqual(a, b);
});
