
const test = require("node:test");
const assert = require("node:assert");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { buildPrompt, buildResumePrompt } = require(join(PKG, "dist/supervisor/worker.js"));
const {
  PREFLIGHT_MARKER,
  attachPreflight,
  buildPreflightBlock,
  preflightAtOf,
} = require(join(PKG, "dist/supervisor/preflight.js"));

const AT = "2026-11-04T13:09:42.000Z";
/** 合并后的段落标题（带区块序号）。 */
const GROUNDING_HEAD = "动手前先核对现状";

function freshPrompt(dispatch) {
  return buildPrompt({
    root: "/tmp/x",
    target: "重构计费服务",
    id: "W-1",
    dispatch: { id: "D-1", stage: "S0", action: "改重试", status: "open", ...dispatch },
  });
}

test("首次派单提示词带「动手前先核对现状」，并写明五项核对", () => {
  const prompt = freshPrompt({ at: AT });
  assert.ok(prompt.includes(GROUNDING_HEAD));
  assert.match(prompt, /读目标文件当前内容与最近改动痕迹/);
  assert.match(prompt, /若已经实现，不要重做：在报告里指出实现位置（文件 \+ 行号）与差异/);
  assert.match(prompt, /只做了一半的只补缺，不推倒重来/);
  assert.match(prompt, /与已验收的做法相反/);
  assert.match(prompt, /不许按旧快照覆盖/);
});

test("有 at 时写进本单创建时刻，并给出 mtime 比较方法", () => {
  const prompt = freshPrompt({ at: AT });
  assert.ok(prompt.includes(AT), "提示词里应能看到本单 at");
  assert.match(prompt, /mtime 晚于本单创建时刻/);
  assert.match(prompt, /stat -c %Y/);
  assert.match(prompt, new RegExp(`date -d "${AT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" \\+%s`));
  /* 能拿到 epoch 秒，用 stat 的秒级时间直接比较。 */
  assert.equal(preflightAtOf({ at: AT }).epoch, Math.floor(Date.parse(AT) / 1000));
});

test("没有 at 时用通用说法，不出现具体时刻与比较命令", () => {
  const prompt = freshPrompt({ at: "" });
  assert.ok(prompt.includes(GROUNDING_HEAD));
  assert.match(prompt, /目标文件在本单创建之后被改过时，按最新内容做/);
  assert.ok(!prompt.includes("date -d"));
  assert.equal(preflightAtOf({ at: "" }), null);
  assert.equal(preflightAtOf({ at: "not-a-date" }), null);
});

test("续跑提示词同样带这一段", () => {
  const prompt = buildResumePrompt({
    root: "/tmp/x",
    target: "重构计费服务",
    dispatch: { id: "D-1", at: AT, stage: "S0", action: "改重试", status: "open" },
  });
  assert.ok(prompt.includes(GROUNDING_HEAD));
  assert.ok(prompt.includes(AT));
  assert.match(prompt, /mtime 晚于本单创建时刻/);
});

test("正文已带过则不重复追加", () => {
  const block = buildPreflightBlock({ at: AT }).join("\n");
  const prompt = freshPrompt({ at: AT, action: `改重试\n\n${block}` });
  assert.equal(prompt.split(PREFLIGHT_MARKER).length - 1, 1);
});

test("attachPreflight 幂等，供 capitalist next 打印时现拼", () => {
  const once = attachPreflight("改重试", { at: AT });
  const twice = attachPreflight(once, { at: AT });
  assert.equal(twice, once);
  assert.equal(twice.split(PREFLIGHT_MARKER).length - 1, 1);
  assert.ok(twice.startsWith("改重试"));
});
