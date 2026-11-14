/**
 * 看板服务端共享类型：启动参数、启动结果与路由上下文。
 *
 * 路由处理函数只认这份契约，不引用 index.ts，避免入口与路由互相依赖。
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";

export interface ServeOptions {
  root: string;
  port?: number | undefined;
  host?: string | undefined;
  maxPortTries?: number;
  newKey?: boolean;
  /** 安全模式：校验访问 key。缺省关闭。 */
  secure?: boolean | undefined;
  /**
   * 宿主令牌，启动监工时一次性传入，仅在内存持有。
   *
   * 监工进程通常无法获取宿主登录态文件的读取权限（桌面端对本机文件访问单独授权）。
   * 返回空值将导致对话通道与工作进程同时认证失败；由启动方传入时不再读取文件。
   */
  token?: string | undefined;
  out?: (line: string) => void;
  onMq?: () => void;
}

export interface Served {
  server: Server;
  url: string;
  port: number;
  close: () => void;
}

/** 单次请求的共享上下文：路由函数只从这里取依赖。 */
export interface BoardCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: string;
  opts: ServeOptions;
  /** 短时视图缓存：同一轮轮询里多个视图只算一次。 */
  cachedView: <T>(key: string, ttlMs: number, build: () => T) => T;
}

/** 统一的 JSON 响应：写头 + 序列化，避免每个路由重复三行样板。 */
export function sendJson(ctx: BoardCtx, body: unknown, code = 200): void {
  ctx.res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  ctx.res.end(JSON.stringify(body));
}

/** 统一的错误响应：路由内 catch 一律走这里，错误文案与前端约定保持一致。 */
export function sendError(ctx: BoardCtx, err: unknown, code = 500): void {
  sendJson(ctx, { error: String(err instanceof Error ? err.message : err) }, code);
}

/** 解析 since 游标：支持秒、毫秒与 ISO 时间串，统一返回秒。 */
export function parseSince(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  const num = Number(text);
  if (Number.isFinite(num)) {
    if (num <= 0) return undefined;
    return num > 1e12 ? num / 1000 : num;
  }
  const ts = Date.parse(text);
  return Number.isFinite(ts) && ts > 0 ? ts / 1000 : undefined;
}
