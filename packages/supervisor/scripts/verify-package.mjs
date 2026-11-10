#!/usr/bin/env node
/**
 * 发布前校验：入口、看板产物、内置契约与手册齐备，且不含任务数据与凭证。
 *
 * 任一检查项不通过时列出原因并以退出码 1 结束。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PKG, "..", "..");

const failures = [];

function ok(label) {
  process.stdout.write(`  ok    ${label}\n`);
}

function fail(label, reason) {
  failures.push(`${label}：${reason}`);
  process.stdout.write(`  缺    ${label}：${reason}\n`);
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function headLine(p) {
  try {
    return readFileSync(p, "utf8").split("\n", 1)[0] ?? "";
  } catch {
    return "";
  }
}

function main() {
  process.stdout.write(`包目录 ${PKG}\n`);

  const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));

  /* bin 指向的文件必须存在且可执行；声明了却缺文件，安装后命令不可用。 */
  for (const [name, rel] of Object.entries(pkg.bin ?? {})) {
    const p = join(PKG, String(rel));
    if (!isFile(p)) fail(`bin ${name}`, `${String(rel)} 不存在`);
    else if (!headLine(p).startsWith("#!")) fail(`bin ${name}`, "缺少 shebang");
    else ok(`bin ${name} → ${String(rel)}`);
  }

  const mainFile = join(PKG, String(pkg.main));
  if (!isFile(mainFile)) fail(String(pkg.main), "库入口缺失");
  else ok(String(pkg.main));
  if (!isFile(join(PKG, String(pkg.types)))) fail(String(pkg.types), "类型声明缺失");
  else ok(String(pkg.types));

  const boardIndex = join(PKG, "dist", "board-web", "index.html");
  if (!isFile(boardIndex)) fail("dist/board-web", "缺少 index.html，先执行 npm run build:web");
  else ok("dist/board-web");

  const assets = join(PKG, "dist", "board-web", "assets");
  if (!isDir(assets) || readdirSync(assets).length === 0) fail("dist/board-web/assets", "目录为空");
  else ok("dist/board-web/assets");

  const contracts = isDir(join(PKG, "contracts"))
    ? readdirSync(join(PKG, "contracts")).filter((n) => n.endsWith(".contract.json"))
    : [];
  if (contracts.length === 0) fail("contracts", "没有内置契约，capitalist start 无法按名加载");
  else ok(`contracts（${contracts.join(" / ")}）`);

  /* 协议文件随包分发；包内副本与仓库根不一致时，发布物与仓库的授权声明会分叉。 */
  for (const name of ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES"]) {
    const inPkg = join(PKG, name);
    const inRepo = join(REPO, name);
    if (!isFile(inPkg)) fail(name, "发布包缺少该文件");
    else if (!isFile(inRepo)) fail(name, "仓库根缺少该文件");
    else if (readFileSync(inPkg, "utf8") !== readFileSync(inRepo, "utf8")) fail(name, "与仓库根内容不一致");
    else ok(name);
  }

  const manual = join(PKG, "skill", "SKILL.md");
  const manualSrc = join(REPO, "skill", "SKILL.md");
  if (!isFile(manual)) fail("skill/SKILL.md", "手册缺失");
  else if (!isFile(manualSrc) || readFileSync(manual, "utf8") !== readFileSync(manualSrc, "utf8")) {
    fail("skill/SKILL.md", "与仓库根手册不一致，先执行 npm run build");
  } else ok("skill/SKILL.md");

  /* 任务数据与凭证不属于发布内容，出现在包目录即视为打包范围写错。 */
  for (const rel of [".capitalist", "auths"]) {
    if (isDir(join(PKG, rel))) fail(rel, "任务数据或凭证目录不应位于包内");
  }
  if (failures.length === 0) ok("无任务数据与凭证");

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.length} 项未通过：\n`);
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    return 1;
  }
  process.stdout.write("\n校验通过\n");
  return 0;
}

process.exit(main());
