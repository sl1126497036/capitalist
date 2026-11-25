/** 判定核心的回归测试：路径抽取、本机边界、红线。 */

const test = require("node:test");
const assert = require("node:assert");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { extractLocalPaths, localCheck, extractDeleteArgs, detectAction, normLocal } = require("../dist/core/guard/localGuard");
const { evaluate, loadPolicy } = require("../dist/core/policy/policy");

const ROOT = join(tmpdir(), "capitalist-guard-root");
const minimal = loadPolicy("minimal");

test("POSIX 绝对路径可被提取，使 /etc 与 /var/log 配置项生效", () => {
  assert.deepEqual(extractLocalPaths("cat /etc/passwd", ROOT), ["/etc/passwd"]);
  assert.deepEqual(extractLocalPaths("rm -rf /var/log/app", ROOT), ["/var/log/app"]);
  assert.deepEqual(extractLocalPaths("--path=/usr/share/x", ROOT), ["/usr/share/x"]);
});

test("家目录写法保持原样，交给 normLocal 展开", () => {
  assert.deepEqual(extractLocalPaths("cat ~/.ssh/config", ROOT), ["~/.ssh/config"]);
  assert.deepEqual(extractLocalPaths("cat ~\\AppData\\x", ROOT), ["~\\AppData\\x"]);
});

test("Windows 盘符路径仍然能抽出来（保持既有能力不回退）", () => {
  assert.deepEqual(extractLocalPaths("type C:\\Windows\\win.ini", ROOT), ["C:\\Windows\\win.ini"]);
  assert.deepEqual(extractLocalPaths("type C:/Windows/win.ini", ROOT), ["C:/Windows/win.ini"]);
});

test("引号里的带空格路径整体取出，不被空白截断", () => {
  assert.deepEqual(extractLocalPaths('cp "C:/Users/a/User Data/x" .', ROOT), [
    "C:/Users/a/User Data/x",
  ]);
});

test("URL 里的路径不算本机路径", () => {
  assert.deepEqual(extractLocalPaths("curl https://example.com/api", ROOT), []);
  assert.deepEqual(extractLocalPaths("git clone https://g.com/a/b.git /tmp/x", ROOT), ["/tmp/x"]);
});

test("没有路径的命令不产生路径", () => {
  assert.deepEqual(extractLocalPaths("ls -la", ROOT), []);
  assert.deepEqual(extractLocalPaths("git status", ROOT), []);
  // 相对路径不在这一层抽（与 Python 版一致）：它落在任务根内，本就放行；
  // 删除场景由 extractDeleteArgs 单独判，不靠这里
  assert.deepEqual(extractLocalPaths("grep -r 'DROP TABLE' ./migrations", ROOT), []);
});

test("敏感路径按 POSIX 写法命中（/etc / /var/log 是守卫里真实存在的配置项）", () => {
  const hit = localCheck(minimal, ROOT, ["/etc/passwd"], "read");
  assert.equal(hit.decision, "deny");
});

test("~/.ssh 下的普通文件也会被拦截（不靠文件名判断）", () => {
  // `id_rsa` 会在 sensitive_names 里命中；`config` 不在，只能靠 sensitive_paths 判定
  const hit = localCheck(minimal, ROOT, ["~/.ssh/config"], "read");
  assert.equal(hit.decision, "deny");
});

test("任务根以内放行，根外要理由", () => {
  const inside = localCheck(minimal, ROOT, [join(ROOT, "docs", "a.md")], "read");
  assert.equal(inside.decision, "allow");

  // 命令原文里的 .. 不会经过 path.join，这里用字符串拼接还原真实输入形态
  const outside = localCheck(minimal, ROOT, [`${ROOT}/../elsewhere/a.md`], "read");
  assert.equal(outside.decision, "justify");
});

test("含 .. 的绝对路径按消点后的位置判定，不能靠字符串前缀蒙过边界", () => {
  const escape = `${ROOT}/../../../etc/passwd`;
  const hit = localCheck(minimal, ROOT, [escape], "read");
  assert.notEqual(hit.decision, "allow", "穿越到任务根以外必须拦截");
  assert.ok(!normLocal(escape, ROOT).includes(".."), "归一后不应残留 ..");

  const stay = localCheck(minimal, ROOT, [`${ROOT}/docs/../a.md`], "read");
  assert.equal(stay.decision, "allow", "消点不能把根内路径误判成越界");
});

test("sensitive_globs 生效：通配的凭据类型按文件名判定", () => {
  // minimal 的 local_guard 把 *.pem / *.key 写在 sensitive_globs，两处判定同源
  const outside = localCheck(minimal, ROOT, ["/tmp/x/server.pem"], "read");
  assert.equal(outside.decision, "deny");
  assert.ok(outside.hits.some((h) => h.why.includes("*.pem")));

  const inside = localCheck(minimal, ROOT, [join(ROOT, "server.pem")], "read");
  assert.equal(inside.decision, "justify", "根内凭据转申请，不直接拒");
});

test("根外删除转申请，不直接拒绝也不直接批准", () => {
  const outside = localCheck(minimal, ROOT, ["/tmp/other"], "delete");
  /* 根外删除由监工裁决：本层只标出需要申请，批准判据在 core/guard/requests。 */
  assert.equal(outside.decision, "justify");
});

test("删除目标不确定时拒绝：通配符与缺失目标语义不同，但都不放行", () => {
  assert.equal(extractDeleteArgs("rm -rf *").unsafe, true);
  assert.deepEqual(extractDeleteArgs("rm -rf").targets, []);
  assert.equal(detectAction("rm -rf a"), "delete");
  assert.equal(detectAction("echo hi > a.txt"), "write");
  assert.equal(detectAction("ls"), "read");
});

test("脚本删除 API 也能抽出目标（否则理由会错成“没给出目标”）", () => {
  assert.deepEqual(extractDeleteArgs("python -c \"shutil.rmtree('/home/user')\"").targets, [
    "/home/user",
  ]);
  assert.deepEqual(extractDeleteArgs("python3 -c 'import os; os.remove(\"/etc/x\")'").targets, [
    "/etc/x",
  ]);
  // 真实路径里的括号不能被截短：截短的方向是“看起来在任务根内”，那是漏判
  assert.deepEqual(extractDeleteArgs("rm -rf a)b").targets, ["a)b"]);
});

test("红线取最严：BLOCK 压过 NEED_USER", () => {
  const r = evaluate(minimal, "mysql -e 'DROP TABLE users' ; cat .env");
  assert.equal(r.decision, "BLOCK");
  assert.ok(r.hits.length >= 2);
});

test("带 defer 的红线不参与最严计算（删除放行与否交给路径判定）", () => {
  const r = evaluate(minimal, "rm -rf /tmp/x");
  const del = r.hits.find((h) => h.id === "DEL-LOCALSHELL");
  assert.ok(del, "应当认出这是删除命令");
  assert.equal(del.defer, "local_delete");
  assert.equal(r.decision, "PASS", "defer 命中不能直接算 BLOCK，否则路径判定被架空");
});

test("skip_if 让只读检索不误判", () => {
  assert.equal(evaluate(minimal, "grep -r 'DROP TABLE' ./migrations").decision, "PASS");
  assert.equal(evaluate(minimal, "mysql -e 'DROP TABLE t'").decision, "BLOCK");
});
