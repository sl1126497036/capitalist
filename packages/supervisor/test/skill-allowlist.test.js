/**
 * 技能目录只读许可：分类口径与路径口径。
 *
 * 这组用例只用 `localCheck`，不起 hook 进程；技能根用临时目录构造，不读本机真实技能。
 * 临时目录不清理（本机安全策略会拦删除），留给系统回收。
 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { localCheck } = require(join(PKG, "dist/core/guard/localGuard.js"));
const { skillAllowRoots } = require(join(PKG, "dist/supervisor/skills.js"));

/** 只带本机边界配置的最小契约。 */
function contract(extra = {}) {
  return { name: "白名单测试", localGuard: { allow_roots: [], ...extra } };
}

function sandbox(name) {
  const base = mkdtempSync(join(tmpdir(), `capitalist-skillallow-${name}-`));
  /* 项目根与技能目录分开：技能在任务根之外，才是被拦截的那种情形。 */
  const root = join(base, "project");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(base, "skills", "wording-guard"), { recursive: true });
  writeFileSync(join(base, "skills", "wording-guard", "SKILL.md"), "# 规范\n");
  writeFileSync(join(base, "skills", "wording-guard", "rules.md"), "要点\n");
  /* 插件缓存：一个真技能包，一个同层其它插件。 */
  mkdirSync(join(base, "cache", "market", "skill-good", "1.0.0"), { recursive: true });
  writeFileSync(join(base, "cache", "market", "skill-good", "1.0.0", "SKILL.md"), "# 技能\n");
  mkdirSync(join(base, "cache", "market", "connector-x"), { recursive: true });
  writeFileSync(join(base, "cache", "market", "connector-x", "README.md"), "不是技能\n");
  return { base, root };
}

const extraOf = (base) => ({ skillRoots: [join(base, "skills")], skillCacheRoots: [join(base, "cache")] });

test("技能目录内的读取放行", () => {
  const { base, root } = sandbox("read");
  const res = localCheck(contract(), root, [join(base, "skills", "wording-guard", "SKILL.md")], "read", extraOf(base));
  assert.strictEqual(res.decision, "allow");
});

test("技能目录内的写入仍按越界申请", () => {
  const { base, root } = sandbox("write");
  const res = localCheck(contract(), root, [join(base, "skills", "wording-guard", "rules.md")], "write", extraOf(base));
  assert.strictEqual(res.decision, "justify", "技能是资料，不是可写区");
});

test("技能目录内命中敏感文件名：仍拒绝，只读许可不能绕过凭据判定", () => {
  const { base, root } = sandbox("env");
  const env = join(base, "skills", "wording-guard", ".env");
  writeFileSync(env, "SECRET=1\n");
  const res = localCheck(
    contract({ sensitive_names: [".env"] }),
    root,
    [env],
    "read",
    extraOf(base),
  );
  assert.strictEqual(res.decision, "deny");
});

test("技能目录内的凭据文件：只读许可不放行，契约未配敏感名时同样不放行", () => {
  const { base, root } = sandbox("hardsecret");
  const env = join(base, "skills", "wording-guard", ".env");
  writeFileSync(env, "SECRET=1\n");
  const key = join(base, "skills", "wording-guard", "server.pem");
  writeFileSync(key, "-----BEGIN-----\n");
  /* 契约只开启只读许可，不列敏感名：由许可自身的内置规则拦截。 */
  const cfg = contract();
  assert.strictEqual(localCheck(cfg, root, [env], "read", extraOf(base)).decision, "justify");
  assert.strictEqual(localCheck(cfg, root, [key], "read", extraOf(base)).decision, "justify");
});

test("技能目录之外的文件：仍走越界申请", () => {
  const { base, root } = sandbox("outside");
  const other = join(base, "elsewhere", "note.md");
  const res = localCheck(contract(), root, [other], "read", extraOf(base));
  assert.strictEqual(res.decision, "justify");
});

test("插件缓存：技能包内放行，同层其它插件不放行", () => {
  const { base, root } = sandbox("cache");
  const inside = localCheck(
    contract(),
    root,
    [join(base, "cache", "market", "skill-good", "1.0.0", "SKILL.md")],
    "read",
    extraOf(base),
  );
  assert.strictEqual(inside.decision, "allow");

  const outside = localCheck(
    contract(),
    root,
    [join(base, "cache", "market", "connector-x", "README.md")],
    "read",
    extraOf(base),
  );
  assert.strictEqual(outside.decision, "justify", "缓存目录不整目录放行");
});

test("契约里关闭技能只读许可：读取转为越界申请", () => {
  const { base, root } = sandbox("off");
  const res = localCheck(
    contract({ allow_read_skills: false }),
    root,
    [join(base, "skills", "wording-guard", "SKILL.md")],
    "read",
    extraOf(base),
  );
  assert.strictEqual(res.decision, "justify");
});

test("显式路径口径：只对读生效", () => {
  const { base, root } = sandbox("paths");
  const doc = join(base, "docs", "spec.md");
  mkdirSync(join(base, "docs"), { recursive: true });
  writeFileSync(doc, "资料\n");
  const cfg = contract({ allow_read_paths: [join(base, "docs")] });

  assert.strictEqual(localCheck(cfg, root, [doc], "read").decision, "allow");
  assert.strictEqual(localCheck(cfg, root, [doc], "write").decision, "justify");
});

test("技能根覆盖三个宿主，且含用户家家目录下的技能目录", () => {
  const r = skillAllowRoots("/tmp/some-root");
  const all = [...r.skills, ...r.cache].map((p) => p.replace(/\\/g, "/"));
  for (const host of [".claude", ".codebuddy", ".workbuddy"]) {
    assert.ok(
      all.some((p) => p.endsWith(`/${host}/skills`)),
      `缺少宿主的技能目录：${host}`,
    );
    assert.ok(
      all.some((p) => p.includes(`/${host}/plugins/cache`)),
      `缺少宿主的插件缓存：${host}`,
    );
  }
  assert.ok(
    r.skills.some((p) => p.startsWith("/tmp/some-root/")),
    "项目级技能目录要按任务根展开",
  );
});
