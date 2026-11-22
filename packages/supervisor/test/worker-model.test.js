/**
 * 工作进程换模型：作用于单，不作用于进程。
 *
 * 回归的是三条用户可见的行为：
 *   1. 没有运行中的进程也能切，模型记在这张单上，下一轮拉起时用它；
 *   2. 已结束的单也能切，为重开与追问准备；找不到单才拒绝；
 *   3. 有进程时不打断这一轮，只登记，避免用户点一下切换就丢掉正在跑的产物。
 */

const test = require("node:test");
const assert = require("node:assert");
const { existsSync, mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const board = require(join(PKG, "dist/supervisor/board"));
const core = require(join(PKG, "dist/core/record/supervisor"));
const { createTaskRoot } = require(join(PKG, "dist/core/contract/init.js"));

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-worker-model-"));
  createTaskRoot({ target: "换模型", contractSpec: "minimal", root, supervisor: false });
  return root;
}

function makeDispatch(root, { id = "1-1", status = "open" } = {}) {
  core.appendDispatch(root, {
    id,
    at: new Date().toISOString(),
    stage: "build",
    action: "做点事",
    status,
    shard: "s1",
  });
  return id;
}

function makeWorker(root, { id = "1", dispatch = "1-1", status = "running" } = {}) {
  /* 必须走 registerWorker：listWorkers 按索引取 id，只写记录文件等于没登记。 */
  core.registerWorker(root, {
    id,
    host: "codebuddy",
    pid: 0,
    session: id,
    dispatch,
    shard: "s1",
    stage: "build",
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    heartbeat_ts: Date.now(),
    status,
    log: "",
  });
  return id;
}

function switchModel(root, body) {
  return board.runCommand(root, { action: "worker-model", ...body });
}

test("没有运行中的进程也能切：模型记在单上，下一轮拉起时生效", () => {
  const root = sandbox();
  const id = makeDispatch(root);

  const r = switchModel(root, { id, model: "glm-5.3" });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const d = core.readDispatches(root).find((x) => x.id === id);
  assert.equal(d.model, "glm-5.3");
  assert.equal(d.model_by, "user", "标记用户显式指定，补派才沿用");
  assert.equal(
    existsSync(core.workerModelPath(root)),
    false,
    "不再写按分片消费的旧文件：它在拉起时优先于单上的值",
  );
});

test("已结束的单也能切，为重开与追问准备", () => {
  const root = sandbox();
  const id = makeDispatch(root, { status: "closed" });

  const r = switchModel(root, { id, model: "hy4std" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(core.readDispatches(root).find((x) => x.id === id).model, "hy4std");

  /* 切回默认：清掉模型与回退档，保留“用户定过”的标记，避免补派沿用更早的切换值。 */
  const cleared = switchModel(root, { id, model: "" });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const d = core.readDispatches(root).find((x) => x.id === id);
  assert.equal(d.model, undefined);
  assert.equal(d.model_by, "user");
});

test("有进程时不打断这一轮：只登记，进程记录不动", () => {
  const root = sandbox();
  const id = makeDispatch(root);
  const wid = makeWorker(root, { status: "running" });

  const r = switchModel(root, { id: wid, model: "deepseek-v4.1-flash" });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const w = core.loadWorker(root, wid);
  assert.equal(w.status, "running", "正在跑的这一轮不能被中断");
  assert.equal(w.exit_code, undefined, "没有走结束进程的路径");
  assert.match(String(r.body.effective || ""), /当前这一轮仍用原模型/);

  assert.equal(core.readDispatches(root).find((x) => x.id === id).model, "deepseek-v4.1-flash");
});

test("找不到单时给 404，不再拿“没有运行中的进程”当理由", () => {
  const root = sandbox();
  const r = switchModel(root, { id: "9-9", model: "glm-5.3" });
  assert.equal(r.status, 404);
  assert.match(String(r.body.error || ""), /找不到这一单/);
});

test("旧的分片文件会被清掉：否则拉起时盖掉刚写下的模型", () => {
  const root = sandbox();
  const id = makeDispatch(root);
  /* 旧版本写下的待生效请求，与这张单同分片。 */
  core.setWorkerModel(root, "s1", "glm-5.3");

  const r = switchModel(root, { id, model: "hy4std" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  /* 不直接断言文件已删：受限环境下不允许删除文件，此时用空值作废，效果相同。 */
  assert.equal(core.takeWorkerModel(root, "s1"), "", "拉起时不能再取到旧模型");
  assert.equal(core.readDispatches(root).find((x) => x.id === id).model, "hy4std");
});

test("清理只动本分片：别的分片的待生效设定保留", () => {
  const root = sandbox();
  const id = makeDispatch(root);
  core.setWorkerModel(root, "s2", "glm-5.3");

  const r = switchModel(root, { id, model: "hy4std" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  /* 直接读文件：takeWorkerModel 的消费语义依赖删除成功，受限环境下测不出“还在不在”。 */
  const kept = JSON.parse(readFileSync(core.workerModelPath(root), "utf8"));
  assert.equal(kept.model, "glm-5.3", "别的线程的设定不能被这一段清掉");
  assert.equal(kept.shard, "s2");
});

test("补派沿用用户切过的模型，别的分片与阶段不受影响", () => {
  const { pinnedModelOf } = require(join(PKG, "dist/core/dispatch/pinModel.js"));
  const root = sandbox();
  const id = makeDispatch(root);
  switchModel(root, { id, model: "glm-5.3" });

  assert.equal(pinnedModelOf(root, "build", "s1"), "glm-5.3", "同一线程的补派要沿用");
  assert.equal(pinnedModelOf(root, "build", "s2"), "", "别的分片不受影响");
  assert.equal(pinnedModelOf(root, "review", "s1"), "", "阶段推进后回到契约取值");
});
