/**
 * 失败重派按指数退避：基数 × 倍数递增、单次封顶、抖动只在本地错开不越界。
 * 时间用环境变量压到毫秒级，测试不真实等待。
 */

const test = require("node:test");
const assert = require("node:assert");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { retryDelayMs, retryDelaysMs } = require(join(PKG, "dist/supervisor/loop.js")).__testing;

const KEYS = [
  "CAPITALIST_RETRY_DELAYS_MS",
  "CAPITALIST_RETRY_BASE_MS",
  "CAPITALIST_RETRY_FACTOR",
  "CAPITALIST_RETRY_MAX_MS",
  "CAPITALIST_RETRY_JITTER",
];

/** 每个用例前清空退避配置，用完还原，避免与其它测试串味。 */
function withEnv(vars, fn) {
  const saved = KEYS.map((k) => [k, process.env[k]]);
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = String(v);
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("阶梯按基数×倍数递增，到上限封顶", () => {
  withEnv(
    {
      CAPITALIST_RETRY_BASE_MS: 1000,
      CAPITALIST_RETRY_FACTOR: 3,
      CAPITALIST_RETRY_MAX_MS: 10000,
      CAPITALIST_RETRY_JITTER: 0,
    },
    () => {
      assert.deepStrictEqual([...retryDelaysMs()], [1000, 3000, 9000, 10000]);
      assert.strictEqual(retryDelayMs(1), 1000);
      assert.strictEqual(retryDelayMs(2), 3000);
      assert.strictEqual(retryDelayMs(3), 9000);
      /* 超过阶梯长度沿用末级，不继续翻倍。 */
      assert.strictEqual(retryDelayMs(9), 10000);
    },
  );
});

test("默认基数为 1、2、4 分钟并封顶 4 分钟", () => {
  withEnv({ CAPITALIST_RETRY_JITTER: 0 }, () => {
    assert.deepStrictEqual([...retryDelaysMs()], [60_000, 120_000, 240_000]);
    assert.strictEqual(retryDelayMs(3), 240_000);
    assert.strictEqual(retryDelayMs(4), 240_000);
  });
});

test("显式 CAPITALIST_RETRY_DELAYS_MS 整段替换阶梯", () => {
  withEnv(
    { CAPITALIST_RETRY_DELAYS_MS: "10, 20 ,30", CAPITALIST_RETRY_JITTER: 0 },
    () => {
      assert.deepStrictEqual([...retryDelaysMs()], [10, 20, 30]);
      assert.strictEqual(retryDelayMs(2), 20);
    },
  );
});

test("抖动在基准值上下浮动，比例受配置约束", () => {
  withEnv(
    {
      CAPITALIST_RETRY_DELAYS_MS: "1000,2000",
      CAPITALIST_RETRY_JITTER: 0.2,
    },
    () => {
      /* rand 取端点，等价于 +20% / -20% / 中间值。 */
      assert.strictEqual(retryDelayMs(1, () => 1), 1200);
      assert.strictEqual(retryDelayMs(1, () => 0), 800);
      assert.strictEqual(retryDelayMs(1, () => 0.5), 1000);
    },
  );
});

test("抖动不越过单次等待上限", () => {
  withEnv(
    {
      CAPITALIST_RETRY_DELAYS_MS: "1000,2000",
      CAPITALIST_RETRY_JITTER: 0.5,
    },
    () => {
      /* 末级 2000 是上限，正向抖动被截到 2000，不会变成 3000。 */
      assert.strictEqual(retryDelayMs(2, () => 1), 2000);
      assert.strictEqual(retryDelayMs(2, () => 0), 1000);
    },
  );
});

test("未失败不等待", () => {
  withEnv({ CAPITALIST_RETRY_JITTER: 0 }, () => {
    assert.strictEqual(retryDelayMs(0), 0);
    assert.strictEqual(retryDelayMs(-1), 0);
  });
});
