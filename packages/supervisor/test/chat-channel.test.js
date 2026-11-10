/**
 * 对话通道的启动装配。
 *
 * 判据：多行中文提示词原样到达子进程；宿主为桌面端时落到同族 CLI。两条都由工作进程
 * 侧的同名装配（`program` / `needsShell` / `quoteShellArg`）保证，本文件守住调用侧。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");

const PKG = resolve(__dirname, "..");
const { askModel, parseReply, resolveChatHost } = require(join(PKG, "dist/supervisor/llm.js"));

/** 替身 CLI：把收到的 argv 写入 `DIAG_ARGV_FILE`，并向 stdout 回一段正文。 */
function fakeCli(dir) {
  const file = join(dir, "fake-chat-cli.cjs");
  writeFileSync(
    file,
    [
      'const { writeFileSync } = require("node:fs");',
      "const argv = process.argv.slice(2);",
      'if (process.env.DIAG_ARGV_FILE) writeFileSync(process.env.DIAG_ARGV_FILE, JSON.stringify(argv), "utf8");',
      'process.stdout.write("替身回复\\n");',
    ].join("\n"),
    "utf8",
  );
  return file;
}

/** 临时替换环境变量，退出时逐项还原；同步与异步回调都支持。 */
async function withEnv(patch, fn) {
  const saved = {};
  for (const key of Object.keys(patch)) {
    saved[key] = process.env[key];
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("对话通道：多行中文提示词原样到达子进程", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capitalist-chat-"));
  const argvFile = join(dir, "argv.json");
  const prompt = ["【监工上下文】", "阶段：S2 交付前复核", "用户消息：核对验收项，并列出未完成项。"].join("\n");
  try {
    await withEnv({ CAPITALIST_WORKER_BIN: fakeCli(dir), DIAG_ARGV_FILE: argvFile }, async () => {
      const r = await askModel({ prompt, cwd: dir, host: "codebuddy" });
      assert.strictEqual(r.ok, true, "对话通道应返回成功");
      const argv = JSON.parse(readFileSync(argvFile, "utf8"));
      const at = argv.indexOf("-p");
      assert.ok(at >= 0, "argv 必须含 -p");
      assert.strictEqual(argv[at + 1], prompt, "提示词必须整段到达，不得被重新分词");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("对话通道：宿主为桌面端时落到同族 CLI", async () => {
  await withEnv({ CAPITALIST_WORKER_BIN: join(tmpdir(), "capitalist-fake-codebuddy") }, () => {
    assert.strictEqual(resolveChatHost("workbuddy"), "codebuddy");
  });
});

test("对话通道：声明了探测优先级的宿主直接作为候选", async () => {
  await withEnv({ CAPITALIST_WORKER_BIN: join(tmpdir(), "capitalist-fake-claude") }, () => {
    assert.strictEqual(resolveChatHost("claude-code"), "claude-code");
  });
});

test("意图拆解：REVOKE 行归属前一单，不进入回复正文", () => {
  const raw = [
    "按你的要求改。",
    "DO: dispatch [ui] 重做顶栏布局",
    "REVOKE: 撤掉输入框上方的调度指令回显条",
    "DO: dispatch [data] 补一列耗时",
    "ATT: none",
  ].join("\n");
  const r = parseReply(raw);
  assert.ok(!r.reply.includes("REVOKE"), "内部标记行不得进入回复正文");
  assert.strictEqual(r.acts.length, 2);
  assert.strictEqual(r.acts[0].revoke, "撤掉输入框上方的调度指令回显条");
  assert.strictEqual(r.acts[1].revoke, undefined, "未写 REVOKE 的单不得继承上一条的推翻说明");
});

test("意图拆解：动作行之前的 REVOKE 归入第一单", () => {
  const raw = ["REVOKE: 旧的回显条作废", "DO: dispatch [ui] 去掉回显条"].join("\n");
  const r = parseReply(raw);
  assert.strictEqual(r.reply, "");
  assert.strictEqual(r.acts[0].revoke, "旧的回显条作废");
});
