/**
 * 看板前端产物的托管。
 *
 * 产物由 web/ 构建到 dist/board-web，本模块只做路径收敛与缓存头；
 * 找不到产物时返回可读的说明页，不返回空白 404。
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

import { readJson, writeJson } from "../../core/record/json";
import { supervisorDir } from "../../core/record/paths";
import { loadSupervisor } from "../../core/record/supervisor";

export function etagOf(body: string): string {
  return `"${createHash("sha256").update(body, "utf8").digest("hex").slice(0, 20)}"`;
}

export function sendAsset(
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  etag: string,
  type: string,
  maxAge: number,
): void {
  const inm = req.headers["if-none-match"];
  const matched =
    typeof inm === "string" && inm.split(",").some((v) => v.trim() === etag);
  if (matched) {
    res.writeHead(304, { etag, "cache-control": `public, max-age=${maxAge}` });
    res.end();
    return;
  }
  res.writeHead(200, {
    "content-type": type,
    "content-length": Buffer.byteLength(body, "utf8"),
    "cache-control": `public, max-age=${maxAge}`,
    etag,
  });
  res.end(body);
}

/**
 * 监工对话层最近一次实际使用的模型，单独落一个文件。
 *
 * 不写 `supervisor.json`：监工每轮调度 用内存快照整份写回该文件，只同步 `supervisor_model`
 * 与上下文上限，别的字段会被抹掉。`supervisor_model` 为空时面板靠这份记录标出具体模型。
 */
export function supervisorModelUsedFile(root: string): string {
  return join(supervisorDir(root), "capitalist-model-used.json");
}

export function noteSupervisorModelUsed(root: string, model: string): void {
  const m = String(model || "").trim();
  if (!m) return;
  try {
    /* 显式指定了模型时跑的就是它，不是宿主默认，记了会把“宿主默认”标错行。 */
    if (String(loadSupervisor(root)?.supervisor_model ?? "").trim()) return;
    const cur = readJson<{ model?: string }>(supervisorModelUsedFile(root), {});
    if (String(cur?.model ?? "") === m) return;
    writeJson(supervisorModelUsedFile(root), { model: m, at: new Date().toISOString() });
  } catch {
    /* 记不住不影响这一轮对话本身。 */
  }
}

export function readSupervisorModelUsed(root: string): string {
  try {
    const d = readJson<{ model?: string }>(supervisorModelUsedFile(root), {});
    return String(d?.model ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * 前端产物缺失时的提示页。
 *
 * 看板只提供 Vue 版本，页面由 `dist/board-web` 托管；产物未构建时给出可执行命令，
 * 不再回落到内联页面。API 路由不受影响，命令行与看板接口保持可用。
 */
export function missingBoardWebPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>capitalist · 看板前端未构建</title>
<style>
body{margin:0;padding:48px 24px;font:14px/1.7 -apple-system,"Segoe UI",sans-serif;color:#1f2328;background:#f6f7f9}
main{max-width:640px;margin:0 auto}
h1{font-size:18px;margin:0 0 12px}
p{margin:0 0 12px;color:#4b5563}
code{display:block;padding:10px 12px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
</style>
</head>
<body>
<main>
<h1>看板前端未构建</h1>
<p>服务已启动，缺少页面产物 <code style="display:inline;padding:2px 6px">dist/board-web/index.html</code>。</p>
<p>在项目内执行构建，然后刷新本页：</p>
<code>cd packages/supervisor &amp;&amp; npm run build:web</code>
<p>API 与命令行不受影响。</p>
</main>
</body>
</html>`;
}

export function boardWebDir(): string {
  /* 本文件编译后在 dist/supervisor/board/，前端产物在 dist/board-web/，上两级才是 dist。 */
  return join(__dirname, "..", "..", "board-web");
}

export const BOARD_WEB_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** resolve 之后路径必须仍在 board-web 目录内，目录索引与隐藏文件一律拒绝。 */
export function serveBoardWeb(req: IncomingMessage, res: ServerResponse, url: string): boolean {
  const base = resolve(boardWebDir());
  const rawPath = url.split(/[?#]/)[0] ?? "/";
  let rel: string;
  try {
    rel = decodeURIComponent(rawPath);
  } catch {
    return false;
  }
  if (rel === "" || rel === "/") rel = "/index.html";
  // 前导 / 先换成 ./ 再 resolve，否则会被当成盘符根并越过产物目录。
  const full = resolve(base, `.${rel}`);
  if (full !== base && !full.startsWith(base + sep)) return false;

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(full);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;

  const ext = extname(full).toLowerCase();
  const type = BOARD_WEB_TYPES[ext];
  if (!type) return false;

  const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const inm = req.headers["if-none-match"];
  if (typeof inm === "string" && inm.split(",").some((v) => v.trim() === etag)) {
    res.writeHead(304, { etag, "cache-control": "no-cache" });
    res.end();
    return true;
  }
  const body = readFileSync(full);
  const cache = ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable";
  res.writeHead(200, {
    "content-type": type,
    "content-length": body.length,
    "cache-control": cache,
    etag,
  });
  res.end(body);
  return true;
}
