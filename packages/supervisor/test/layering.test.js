/** 分层守卫。 */

const test = require("node:test");
const assert = require("node:assert");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join, relative, resolve, sep } = require("node:path");

const PKG = resolve(__dirname, "..");
const SRC = join(PKG, "src");
const IMPL = join(SRC, "agent", "impl");

/** 各宿主的产品名 / 别名 / 配置目录痕迹。顶层出现任何一个都算越界。 */
const HOST_TOKENS = ["claude", "codebuddy", "workbuddy", "tencent", "anthropic"];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function labels(file) {
  return HOST_TOKENS.filter((t) => readFileSync(file, "utf8").toLowerCase().includes(t));
}

test("规则1：impl 不得 import 注册表 / 编排 / core 契约", () => {
  const forbidden = [
    /from "\.\.\/registry"/,
    /from "\.\.\/dispatch"/,
    /from "\.\.\/main"/,
    /from "\.\.\/locations"/,
    /from "\.\.\/\.\.\/core\/contract"/,
    /from "\.\.\/\.\.\/core\/init"/,
  ];
  const offenders = [];
  for (const file of walk(IMPL)) {
    const text = readFileSync(file, "utf8");
    for (const re of forbidden) {
      if (re.test(text)) offenders.push(`${relative(PKG, file)} -> ${re}`);
    }
    // 一个 impl 不得 import 另一个 impl（共用部分提到 impl/shared）
    const dirs = readdirSync(IMPL, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "shared")
      .map((d) => d.name);
    for (const d of dirs) {
      if (new RegExp(`from "\\.\\./${d}(/|")`).test(text)) {
        offenders.push(`${relative(PKG, file)} -> 跨 impl 引用 ${d}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `分层越界：\n${offenders.join("\n")}`);
});

test("规则2：core 目录内不出现宿主名", () => {
  const offenders = walk(join(SRC, "core"))
    .map((f) => ({ f: relative(PKG, f), hits: labels(f) }))
    .filter((x) => x.hits.length > 0)
    .map((x) => `${x.f}: ${x.hits.join(", ")}`);
  assert.deepEqual(offenders, [], `core 里出现了宿主名：\n${offenders.join("\n")}`);
});

test("规则3：顶层（impl 之外）不出现宿主名", () => {
  const offenders = walk(SRC)
    .filter((f) => !f.startsWith(IMPL + sep))
    .map((f) => ({ f: relative(PKG, f), hits: labels(f) }))
    .filter((x) => x.hits.length > 0)
    .map((x) => `${x.f}: ${x.hits.join(", ")}`);
  assert.deepEqual(
    offenders,
    [],
    `宿主名泄漏到 impl 之外：\n${offenders.join("\n")}\n` +
      "宿主差异只允许出现在 src/agent/impl/ 下；接口与注册表按能力分支，不按 id 分支。",
  );
});

test("规则4：impl 清单与目录一一对应，且 id 等于目录名", () => {
  const manifest = readFileSync(join(IMPL, "manifest.ts"), "utf8");
  const listed = [...manifest.matchAll(/^\s{2}"?([a-z0-9-]+)"?:\s*\(\)/gm)].map((m) => m[1]);
  const onDisk = readdirSync(IMPL, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "shared")
    .map((d) => d.name)
    .sort();

  assert.deepEqual([...listed].sort(), onDisk, "manifest 与 impl 目录不一致");

  const registry = require("../dist/agent/registry");
  for (const id of listed) {
    const impl = registry.byId(id);
    assert.ok(impl, `注册表查不到 ${id}`);
    assert.equal(impl.id, id, `${id} 的 impl.id 必须等于目录名`);
    assert.equal(registry.normalize(id), id, `normalize(${id}) 必须幂等`);
    for (const alias of impl.aliases) {
      assert.equal(registry.normalize(alias), id, `${id} 的别名 ${alias} 必须能归一回来`);
    }
  }

  const falls = registry.all().filter((impl) => impl.fallback);
  assert.equal(falls.length, 1, "兜底 impl 必须恰好一个");
});

test("规则4：未知 id 返回 null 而不是抛，也不静默回落", () => {
  const registry = require("../dist/agent/registry");
  assert.equal(registry.byId("definitely-not-a-host"), null);
  assert.equal(registry.normalize("definitely-not-a-host"), null);
  assert.equal(registry.normalize("  "), null);
  assert.equal(registry.normalize("Claude Code"), "claude-code");
  assert.equal(registry.workerByKey("nope"), null);
});

test("能力矩阵由 facet 推导，缺 facet 即缺能力", () => {
  const registry = require("../dist/agent/registry");
  const { deriveCapabilities } = require("../dist/agent/contract");
  for (const impl of registry.all()) {
    const caps = deriveCapabilities(impl);
    assert.equal(caps.install, impl.install !== undefined, `${impl.id}: install 能力与 facet 不一致`);
    assert.equal(caps.workerLaunch, impl.worker !== undefined, `${impl.id}: worker 能力与 facet 不一致`);
    assert.equal(caps.workspacePrepare, impl.workspace !== undefined, `${impl.id}: workspace 能力与 facet 不一致`);
    assert.equal(caps.hookBlock, true, `${impl.id}: hook 是必选 facet`);
  }
});

test("事件映射快照：全部 impl 的原生事件映射逐条不变", () => {
  const registry = require("../dist/agent/registry");
  const expected = {
    PreToolUse: "on_action",
    UserPromptSubmit: "on_idle",
    SessionStart: "on_start",
    SessionEnd: "on_start",
    Stop: "on_stop",
    SubagentStop: "on_stop",
    PreCompact: "on_compact",
    PostCompact: "on_compact",
    Notification: "on_start",
    on_action: "on_action",
    action: "on_action",
    unknown: null,
    PostToolUse: null,
  };

  for (const impl of registry.all()) {
    for (const [native, point] of Object.entries(expected)) {
      assert.equal(
        impl.hook.pointFor(native),
        point,
        `${impl.id}: ${native} 的映射变了（期望 ${point ?? "不处理"}）`,
      );
    }
  }
});

test("注入 / 拒绝能力就在 impl 里声明，不靠顶层按 id 判断", () => {
  const registry = require("../dist/agent/registry");
  // 结构化拒绝的 impl 必须真的输出 JSON；退化为退出码的必须真的给 2。
  for (const impl of registry.all()) {
    const d = impl.hook.deny("test-reason", "on_action", "s1");
    if (impl.hook.structuredDeny) {
      assert.equal(d.code, 0, `${impl.id}: 结构化拒绝不该用非零退出码`);
      assert.ok(d.stdout && d.stdout.includes("test-reason"), `${impl.id}: 结构化拒绝要把理由带回去`);
    } else {
      assert.equal(d.code, 2, `${impl.id}: 无结构化输出时必须用退出码 2 阻断`);
    }
  }
});
