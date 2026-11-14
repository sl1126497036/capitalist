/**
 * 看板访问控制：安全模式下的访问 key、同源判定与数据接口的客户端标识。
 *
 * key 与开关只在本模块持有，看板启动时经 configureBoardAuth 写入一次，
 * 其余模块读 boardKeyOf / boardSecureOn，不直接改这两个值。
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let boardKey = "";
/**
 * 是否校验访问 key（安全模式）。
 *
 * 缺省关闭。看板仅监听回环地址，缺省无需 key。需区分本机其它用户，或看板以 `capitalist board --host`
 * 对外开放时，启动传 `--secure`。关闭时不做 key 比对，同源判定与客户端标识头仍生效。
 */
let boardSecure = false;
export const BOARD_KEY_COOKIE = "supervisor_board_key";

export function boardKeyPath(root: string): string {
  return join(root, ".capitalist", "board.key");
}

export function loadOrCreateBoardKey(root: string, forceNew: boolean): string {
  const p = boardKeyPath(root);
  if (!forceNew) {
    try {
      const old = readFileSync(p, "utf8").trim();
      if (old.length >= 16) return old;
    } catch {
    }
  }
  const key = randomBytes(18).toString("base64url");
  try {
    mkdirSync(join(root, ".capitalist"), { recursive: true });
    writeFileSync(p, `${key}\n`, "utf8");
  } catch {
  }
  return key;
}

/** 常数时间比较，长度不同直接判否。 */
export function keyEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export function needKeyPage(): string {
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>capitalist · 需要访问 key</title>",
    "<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;",
    "background:#0b1020;color:#c8d3e6;font:14px/1.7 system-ui,-apple-system,'Segoe UI',sans-serif}",
    ".box{max-width:560px;padding:32px 36px;border:1px solid #24304a;border-radius:12px;background:#111830}",
    "h1{margin:0 0 12px;font-size:16px;font-weight:600;color:#e6edf8}",
    "p{margin:8px 0;color:#8fa1bd}code{font-family:ui-monospace,Menlo,Consolas,monospace;",
    "background:#1a2338;padding:2px 6px;border-radius:4px;color:#9ecbff}</style></head><body>",
    '<div class="box"><h1>需要访问 key</h1>',
    "<p>安全模式下需要提供访问 key，每次启动生成新的 key，并输出到启动日志。</p>",
    "<p>带 key 打开一次后，浏览器以会话 cookie 保存，关闭浏览器后失效：</p>",
    "<p><code>http://&lt;主机&gt;:&lt;端口&gt;/?key=&lt;访问 key&gt;</code></p>",
    "<p>访问 key 也可从启动监工终端输出的 <code>board_url</code> 或 <code>capitalist status</code> 读取。</p>",
    "</div></body></html>",
  ].join("");
}

export function sameOrigin(req: IncomingMessage): boolean {
  const origin = String(req.headers.origin ?? "").trim();
  if (!origin) return true;
  const host = String(req.headers.host ?? "").trim();
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function isImageGet(req: IncomingMessage, url: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  return url === "/api/attachment" || url.startsWith("/api/attachment?");
}

export function hasClientHeader(req: IncomingMessage, url: string): boolean {
  if (url.startsWith("/stream")) return true;
  return String(req.headers["x-capitalist-client"] ?? "").trim() === "board";
}

export function guardBoardAccess(req: IncomingMessage, res: ServerResponse, url: string): boolean {
  const cookie = String(req.headers.cookie ?? "");
  const hasCookie = cookie.split(";").some((c) => c.trim() === `${BOARD_KEY_COOKIE}=${boardKey}`);
  const isData = url.startsWith("/api/") || url === "/health" || url.startsWith("/stream");
  /* 非安全模式不校验 key，与持有 cookie 走同一分支；同源判定与客户端标识头仍生效。 */
  if (hasCookie || !boardSecure) {
    if (!sameOrigin(req)) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "来源不匹配：只接受与看板同源的请求" }));
      return false;
    }
    /** 数据接口要求自定义头，跨源请求会先触发 OPTIONS 预检，预检同样过鉴权。 */
    if (isData && !hasClientHeader(req, url) && !isImageGet(req, url)) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "缺少客户端标识头 x-capitalist-client" }));
      return false;
    }
    return true;
  }

  const qs = url.indexOf("?") >= 0 ? new URLSearchParams(url.slice(url.indexOf("?") + 1)) : null;
  const given = String(qs?.get("key") ?? "").trim();
  if (given && keyEquals(given, boardKey)) {
    /** 种下 cookie 后从地址栏清除 key。 */
    const u = new URL(url, "http://placeholder");
    u.searchParams.delete("key");
    const loc = `${u.pathname}${u.search}` || "/";
    res.writeHead(302, {
      location: loc,
      /* 会话 cookie：不设 Max-Age，关闭浏览器即失效。 */
      "set-cookie": `${BOARD_KEY_COOKIE}=${boardKey}; Path=/; HttpOnly; SameSite=Lax`,
      "cache-control": "no-store",
    });
    res.end();
    return false;
  }

  if (isData) {
    res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "需要访问 key：用启动时打印的带 ?key= 的地址打开看板" }));
  } else {
    res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(needKeyPage());
  }
  return false;
}
/** 写入本次启动的访问 key 与安全模式开关。看板启动时调用一次。 */
export function configureBoardAuth(key: string, secure: boolean): void {
  boardKey = key;
  boardSecure = secure;
}

/** 启动日志拼访问地址时需要当前 key。 */
export function boardKeyOf(): string {
  return boardKey;
}

/** 日志据此决定是否打印带 key 的地址。 */
export function boardSecureOn(): boolean {
  return boardSecure;
}
