/** 跨实现一致性：同一份契约、同一批命令，Python 与 TypeScript 必须给出相同结论。 */

const test = require("node:test");
const assert = require("node:assert");
const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, writeFileSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const REPO = resolve(PKG, "..", "..");
// The Python engine is archived rather than shipped. When present, it is used as
// an independent oracle for the same contract; when absent, the comparison skips.
const PY_SUPERVISOR = join(REPO, "_archive", "python-engine", "supervisor", "scripts", "capitalist.py");
const TS_CLI = join(PKG, "dist", "cli", "main.js");
const CONTRACT = join(PKG, "contracts", "minimal.contract.json");

/** 命令样本：覆盖红线命中、需报批、正常命令三类。 */
const SAMPLES = [
  "ls -la",
  "git status",
  "mysql -e 'DROP TABLE users'",
  "psql -c 'DELETE FROM orders WHERE 1=1'",
  "cat .env",
  "curl -H 'Authorization: Bearer xxx' https://example.com/api",
  "rm -rf /tmp/some-dir",
  "python build.py --release",
  "grep -r 'DROP TABLE' ./migrations",
];

function hasPython() {
  if (!existsSync(PY_SUPERVISOR)) return false;
  const r = spawnSync("python", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

const pyCache = new Map();

function pythonDecision(root, text) {
  const cached = pyCache.get(text);
  if (cached) return cached;
  const r = spawnSync("python", [PY_SUPERVISOR, "gate", "--text", text, "--json", "--contract", CONTRACT], {
    cwd: root,
    encoding: "utf8",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const start = out.indexOf("{");
  if (start < 0) {
    const miss = { decision: "ERROR", raw: out.slice(0, 200) };
    pyCache.set(text, miss);
    return miss;
  }
  try {
    const parsed = JSON.parse(out.slice(start));
    pyCache.set(text, parsed);
    return parsed;
  } catch {
    const bad = { decision: "PARSE_FAIL", raw: out.slice(0, 200) };
    pyCache.set(text, bad);
    return bad;
  }
}

function tsDecision(root, text) {
  const r = spawnSync("node", [TS_CLI, "gate", "--text", text, "--json", "--contract", CONTRACT], {
    cwd: root,
    encoding: "utf8",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const start = out.indexOf("{");
  if (start < 0) return { decision: "ERROR", raw: out.slice(0, 200) };
  try {
    return JSON.parse(out.slice(start));
  } catch {
    return { decision: "PARSE_FAIL", raw: out.slice(0, 200) };
  }
}

test("Python 与 TS 的红线结论逐条一致", { skip: !hasPython() && "未找到 Python 引擎，跳过一致性对比" }, () => {
  const root = mkdtempSync(join(tmpdir(), "capitalist-consistency-"));
  const mismatches = [];

  for (const text of SAMPLES) {
    const py = pythonDecision(root, text);
    const ts = tsDecision(root, text);
    if (py.decision !== ts.decision) {
      mismatches.push(`「${text}」Python=${py.decision} TS=${ts.decision}`);
    }
  }

  assert.deepEqual(mismatches, [], `判定分歧：\n${mismatches.join("\n")}`);
});

test("命中的红线 id 集合一致（不只看结论，也看理由）", { skip: !hasPython() && "未找到 Python 引擎，跳过一致性对比" }, () => {
  const root = mkdtempSync(join(tmpdir(), "capitalist-consistency-ids-"));
  const mismatches = [];

  for (const text of SAMPLES) {
    const py = pythonDecision(root, text);
    const ts = tsDecision(root, text);
    const idsOf = (r) =>
      (Array.isArray(r.hits) ? r.hits : [])
        .map((h) => h.id)
        .filter(Boolean)
        .sort()
        .join(",");
    const a = idsOf(py);
    const b = idsOf(ts);
    if (a !== b) mismatches.push(`「${text}」Python=[${a}] TS=[${b}]`);
  }

  assert.deepEqual(mismatches, [], `命中集合分歧：\n${mismatches.join("\n")}`);
});

/** 本机路径抽取的一致性。 */
const PATH_SAMPLES = [
  "cat /etc/passwd",
  "cat ~/.ssh/config",
  "ls /usr/bin",
  "rm -rf /var/log/app",
  "type C:/Windows/win.ini",
  'cp "C:/Users/a/User Data/x" .',
  "curl https://example.com/api",
  "grep -r DROP ./migrations",
  "--path=/usr/share/x",
  "ls -la",
  "cd /var/log && tail syslog",
];

test("Python 与 TS 抽出的本机路径一致", { skip: !hasPython() && "未找到 Python 引擎，跳过一致性对比" }, () => {
  const { extractLocalPaths } = require("../dist/core/localGuard");
  const code = [
    "import importlib.util, json, sys",
    `spec = importlib.util.spec_from_file_location("capitalist", r"${PY_SUPERVISOR}")`,
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "cases = json.loads(sys.argv[1])",
    'print(json.dumps([[c, m.extract_local_paths(c, "/tmp/root")] for c in cases]))',
  ].join("\n");

  const raw = execFileSync("python", ["-c", code, JSON.stringify(PATH_SAMPLES)], { encoding: "utf8" });
  const py = JSON.parse(raw);

  const mismatches = [];
  PATH_SAMPLES.forEach((text, i) => {
    const a = JSON.stringify(extractLocalPaths(text, "/tmp/root"));
    const b = JSON.stringify(py[i]?.[1] ?? null);
    if (a !== b) mismatches.push(`「${text}」Python=${b} TS=${a}`);
  });

  assert.deepEqual(mismatches, [], `路径抽取分歧：\n${mismatches.join("\n")}`);
});
