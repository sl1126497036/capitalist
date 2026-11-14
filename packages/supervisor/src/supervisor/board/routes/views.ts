/**
 * 看板路由处理。
 *
 * 只做收发与入参校验，业务逻辑在 threads / views / commands 各层。
 */

import { BoardCtx, parseSince } from "../types";
import { buildForestView } from "../../forestView";
import { forestNoOf } from "../cmdContext";
import { overviewJson } from "../overview";
import { buildSnapshot, dispatchTitle, rootFromUrl } from "../snapshot";
import { modelsView } from "../models";
import { listTaskRoots } from "../sources";
import { ALERT_LIMIT_DEFAULT, buildAlerts, buildMetrics, buildSupervisorStatus, buildTaskSummaries, fitState } from "../views";

import { bindAttachments } from "../../../core/attachments";
import { CTX_WINDOW_PRESETS, ctxWindowSupported, isCtxWindowPreset, modelRealWindow, readCtxWindow, readCtxWindowChosen, writeCtxWindow } from "../../../core/limits";
import { attachmentsOfMessage } from "../../../core/messages";
import { listWorkers, readDispatches } from "../../../core/supervisor";
import { dismissChat, listUnhandled, settleChat } from "../../chatSettle";
import { appendSupervisorDirective } from "../../direct";
import { addMemory, deleteMemory, isMemoryKind, memorySnapshot, updateMemory } from "../../memory";
import { buildUsageLedger as usageLedger, workerUsageRow } from "../../usage";
import { buildSupervisorLog } from "../supervisorLog";
import { resolve } from "node:path";

/** /api/tasks */
export function handleTasks(ctx: BoardCtx): void {
try {
  const tasks = ctx.cachedView(`tasks:${ctx.opts.root}`, 4000, () => buildTaskSummaries(listTaskRoots(ctx.opts.root)));
  ctx.res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  ctx.res.end(JSON.stringify({ serverTime: new Date().toISOString(), tasks }));
} catch (err) {
  ctx.res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
}
return;
}

/** /api/forest */
export function handleForest(ctx: BoardCtx): void {
try {
  const root = rootFromUrl(ctx.url, ctx.opts.root);
  const view = buildForestView(root, forestNoOf(root));
  ctx.res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  ctx.res.end(JSON.stringify({ serverTime: new Date().toISOString(), ...view }));
} catch (err) {
  ctx.res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
}
return;
}

/** /api/metrics */
export function handleMetrics(ctx: BoardCtx): void {
try {
  const root = rootFromUrl(ctx.url, ctx.opts.root);
  const metrics = ctx.cachedView(`metrics:${root}`, 4000, () => buildMetrics(root));
  ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  ctx.res.end(JSON.stringify({ serverTime: new Date().toISOString(), root, ...metrics }));
} catch (err) {
  ctx.res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
}
return;
}

/** /api/overview */
export function handleOverview(ctx: BoardCtx): void {
try {
  const roots = listTaskRoots(ctx.opts.root);
  const fresh = new URL(ctx.url, "http://x").searchParams.has("fresh");
  ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  ctx.res.end(overviewJson(roots, fresh));
} catch (err) {
  ctx.res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
}
return;
}

/** /api/usage */
export function handleUsage(ctx: BoardCtx): void {
try {
  const root = rootFromUrl(ctx.url, ctx.opts.root);
  const ledger = ctx.cachedView(`usage:${root}`, 3000, () => usageLedger(root));
  const titles = new Map(readDispatches(root).map((d) => [d.id, dispatchTitle(d)] as const));
  const byDispatch = ledger.by_dispatch.map((r) => ({ ...r, title: titles.get(r.id) ?? "" }));
  ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  ctx.res.end(
    JSON.stringify({
      serverTime: new Date().toISOString(),
      root,
      ...ledger,
      by_dispatch: byDispatch,
    }),
  );
} catch (err) {
  ctx.res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
}
return;
}

/** /api/mq */
export function handleMq(ctx: BoardCtx): void {
const peer = ctx.req.socket.remoteAddress ?? "";
const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
if (!loopback) {
  ctx.res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: "申报接口只接受本机回环地址" }));
  return;
}
ctx.req.resume(); // 丢弃请求体（内容以文件为准）
ctx.req.on("end", () => {
  try {
    ctx.opts.onMq?.();
  } catch {
  }
  ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  ctx.res.end(JSON.stringify({ ok: true }));
});
return;
}

/** 告警响应字节上限：超出时从最旧一条开始丢弃，避免响应体过大拖慢前端。 */
const ALERT_MAX_BYTES = 30_000;

/** /api/alerts */
export function handleAlerts(ctx: BoardCtx): void {
try {
  const q =
    ctx.url.indexOf("?") >= 0 ? new URLSearchParams(ctx.url.slice(ctx.url.indexOf("?") + 1)) : new URLSearchParams();
  const lvlParam = q.get("level");
  const level = lvlParam === "P0" || lvlParam === "P1" || lvlParam === "P2" ? lvlParam : undefined;
  const rawLimit = Number(q.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : undefined;
  const sinceRaw = (q.get("since") ?? "").trim();
  const since: number | string | undefined = parseSince(sinceRaw) ?? (sinceRaw || undefined);
  const root = rootFromUrl(ctx.url, ctx.opts.root);

  const { alerts, unread, total, has_more, next_since } = buildAlerts(root, { level, limit, since });
  const payload = {
    serverTime: new Date().toISOString(),
    level: level ?? "all",
    since: since ?? 0,
    limit: limit ?? ALERT_LIMIT_DEFAULT,
    total,
    has_more,
    truncated: total > alerts.length,
    next_since,
    unread,
    alerts,
  };
  while (Buffer.byteLength(JSON.stringify(payload), "utf8") > ALERT_MAX_BYTES && payload.alerts.length > 0) {
    payload.alerts.pop();
    payload.truncated = true;
  }
  payload.has_more = payload.total > payload.alerts.length;
  ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  ctx.res.end(JSON.stringify(payload));
} catch (err) {
  ctx.res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
}
return;
}

/** /api/unhandled */
export function handleUnhandled(ctx: BoardCtx): void {
const jsonReply = (obj: unknown, code = 200): void => {
  ctx.res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  ctx.res.end(JSON.stringify(obj));
};
let root = ctx.opts.root;
try {
  root = rootFromUrl(ctx.url, ctx.opts.root);
} catch (err) {
  jsonReply({ error: String(err instanceof Error ? err.message : err) }, 500);
  return;
}
if (ctx.req.method !== "POST") {
  try {
    jsonReply({ ok: true, root, items: listUnhandled(root) });
  } catch (err) {
    jsonReply({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
  return;
}
const peer = ctx.req.socket.remoteAddress ?? "";
const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
if (!loopback) {
  jsonReply({ error: "该接口只接受本机回环地址" }, 403);
  return;
}
let raw = "";
ctx.req.on("data", (chunk: Buffer) => {
  raw += chunk.toString("utf8");
  if (raw.length > 10_000) ctx.req.destroy();
});
ctx.req.on("end", () => {
  let body: Record<string, unknown> = {};
  try {
    body = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    jsonReply({ error: "请求体不是合法 JSON" }, 400);
    return;
  }
  const wanted = typeof body.root === "string" && body.root.trim() ? resolve(body.root.trim()) : "";
  const targetRoot = wanted && listTaskRoots(ctx.opts.root).includes(wanted) ? wanted : ctx.opts.root;
  const msgId = String(body.msg_id ?? "").trim();
  const op = String(body.op ?? "").trim();
  if (!msgId) {
    jsonReply({ error: "msg_id 必填" }, 400);
    return;
  }
  try {
    const hit = listUnhandled(targetRoot).find((u) => u.msg_id === msgId);
    if (!hit) {
      jsonReply({ error: "这条发言已处置，或不在未建单列表里" }, 409);
      return;
    }
    if (op === "dismiss") {
      dismissChat(targetRoot, { msg_id: msgId });
      jsonReply({ ok: true, root: targetRoot, msg_id: msgId, items: listUnhandled(targetRoot) });
      return;
    }
    if (op === "dispatch") {
      const atts = attachmentsOfMessage(targetRoot, msgId) ?? [];
      const arg = bindAttachments(hit.text, atts).text;
      const w = appendSupervisorDirective(targetRoot, {
        action: "dispatch",
        arg,
        confirm: true,
        via: "user",
        msg_id: msgId,
        atts,
      });
      if (!w.ok) {
        jsonReply({ error: `建单失败：${w.error}`, root: targetRoot, msg_id: msgId }, 400);
        return;
      }
      settleChat(targetRoot, {
        msg_id: msgId,
        verdict: "dispatched",
        text: hit.text,
        thread: hit.thread,
        dispatch: String(w.rec?.id ?? ""),
        action: "dispatch",
      });
      jsonReply({
        ok: true,
        root: targetRoot,
        msg_id: msgId,
        directive: String(w.rec?.id ?? ""),
        items: listUnhandled(targetRoot),
      });
      return;
    }
    jsonReply({ error: `未知操作：${op || "(空)"}（dispatch / dismiss）` }, 400);
  } catch (err) {
    jsonReply({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
return;
}

/** /api/memory */
export function handleMemory(ctx: BoardCtx): void {
const peer = ctx.req.socket.remoteAddress ?? "";
const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
const jsonReply = (obj: unknown, code = 200): void => {
  ctx.res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  ctx.res.end(JSON.stringify(obj));
};
if (ctx.req.method !== "POST") {
  try {
    const root = rootFromUrl(ctx.url, ctx.opts.root);
    jsonReply({ ok: true, root, ...memorySnapshot(root) });
  } catch (err) {
    jsonReply({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
  return;
}
if (!loopback) {
  jsonReply({ error: "记忆接口只接受本机回环地址" }, 403);
  return;
}
let raw = "";
ctx.req.on("data", (chunk: Buffer) => {
  raw += chunk.toString("utf8");
  if (raw.length > 20_000) ctx.req.destroy();
});
ctx.req.on("end", () => {
  let body: Record<string, unknown> = {};
  try {
    body = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    jsonReply({ error: "请求体不是合法 JSON" }, 400);
    return;
  }
  const wanted = typeof body.root === "string" && body.root.trim() ? resolve(body.root.trim()) : "";
  const root = wanted && listTaskRoots(ctx.opts.root).includes(wanted) ? wanted : ctx.opts.root;
  const op = String(body.op ?? "").trim();
  const id = String(body.id ?? "").trim();
  const note = String(body.note ?? "");
  const kind = isMemoryKind(body.kind) ? body.kind : undefined;
  try {
    if (op === "add") {
      if (!note.trim()) {
        jsonReply({ error: "note 必填" }, 400);
        return;
      }
      if (body.kind !== undefined && !kind) {
        jsonReply({ error: "kind 只能是 habit / blocker" }, 400);
        return;
      }
      const made = addMemory(root, note, kind ?? "habit");
      if (!made) {
        jsonReply({ error: "正文为空，没有可保存的内容" }, 400);
        return;
      }
      jsonReply({ ok: true, root, id: made.id, ...memorySnapshot(root) });
      return;
    }
    if (op === "update") {
      if (!id) {
        jsonReply({ error: "id 必填" }, 400);
        return;
      }
      if (body.kind !== undefined && !kind) {
        jsonReply({ error: "kind 只能是 habit / blocker" }, 400);
        return;
      }
      const next = updateMemory(root, id, { ...(body.note !== undefined ? { note } : {}), ...(kind ? { kind } : {}) });
      if (!next) {
        jsonReply({ error: "条目不存在，或改完正文为空" }, 400);
        return;
      }
      jsonReply({ ok: true, root, id: next.id, ...memorySnapshot(root) });
      return;
    }
    if (op === "delete") {
      if (!id) {
        jsonReply({ error: "id 必填" }, 400);
        return;
      }
      const gone = deleteMemory(root, id);
      jsonReply({ ok: gone, root, id, ...memorySnapshot(root), ...(gone ? {} : { error: "条目不存在" }) }, gone ? 200 : 404);
      return;
    }
    jsonReply({ error: `未知操作：${op || "(空)"}（add / update / delete）` }, 400);
  } catch (err) {
    jsonReply({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
return;
}

/** /api/ctx-window */
export function handleCtxWindow(ctx: BoardCtx): void {
const peer = ctx.req.socket.remoteAddress ?? "";
const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
if (!loopback) {
  ctx.res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: "该接口只接受本机回环地址" }));
  return;
}
const reply = (code: number, body: unknown): void => {
  ctx.res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  ctx.res.end(JSON.stringify(body));
};
/* 作用域：supervisor 是监工自己，其余为工作进程 id；监工与各工作进程互不影响。 */
const q = ctx.url.indexOf("?") >= 0 ? new URLSearchParams(ctx.url.slice(ctx.url.indexOf("?") + 1)) : new URLSearchParams();
const scopeOfQuery = (): string => {
  const s = String(q.get("scope") ?? "").trim();
  return s || "supervisor";
};
const modelOfScope = (scope: string): string => {
  if (scope === "supervisor" || scope === "default") return String(buildSupervisorStatus(ctx.opts.root).model ?? "");
  const w = listWorkers(ctx.opts.root).find((x) => String(x.id) === scope);
  return w ? String(workerUsageRow(w).model ?? "") : "";
};
if (ctx.req.method === "GET") {
  const scope = scopeOfQuery();
  const curModel = modelOfScope(scope);
  reply(200, {
    scope,
    window: readCtxWindow(ctx.opts.root, scope),
    chosen: readCtxWindowChosen(ctx.opts.root, scope),
    default: readCtxWindowChosen(ctx.opts.root, "default"),
    presets: CTX_WINDOW_PRESETS,
    model: curModel,
    real: modelRealWindow(curModel, null),
  });
  return;
}
if (ctx.req.method !== "POST") {
  ctx.res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET, POST" });
  ctx.res.end(JSON.stringify({ error: "只接受 GET / POST" }));
  return;
}
let body = "";
ctx.req.on("data", (c: Buffer) => {
  body += c.toString("utf8");
  if (body.length > 10_000) ctx.req.destroy();
});
ctx.req.on("end", () => {
  let parsed: { window?: number; force?: boolean; scope?: string } = {};
  try {
    parsed = body.trim() ? (JSON.parse(body) as typeof parsed) : {};
  } catch {
    reply(400, { error: "JSON 解析失败" });
    return;
  }
  const want = Math.round(Number(parsed.window));
  if (!isCtxWindowPreset(want)) {
    reply(400, { error: "只能是 300k / 600k / 1M 三档" });
    return;
  }
  const scope = String(parsed.scope ?? "").trim() || scopeOfQuery();
  const curModel = modelOfScope(scope);
  const check = ctxWindowSupported(curModel, null, want);
  if (!check.supported && !parsed.force) {
    reply(409, {
      supported: false,
      scope,
      window: want,
      real: check.real,
      model: curModel,
      message: check.real
        ? `${curModel} 的窗口是 ${Math.round(check.real / 1000)}k，设不到 ${Math.round(want / 1000)}k。`
        : `${curModel} 没有窗口读数，无法确认是否支持 ${Math.round(want / 1000)}k。`,
    });
    return;
  }
  const ok = writeCtxWindow(ctx.opts.root, want, scope);
  reply(ok ? 200 : 500, { ok, scope, window: want, supported: check.supported });
});
return;
}

/** /api/supervisor */
export function handleSupervisor(ctx: BoardCtx): void {
try {
  const view = ctx.cachedView(`supervisorview:${ctx.opts.root}`, 1200, () => buildSupervisorStatus(ctx.opts.root));
  ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  ctx.res.end(JSON.stringify({ serverTime: new Date().toISOString(), ...view }));
} catch (err) {
  ctx.res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
}
return;
}

/** /api/supervisor/self */
export function handleSupervisorSelf(ctx: BoardCtx): void {
try {
  const root = rootFromUrl(ctx.url, ctx.opts.root);
  const view = ctx.cachedView(`supervisorstatus:${root}`, 1500, () => buildSupervisorStatus(root));
  ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  ctx.res.end(JSON.stringify({ serverTime: new Date().toISOString(), root, ...view }));
} catch (err) {
  ctx.res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
}
return;
}

/** /api/capitalist-events */
export function handleCapitalistEvents(ctx: BoardCtx): void {
try {
  const root = rootFromUrl(ctx.url, ctx.opts.root);
  const q = ctx.url.indexOf("?") >= 0 ? new URLSearchParams(ctx.url.slice(ctx.url.indexOf("?") + 1)) : new URLSearchParams();
  const want = Number(q.get("limit"));
  const limit = Number.isFinite(want) && want > 0 ? Math.floor(want) : 120;
  /** hours 不传按 6 小时，传 0 表示不限；解析不了按未传处理。 */
  const hRaw = Number(q.get("hours"));
  const hours = q.has("hours") && Number.isFinite(hRaw) && hRaw >= 0 ? hRaw : undefined;
  const log = buildSupervisorLog(root, { limit, ...(hours === undefined ? {} : { hours }) });
  ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  ctx.res.end(JSON.stringify({ serverTime: new Date().toISOString(), root, ...log }));
} catch (err) {
  ctx.res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
}
return;
}

/** /api/models */
export function handleModels(ctx: BoardCtx): void {
try {
  const qs = ctx.url.indexOf("?") >= 0 ? new URLSearchParams(ctx.url.slice(ctx.url.indexOf("?") + 1)) : null;
  const root = rootFromUrl(ctx.url, ctx.opts.root);
  const view = modelsView(root, qs?.get("fresh") === "1");
  ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  ctx.res.end(JSON.stringify({ root, ...view }));
} catch (err) {
  ctx.res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
}
return;
}

/** /api/state */
export function handleState(ctx: BoardCtx): void {
try {
  const root = rootFromUrl(ctx.url, ctx.opts.root);
  const snap = ctx.cachedView(`snapshot:${root}`, 4000, () => buildSnapshot(root));
  ctx.res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  ctx.res.end(fitState(snap));
} catch (err) {
  ctx.res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
}
return;
}
