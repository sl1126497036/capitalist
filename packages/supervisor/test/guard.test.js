/** 判定核心的回归测试：路径抽取、本机边界、红线、阶段检查。 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { extractLocalPaths, localCheck, extractDeleteArgs, detectAction } = require("../dist/core/guard/localGuard");
const { evaluate, loadContract, nextStageId, isLastStage, stageIds } = require("../dist/core/contract/contract");
const { runCheck } = require("../dist/core/contract/checks");

const ROOT = join(tmpdir(), "capitalist-guard-root");
const minimal = loadContract("minimal");

function tmpRoot() {
  const dir = mkdtempSync(join(tmpdir(), "capitalist-guard-"));
  mkdirSync(join(dir, ".capitalist"), { recursive: true });
  return dir;
}


test("POSIX 绝对路径能抽出来（曾经抽不出，导致 /etc 与 /var/log 从未生效）", () => {
  assert.deepEqual(extractLocalPaths("cat /etc/passwd", ROOT), ["/etc/passwd"]);
  assert.deepEqual(extractLocalPaths("rm -rf /var/log/app", ROOT), ["/var/log/app"]);
  assert.deepEqual(extractLocalPaths("--path=/usr/share/x", ROOT), ["/usr/share/x"]);
});

test("家目录写法保持原样，交给 normLocal 展开", () => {
  assert.deepEqual(extractLocalPaths("cat ~/.ssh/config", ROOT), ["~/.ssh/config"]);
  assert.deepEqual(extractLocalPaths("cat ~\\AppData\\x", ROOT), ["~\\AppData\\x"]);
});

test("Windows 盘符路径仍然能抽出来（不要把已有能力改坏）", () => {
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


test("敏感路径按 POSIX 写法命中（/etc / /var/log 是契约里真实存在的配置项）", () => {
  const hit = localCheck(minimal, ROOT, ["/etc/passwd"], "read");
  assert.equal(hit.decision, "deny");
});

test("~/.ssh 下的普通文件也拦（不靠文件名兜底）", () => {
  // `id_rsa` 会在 sensitive_names 里命中；`config` 不在，只能靠 sensitive_paths 判定
  const hit = localCheck(minimal, ROOT, ["~/.ssh/config"], "read");
  assert.equal(hit.decision, "deny");
});

test("任务根以内放行，根外要理由", () => {
  const inside = localCheck(minimal, ROOT, [join(ROOT, "docs", "a.md")], "read");
  assert.equal(inside.decision, "allow");

  const outside = localCheck(minimal, ROOT, [join(ROOT, "..", "elsewhere", "a.md")], "read");
  assert.equal(outside.decision, "justify");
});

test("删除不许出任务根", () => {
  const outside = localCheck(minimal, ROOT, ["/tmp/other"], "delete");
  assert.equal(outside.decision, "deny");
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


test("mtime_after_stage：缺时间字段时回落 created_at，而不是永远失败", () => {
  const root = tmpRoot();
  const file = join(root, "memory.md");
  writeFileSync(file, "x", "utf8");

  // 只有 created_at（老任务根 / 手工建根）
  writeFileSync(
    join(root, ".capitalist", "state.json"),
    JSON.stringify({ stage: "S5", created_at: new Date(Date.now() - 60_000).toISOString() }),
  );
  assert.equal(runCheck({ type: "mtime_after_stage", path: "memory.md" }, root).ok, true);

  // 阶段在本文件上次修改之后才进入 -> 没更新过
  writeFileSync(
    join(root, ".capitalist", "state.json"),
    JSON.stringify({ stage: "S5", stage_entered_at_ts: Math.floor(Date.now() / 1000) + 60 }),
  );
  assert.equal(runCheck({ type: "mtime_after_stage", path: "memory.md" }, root).ok, false);
});

test("mtime_after_stage：完全没有时间字段时说明原因，不假装已满足", () => {
  const root = tmpRoot();
  writeFileSync(join(root, "memory.md"), "x", "utf8");
  writeFileSync(join(root, ".capitalist", "state.json"), JSON.stringify({ stage: "S5" }));
  const r = runCheck({ type: "mtime_after_stage", path: "memory.md" }, root);
  assert.equal(r.ok, false);
  assert.match(r.missing[0], /读不到阶段进入时间/);
});

test("未知检查类型 fail closed", () => {
  const r = runCheck({ type: "no_such_check" }, tmpRoot());
  assert.equal(r.ok, false);
  assert.match(r.missing[0], /未知检查类型/);
});

test("script 检查明确报未实现，而不是静默通过", () => {
  const r = runCheck({ type: "script", cmd: "exit 0" }, tmpRoot());
  assert.equal(r.ok, false);
  assert.match(r.missing[0], /未在 TS 版实现/);
});


/** 写一份量测报告到任务根下的相对路径，返回任务根。 */
function reportRoot(rel, value) {
  const root = tmpRoot();
  const file = join(root, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value), "utf8");
  return root;
}

const VISUAL = { header: 88, leftColumn: 322, radialLayers: 4, hasAddRoot: false, scale: 1.25 };

test("report_assert：一组断言全满足才 pass", () => {
  const root = reportRoot(".workbuddy/reports/visual-audit.json", VISUAL);
  const r = runCheck(
    {
      type: "report_assert",
      file: ".workbuddy/reports/visual-audit.json",
      assert: [
        { path: "header", op: "near", value: 88, tol: 1 },
        { path: "leftColumn", op: "equals", value: 322 },
        { path: "radialLayers", op: "near", value: 4 },
        { path: "hasAddRoot", op: "falsy" },
        { path: "scale", op: "min", value: 1 },
        { path: "scale", op: "max", value: 2 },
      ],
    },
    root,
  );
  assert.deepEqual(r, { ok: true, missing: [] });
});

test("report_assert：数值不符时 missing 里同时有字段名、期望值与实际值", () => {
  const root = reportRoot(".workbuddy/reports/visual-audit.json", VISUAL);
  const r = runCheck(
    {
      type: "report_assert",
      file: ".workbuddy/reports/visual-audit.json",
      // 只错一条，也要把这一条单独列出来：一版实现可能只差一处，报告要指出差在哪。
      assert: [
        { path: "header", op: "near", value: 999, tol: 1 },
        { path: "leftColumn", op: "equals", value: 322 },
      ],
    },
    root,
  );
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 1);
  assert.match(r.missing[0], /header/);
  assert.match(r.missing[0], /999/);
  assert.match(r.missing[0], /88/);
});

test("report_assert：缺字段、非数值、未知断言类型都 fail closed", () => {
  const root = reportRoot(".workbuddy/reports/visual-audit.json", VISUAL);
  const spec = (assertion) => ({ type: "report_assert", file: ".workbuddy/reports/visual-audit.json", assert: [assertion] });

  const missing = runCheck(spec({ path: "metrics", op: "near", value: 140 }), root);
  assert.equal(missing.ok, false);
  assert.match(missing.missing[0], /实际 缺失/);

  // 报告里写的是字符串 "88"，equals 88 必须判不等（严格相等）
  const stringy = runCheck(spec({ path: "leftColumn", op: "equals", value: "322" }), root);
  assert.equal(stringy.ok, false);

  const notNumber = runCheck(spec({ path: "hasAddRoot", op: "min", value: 0 }), root);
  assert.equal(notNumber.ok, false);
  assert.match(notNumber.missing[0], /不是数值/);

  /* `lte` 是 `max` 的别名，已支持；此处用一个无法识别的词验证 fail closed。 */
  const unknown = runCheck(spec({ path: "header", op: "between", value: 88 }), root);
  assert.equal(unknown.ok, false);
  assert.match(unknown.missing[0], /未知断言类型/);
});

test("report_assert：只有空断言或读不到报告时不判通过", () => {
  const root = tmpRoot();
  assert.equal(runCheck({ type: "report_assert", file: "nope.json", assert: [] }, root).ok, false);
  assert.equal(runCheck({ type: "report_assert", file: "nope.json", assert: "header" }, root).ok, false);
  const r = runCheck({ type: "report_assert", file: "nope.json", assert: [{ path: "header", op: "near", value: 88 }] }, root);
  assert.equal(r.ok, false);
  assert.match(r.missing[0], /不存在或不是合法 JSON/);
});

test("report_assert：路径允许 .capitalist/ 前缀与直接路径两种写法", () => {
  const root = tmpRoot();
  writeFileSync(join(root, ".capitalist", "audit.json"), JSON.stringify({ header: 88 }), "utf8");

  // 直接写 .capitalist/...：resolveListFile 先试 .capitalist/.capitalist/... 再回落任务根，两种都命中同一份
  assert.equal(
    runCheck({ type: "report_assert", file: ".capitalist/audit.json", assert: [{ path: "header", op: "equals", value: 88 }] }, root).ok,
    true,
  );
  // 只写文件名：命中 .capitalist/<name>（record 的落点）
  assert.equal(
    runCheck({ type: "report_assert", file: "audit.json", assert: [{ path: "header", op: "equals", value: 88 }] }, root).ok,
    true,
  );
});


test("阶段按契约数组顺序推进，末阶段不再前进", () => {
  assert.deepEqual(stageIds(minimal), ["S0", "S1", "S2"]);
  assert.equal(nextStageId(minimal, "S0"), "S1");
  assert.equal(nextStageId(minimal, "S1"), "S2");
  assert.equal(nextStageId(minimal, "S2"), "S2");
  assert.equal(isLastStage(minimal, "S2"), true);
  assert.equal(isLastStage(minimal, "S0"), false);
});
