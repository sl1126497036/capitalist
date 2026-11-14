
const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { createTaskRoot } = require(join(PKG, "dist/core/contract/init.js"));
const { appendDispatch, readDispatches } = require(join(PKG, "dist/core/record/supervisor.js"));
const { bindAttachments } = require(join(PKG, "dist/core/message/attachments.js"));
const { spliceDirectives } = require(join(PKG, "dist/core/dispatch/commands.js"));

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "capitalist-attlimit-"));
  createTaskRoot({ target: "附件不设上限", contractSpec: "minimal", root: base });
  return base;
}

const FIVE = ["a.png", "b.png", "c.png", "d.png", "e.png"];

test("不设上限：五张全带上，一张都不裁", () => {
  const r = bindAttachments("看这几张\n\n[附件] 野路径.png", FIVE);
  assert.deepStrictEqual(r.kept, FIVE, "字段里声明了几张就带几张");
  assert.equal((r.text.match(/\[附件\]/g) ?? []).length, 5, "正文里应有五行附件");
  assert.ok(!r.text.includes("野路径.png"), "正文里原有的路径一律剥掉，不参与合并");
});

test("顺序不再决定生死：旧图排前面也挤不掉新图", () => {
  /* 这就是出事的那一单：单上已有两张旧图，插话又带了一张新的。 */
  const old = ["old-1.png", "old-2.png"];
  const fresh = ["new-1.png"];
  const r = bindAttachments("做这个", [...old, ...fresh]);
  assert.deepStrictEqual(r.kept, ["old-1.png", "old-2.png", "new-1.png"], "旧的新的都在");
});

test("插话拼进派单：只认插话自己的 atts，正文里的路径不采信", () => {
  const action = spliceDirectives("做这个", [
    { text: "补一句说明\n\n[附件] 模型抄来的.png", atts: ["真图.png"] },
  ]);
  assert.ok(action.includes("真图.png"), "字段里的图必须到");
  assert.ok(!action.includes("模型抄来的.png"), "正文里抄来的路径不许进派单");
});

test("重派继承：只接上一单字段声明的图，不从它的正文里解析", () => {
  const root = sandbox();
  try {
    /* 上一单：字段里只声明了 kept.png，正文里却躺着一张残留的 stray.png。 */
    appendDispatch(root, {
      id: "D-prev",
      at: new Date().toISOString(),
      stage: "S0",
      shard: "",
      action: "上一轮做这个\n\n[附件] stray.png",
      atts: ["kept.png"],
      status: "failed",
      source: "requeue",
      lineage: "D-chain",
      attempt: 1,
    });
    appendDispatch(root, {
      id: "D-next",
      at: new Date().toISOString(),
      stage: "S0",
      shard: "",
      action: "再做一遍",
      status: "open",
      source: "requeue",
      lineage: "D-chain",
      attempt: 2,
    });

    const next = readDispatches(root).find((x) => x.id === "D-next");
    assert.ok(next, "重派单已建");
    assert.deepStrictEqual(next.atts, ["kept.png"], "只继承上一单声明过的那张");
    assert.ok(!String(next.action).includes("stray.png"), "正文里的残留路径不跟着走");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("新需求不接上一单的图：继承只发生在同链重派", () => {
  const root = sandbox();
  try {
    appendDispatch(root, {
      id: "D-old",
      at: new Date().toISOString(),
      stage: "S0",
      shard: "",
      action: "旧的活",
      atts: ["old.png"],
      status: "failed",
      source: "adhoc",
      lineage: "D-old",
      attempt: 1,
    });
    appendDispatch(root, {
      id: "D-new",
      at: new Date().toISOString(),
      stage: "S0",
      shard: "",
      action: "新的活",
      status: "open",
      source: "adhoc",
      lineage: "D-new",
      attempt: 1,
    });

    const fresh = readDispatches(root).find((x) => x.id === "D-new");
    assert.ok(!Array.isArray(fresh.atts) || fresh.atts.length === 0, "新需求的单一张都不继承");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
