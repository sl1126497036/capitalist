
const test = require("node:test");
const assert = require("node:assert");
const { readFileSync, readdirSync, statSync } = require("node:fs");
const { resolve, join } = require("node:path");

const PKG = resolve(__dirname, "..");
const WEB = resolve(PKG, "web/src");
const AppSrc = readFileSync(resolve(WEB, "App.vue"), "utf8");
const i18nSrc = readFileSync(resolve(WEB, "lib/i18n.js"), "utf8");

/** 蒙版那一段（模板里 v-if="ctxMask" 到它的闭合 div），断言只看这一段。 */
function maskBlock() {
  const start = AppSrc.indexOf('v-if="ctxMask"');
  assert.ok(start > 0, "App.vue 里应有 ctxMask 蒙版");
  const end = AppSrc.indexOf("</div>\n      </div>", start);
  assert.ok(end > start, "蒙版块应能截出边界");
  return AppSrc.slice(start, end);
}

/** 递归收集 web/src 下的样式与模板源码，查等待光标残留。 */
function sourceFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(vue|css|html|js)$/.test(name)) acc.push(full);
  }
  return acc;
}

test("蒙版标题是“重启中…”，不再说压缩中", () => {
  const block = maskBlock();
  assert.ok(block.includes('t("重启中…")'), "标题走“重启中…”");
  assert.ok(block.includes('t(\'重启中…\')'), "aria-label 同口径");
  assert.ok(!block.includes('t("压缩中")'), "蒙版标题不再复用气泡的“压缩中”");
  assert.ok(!block.includes("上下文优化中"), "旧标题“上下文优化中”不再出现");
});

test("副标题讲重启期间的暂停与自动恢复，不提压缩上下文", () => {
  const note = /class="ctx-mask-note"[^>]*>\{\{\s*t\("([^"]+)"\)\s*\}\}/.exec(maskBlock());
  assert.ok(note, "蒙版副标题应走 t() 词条");
  const text = note[1];
  assert.ok(text.includes("重启期间界面暂停"), "写明重启期间界面暂停");
  assert.ok(text.includes("自动恢复调度"), "写明完成后自动恢复调度");
  assert.ok(!/压缩|重建会话/.test(text), "不提压缩上下文与重建会话");
});

test("副标题给出重启失败时的处理动作", () => {
  const block = maskBlock();
  assert.ok(block.includes("capitalist supervise"), "命令行要写具体命令，不写占位符");
  assert.ok(/重新执行|重新启动/.test(block), "说明未恢复时如何处置");
});

test("蒙版不挂等待光标，全站没有 wait / progress 光标残留", () => {
  const block = maskBlock();
  assert.ok(!/cursor\s*:\s*(wait|progress)/.test(block), "蒙版自身不设等待光标");
  const hits = [];
  for (const file of sourceFiles(WEB)) {
    if (/cursor\s*:\s*(wait|progress)/.test(readFileSync(file, "utf8"))) hits.push(file);
  }
  assert.deepEqual(hits, [], `这些文件仍在用等待光标：${hits.join(", ")}`);
});

test("英文条目齐全，旧蒙版词条已摘掉", () => {
  assert.ok(i18nSrc.includes('"重启中…": "Restarting…"'), "标题英文条目");
  assert.ok(
    i18nSrc.includes("The UI is paused while the supervisor restarts"),
    "副标题英文条目",
  );
  assert.ok(
    !i18nSrc.includes("The chat context is near its limit. Dispatch progress is being saved"),
    "旧副标题词条不再保留",
  );
  assert.ok(!i18nSrc.includes('"上下文优化中"'), "旧标题词条不再保留");
});
