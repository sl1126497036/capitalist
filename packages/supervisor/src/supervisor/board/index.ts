/**
 * 看板 HTTP 服务：鉴权、路由分发、SSE、端口占用回收。
 *
 * 分层顺序固定：index → routes/ → views、threads、commands → snapshot → stats、logs、sources。
 * 新增接口在 routes/ 按领域归入现有文件，这里只加一行分发。
 * 子模块不反向引用本文件，共用逻辑下沉到 state、render、sources。
 */

import os from "node:os";
import { ServerResponse, createServer, IncomingMessage } from "node:http";
import { resolve, join } from "node:path";

import { readJson, writeJson } from "../../core/json";
import { pidAlive } from "../../core/fileLock";
import { SupervisorRecord, listWorkers, WorkerRecord, loadSupervisor } from "../../core/supervisor";
import { reapOrphans } from "../reapOrphans";
import { parseWorkerLog } from "../workerLog";
import { handleCapitalistChat } from "./routes/chat";
import { handleCommand, handleCapitalistCommand, handleConfirmDispatch } from "./routes/command";
import { handleFsList, handleAttachments, handleUpload, handleAttachment } from "./routes/files";
import { handleThreads, handleThreadMessage } from "./routes/threads";
import { handleTasks, handleForest, handleMetrics, handleUsage, handleModels, handleOverview, handleState, handleMq, handleCtxWindow, handleAlerts, handleSupervisorSelf, handleCapitalistEvents, handleMemory, handleUnhandled, handleSupervisor } from "./routes/views";
import { threadsPageCache } from "./threads";
import { clearSourceCache } from "./sources";
import { messageContextCache } from "./messages";
import { clearSupervisorLogCache } from "./supervisorLog";
import { loadOrCreateBoardKey, guardBoardAccess, boardSecureOn, boardKeyOf, configureBoardAuth } from "./auth";
import { buildSnapshot } from "./snapshot";
import { fileSize, alignToLine, NEW_WORKER_TAIL_BYTES, readDelta, meaningfulLines, tailLines } from "./logs";
import { missingBoardWebPage, sendAsset, etagOf, serveBoardWeb } from "./assets";
import type { ServeOptions, Served } from "./types";

/*
 * 导出面与拆分前 board.ts 对齐：CLI 与测试按这些名字取用，入口只做汇总。
 *
 * 实现分散在子模块，本文件不承载业务。
 */
export type {
  BoardAsk,
  BoardDispatch,
  BoardDiagnosis,
  BoardEvent,
  BoardSnapshot,
  BoardWorker,
  ThreadKind,
  ThreadMessage,
  ThreadRole,
  ThreadSummary,
} from "./snapshot";
export { buildFeed, buildSnapshot } from "./snapshot";

export type { ThreadCost, ThreadCostRow } from "./stats";
export { costTotals, threadCostRows, workerCost } from "./stats";

export type { AlertItem, AlertLevel, AlertQuery, BoardMetrics, SupervisorStageView, SupervisorState, SupervisorStatusView, TaskSummary } from "./views";
export { alertLevelOf, buildAlerts, buildMetrics, buildSupervisorStatus, buildTaskSummaries } from "./views";

export type { TaskBucket, TaskCounts } from "./threads";
export { buildThreads, buildThreadsPage, taskBucket, taskCounts, taskCountsOf } from "./threads";

export { buildThreadMessages } from "./messages";
export type { CommandResult } from "./cmdArgs";
export { clearRuntimeLedger, runCommand } from "./commands";
export { CAPITALIST_THREAD_ID, buildSupervisorLog } from "./supervisorLog";
export type { BoardOverview } from "./overview";
export { buildOverview } from "./overview";
export type { NodeProcSample, ResourceSampleView } from "./sysmon";
export { humanBytes, workingSetBytes } from "./sysmon";
export { listTaskRoots } from "./sources";
export { findHostCli, helpModels, parseModelIdsFromHelp, resetHelpModelsCacheForTest } from "./models";
export type { ServeOptions, Served } from "./types";

/**

 * 清空看板侧全部读缓存。

 *

 * 写接口进来时调用：用户刚做的操作必须在下一次读取里立刻可见，

 * 宁可多读一次盘，也不能让界面停在操作之前的状态。

 */

function invalidateBoardCaches(): void {
  clearSourceCache();
  threadsPageCache.clear();
  messageContextCache.clear();
  clearSupervisorLogCache();
}

const RESTART_DELAY_MS = 3000;

/** 监工被强制结束后，由看板收掉它拉起的工作进程。 */
function watchOrphanSupervisors(root: string, out: (s: string) => void): () => void {
  const handled = new Set<string>();
  const tick = (): void => {
    let rec: SupervisorRecord | null = null;
    try {
      rec = loadSupervisor(root);
    } catch {
      return;
    }
    if (!rec || rec.status !== "running") return;
    if (!Number.isInteger(rec.pid) || rec.pid <= 0 || rec.pid === process.pid) return;
    if (pidAlive(rec.pid)) return;
    const key = `${root}|${rec.pid}`;
    if (handled.has(key)) return;
    try {
      const live = listWorkers(root).filter(
        (w) => (w.status === "running" || w.status === "starting") && w.supervisor_pid === rec!.pid,
      );
      if (live.length === 0) {
        handled.add(key);
        return;
      }
      const reaped = reapOrphans(root, out, { onlySupervisorPid: rec.pid });
      handled.add(key);
      out(
        `[看板] 监工 pid ${rec.pid} 已不在（记录状态仍是 running，判定被强杀），` +
          `收掉它拉起的 ${reaped.length} 个 worker`,
      );
    } catch (err) {
      out(`[看板] 收孤儿失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const timer = setInterval(tick, 5000);
  timer.unref?.();
  setTimeout(tick, 2500).unref?.();
  return () => clearInterval(timer);
}

const WORKER_TERMINAL = new Set(["exited", "failed", "done"]);

/** 从列表消失只是结束的一种来源，判结束还要看终态记录或 pid 是否存活。 */

function workerGone(w: WorkerRecord): boolean {
  if (WORKER_TERMINAL.has(w.status)) return true;
  return w.mode !== "visible" && w.pid > 0 && !pidAlive(w.pid);
}

/** 仅当 .capitalist/board.pid 的 pid、端口、任务根三者都匹配时才回收占用端口的旧看板，且只给一次机会。 */

async function reclaimStaleBoard(root: string, port: number): Promise<boolean> {
  try {
    const rec = readJson<{ pid?: number; port?: number; root?: string } | null>(join(root, ".capitalist", "board.pid"), null);
    if (!rec || !rec.pid || Number(rec.port) !== port) return false;
    if (rec.root && resolve(rec.root) !== resolve(root)) return false;
    try {
      process.kill(Number(rec.pid), "SIGTERM");
    } catch {
      return false;
    }
    /** SIGTERM 到内核回收句柄之间存在间隙，需等端口真正释放再 listen。 */
    await new Promise((r) => setTimeout(r, 500));
    return true;
  } catch {
    return false;
  }
}

/** 默认只监听回环地址；对外网卡开放需显式传 --host。 */

export async function serveBoard(opts: ServeOptions): Promise<Served> {
  const out = opts.out ?? ((s: string) => process.stdout.write(`${s}\n`));
  const host = opts.host ?? "127.0.0.1";
  const tries = opts.maxPortTries ?? 20;
  const base = opts.port ?? 7788;
  configureBoardAuth(loadOrCreateBoardKey(opts.root, opts.newKey === true), opts.secure === true);

  const viewCache = new Map<string, { at: number; val: unknown }>();
  const cachedView = <T,>(key: string, ttlMs: number, build: () => T): T => {
    const now = Date.now();
    const hit = viewCache.get(key);
    if (hit !== undefined && now - hit.at < ttlMs) return hit.val as T;
    const val = build();
    viewCache.set(key, { at: now, val });
    if (viewCache.size > 64) {
      for (const [k, v] of viewCache) if (now - v.at > 60_000) viewCache.delete(k);
    }
    return val;
  };
  const stopOrphanWatch = watchOrphanSupervisors(opts.root, (s) => {
    opts.out?.(s);
  });

  /** 工作进程记录按 400ms 共享一次读取，跨连接复用。 */
  let workersCache: { at: number; list: ReturnType<typeof listWorkers> } = { at: 0, list: [] };
  const workersNow = (root: string): ReturnType<typeof listWorkers> => {
    const now = Date.now();
    if (now - workersCache.at < 400 && workersCache.list.length > 0) return workersCache.list;
    const list = listWorkers(root);
    workersCache = { at: now, list };
    return list;
  };
  /** SSE 单一通道 output：只推工作进程日志增量，每帧带自增 seq，收尾帧带 done。 */
  const sse = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (event: string, data: unknown): void => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
      }
    };
    const logOffsets = new Map<string, number>();
    const seqs = new Map<string, number>();
    /** 同一个 id 只发一次 done，重连不重发。 */
    const doneSent = new Set<string>();
    const known = new Set<string>();
    const streamModes = new Map<string, boolean>();
    const modeOf = (rec: WorkerRecord): boolean => {
      const caused = streamModes.get(rec.id);
      if (caused !== undefined) return caused;
      let mode = false;
      try {
        mode = parseWorkerLog(tailLines(rec.log, 65_536)).stream;
      } catch {
        mode = false;
      }
      streamModes.set(rec.id, mode);
      return mode;
    };
    for (const w of workersNow(opts.root)) {
      known.add(w.id);
      if (w.log) logOffsets.set(w.id, fileSize(w.log));
      // 连上时已结束的工作进程不补 done，全文由 /api/thread 首轮拉取负责。
      if (workerGone(w)) doneSent.add(w.id);
    }
    const nextSeq = (id: string): number => {
      const n = (seqs.get(id) ?? 0) + 1;
      seqs.set(id, n);
      return n;
    };
    const timer = setInterval(() => {
      try {
        const workers = workersNow(opts.root);
        for (const w of workers) {
          known.add(w.id);
          if (doneSent.has(w.id)) continue;
          if (!w.log) continue;
          const from = logOffsets.get(w.id);
          if (from === undefined) {
            logOffsets.set(w.id, alignToLine(w.log, Math.max(0, fileSize(w.log) - NEW_WORKER_TAIL_BYTES)));
            continue;
          }
          const r = readDelta(w.log, from, 8192);
          logOffsets.set(w.id, r.next);
          if (r.text) {
            const text = meaningfulLines(r.text.split("\n"), modeOf(w)).join("\n");
            if (text !== "") {
              send("output", {
                worker: w.id,
                host: w.host,
                seq: nextSeq(w.id),
                text,
                at: new Date().toISOString(),
              });
            }
          }
        }
        // 收尾帧置于输出之后。
        // 收尾同时释放 logOffsets，否则会随历史工作进程持续增长。
        const live = new Map(workers.map((w) => [w.id, w] as const));
        for (const id of known) {
          if (doneSent.has(id)) continue;
          const w = live.get(id);
          if (w && !workerGone(w)) continue;
          doneSent.add(id);
          logOffsets.delete(id);
          send("output", { worker: id, seq: nextSeq(id), text: "", done: true, at: new Date().toISOString() });
        }
      } catch {
      }
    }, 500);
    // 心跳用注释行发送，不触发客户端逻辑。
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
      }
    }, 15_000);
    // 连接关闭时清掉该连接的所有定时器；req 与 res 的 close 都挂上，stop 幂等。
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearInterval(ping);
      try {
        res.end();
      } catch {
      }
    };
    req.on("close", stop);
    req.on("error", stop);
    res.on("close", stop);
  };
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? "/";
    /** 页面、静态资源、API、SSE、health 都要先过鉴权。 */
    if (!guardBoardAccess(req, res, url)) return;
    /*
     * 任何写请求进来先清一次读缓存。
     *
     * 前端在操作后立刻重新拉数据；缓存仍留着上一轮的线程列表或派单快照时，
     * 界面停在被操作之前的状态，操作没有反应。写请求进入时清空，下一次 GET 重建。
     */
    if (req.method !== "GET" && req.method !== "HEAD" && url.startsWith("/api/")) invalidateBoardCaches();
    if (url === "/stream" || url.startsWith("/stream?")) {
      sse(req, res);
      return;
    }
    if (url === "/api/tasks" || url.startsWith("/api/tasks?")) {
      handleTasks({ req, res, url, opts, cachedView });
      return;
    }
    /** 结构、状态归一与堵点标记在 forestView.ts 计算；台账是唯一数据源，前端不拼 jsonl、不留结构副本。 */
    if (url === "/api/forest" || url.startsWith("/api/forest?")) {
      handleForest({ req, res, url, opts, cachedView });
      return;
    }
    if (url === "/api/metrics" || url.startsWith("/api/metrics?")) {
      handleMetrics({ req, res, url, opts, cachedView });
      return;
    }
    if (url === "/api/usage" || url.startsWith("/api/usage?")) {
      handleUsage({ req, res, url, opts, cachedView });
      return;
    }
    if (url.startsWith("/api/models")) {
      handleModels({ req, res, url, opts, cachedView });
      return;
    }
    if (url.startsWith("/api/fs-list")) {
      handleFsList({ req, res, url, opts, cachedView });
      return;
    }
    if (url === "/api/overview" || url.startsWith("/api/overview?")) {
      handleOverview({ req, res, url, opts, cachedView });
      return;
    }
    if (url.startsWith("/api/state")) {
      handleState({ req, res, url, opts, cachedView });
      return;
    }
    /** 推送只唤醒监工；内容以 .capitalist/mq/reports.jsonl 为准，按 cursor 顺序读取，推送丢失、重复或乱序不影响队列。 */
    if (url === "/api/mq" || url.startsWith("/api/mq?")) {
      handleMq({ req, res, url, opts, cachedView });
      return;
    }
    if (url === "/api/attachments" || url.startsWith("/api/attachments?")) {
      handleAttachments({ req, res, url, opts, cachedView });
      return;
    }
    if (url === "/api/threads" || url.startsWith("/api/threads?")) {
      handleThreads({ req, res, url, opts, cachedView });
      return;
    }
    /** 单线程消息流；必须排在 /api/threads 之后，否则前缀匹配会把它吞掉。 */
    if (url === "/api/thread" || url.startsWith("/api/thread?")) {
      handleThreadMessage({ req, res, url, opts, cachedView });
      return;
    }
    if (url === "/api/command" || url.startsWith("/api/command?")) {
      handleCommand({ req, res, url, opts, cachedView });
      return;
    }
    if (url === "/api/ctx-window" || url.startsWith("/api/ctx-window?")) {
      handleCtxWindow({ req, res, url, opts, cachedView });
      return;
    }
    if (url === "/api/alerts" || url.startsWith("/api/alerts?")) {
      handleAlerts({ req, res, url, opts, cachedView });
      return;
    }
    if (url === "/api/supervisor/self" || url.startsWith("/api/supervisor/self?")) {
      handleSupervisorSelf({ req, res, url, opts, cachedView });
      return;
    }
    if (url === "/api/capitalist-events" || url.startsWith("/api/capitalist-events?")) {
      handleCapitalistEvents({ req, res, url, opts, cachedView });
      return;
    }
    if (url === "/api/capitalist-command" || url.startsWith("/api/capitalist-command?")) {
      handleCapitalistCommand({ req, res, url, opts, cachedView });
      return;
    }
    if (url === "/api/confirm-dispatch" || url.startsWith("/api/confirm-dispatch?")) {
      handleConfirmDispatch({ req, res, url, opts, cachedView });
      return;
    }
    if (url === "/api/memory" || url.startsWith("/api/memory?")) {
      handleMemory({ req, res, url, opts, cachedView });
      return;
    }
    if (url === "/api/unhandled" || url.startsWith("/api/unhandled?")) {
      handleUnhandled({ req, res, url, opts, cachedView });
      return;
    }
    if (url === "/api/supervisor" || url.startsWith("/api/supervisor?")) {
      handleSupervisor({ req, res, url, opts, cachedView });
      return;
    }
    if (url === "/api/capitalist-chat" || url.startsWith("/api/capitalist-chat?")) {
      handleCapitalistChat({ req, res, url, opts, cachedView });
      return;
    }
    if (url === "/api/upload" || url.startsWith("/api/upload?")) {
      handleUpload({ req, res, url, opts, cachedView });
      return;
    }
    /** 只认 .capitalist/attachments/ 下的图片文件，其余返回 404。 */
    if (url === "/api/attachment" || url.startsWith("/api/attachment?")) {
      handleAttachment({ req, res, url, opts, cachedView });
      return;
    }
    if (url === "/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }
    if (serveBoardWeb(req, res, url)) return;
    const html = missingBoardWebPage();
    sendAsset(req, res, html, etagOf(html), "text/html; charset=utf-8", 0);
  };
  let lastErr: unknown = null;
  let reclaimed = false;
  for (let i = 0; i < tries; i += 1) {
    const port = base + i;
    const server = createServer(handler);
    const bound = await new Promise<boolean>((resolve) => {
      const onError = (err: unknown): void => {
        lastErr = err;
        server.removeListener("listening", onListening);
        resolve(false);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
    if (bound) {
      try {
        writeJson(join(opts.root, ".capitalist", "board.pid"), {
          pid: process.pid,
          port,
          root: opts.root,
          at: new Date().toISOString(),
        });
      } catch {
      }
      /* 非安全模式不带 key，地址可直接打开。 */
      const url = boardSecureOn()
        ? `http://${host}:${port}/?key=${boardKeyOf()}`
        : `http://${host}:${port}/`;
      return {
        server,
        url,
        port,
        close: () => {
          stopOrphanWatch();
          try {
            server.close();
          } catch {
          }
        },
      };
    }
    if (!reclaimed && (await reclaimStaleBoard(opts.root, port))) {
      reclaimed = true;
      i -= 1;
      continue;
    }
    try {
      server.close();
    } catch {
    }
  }
  throw new Error(
    `端口 ${base}~${base + tries - 1} 都占用，看板未能启动：${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

export function snapshotJson(root: string): string {
  return `${JSON.stringify(buildSnapshot(root), null, 2)}\n`;
}
