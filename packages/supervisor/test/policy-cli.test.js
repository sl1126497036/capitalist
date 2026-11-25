/**
 * 守卫与 CLI 的一致性。
 *
 * 守卫是数据，CLI 是能力，两者之间没有类型系统约束：守卫的说明文案里写到的
 * `capitalist <cmd>` 会原样交给执行侧，若指向不存在的命令，模型按此执行将得到
 * “未知命令”报错。这类漂移不会被任何单测发现，只会在真实使用里以“照着指示做却失败”的形式出现。
 *
 * 所以这里直接读源码与守卫文本比对：守卫里写到的每个 `capitalist <cmd>` 都必须有实现。
 */

const test = require("node:test");
const assert = require("node:assert");
const { readdirSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
/* 内置守卫只有 `policies/` 一处。 */
const GUARD_DIRS = [join(PKG, "policies")];
const CLI_SRC = join(PKG, "src", "cli", "main.ts");

function guardFiles() {
  const out = [];
  for (const dir of GUARD_DIRS) {
    let names = [];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const name of names) out.push(join(dir, name));
  }
  return out;
}

function referencedCommands() {
  const out = new Map(); // cmd -> 出现它的守卫
  for (const file of guardFiles()) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\bcapitalist ([a-z][a-z-]*)/g)) {
      const cmd = m[1];
      if (cmd === "0") continue; // 版本号 `capitalist 0.1.0`
      if (!out.has(cmd)) out.set(cmd, new Set());
      out.get(cmd).add(file.replace(PKG + "/", ""));
    }
  }
  return out;
}

function implementedCommands() {
  const src = readFileSync(CLI_SRC, "utf8");
  return new Set([...src.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]));
}

test("守卫里引用的 capitalist 命令均有实现（否则执行侧按守卫执行会报未知命令）", () => {
  const refs = referencedCommands();
  const impl = implementedCommands();

  const missing = [...refs.entries()]
    .filter(([cmd]) => !impl.has(cmd))
    .map(([cmd, files]) => `capitalist ${cmd}（${[...files].join(", ")}）`);

  assert.deepEqual(missing, [], `守卫引用了不存在的命令：\n${missing.join("\n")}`);
});

test("守卫引用的命令不该少到只剩一两个（防止匹配规则写错后测试假通过）", () => {
  const refs = referencedCommands();
  /* 内置守卫只有 minimal 一份，其中引用的命令是 record 与 ask。下限按现状定，用途是发现正则失效。 */
  assert.ok(refs.size >= 2, `只匹配到 ${refs.size} 个命令，检查正则是否失效`);
  assert.ok(implementedCommands().size >= refs.size, "实现数应不少于被引用的命令数");
});
