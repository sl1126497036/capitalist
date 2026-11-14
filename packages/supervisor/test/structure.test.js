/** 结构守卫：把文件规模与模块边界写成断言，避免拆分后重新长回去。 */

const test = require("node:test");
const assert = require("node:assert");
const { readdirSync, readFileSync, statSync, existsSync } = require("node:fs");
const { join, relative, resolve, sep } = require("node:path");

const PKG = resolve(__dirname, "..");
const SRC = join(PKG, "src");
const BASELINE_FILE = join(__dirname, "structure.baseline.json");

/** 新文件的规模上限。超出的既有文件登记在基线里，只准减不准增。 */
const MAX_LINES = 800;
/** 基线条目上限。到顶说明拆分没有进展，只是把超标文件换了个位置。 */
const BASELINE_MAX_ENTRIES = 20;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function rel(file) {
  return relative(PKG, file).split(sep).join("/");
}

function baseline() {
  if (!existsSync(BASELINE_FILE)) return {};
  return JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
}

test("规则1：单文件行数不超上限，已超标的只准减不准增", () => {
  const known = baseline();
  const offenders = [];
  for (const file of walk(SRC)) {
    const lines = readFileSync(file, "utf8").split("\n").length;
    const cap = known[rel(file)] ?? MAX_LINES;
    if (lines > cap) offenders.push(`${rel(file)}: ${lines} 行，上限 ${cap}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `文件超过规模上限：\n${offenders.join("\n")}\n` +
      "新增代码请拆到新文件；确需保留时把 test/structure.baseline.json 的对应值调到当前行数。",
  );
});

test("规则2：core 不引用上层目录", () => {
  /* core 按领域分了子目录，反向引用要穿透任意层数，不能只认一级。 */
  const forbidden = /from "(?:\.\.\/)+(supervisor|cli|agent|install)\//;
  const offenders = [];
  for (const file of walk(join(SRC, "core"))) {
    if (forbidden.test(readFileSync(file, "utf8"))) offenders.push(rel(file));
  }
  assert.deepEqual(
    offenders,
    [],
    `core 依赖了上层目录：\n${offenders.join("\n")}\n` +
      "core 是被依赖方；需要共用时把实现下沉到 core，而不是反向引用。",
  );
});

test("规则3：board 子模块不引用 board/index", () => {
  const dir = join(SRC, "supervisor", "board");
  if (!existsSync(dir)) return;
  const offenders = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts") || name === "index.ts") continue;
    const text = readFileSync(join(dir, name), "utf8");
    if (/from "\.\/index"|from "\.\.\/board"/.test(text)) offenders.push(`board/${name}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `board 子模块反向引用了入口：\n${offenders.join("\n")}\n` +
      "会形成循环依赖。共用部分下沉到 sources / logs / stats 等下层模块。",
  );
});

test("规则4：基线条目数量受控", () => {
  const known = baseline();
  const entries = Object.keys(known).length;
  assert.ok(
    entries <= BASELINE_MAX_ENTRIES,
    `基线条目 ${entries} 个，上限 ${BASELINE_MAX_ENTRIES}。新增超标文件应当拆开，而不是继续登记。`,
  );
});

test("规则5：基线记录只减不增", () => {
  const known = baseline();
  const regressed = [];
  for (const [file, cap] of Object.entries(known)) {
    const full = join(PKG, file);
    if (!existsSync(full)) continue;
    const lines = readFileSync(full, "utf8").split("\n").length;
    if (lines > cap) regressed.push(`${file}: ${lines} > ${cap}`);
  }
  assert.deepEqual(
    regressed,
    [],
    `已拆分的文件又长回去了：\n${regressed.join("\n")}\n请把新增逻辑放到独立模块。`,
  );
});

test("规则6：board 子模块用 __dirname 上跳不少于两级", () => {
  /*
   * 拆分后产物在 dist/supervisor/board/，比单文件时代深一层。
   * 单级上跳会落到 dist/supervisor，找前端产物与 CLI 入口都会失败。
   */
  const dir = join(SRC, "supervisor", "board");
  if (!existsSync(dir)) return;
  const offenders = [];
  for (const file of walk(dir)) {
    const text = readFileSync(file, "utf8");
    if (/join\(__dirname, "\.\.", "(?!\.\.)/.test(text)) offenders.push(rel(file));
  }
  assert.deepEqual(
    offenders,
    [],
    `board 子模块用 __dirname 上跳时少了一层：\n${offenders.join("\n")}\n` +
      "产物在 dist/supervisor/board/，到 dist 要上跳两级。",
  );
});
