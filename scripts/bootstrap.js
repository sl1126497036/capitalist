#!/usr/bin/env node
/** 将本仓库安装到本机，并把监工手册投放给已安装的宿主。 */

const { execSync } = require("node:child_process");
const { copyFileSync, existsSync, mkdirSync, readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { dirname, join, resolve } = require("node:path");

const REPO = resolve(__dirname, "..");
const PKG = join(REPO, "packages", "supervisor");
const SKILL_SRC = join(REPO, "skill", "SKILL.md");
const DRY = process.argv.includes("--dry-run");

/** 有 skills 目录约定的宿主。 */
const SKILL_HOSTS = [".workbuddy", ".claude", ".codebuddy"];

const log = (s) => process.stdout.write(`${s}\n`);

/** 只读命令；dry-run 时仍需执行以取得真实路径。 */
function shRead(cmdline) {
  try {
    return execSync(cmdline, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function shVerbose(cmdline) {
  log(`$ ${cmdline}`);
  if (DRY) return "";
  execSync(cmdline, { stdio: "inherit" });
  return "";
}

function fail(msg, hint) {
  process.stderr.write(`\n[安装失败] ${msg}\n`);
  if (hint) process.stderr.write(`  ${hint}\n`);
  process.exit(1);
}

function main() {
  // 0) 前置检查
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major < 18) {
    fail(`Node ${process.versions.node} 低于 18.17`, "升级 Node 后重新执行");
  }
  if (!existsSync(PKG)) fail(`找不到包目录：${PKG}`, "确认是在仓库根执行，且 packages/supervisor 存在");
  if (!existsSync(SKILL_SRC)) fail(`找不到 skill 源文件：${SKILL_SRC}`, "仓库不完整，重新克隆");

  log(`仓库：${REPO}`);
  log(`Node：${process.versions.node}`);
  if (DRY) log("（dry-run：只打印，不执行）");
  log("");

  // 1) 全局安装
  log("== 1/4 全局安装 ==");
  try {
    shVerbose(`npm i -g "${PKG}"`);
  } catch {
    fail(
      "npm 全局安装失败",
      "全局写权限不足时，执行 `npm prefix -g` 查看前缀目录，或调整 prefix。",
    );
  }

  // 2) 定位 capitalist
  log("\n== 2/4 定位 capitalist ==");
  const prefix = shRead("npm prefix -g");
  if (!prefix) fail("未取得 npm 全局前缀", "执行 npm prefix -g 查看错误");
  const candidates = process.platform === "win32"
    ? [join(prefix, "capitalist.cmd"), join(prefix, "capitalist")]
    : [join(prefix, "bin", "capitalist"), join(prefix, "capitalist")];
  const supBin = candidates.find((p) => existsSync(p)) ?? candidates[0];
  log(`capitalist：${supBin}${existsSync(supBin) || DRY ? "" : "（尚未生成）"}`);

  // 3) 投 skill
  log("\n== 3/4 投放监工手册 ==");
  const body = readFileSync(SKILL_SRC, "utf8");
  let placed = 0;
  for (const host of SKILL_HOSTS) {
    const hostDir = join(homedir(), host);
    if (!existsSync(hostDir)) continue;
    const target = join(hostDir, "skills", "supervisor", "SKILL.md");
    log(`  ${target}`);
    if (!DRY) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(SKILL_SRC, target);
    }
    placed += 1;
  }
  if (placed === 0) {
    log("  未探测到宿主配置目录，跳过投放。安装宿主后重新执行本脚本。");
  }

  // 4) 注册 hook（探测所有已装宿主）
  log("\n== 4/4 注册 hook ==");
  try {
    // --yes：跳过交互菜单（脚本调用）。
    shVerbose(`"${supBin}" install --yes`);
  } catch {
    fail(
      "hook 注册失败",
      `执行 ${supBin} install --agent <宿主> 重试。权限被拒时需由用户确认。`,
    );
  }

  log("\n== 完成 ==");
  log("");
  log("验证：");
  log(`  ${supBin} --version`);
  log("  在面板发送一条消息，回复中出现【capitalist 已生效 …】注入行表示安装完成。");
  log("  未出现时重启宿主应用（WorkBuddy 需连同托盘退出进程），重启后无需再次执行命令。");
}

main();
