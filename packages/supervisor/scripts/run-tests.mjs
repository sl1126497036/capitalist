/** 测试运行器：给 `node --test` 补上整体时限，跨平台不依赖 shell 展开 glob。 */

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = "test";
const PER_TEST_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = Number(process.env.CAPITALIST_TEST_TIMEOUT_MS ?? 180_000);

const files = readdirSync(TEST_DIR)
  .filter((f) => f.endsWith(".test.js"))
  .sort()
  .map((f) => join(TEST_DIR, f));

if (files.length === 0) {
  console.error(`[test] ${TEST_DIR}/ 下没有 *.test.js，检查是不是在包根目录跑的`);
  process.exit(1);
}

console.log(
  `[test] ${files.length} 个测试文件，单测试上限 ${PER_TEST_TIMEOUT_MS / 1000}s，` +
    `整体上限 ${Math.round(TOTAL_TIMEOUT_MS / 1000)}s`,
);

const child = spawn(
  process.execPath,
  ["--test", "--test-force-exit", `--test-timeout=${PER_TEST_TIMEOUT_MS}`, ...files],
  { stdio: "inherit" },
);

let killedByTimeout = false;
const timer = setTimeout(() => {
  killedByTimeout = true;
  /* 先礼后兵：SIGTERM 让 node 自己收尾，5 秒还不走就 SIGKILL。 */
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
}, TOTAL_TIMEOUT_MS);

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  if (killedByTimeout) {
    console.error(
      `\n[test] 整体超过 ${Math.round(TOTAL_TIMEOUT_MS / 1000)}s，已中止（signal=${signal ?? "?"}）。\n` +
        `[test] 想放宽：CAPITALIST_TEST_TIMEOUT_MS=600000 npm test；想缩范围：单独跑相关文件。`,
    );
    process.exit(124);
  }
  process.exit(code ?? 1);
});

child.on("error", (err) => {
  clearTimeout(timer);
  console.error(`[test] 启动测试进程失败：${String(err?.message ?? err)}`);
  process.exit(1);
});
