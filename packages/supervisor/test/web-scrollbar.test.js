/**
 * 滚动条尺寸守卫：全站只允许一处定义宽度。
 *
 * 曾有两份宽度：全局 8px，消息流单独收窄到 6px。同一屏里左栏比右栏粗，改一处不影响
 * 另一处。判据是「带 width 的滚动条样式块只允许出现在全局样式里」，组件再写一份即被拦下。
 */

const test = require("node:test");
const assert = require("node:assert");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join, relative, resolve, sep } = require("node:path");

const PKG = resolve(__dirname, "..");
const WEB_SRC = join(PKG, "web/src");
/** 全局样式文件的包内相对路径，与断言信息里显示的一致。 */
const GLOBAL_CSS = "web/src/styles/app.css";
const SCROLLBAR_SIZE = "6px";
/** Firefox 只支持 auto / thin / none，具体像素在这里没有表达方式。 */
const WIDTH_KEYWORDS = new Set(["auto", "thin", "none"]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(css|vue|html)$/.test(name)) out.push(full);
  }
  return out;
}

function rel(file) {
  return relative(PKG, file).split(sep).join("/");
}

/**
 * 取所有 `::-webkit-scrollbar { ... }` 样式块的声明体。
 *
 * `::-webkit-scrollbar-thumb` 这类伪元素不在其列：前缀后面紧跟 `-`，不满足花括号前的空白。
 */
function scrollbarBlocks(src) {
  return [...src.matchAll(/::-webkit-scrollbar\s*\{([^}]*)\}/g)].map((m) => m[1] ?? "");
}

test("滚动条宽度只在全局样式里定义，且为 6px", () => {
  const offenders = [];
  for (const file of walk(WEB_SRC)) {
    for (const body of scrollbarBlocks(readFileSync(file, "utf8"))) {
      const hit = /(?:^|;)\s*width\s*:\s*([^;]+)/.exec(body);
      if (!hit) continue;
      const value = String(hit[1]).trim();
      const where = rel(file);
      if (where !== GLOBAL_CSS) offenders.push(`${where}: width: ${value}`);
      else if (value !== SCROLLBAR_SIZE) offenders.push(`${where}: width: ${value}，应为 ${SCROLLBAR_SIZE}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `滚动条宽度出现多处定义：\n${offenders.join("\n")}\n` +
      `改 ${GLOBAL_CSS} 里的全局值，组件内不要另写宽度。`,
  );
});

test("横向滚动条宽度与纵向一致", () => {
  const blocks = scrollbarBlocks(readFileSync(join(PKG, GLOBAL_CSS), "utf8"));
  const main = blocks.find((b) => /(?:^|;)\s*width\s*:/.test(b));
  assert.ok(main, `${GLOBAL_CSS} 缺少全局滚动条宽度`);
  assert.match(String(main), new RegExp(`height\\s*:\\s*${SCROLLBAR_SIZE}`), "全局滚动条的高度应与宽度相同");
});

test("Firefox 的 scrollbar-width 只使用关键字", () => {
  const offenders = [];
  for (const file of walk(WEB_SRC)) {
    for (const m of readFileSync(file, "utf8").matchAll(/scrollbar-width\s*:\s*([^;}\n]+)/g)) {
      const value = String(m[1]).trim();
      if (!WIDTH_KEYWORDS.has(value)) offenders.push(`${rel(file)}: scrollbar-width: ${value}`);
    }
  }
  assert.deepEqual(offenders, [], `scrollbar-width 只接受 auto / thin / none：\n${offenders.join("\n")}`);
});
