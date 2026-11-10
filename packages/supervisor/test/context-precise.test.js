
const test = require("node:test");
const assert = require("node:assert");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { contextUsageOfResult, contextUsedOfAssistantMessage } = require(join(PKG, "dist/supervisor/llm.js"));

test("assistant 行：input_tokens 原样作为已用（已含缓存命中）", () => {
  const line = {
    type: "assistant",
    message: {
      role: "assistant",
      usage: {
        input_tokens: 19618,
        output_tokens: 3,
        cache_read_input_tokens: 19328,
        cache_creation_input_tokens: 0,
      },
    },
  };
  assert.equal(contextUsedOfAssistantMessage(line), 19618);
});

test("assistant 行：没有读数时返回 null，不拿 0 冒充", () => {
  assert.equal(contextUsedOfAssistantMessage(null), null);
  assert.equal(contextUsedOfAssistantMessage({ type: "assistant" }), null);
  assert.equal(contextUsedOfAssistantMessage({ message: null }), null);
  assert.equal(contextUsedOfAssistantMessage({ message: { usage: null } }), null);
  assert.equal(
    contextUsedOfAssistantMessage({ message: { usage: { input_tokens: 0, output_tokens: 0 } } }),
    null,
  );
  assert.equal(contextUsedOfAssistantMessage({ message: { usage: { input_tokens: -5 } } }), null);
  assert.equal(contextUsedOfAssistantMessage({ message: { usage: { input_tokens: "abc" } } }), null);
});

test("result 行的 usage 是会话累计值，不能当已用", () => {
  const line = {
    type: "result",
    usage: { input_tokens: 39209, cache_read_input_tokens: 19840, output_tokens: 18 },
    modelUsage: { "deepseek-v4.1": { contextWindow: 300000 } },
  };
  const u = contextUsageOfResult(line);
  assert.equal(u.used, null, "累计 usage 不能冒充当前占用");
  assert.equal(u.window, 300000, "窗口仍从 modelUsage 取");
});

test("result 行的 _meta 仍优先作为宿主真读数", () => {
  const u = contextUsageOfResult({
    type: "result",
    _meta: { "codebuddy.ai/contextUsed": 19618 },
    modelUsage: { m: { contextWindow: 300000 } },
  });
  assert.equal(u.used, 19618);
  assert.equal(u.window, 300000);
});
