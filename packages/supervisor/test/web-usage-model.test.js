
const test = require("node:test");
const assert = require("node:assert");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const USAGE = pathToFileURL(join(__dirname, "..", "web", "src", "lib", "usage.js")).href;

test("模型名按原始 id 原样展示：连字符与大小写不变", async () => {
  const { modelLabel, modelOf } = await import(USAGE);
  for (const id of ["GLM-5.3-Flash", "DeepSeek-v4.1-Flash", "glm-5.3-flash", "deepseek-v4.1-flash"]) {
    assert.equal(modelLabel(id), id, `展示名必须与原始 id 一致：${id}`);
    assert.deepEqual(modelOf(id), { name: id, ver: "", raw: id });
  }
});

test("路由别名 fast-model 原样展示，轮换说明单独标注不拼进名字", async () => {
  const { modelLabel, modelOf } = await import(USAGE);
  assert.equal(modelLabel("fast-model"), "fast-model");
  const parsed = modelOf("fast-model");
  assert.equal(parsed.name, "fast-model");
  assert.equal(parsed.ver, "");
  assert.notEqual(parsed.note, "");
});

test("空值不编造模型名", async () => {
  const { modelLabel, modelOf } = await import(USAGE);
  assert.equal(modelOf(""), null);
  assert.equal(modelLabel(""), "");
});
