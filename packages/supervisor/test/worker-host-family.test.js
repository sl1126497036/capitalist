/**
 * 工作进程宿主按当前宿主所属的族挑选。
 * 判据：当前宿主按注入变量判定、同族才可顶替、无可选时不回落。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, writeFileSync, chmodSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");

const PKG = resolve(__dirname, "..");
const { detectWorkerHost } = require(join(PKG, "dist/supervisor/worker/worker.js"));
const { currentHost, siblings } = require(
  join(PKG, "dist/agent/registry.js"),
);

/** 造一个只含指定可执行文件名的临时目录，用作受控 PATH。 */
function fakePath(names) {
  const dir = mkdtempSync(join(tmpdir(), "cap-host-"));
  for (const n of names) {
    const p = join(dir, n);
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
  }
  return dir;
}

/** 临时替换环境变量，退出时逐项还原；值为 undefined 表示删除该变量。 */
function withEnv(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** 清掉所有会干扰宿主角定的变量。 */
const CLEAN = {
  CODEBUDDY_HOST: undefined,
  CLAUDE_PROJECT_DIR: undefined,
  CLAUDE_SESSION_ID: undefined,
  CAPITALIST_WORKER_BIN: undefined,
};

test("当前宿主按宿主注入的变量判定，WorkBuddy 桌面端优先于配置目录", () => {
  withEnv({ ...CLEAN, CODEBUDDY_HOST: "workbuddy-desktop" }, () => {
    assert.strictEqual(currentHost(), "workbuddy");
  });
});

test("当前宿主在 Claude Code 里是 claude-code", () => {
  withEnv({ ...CLEAN, CLAUDE_PROJECT_DIR: "/tmp/probe" }, () => {
    assert.strictEqual(currentHost(), "claude-code");
  });
});

test("WorkBuddy 里没有同族 CLI 时不跨族借用 Claude", () => {
  const dir = fakePath(["claude"]);
  try {
    withEnv({ ...CLEAN, CODEBUDDY_HOST: "workbuddy-desktop", PATH: dir }, () => {
      assert.strictEqual(
        detectWorkerHost(),
        null,
        "PATH 上只有 claude 时必须返回 null，不得回落",
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WorkBuddy 里由同族 CodeBuddy CLI 顶替", () => {
  const dir = fakePath(["codebuddy", "claude"]);
  try {
    withEnv({ ...CLEAN, CODEBUDDY_HOST: "workbuddy-desktop", PATH: dir }, () => {
      assert.strictEqual(detectWorkerHost(), "codebuddy");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("同族解析只认 family 相等，Claude 不算同族", () => {
  const sib = siblings("workbuddy").map((i) => i.id);
  assert.ok(sib.includes("codebuddy"), "CodeBuddy 与 WorkBuddy 同族");
  assert.ok(!sib.includes("claude-code"), "Claude Code 属另一族，不可顶替");
});

test("未声明 family 的 impl 无同族实现", () => {
  assert.deepStrictEqual(siblings("generic"), []);
});
