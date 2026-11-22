/**
 * 通道故障判定唯一入口。
 *
 * 覆盖两类回归：
 * 1. 模型正常回答里提到“额度耗尽”被当成上游拒绝说明，整段回复被替换成错误文案；
 * 2. 业务文本（正文、历史行、被读取的文件内容）混进判定作用域。
 *
 * 同时守卫判据只存在于 `channel/fault.ts`，其余模块不得另写正则与阈值。
 */

const test = require("node:test");
const assert = require("node:assert");
const { readFileSync, readdirSync, statSync } = require("node:fs");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const { judgeFault, judgeResultFault, isQuotaText } = require(join(PKG, "dist/supervisor/channel/fault.js"));

/** 15:01:50 那轮的完整正文，含四行动作；原判据因此把它整段作废。 */
const REPLY_DEEPSEEK = [
  "4 张文案校验单因额度耗尽失败，分别是 #65 worker/usage、#68 agent/install、#69 chat-pane 三组件、#70 其余前端文件，现已按原要求重开、放回队列。监工当前处于暂停状态，这 4 张单要等在看板点“恢复调度”后才会继续执行。",
  "",
  "DO: retry #65",
  "DO: retry #68",
  "DO: retry #69",
  "DO: retry #70",
  "ATT: no",
].join("\n");

/** 15:05:59 那轮的完整正文，同样被原判据整段作废。 */
const REPLY_HY4 = [
  "#65、#68、#69、#70 仍是失败状态，额度耗尽后已重开放回队列。上一轮派单动作未生效，这 4 项按原要求重新提交。",
  "",
  "DO: retry #65",
  "DO: retry #68",
  "DO: retry #69",
  "DO: retry #70",
  "ATT: none",
].join("\n");

/** 宿主真 429 时原样转述的拒绝说明。 */
const REFUSAL_429 =
  "429 您的使用量已超出频率限制，将在 2026-11-22 22:55:23 UTC+8 重置，您也可以切换其他模型继续使用。 (01a1ff33afd272f9b28e28cdc8c3e94a/48f02136-f735-40d9-b93e-47cfe5b13000)";

test("正文作用域：复述额度的正常回答不判额度", () => {
  assert.equal(judgeFault("reply", REPLY_DEEPSEEK), "", "含动作行的正文不能当成拒绝说明");
  assert.equal(judgeFault("reply", REPLY_HY4), "", "同上，换模型不影响结论");
  assert.equal(
    judgeFault("reply", "额度已耗尽后已重开放回队列"),
    "",
    "只有中文措辞、没有协议特征，不算宿主转述的拒绝说明",
  );
});

test("正文作用域：真拒绝说明仍判额度", () => {
  assert.equal(judgeFault("reply", REFUSAL_429), "quota");
  assert.equal(judgeFault("reply", "402 payment required"), "quota");
});

test("正文作用域：超长正文不参与判定", () => {
  const long = `${"正".repeat(500)}${REFUSAL_429}`;
  assert.equal(judgeFault("reply", long), "", "超过 400 字按正常回答处理");
});

test("协议作用域：只认带 errors / is_error 的协议行", () => {
  const businessLine = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "额度已耗尽后已重开放回队列" }] },
  });
  assert.equal(judgeFault("stream", businessLine), "", "业务正文行不带协议字段，不计入判定");

  const resultLine = JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: [REFUSAL_429],
    errors_info: [{ status: 429, category: "quota", details: REFUSAL_429 }],
  });
  assert.equal(judgeFault("stream", resultLine), "quota");

  assert.equal(judgeFault("stream", `${businessLine}\n${resultLine}`), "quota", "混排时只取协议行");
});

test("诊断作用域取尾部，日志作用域取尾部行", () => {
  assert.equal(judgeFault("diag", `${"x".repeat(1000)} 额度已耗尽`), "quota", "错误在末尾应命中");
  assert.equal(judgeFault("diag", `额度已耗尽${"x".repeat(1000)}`), "", "600 字以外的旧内容不参与判定");

  const withinTail = [...Array(1000).fill("x"), "额度已耗尽"].join("\n");
  assert.equal(judgeFault("log", withinTail), "quota");
  const outOfTail = ["额度已耗尽", ...Array(1000).fill("x")].join("\n");
  assert.equal(judgeFault("log", outOfTail), "", "尾部 200 行以外的历史不计入判定");
});

test("协议行分类：category 优先于 status", () => {
  assert.equal(judgeResultFault({ errors_info: [{ status: 429, category: "quota" }] }).kind, "quota");
  assert.equal(
    judgeResultFault({ errors_info: [{ status: 429, category: "rate_limit" }] }).kind,
    "rate",
    "限流可自愈，不能写进额度状态",
  );
  assert.equal(judgeResultFault({ errors_info: [{ status: 402 }] }).kind, "quota");
  assert.equal(judgeResultFault({}).kind, "");
  assert.equal(judgeResultFault(null).kind, "");
});

test("isQuotaText 只认常量，不做特征匹配", () => {
  assert.equal(isQuotaText("额度已耗尽"), true);
  assert.equal(isQuotaText("额度不足"), false);
});

test("守卫：判据只在 fault.ts 实现，其余模块不得另写", () => {
  const srcRoot = join(PKG, "src");
  const banned = ["QUOTA_HINT", "looksLikeQuota", "looksLikeAuth", "quotaReplyOf", "quotaOfResult"];
  const skip = join("supervisor", "channel", "fault.ts");
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!name.endsWith(".ts")) continue;
      if (p.endsWith(skip)) continue;
      const body = readFileSync(p, "utf8");
      for (const word of banned) {
        assert.ok(!body.includes(word), `${p} 不得出现 ${word}，判定统一走 channel/fault.ts`);
      }
    }
  };
  walk(srcRoot);
});
