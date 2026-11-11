/**
 * 登记通道的免检识别。
 *
 * `justify` 是解除本机边界的唯一入口，它自己必须先过边界判定，否则“要放行必须先放行”，
 * 登记通道无法使用。识别过宽会让任意命令借 `justify` 字样绕过边界，过窄会让登记动作被
 * 自己要解除的规则拦住，两个方向都有代价，因此逐形态固定用例。
 */

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { isJustifyInvocation } = require("../dist/agent/dispatch");

/** 应当免检的形态：都是本命令行入口后紧跟 `justify`。 */
const ALLOWED = [
  'capitalist justify "/etc/hosts" "核对解析"',
  'cap justify "/etc/hosts" "核对解析"',
  'capitalist.js justify x y',
  'npx capitalist justify "/etc/hosts" r',
  'node packages/supervisor/dist/cli/main.js justify "/etc/hosts" r',
  'node /abs/path/dist/cli/main.js justify x r',
  'rm -rf /tmp/a && capitalist justify /tmp/a "清理临时目录"',
  'cd /tmp; capitalist justify /tmp/x r',
  'CAPITALIST_ROOT=/tmp capitalist justify /tmp/x r',
];

/** 不应免检的形态：不是登记动作，或入口不是本命令行。 */
const DENIED = [
  "",
  "git status",
  "capitalist status",
  'capitalist justify-x "/etc/hosts" r',
  'echo "capitalist justify /etc/hosts r"',
  "cat notes.txt | grep justify",
  'node -e "console.log(1)" justify',
  'node /other/project/main.js justify x y',
  'python justify.py "/etc/hosts"',
  "capitall justify x y",
];

test("登记动作的免检识别：应当放行的形态", () => {
  for (const cmd of ALLOWED) {
    assert.equal(isJustifyInvocation(cmd), true, `应识别为登记动作：${cmd}`);
  }
});

test("登记动作的免检识别：不应放行的形态", () => {
  for (const cmd of DENIED) {
    assert.equal(isJustifyInvocation(cmd), false, `不应识别为登记动作：${cmd}`);
  }
});

test("登记动作的免检识别：引号内的分隔符不切段", () => {
  /* 理由里带 `;` 的常见写法，切段失败会退化成“找不到 justify”。 */
  assert.equal(isJustifyInvocation('capitalist justify "/tmp/a" "先备份；再删除"'), true);
});

test("登记动作的免检识别：同包的绝对路径入口", () => {
  const own = join(__dirname, "..", "dist", "cli", "main.js");
  assert.equal(isJustifyInvocation(`node "${own}" justify /tmp/x r`), true);
});

test("登记输出：不谎报已经入队", () => {
  /* 登记只写理由文件；入队发生在越界命令真的放行那一刻，两件事不能混成一句。 */
  const root = mkdtempSync(join(tmpdir(), "capitalist-justify-"));
  mkdirSync(join(root, ".capitalist"), { recursive: true });
  const r = spawnSync(
    process.execPath,
    [join(__dirname, "..", "dist", "cli", "main.js"), "justify", "/tmp/probe-path", "核对文案", "--root", root],
    { encoding: "utf8" },
  );
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 0, `登记应当成功：${out}`);
  assert.ok(out.includes("放行时记入待复核队列"), `要说明入队时机：${out}`);
  assert.ok(!out.includes("已排入"), `不能写成已经入队：${out}`);
});
