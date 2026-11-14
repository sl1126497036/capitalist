/**
 * 看板路由处理：把 HTTP 请求翻译成视图与命令调用。
 *
 * 只做收发与入参校验，业务逻辑在 threads / views / commands 各层。
 */

import { parseSince, type BoardCtx } from "../types";
import { activeTakeover } from "../../../core/dispatch/commands";
import { lockStatus } from "../../../core/record/fileLock";
import { listWorkers, readDispatches } from "../../../core/record/supervisor";
import { balanceView } from "../../usage/balance";
import { stripDispatchEcho } from "../../view/msgView";
import { readJsonlFromTail } from "../logs";
import { buildThreadMessages } from "../messages";
import { fingerprint } from "../render";
import { THREAD_PAGE_LIMIT, ThreadRole, ThreadKind, ThreadMessage, rootFromUrl } from "../snapshot";
import { eventsFile } from "../sources";
import { buildThreadsPage, markThreadSeen } from "../threads";

/** /api/threads */
export function handleThreads(ctx: BoardCtx): void {
  try {
    const root = rootFromUrl(ctx.url, ctx.opts.root);
    const q = ctx.url.indexOf("?") >= 0 ? new URLSearchParams(ctx.url.slice(ctx.url.indexOf("?") + 1)) : new URLSearchParams();
    const want = Number(q.get("limit"));
    const limit = Number.isFinite(want) && want > 0 ? Math.min(Math.floor(want), 500) : THREAD_PAGE_LIMIT;
    const page = ctx.cachedView(`threads:${root}:${limit}`, 4000, () => buildThreadsPage(root, limit));
    const now = new Date().toISOString();
    const balance = balanceView(root);
    ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    ctx.res.end(
      JSON.stringify({
        serverTime: now,
        lastUpdated: now,
        root,
        takeover: activeTakeover(root),
        ...page.totals,
        credit: balance.credit,
        credit_used: balance.credit_used,
        credit_left: balance.credit,
        credit_unit: balance.credit_unit,
        credit_at: balance.at,
        credit_source: balance.source,
        credit_stale: balance.stale,
        balance,
        credit_unavailable_reason: balance.reason,
        file_locks: (() => {
          try {
            const { locks } = lockStatus(root);
            const nowMs = Date.now();
            return {
              count: locks.length,
              items: locks.slice(0, 20).map((e) => {
                const beat = Date.parse(e.beat);
                return {
                  path: e.path,
                  mode: e.mode,
                  holder: e.holder,
                  since: e.since,
                  age_sec: Number.isFinite(beat) ? Math.max(0, Math.round((nowMs - beat) / 1000)) : -1,
                };
              }),
            };
          } catch {
            return { count: 0, items: [] };
          }
        })(),
        total: page.total,
        truncated: page.truncated,
        counts: page.counts,
        threads: page.threads,
      }),
    );
  } catch (err) {
    ctx.res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    ctx.res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
  }
  return;
}

/** /api/thread：单线程消息流，含工作进程会话。 */
export function handleThreadMessage(ctx: BoardCtx): void {
  if (ctx.url.startsWith("/api/thread")) {
  const q = ctx.url.indexOf("?") >= 0 ? new URLSearchParams(ctx.url.slice(ctx.url.indexOf("?") + 1)) : new URLSearchParams();
  const id = q.get("id");
  if (!id) {
    ctx.res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    ctx.res.end(JSON.stringify({ error: "缺少 id 参数" }));
    return;
  }
  const root = rootFromUrl(ctx.url, ctx.opts.root);
  const limitRaw = Number(q.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 2000) : 400;
  const since = parseSince(q.get("since")) ?? 0;
  try {
    const base = buildThreadMessages(root, id, q.get("shard") ?? "", { limit, since });
    /** 工作进程会话的对话记在 events.jsonl 并带 thread 标识，需并入消息流。 */
    const talkIds = ((): Set<string> => {
      if (!id.includes("/")) return new Set([id]);
      const parts = id.split("/");
      const st = String(parts[0] ?? "").trim().toLowerCase();
      const tail = String(parts[1] ?? "").trim().toLowerCase();
      const workers = listWorkers(root);
      const isLineage =
        /^x[0-9a-z]{3,}$/.test(tail) &&
        !workers.some((w) => String(w.shard ?? "").trim().toLowerCase() === tail);
      const sh = tail === "main" || isLineage ? "" : tail;
      const linTail = isLineage ? tail.slice(1) : "";
      const rows = linTail ? readDispatches(root) : [];
      return new Set([
        id,
        ...workers
          .filter((w) => {
            if (String(w.stage || "").trim().toLowerCase() !== st) return false;
            if (sh) return String(w.shard ?? "").trim().toLowerCase() === sh;
            if (String(w.shard ?? "").trim()) return false;
            if (!linTail) return true;
            const d = w.dispatch ? rows.find((x) => x.id === w.dispatch) : undefined;
            return String((d as { lineage?: string } | undefined)?.lineage ?? "").endsWith(linTail);
          })
          .map((w) => w.id),
      ]);
    })();
    const talkRows = readJsonlFromTail(eventsFile(root), 2_000_000).filter((e) => {
      const n = String(e.event ?? e.kind ?? "");
      return (n === "supervisor_chat_ask" || n === "supervisor_reply") && talkIds.has(String(e.thread ?? ""));
    });
    /** 同一句用户发言会落 supervisor_chat_ask 与 direct.jsonl 两条记录，按正文归一判同去重。 */
    const normTalk = (s: unknown): string =>
      String(s ?? "")
        .replace(/^\[附件\][^\n]*$/gm, "")
        .replace(/\s+/g, "")
        .toLowerCase();
    const saidRows = base.messages.filter((m) => m.role === "user" && m.kind === "say");
    const said = new Set(saidRows.map((m) => normTalk(m.text)));
    const mergeActedEcho = (
      e: Record<string, unknown>,
      role: ThreadRole,
    ): ThreadMessage | null => {
      const replyText = String(e.reply ?? "");
      const body = String((e as { dispatch_text?: unknown }).dispatch_text ?? e.want ?? "");
      const leftover = stripDispatchEcho(replyText, body);
      const atN = Date.parse(String(e.at ?? "")) || 0;
      /** 同一时间窗（10 秒）内才算同一条。 */
      const near = (m: ThreadMessage): boolean =>
        Math.abs((Date.parse(String(m.at ?? "")) || 0) - atN) < 10_000;
      const hit = body
        ? base.messages.find((m) => {
            if (!near(m)) return false;
            if (m.kind === "say" && m.role === "supervisor") {
              return normTalk(m.text) === normTalk(`amend ${body}`);
            }
            if (m.kind === "verdict") {
              const vt = String(m.text ?? "");
              const bodyClean = normTalk(body.replace(/^\s*#\s*\d{1,4}\s*/, ""));
              return vt.startsWith("派单 ") && vt.includes("追加内容") && normTalk(vt).includes(bodyClean);
            }
            if (m.kind === "dispatch") {
              return normTalk(String(m.text ?? "")).includes(normTalk(body));
            }
            return false;
          })
        : undefined;
      if (hit) {
        if (leftover) hit.text = `${hit.text}\n${leftover}`;
        return null;
      }
      if (!leftover) return null;
      return {
        id: `CH-${fingerprint(e)}`,
        at: String(e.at ?? ""),
        role,
        kind: "say",
        text: leftover,
        tool: "",
        cmd: "",
        status: "",
        thread: id,
      } as ThreadMessage;
    };
    const talk = talkRows
      .filter((e) => {
        const isAsk = String(e.event ?? e.kind) === "supervisor_chat_ask";
        if (!isAsk) return true;
        if (!said.has(normTalk(e.text))) return true;
        const askAt = Date.parse(String(e.at ?? "")) || 0;
        return !saidRows.some((m) => {
          if (normTalk(m.text) !== normTalk(e.text)) return false;
          const sayAt = Date.parse(String(m.at ?? "")) || 0;
          return Math.abs(askAt - sayAt) < 5_000;
        });
      })
      .map((e) => {
      const isAsk = String(e.event ?? e.kind) === "supervisor_chat_ask";
      /** 角色以写入时的 from 字段为准，旧记录缺该字段才按事件名回落。 */
      const from = String((e as { from?: unknown }).from ?? "");
      const role: ThreadRole =
        from === "user" || from === "supervisor" || from === "worker"
          ? (from as ThreadRole)
          : ((isAsk ? "user" : "supervisor") as ThreadRole);
      if (!isAsk && (e as { acted?: unknown }).acted === true) return mergeActedEcho(e, role);
      return {
        id: `CH-${fingerprint(e)}`,
        at: String(e.at ?? ""),
        role,
        kind: "say" as ThreadKind,
        text: isAsk ? String(e.text ?? "") : String(e.reply ?? ""),
        tool: "",
        cmd: "",
        status: "",
        ref: "",
        unread: false,
        thread: id,
        /** 引用随事件原样下发，写入时已持久化，重建与实时发送同一口径。 */
        ...(isAsk && String((e as { quote?: unknown }).quote ?? "")
          ? {
              quote: String((e as { quote?: unknown }).quote),
              ...(String((e as { quote_text?: unknown }).quote_text ?? "")
                ? { quote_text: String((e as { quote_text?: unknown }).quote_text) }
                : {}),
            }
          : {}),
      } as ThreadMessage;
    })
      .filter((m): m is ThreadMessage => m !== null)
      .filter((m) => m.text.trim() !== "");
    const sameSaid = (a: ThreadMessage, b: ThreadMessage): boolean => {
      if (String(a.role) !== "user" || String(b.role) !== "user") return false;
      const ka = String(a.text ?? "").trim();
      if (!ka || ka !== String(b.text ?? "").trim()) return false;
      const ta = Date.parse(String(a.at ?? "")) || 0;
      const tb = Date.parse(String(b.at ?? "")) || 0;
      return Math.abs(ta - tb) < 5000;
    };
    const baseKept = base.messages.filter((m) => !talk.some((t) => sameSaid(m, t)));
    const messages = [...baseKept, ...talk].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const total = base.total + talk.length;
    const next_since = base.next_since;
    markThreadSeen(root, id);
    ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    ctx.res.end(
      JSON.stringify({
        serverTime: new Date().toISOString(),
        root,
        id,
        since,
        total,
        truncated: total > messages.length,
        next_since,
        messages,
      }),
    );
  } catch (err) {
    ctx.res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    ctx.res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
  }
}
}
