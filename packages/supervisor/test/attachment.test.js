/** 取图接口对 `<img>` 必须可用。 */

const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const PKG = resolve(__dirname, "..");
const board = require(join(PKG, "dist/supervisor/board.js"));
const { createTaskRoot } = require(join(PKG, "dist/core/init.js"));
const { supervisorDir } = require(join(PKG, "dist/core/paths.js"));

/** 1x1 透明 PNG；接口按扩展名发 content-type，不校验像素内容。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "capitalist-att-"));
  createTaskRoot({ target: "取图", contractSpec: "minimal", root, supervisor: false });
  const dir = join(supervisorDir(root), "attachments");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "shot.png"), PNG);
  return root;
}

test("取图接口：<img> 形状的请求能拿到图，安全模式仍需 key，越界仍然被拒", async () => {
  const root = sandbox();
  let served = null;
  try {
    served = await board.serveBoard({ root, port: 0, out: () => {} });
    const port = served.server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const key = readFileSync(join(supervisorDir(root), "board.key"), "utf8").trim();
    const cookie = `supervisor_board_key=${key}`;

    const get = (path, headers = {}) => fetch(`${base}${path}`, {headers, redirect: "manual"});

    /* 1. 浏览器给 <img> 发的就是这种请求：只有 cookie，没有自定义头。 */
    const ok = await get("/api/attachment?path=.capitalist/attachments/shot.png", {cookie});
    assert.equal(ok.status, 200, "带 cookie 的图片 GET 不应被 x-capitalist-client 校验拦下");
    assert.match(String(ok.headers.get("content-type")), /^image\/png/);
    assert.equal(Buffer.from(await ok.arrayBuffer()).length, PNG.length);

    /* 2. 缺省不校验 key：不带 cookie 的取图请求同样放行。 */
    const noCookie = await get("/api/attachment?path=.capitalist/attachments/shot.png");
    assert.equal(noCookie.status, 200, "缺省不校验 key");

    /* 3. 文件真没了才是 404。 */
    const missing = await get("/api/attachment?path=.capitalist/attachments/none.png", {cookie});
    assert.equal(missing.status, 404);

    /* 4. 路径白名单没被放开：`.capitalist/` 下其它文件照样取不到。 */
    const escape = await get("/api/attachment?path=.capitalist/state.json", {cookie});
    assert.equal(escape.status, 404, "只能取 attachments 目录里的图片");
  } finally {
    served?.close();
  }

  /* 5. 安全模式仍需 key：仅靠 cookie 之外的门槛，不因缺省放行而失效。 */
  let guarded = null;
  try {
    guarded = await board.serveBoard({ root, port: 0, secure: true, out: () => {} });
    const port = guarded.server.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/api/attachment?path=.capitalist/attachments/shot.png`, {
      redirect: "manual",
    });
    assert.equal(r.status, 401, "安全模式下没有 key 的取图请求必须 401");
  } finally {
    guarded?.close();
    rmSync(root, {recursive: true, force: true});
  }
});
