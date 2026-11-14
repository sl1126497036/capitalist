/**
 * 看板路由处理。
 *
 * 只做收发与入参校验，业务逻辑在 threads / views / commands 各层。
 */

import type { BoardCtx } from "../types";
import { appendJsonl, readJsonl } from "../../../core/json";
import { supervisorDir } from "../../../core/paths";
import { BOARD_WEB_TYPES } from "../assets";
import { rootFromUrl } from "../snapshot";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { all } from "../../../agent/registry";

/** /api/upload */
export function handleUpload(ctx: BoardCtx): void {
const peer = ctx.req.socket.remoteAddress ?? "";
const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
if (!loopback) {
  ctx.res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: "上传接口只接受本机回环地址" }));
  return;
}
if (ctx.req.method !== "POST") {
  ctx.res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
  ctx.res.end(JSON.stringify({ error: "只接受 POST" }));
  return;
}
let raw = "";
ctx.req.on("data", (chunk: Buffer) => {
  raw += chunk.toString("utf8");
  if (raw.length > 12_000_000) ctx.req.destroy();
});
ctx.req.on("end", () => {
  const json = (obj: unknown, code = 200): void => {
    ctx.res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    ctx.res.end(JSON.stringify(obj));
  };
  let payload: { name?: string; dataUrl?: string; thread?: string; tag?: string };
  try {
    payload = JSON.parse(raw) as { name?: string; dataUrl?: string; thread?: string; tag?: string };
  } catch {
    json({ error: "请求体不是合法 JSON" }, 400);
    return;
  }
  const dataUrl = String(payload.dataUrl ?? "");
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) {
    json({ error: "只接受 png / jpeg / webp / gif 的 base64 data URL" }, 400);
    return;
  }
  const mime = m[1] as string;
  const ext = mime === "image/jpeg" ? "jpg" : (mime.split("/")[1] as string);
  let buf: Buffer;
  try {
    buf = Buffer.from((m[2] as string).replace(/\s+/g, ""), "base64");
  } catch {
    json({ error: "base64 解码失败" }, 400);
    return;
  }
  if (buf.length === 0) {
    json({ error: "图片为空" }, 400);
    return;
  }
  if (buf.length > 8_000_000) {
    json({ error: `图片太大（${buf.length} 字节，上限 8MB）` }, 413);
    return;
  }
  try {
    const dir = join(supervisorDir(ctx.opts.root), "attachments");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const rand = Math.random().toString(36).slice(2, 8);
    const fileName = `${stamp}-${rand}.${ext}`;
    writeFileSync(join(dir, fileName), buf);
    const rel = `.capitalist/attachments/${fileName}`;
    const attMeta = {
      path: rel,
      at: new Date().toISOString(),
      bytes: buf.length,
      mime,
      thread: String(payload.thread ?? "").slice(0, 80),
      tag: String(payload.tag ?? "").slice(0, 40),
      name: String(payload.name ?? "").slice(0, 120),
    };
    appendJsonl(join(dir, "index.jsonl"), attMeta);
    json({ ok: true, path: rel, bytes: buf.length, mime, thread: attMeta.thread, tag: attMeta.tag });
  } catch (err) {
    json({ error: `保存失败：${String(err instanceof Error ? err.message : err)}` }, 500);
  }
});
return;
}

/** /api/attachment */
export function handleAttachment(ctx: BoardCtx): void {
const q = new URLSearchParams(ctx.url.slice(ctx.url.indexOf("?") + 1));
const want = String(q.get("path") || "").trim();
const root = rootFromUrl(ctx.url, ctx.opts.root);
const dir = resolve(supervisorDir(root), "attachments");
const full = resolve(root, want.replace(/^[\\/]+/, ""));
if (!want || (full !== dir && !full.startsWith(dir + sep))) {
  ctx.res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: "没有这张图" }));
  return;
}
try {
  const st = statSync(full);
  if (!st.isFile()) throw new Error("not a file");
  const ext = extname(full).toLowerCase();
  const type = BOARD_WEB_TYPES[ext];
  if (!type || !type.startsWith("image/")) throw new Error("not an image");
  const body = readFileSync(full);
  ctx.res.writeHead(200, {
    "content-type": type,
    "content-length": body.length,
    "cache-control": "private, max-age=86400",
  });
  ctx.res.end(body);
} catch {
  ctx.res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: "没有这张图" }));
}
return;
}

/** /api/attachments */
export function handleAttachments(ctx: BoardCtx): void {
try {
  const rows = readJsonl<{ path?: string; thread?: string; tag?: string; at?: string; name?: string }>(
    join(supervisorDir(ctx.opts.root), "attachments", "index.jsonl"),
  );
  const map: Record<string, { thread: string; tag: string; at: string; name: string }> = {};
  for (const r of rows) {
    const p = String(r.path ?? "");
    if (!p) continue;
    map[p] = {
      thread: String(r.thread ?? ""),
      tag: String(r.tag ?? ""),
      at: String(r.at ?? ""),
      name: String(r.name ?? ""),
    };
  }
  ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  ctx.res.end(JSON.stringify({ count: Object.keys(map).length, items: map }));
} catch {
  ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  ctx.res.end(JSON.stringify({ count: 0, items: {} }));
}
return;
}

/** /api/fs-list */
export function handleFsList(ctx: BoardCtx): void {
try {
  /** 该接口能列本机目录，只接受本机回环来源。 */
  const peer = ctx.req.socket.remoteAddress ?? "";
  const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  if (!loopback) {
    ctx.res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    ctx.res.end(JSON.stringify({ error: "目录浏览只接受本机回环地址" }));
    return;
  }
  const qs = ctx.url.indexOf("?") >= 0 ? new URLSearchParams(ctx.url.slice(ctx.url.indexOf("?") + 1)) : new URLSearchParams();
  const root = rootFromUrl(ctx.url, ctx.opts.root);
  const want = String(qs.get("path") ?? "").trim();
  const abs = want ? (isAbsolute(want) ? resolve(want) : resolve(root, want)) : root;
  const outside = !(abs === root || abs.startsWith(root + sep));
  const SKIP = new Set([".capitalist", ".git", "node_modules", ".tmp", ...all().map((h) => h.configDir)]);
  const entries = readdirSync(abs, { withFileTypes: true })
    .filter((e) => !SKIP.has(e.name) && !(e.name.startsWith(".") && e.name !== ".env"))
    .map((e) => {
      const full = join(abs, e.name);
      return {
        name: e.name,
        dir: e.isDirectory(),
        rel: outside ? full : relative(root, full).split(sep).join("/"),
        outside,
        size: e.isDirectory() ? 0 : (() => {
          try {
            return statSync(full).size;
          } catch {
            return 0;
          }
        })(),
      };
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    .slice(0, 500);
  ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  ctx.res.end(
    JSON.stringify({
      root,
      path: abs,
      rel: outside ? abs : relative(root, abs).split(sep).join("/"),
      outside,
      entries,
    }),
  );
} catch (err) {
  ctx.res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
}
return;
}
