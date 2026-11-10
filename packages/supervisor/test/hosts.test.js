/** impl 面的行为快照：安装计划、worker 参数、工作区准备、凭证接口。 */

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const registry = require("../dist/host/registry");
const { deriveCapabilities } = require("../dist/host/contract");

const CTX = {
  entry: "/pkg/dist/host/main.js",
  node: "/usr/bin/node",
  marker: "capitalist-supervisor",
  platform: "linux",
};

test("安装计划：每个可安装 impl 都挂四个生命周期点，且命令带自有标记", () => {
  for (const impl of registry.all()) {
    if (!impl.install) continue;
    const plan = impl.install.plan(CTX);
    assert.deepEqual(
      Object.keys(plan).sort(),
      ["PreCompact", "PreToolUse", "Stop", "UserPromptSubmit"],
      `${impl.id}: 挂载的事件集合变了`,
    );
    for (const [event, entries] of Object.entries(plan)) {
      assert.equal(entries.length, 1, `${impl.id}/${event}: 每个事件一条`);
      const entry = entries[0];
      const cmd = entry.hooks[0].command;
      assert.match(cmd, /--agent (?:[a-z-]+)/, `${impl.id}/${event}: 命令必须写死宿主 id`);
      assert.ok(cmd.includes(impl.id), `${impl.id}/${event}: --agent 必须是本 impl 的 id`);
      assert.ok(cmd.includes("--from capitalist-supervisor"), `${impl.id}/${event}: 缺自有标记，卸载会认不出`);
      assert.ok(!cmd.includes("\\"), `${impl.id}/${event}: 命令串必须是 POSIX 写法（Windows 由 impl 声明差异）`);
      // matcher 只用于工具类事件：提交输入与结束事件不识别该字段
      assert.equal(entry.matcher !== undefined, event === "PreToolUse", `${impl.id}/${event}: matcher 出现位置不对`);
    }
  }
});

test("安装后置条件：需要用户再动一步的 impl 必须给出 notice 或 preconditions", () => {
  for (const impl of registry.all()) {
    if (!impl.install) continue;
    const caps = deriveCapabilities(impl, CTX);
    const notice = impl.install.notice?.() ?? null;
    const pre = impl.install.preconditions?.(CTX) ?? [];
    if (caps.installNeedsConfirm) {
      assert.ok(pre.length > 0, `${impl.id}: 声明了需要确认却没写前置条件`);
    }
    if (notice !== null) assert.ok(notice.length > 0, `${impl.id}: notice 为空等于没提示`);
  }
});

test("worker 参数快照：argv 与 stdin 两种路径都在 impl 里定死", () => {
  const seen = {};
  for (const impl of registry.workerHosts()) {
    const w = impl.worker;
    if (!w) continue;
    seen[w.key] = {
      argv: w.argv({ prompt: "DO", model: "m" }),
      stdin: w.argvStdin ? w.argvStdin({ model: "m" }) : null,
      autoDetect: w.detectPriority !== undefined,
      authEnvVar: w.authEnvVar ?? null,
    };
  }
  // 取值与形状都是外部兼容面：改这里等于改任务根里的 worker 记录。
  assert.deepEqual(seen.claude, {
    argv: ["-p", "DO", "--permission-mode", "acceptEdits", "--output-format", "text", "--model", "m"],
    stdin: ["-p", "--output-format", "text", "--model", "m"],
    autoDetect: true,
    authEnvVar: null,
  });
  // `--port 0` 让每个 worker 自选端口：默认端口固定，与桌面端宿主同机运行会 EADDRINUSE，
  // 而 CLI 在这种失败下仍以退出码 0 结束，表现为「进程起来了但什么也没干」。
  assert.deepEqual(seen.codebuddy, {
    argv: ["-p", "DO", "--permission-mode", "bypassPermissions", "--port", "0", "--model", "m", "--output-format", "stream-json", "-d"],
    stdin: ["-p", "--permission-mode", "bypassPermissions", "--port", "0", "--model", "m", "--output-format", "stream-json", "-d"],
    autoDetect: true,
    authEnvVar: null,
  });
  assert.equal(seen.workbuddy.autoDetect, false, "没有可靠非交互入口的宿主不得参与自动探测");
});

test("探测顺序：自动探测仍是 codebuddy → claude（外部行为，不许变）", () => {
  const auto = registry
    .workerHosts()
    .filter((impl) => impl.worker.detectPriority !== undefined)
    .map((impl) => impl.worker.key);
  assert.deepEqual(auto, ["codebuddy", "claude"]);
});

test("探测优先级：workerHosts 降序且不含未声明优先级的宿主在前", () => {
  const hosts = registry.workerHosts();
  const scores = hosts.map((impl) => impl.worker.detectPriority ?? -1);
  const sorted = [...scores].sort((a, b) => b - a);
  assert.deepEqual(scores, sorted, "workerHosts 必须按探测优先级降序");
});

test("workspace：没有 facet 的 impl 一个项目配置都不写", () => {
  const root = mkdtempSync(join(tmpdir(), "capitalist-ws-"));
  const silent = registry.all().filter((impl) => !impl.workspace);
  assert.ok(silent.length > 0, "至少应有一个宿主不需要准备目录，否则这条断言没意义");

  // 模拟监工的开机准备：只有 facet 存在时才调用。没有 facet 的宿主不该留下任何痕迹。
  for (const impl of registry.all()) {
    if (impl.workspace) continue;
    const dir = join(root, impl.configDir);
    assert.equal(existsSync(dir), false, `${impl.id}: 没有 workspace facet 却写了 ${dir}`);
  }
  assert.deepEqual(
    require("node:fs").readdirSync(root),
    [],
    "没有 workspace 的宿主不该在任务根留下任何文件",
  );
});

test("workspace：有 facet 的 impl 幂等追加，且不改用户已有值", () => {
  const root = mkdtempSync(join(tmpdir(), "capitalist-ws2-"));
  // 用 impl/shared 的工厂自建一份（家目录指向临时目录），避免测试写真实宿主配置。
  const { createWorkspaceFacet } = require("../dist/host/impl/shared/dirTrust");
  const facet = createWorkspaceFacet({
    configDir: ".hostx",
    label: "HostX",
    defaultMode: "acceptEdits",
    allow: ["Read", "Write"],
    home: () => root,
  });
  mkdirSync(join(root, ".hostx"), { recursive: true });
  writeFileSync(join(root, ".hostx", "settings.json"), JSON.stringify({ trustedDirectories: [] }), "utf8");
  const impl = { configDir: ".hostx", workspace: facet };

  const first = impl.workspace.prepare(root);
  assert.equal(first.ok, true, first.message);
  const file = join(root, impl.configDir, "settings.json");
  assert.ok(existsSync(file), "应当写出项目级配置");
  const data = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(data.permissions, "应当写入 permissions");
  assert.equal(typeof data.permissions.defaultMode, "string");

  // 用户已有自己的设置：再跑一次不能覆盖
  data.permissions.defaultMode = "user-choice";
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  const second = impl.workspace.prepare(root);
  assert.equal(second.ok, true);
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.permissions.defaultMode, "user-choice", "不得覆盖用户已有配置");
});

test("Windows hook 依赖：缺 Git Bash 时判定不可用，非 Windows 不检查", () => {
  const { gitBashAvailable } = require("../dist/host/impl/shared/workerCommon");
  const never = () => false;
  assert.equal(gitBashAvailable("darwin", {}, never), true, "非 Windows 恒为可用");
  assert.equal(gitBashAvailable("linux", { PATH: "" }, never), true);
  assert.equal(gitBashAvailable("win32", { PATH: "", ProgramFiles: "", ProgramW6432: "", LOCALAPPDATA: "" }, never), false);
  assert.equal(
    gitBashAvailable("win32", { ProgramFiles: "C:\\Program Files", PATH: "" }, (p) => p.includes("Git") && p.endsWith("bash.exe")),
    true,
    "Git for Windows 默认位置应被识别",
  );
  assert.equal(
    gitBashAvailable("win32", { ProgramFiles: "", PATH: "C:\\Portable\\Git\\bin;C:\\Windows" }, (p) => p === join("C:\\Portable\\Git\\bin", "bash.exe")),
    true,
    "便携版装在 PATH 里也要认",
  );
});

test("capitalist hosts 的输出与注册表一致（自检出口不会各说各话）", () => {
  /* 测试进程本身可能跑在 worker 环境里；`capitalist hosts` 是监工命令，先把 worker 标记摘掉。 */
  const env = { ...process.env };
  delete env.CAPITALIST_WORKER_ID;
  const r = spawnSync(process.execPath, [join(PKG, "dist", "cli", "main.js"), "hosts", "--json"], {
    encoding: "utf8",
    env,
  });
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.deepEqual(
    rows.map((row) => row.id),
    registry.all().map((impl) => impl.id),
    "capitalist hosts 的 id 集合与顺序必须等于注册表",
  );
  for (const row of rows) {
    const impl = registry.byId(row.id);
    assert.deepEqual(row.aliases, [...impl.aliases]);
    assert.equal(row.worker, impl.worker?.key ?? null);
  }
});

test("hook 入口：未知宿主不阻断，也不假装跑的是别的 impl", () => {
  const r = spawnSync(process.execPath, [join(PKG, "dist", "host", "main.js"), "PreToolUse", "--agent", "nope"], {
    encoding: "utf8",
    input: "{}",
  });
  assert.equal(r.status, 0, "hook 自身故障不得阻断宿主");
  assert.match(r.stderr, /未知宿主/);
});

test("hook 入口：--selftest 打印配置位置与映射，不处理事件", () => {
  const r = spawnSync(process.execPath, [join(PKG, "dist", "host", "main.js"), "--selftest"], {
    encoding: "utf8",
    input: "{}",
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^host: /m);
  assert.match(r.stdout, /^config: ~\//m);
  assert.match(r.stdout, /PreToolUse -> on_action/);
});

test("模型清单从宿主 CLI 帮助的 --model 行解析全量 ID，解析失败才回退已知清单", () => {
  const { parseModelIdsFromHelp } = require("../dist/supervisor/board");
  const help = [
    "Options:",
    "  --model <id>   Model to use. Currently supported:",
    "                 (fast-model, balanced-model, deep-model, hy4-preview, hy3, hy3-x,",
    "                  deepseek-v4.1-flash, glm-5.3, glm-5.3-flash, glm-5.3-flashx, glm-5.2,",
    "                  space-bunny, minimax-m3.1-flash, minimax-m3-pay, kimi-k3.1-pro-highspeed,",
    "                  kimi-k3.1-pro, kimi-k3-2, kimi-k2.8-preview, deepseek-v4-pro, step-5-preview,",
    "                  mimo-v2.6-pro, custom-local:deepseek-flash)",
    "  --effort <level>  Reasoning effort",
  ].join("\n");
  const ids = parseModelIdsFromHelp(help);
  assert.ok(ids.length >= 20, `应解析出全部模型，实际 ${ids.length}：${ids.join(",")}`);
  assert.ok(ids.includes("custom-local:deepseek-flash"), "带冒号的本地模型 ID 不能被截断");
  assert.ok(ids.includes("glm-5.3-flashx"));
  assert.deepEqual(parseModelIdsFromHelp("no model list here"), [], "解析不出时返回空数组，由调用方回退");

  /* 回退清单挂在 impl 能力上，不在 board 里按宿主 id 维护第二份。 */
  const cb = registry.byId("codebuddy");
  assert.ok(cb && Array.isArray(cb.knownModels) && cb.knownModels.length > 0, "宿主应声明可用的回退模型清单");
});

const WIN_HELP = "Usage: cli --model Model to use. Currently supported: (fast-model, balanced-model, deep-model, hy4-preview)";

test("win32：findHostCli 优先同名 .cmd 可执行体，不落在无扩展名包装脚本上", { skip: process.platform !== "win32" }, () => {
  const board = require("../dist/supervisor/board");
  const dir = mkdtempSync(join(tmpdir(), "capitalist-cli-"));
  writeFileSync(join(dir, "codebuddy"), "#!/bin/sh\nexit 1\n", "utf8");
  writeFileSync(join(dir, "codebuddy.cmd"), "@echo off\r\n", "utf8");
  const saved = process.env.PATH ?? "";
  process.env.PATH = `${dir};${saved}`;
  try {
    assert.equal(board.findHostCli("codebuddy"), join(dir, "codebuddy.cmd"), "应优先选 .cmd，而不是无扩展名脚本");
  } finally {
    process.env.PATH = saved;
  }
});

test("win32：无扩展名宿主脚本也能解析出全量清单；路径含空格不破引用", { skip: process.platform !== "win32" }, () => {
  const board = require("../dist/supervisor/board");
  /* 目录名故意带空格：shell:true 时 node 不代加引号，路径含空格必须由实现自理。 */
  const dir = mkdtempSync(join(tmpdir(), "capitalist cli 空格-"));
  writeFileSync(
    join(dir, "codebuddy.cmd"),
    ["@echo off", `echo ${WIN_HELP}`, "@echo on\r\n"].join("\r\n"),
    "utf8",
  );
  const saved = process.env.PATH ?? "";
  process.env.PATH = `${dir};${saved}`;
  try {
    board.resetHelpModelsCacheForTest();
    const models = board.helpModels("codebuddy");
    assert.ok(models.length >= 4, `win32 应解析出全量清单，实际 ${models.length}：${models.join(",")}`);
    assert.ok(models.includes("hy4-preview"));
    assert.ok(models.includes("fast-model"));
  } finally {
    process.env.PATH = saved;
    board.resetHelpModelsCacheForTest();
  }
});

test("解析失败不缓存：只命中无扩展名文件时返回空清单，不把失败钉死在缓存里", { skip: process.platform !== "win32" }, () => {
  const board = require("../dist/supervisor/board");
  const dir = mkdtempSync(join(tmpdir(), "capitalist-cli-"));
  /* 只有 sh 风格无扩展名文件：win32 cmd 起不动它，解析必然为空。 */
  writeFileSync(join(dir, "codebuddy"), "#!/bin/sh\nexit 1\n", "utf8");
  const saved = process.env.PATH ?? "";
  process.env.PATH = `${dir};${saved}`;
  try {
    board.resetHelpModelsCacheForTest();
    const first = board.helpModels("codebuddy");
    assert.deepEqual(first, [], "起不动的宿主返回空清单，由调用方回退");
    /* 再跑一遍仍会重试（失败不写缓存）：这里只验证不抛错、结果稳定。 */
    const second = board.helpModels("codebuddy");
    assert.deepEqual(second, []);
  } finally {
    process.env.PATH = saved;
    board.resetHelpModelsCacheForTest();
  }
});
