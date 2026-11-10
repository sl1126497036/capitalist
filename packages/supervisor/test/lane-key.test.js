/** 线程键不能把「没有血缘」的派单折成 `阶段/main`。 */

const test = require("node:test");
const assert = require("node:assert");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { laneKeyOf } = require(join(PKG, "dist/core/commands.js"));

test("lineage 为空串时回退到派单 id，不落 main", () => {
  const key = laneKeyOf({ stage: "U1", shard: "", lineage: "", id: "D-mw24vv03ykh" });
  assert.strictEqual(key, "u1/xv03ykh");
  assert.notStrictEqual(key, "u1/main");
});

test("lineage 缺省（undefined）时同样回退到派单 id", () => {
  const key = laneKeyOf({ stage: "U1", shard: "", id: "D-mw24vv03ykh" });
  assert.strictEqual(key, "u1/xv03ykh");
});

test("lineage 有值时用 lineage，不用 id", () => {
  const key = laneKeyOf({ stage: "U1", shard: "", lineage: "D-mw244poqqm2", id: "D-mw99999999" });
  assert.strictEqual(key, "u1/xpoqqm2");
});

test("有分片时优先按分片，不看血缘", () => {
  const key = laneKeyOf({ stage: "U1", shard: "parity-audit-b", lineage: "D-mw244poqqm2", id: "D-x" });
  assert.strictEqual(key, "u1/parity-audit-b");
});

test("lineage 与 id 都为空才落 main", () => {
  assert.strictEqual(laneKeyOf({ stage: "U1", shard: "" }), "u1/main");
  assert.strictEqual(laneKeyOf({ stage: "U1", shard: "", lineage: "", id: "" }), "u1/main");
});

test("两个不同派单不会得到同一个键", () => {
  const a = laneKeyOf({ stage: "U1", shard: "", lineage: "", id: "D-mw24vv03ykh" });
  const b = laneKeyOf({ stage: "U1", shard: "", lineage: "", id: "D-mw24fafjujg" });
  assert.notStrictEqual(a, b);
});
