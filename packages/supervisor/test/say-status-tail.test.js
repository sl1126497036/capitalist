
const test = require("node:test");
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const PKG = resolve(__dirname, "..");
const WEB = resolve(PKG, "web/src");

/** Windows 下动态 import ESM 必须用 file:// URL。 */
const load = async (rel) => import(pathToFileURL(resolve(WEB, rel)).href);

/** 服务端下发状态用的分隔符：空格、中点、空格。转义书写，避免字符被抄进界面文案。 */
const SEP = " \u00b7 ";

test("splitStatus：结论段与主状态分开，无结论时为空", async () => {
  const { splitStatus } = await load("lib/statusParts.js");
  assert.deepEqual(splitStatus(`已并入派单${SEP}已落实`), { head: "已并入派单", tail: ["已落实"] });
  assert.deepEqual(splitStatus(`未投递${SEP}所属单已随阶段推进作废`), {
    head: "未投递",
    tail: ["所属单已随阶段推进作废"],
  });
  assert.deepEqual(splitStatus("已并入派单"), { head: "已并入派单", tail: [] });
  assert.deepEqual(splitStatus(""), { head: "", tail: [] });
  assert.deepEqual(splitStatus(undefined), { head: "", tail: [] });
});

test("interjectTone：任何状态都有档位，认不出的一律待送达", async () => {
  const { interjectTone } = await load("lib/statusParts.js");
  assert.equal(interjectTone(`已送达执行中的进程${SEP}待结论`), "ok");
  assert.equal(interjectTone(`已并入派单${SEP}已落实`), "ok");
  assert.equal(interjectTone(`未投递${SEP}所属单已随阶段推进作废`), "bad");
  assert.equal(interjectTone("rejected"), "bad");
  assert.equal(interjectTone("随派单启动带入"), "pending");
  assert.equal(interjectTone("待补投递"), "pending");
  /* 本地回显没有状态、老记录状态词已改、将来新增的状态，都必须落到待送达，不能返回空。 */
  assert.equal(interjectTone(""), "pending");
  assert.equal(interjectTone(undefined), "pending");
  assert.equal(interjectTone("以后才有的状态"), "pending");
});

test("mergeInterject：插话的送达状态不倒退，其余消息整体取新", async () => {
  const { mergeInterject } = await load("lib/statusParts.js");
  const said = (status) => ({ role: "user", kind: "say", status, text: "x" });
  /* 已送达不会被旧的待送达覆盖，这是尾标来回跳的直接原因。 */
  assert.equal(mergeInterject(said("已送达执行中的进程"), said("")).status, "已送达执行中的进程");
  /* 状态前进时照常替换。 */
  assert.equal(mergeInterject(said(""), said("已送达执行中的进程")).status, "已送达执行中的进程");
  /* 非插话消息不受此约束，工作进程输出块靠整条替换原地增长。 */
  const log = mergeInterject({ role: "worker", kind: "say", status: "a" }, { role: "worker", kind: "say", status: "b" });
  assert.equal(log.status, "b");
});

test("气泡：用户插话的尾标是三档短词，不出现编号，不写解释", () => {
  const chatSrc = readFileSync(resolve(WEB, "components/chat-pane/index.vue"), "utf8");
  const tplSrc = readFileSync(resolve(WEB, "components/chat-pane/template.html"), "utf8");
  const appSrc = readFileSync(resolve(WEB, "App.vue"), "utf8");
  /* 用户插话走 interjectStatus：短词与配色档，过程说明只在悬停提示里。 */
  assert.match(chatSrc, /interjectStatus\(v\.m\.status,\s*v\.m\.reason,\s*v\.m\.detail\)/);
  /*
   * 用户插话分支只取短词，不得出现 noLabel。兜底出来的编号就是那个时有时无的号码；
   * 监工派单卡的兜底在其后的分支里，不受此限。
   */
  const statBody = chatSrc.slice(chatSrc.indexOf("function stat(v)"));
  const userBranch = statBody.slice(0, statBody.indexOf('if (v.c === "supervisorsay")'));
  assert.ok(userBranch.length > 0, "stat() 应分出用户插话与监工派单卡两支");
  assert.ok(!userBranch.includes("noLabel("), "用户插话的尾标不得用编号兜底");
  /* 配色档绑到 statTone。原先把中文状态串当类名，样式永远命不中。 */
  assert.match(tplSrc, /:class="statTone\(v\)"/);
  assert.ok(!tplSrc.includes(':class="v.m.status"'), "状态类名不得直接用原始状态串");
  /* 合并入口用 mergeInterject，状态才不会被旧对象覆盖回去。 */
  assert.match(appSrc, /mergeInterject\(out\[at\], m\)/);
  /* 监工派单卡按编号对齐回执。 */
  assert.match(chatSrc, /sayStatus\(v\.m\.status,\s*v\.m\.no,\s*v\.m\.reason,\s*v\.m\.detail\)/);
});
