/**
 * 测试运行器：给 `node --test` 补上整体时限与并发上限，并在机器过载时中止。
 *
 * `node --test` 的缺省并发度是“核数 - 1”，每个测试文件各起一个子进程。全量 113 个文件会占满所有核心，内存随之抬升，短时间内即可让机器过热。本脚本显式限制并发，并在 CPU 长时间打满时熔断。
 *
 * 环境变量：
 * - CAPITALIST_TEST_CONCURRENCY：同时运行的测试文件数，缺省 2，上限 4。
 * - CAPITALIST_TEST_TIMEOUT_MS：整体时限，缺省 180 秒。
 * - CAPITALIST_TEST_FORCE：设为 1 时跳过启动前的负载检查。
 * - CAPITALIST_TEST_LOAD_LIMIT：运行中允许的 CPU 占用比例，缺省 0.9；设为 1 关闭熔断。
 *
 * CI 上跳过负载检查与 CPU 熔断：构建机本就独占全速跑测试，占用高属正常。
 */

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism, cpus, loadavg } from "node:os";
import { join } from "node:path";

const TEST_DIR = "test";
const PER_TEST_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = Number(process.env.CAPITALIST_TEST_TIMEOUT_MS ?? 180_000);

const CPUS = Math.max(1, availableParallelism());
/** 构建机上占用高属正常，负载判定与熔断在此关闭。 */
const CI = Boolean(process.env.CI);
/** 上限取 4：再高就接近“核数 - 1”，失去限制意义。 */
const MAX_CONCURRENCY = 4;
const DEFAULT_CONCURRENCY = Math.min(2, Math.max(1, CPUS - 1));

/** 启动前允许的负载：超过一倍核数说明机器已被别的任务占满。 */
const LOAD_IDLE_RATIO = 1;
/** 运行中允许的 CPU 占用比例，超过即视为失控。 */
const CPU_TRIP_RATIO = Number(process.env.CAPITALIST_TEST_LOAD_LIMIT ?? 0.9);
/** 连续采样达到此次数才熔断，避免瞬时抖动误杀。 */
const CPU_TRIP_SAMPLES = 3;
const CPU_SAMPLE_MS = 2_000;

const files = readdirSync(TEST_DIR)
  .filter((f) => f.endsWith(".test.js"))
  .sort()
  .map((f) => join(TEST_DIR, f));

if (files.length === 0) {
  console.error(`[test] ${TEST_DIR}/ 下没有 *.test.js，请在包根目录运行`);
  process.exit(1);
}

/** CPU 时间累计值，两次采样求差得到区间占用率。 */
function cpuSnapshot() {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

let baseline = cpuSnapshot();

/**
 * 自上次采样以来的 CPU 占用比例。
 *
 * 用 `os.cpus()` 的累计时间求差，不用 `loadavg()`：后者是分钟级均值，
 * 测试只跑几十秒，等它升上去时熔断已经晚了。
 */
function cpuRatio() {
  const now = cpuSnapshot();
  const dTotal = now.total - baseline.total;
  const dIdle = now.idle - baseline.idle;
  baseline = now;
  if (dTotal <= 0) return 0;
  return 1 - dIdle / dTotal;
}

/** 负载倍数；读不到负载（Windows）时返回 0，等价于不做负载判定。 */
function loadRatio() {
  const one = loadavg()[0];
  return one > 0 ? one / CPUS : 0;
}

function overloadHint() {
  return `降低并发：CAPITALIST_TEST_CONCURRENCY=1 npm test；或先结束占用 CPU 的任务。`;
}

function resolveConcurrency() {
  const raw = String(process.env.CAPITALIST_TEST_CONCURRENCY ?? "").trim();
  if (!raw) return DEFAULT_CONCURRENCY;
  const wanted = Number(raw);
  if (!Number.isInteger(wanted) || wanted < 1) {
    console.error(`[test] CAPITALIST_TEST_CONCURRENCY 必须是正整数：${raw}`);
    process.exit(2);
  }
  if (wanted > MAX_CONCURRENCY) {
    console.error(
      `[test] 并发 ${wanted} 超过上限 ${MAX_CONCURRENCY}，已拒绝启动：` +
        `把 CAPITALIST_TEST_CONCURRENCY 调到 ${MAX_CONCURRENCY} 以内后重试`,
    );
    process.exit(2);
  }
  return wanted;
}

function assertMachineFree() {
  if (CI || process.env.CAPITALIST_TEST_FORCE === "1") return;
  const ratio = loadRatio();
  if (ratio <= LOAD_IDLE_RATIO) return;
  console.error(
    `[test] 当前负载为核数的 ${ratio.toFixed(2)} 倍，超过 ${LOAD_IDLE_RATIO} 倍上限，已拒绝启动：` +
      `先结束占用 CPU 的任务再运行；确需此时运行，设 CAPITALIST_TEST_FORCE=1`,
  );
  process.exit(3);
}

const concurrency = resolveConcurrency();
assertMachineFree();

console.log(
  `[test] ${files.length} 个测试文件，并发 ${concurrency}/${CPUS} 核，` +
    `单测试上限 ${PER_TEST_TIMEOUT_MS / 1000}s，整体上限 ${Math.round(TOTAL_TIMEOUT_MS / 1000)}s`,
);

/** 中止原因：`timeout` 或 `overload`；空串表示正常跑完。 */
let killedBy = "";

const child = spawn(
  process.execPath,
  [
    "--test",
    "--test-force-exit",
    `--test-timeout=${PER_TEST_TIMEOUT_MS}`,
    `--test-concurrency=${concurrency}`,
    ...files,
  ],
  { stdio: "inherit" },
);

const timeoutTimer = setTimeout(() => {
  killedBy = "timeout";
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
}, TOTAL_TIMEOUT_MS);
timeoutTimer.unref();

/* 运行中熔断：连续多次采样超过占用上限即中止，不等机器热到降频。 */
let hot = 0;
const loadGuard = CI
  ? null
  : setInterval(() => {
      if (cpuRatio() <= CPU_TRIP_RATIO) {
        hot = 0;
        return;
      }
      hot += 1;
      if (hot < CPU_TRIP_SAMPLES) return;
      clearInterval(loadGuard);
      killedBy = "overload";
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, CPU_SAMPLE_MS);
loadGuard?.unref();

child.on("error", (err) => {
  clearInterval(loadGuard);
  clearTimeout(timeoutTimer);
  console.error(`[test] 启动测试进程失败：${String(err?.message ?? err)}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  clearInterval(loadGuard);
  clearTimeout(timeoutTimer);

  if (killedBy === "timeout") {
    console.error(
      `\n[test] 整体超过 ${Math.round(TOTAL_TIMEOUT_MS / 1000)}s，已中止（signal=${signal ?? "?"}）。\n` +
        `[test] 放宽时限：CAPITALIST_TEST_TIMEOUT_MS=600000 npm test；缩小范围：单独运行相关文件。`,
    );
    process.exit(124);
  }
  if (killedBy === "overload") {
    console.error(
      `\n[test] CPU 占用连续超过 ${Math.round(CPU_TRIP_RATIO * 100)}%，已熔断（signal=${signal ?? "?"}）。\n` +
        `[test] ${overloadHint()}`,
    );
    process.exit(125);
  }
  process.exit(code ?? 1);
});
