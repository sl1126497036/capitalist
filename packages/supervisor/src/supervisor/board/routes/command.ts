/**
 * 看板路由处理：把 HTTP 请求翻译成视图与命令调用。
 *
 * 只做收发与入参校验，业务逻辑在 threads / views / commands 各层。
 */

import { BoardCtx } from "../types";
import { hostOverrideOf } from "../../../agent/registry";
import { writeJson } from "../../../core/json";
import { recordEvent } from "../../../core/ledger";
import { loadSupervisor, requestSupervisorStop, saveSupervisor, finishDispatch, readDispatches } from "../../../core/supervisor";
import { appendSupervisorDirective } from "../../direct";
import { listTaskRoots } from "../sources";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCommand } from "../commands";

/** /api/capitalist-command */
export function handleCapitalistCommand(ctx: BoardCtx): void {
const peer = ctx.req.socket.remoteAddress ?? "";
const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
if (!loopback) {
  ctx.res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: "指令接口只接受本机回环地址" }));
  return;
}
if (ctx.req.method !== "POST") {
  ctx.res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
  ctx.res.end(JSON.stringify({ error: "只接受 POST" }));
  return;
}
let body = "";
ctx.req.on("data", (chunk: Buffer) => {
  body += chunk.toString("utf8");
  if (body.length > 10_000) ctx.req.destroy();
});
ctx.req.on("end", () => {
  let parsed: Record<string, unknown>;
  try {
    parsed = body.trim() ? (JSON.parse(body) as Record<string, unknown>) : {};
  } catch {
    ctx.res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    ctx.res.end(JSON.stringify({ error: "JSON 解析失败" }));
    return;
  }
  const input: { text?: string; action?: string; arg?: string; confirm?: boolean; via?: "user" | "capitalist" } = {};
  if (typeof parsed.text === "string") input.text = parsed.text;
  if (typeof parsed.action === "string") input.action = parsed.action;
  if (typeof parsed.arg === "string") input.arg = parsed.arg;
  if (parsed.confirm === true) input.confirm = true;
  // 该接口的指令来源记为 user；监工落的指令走 /api/capitalist-chat 的 DO 行并带 via:"capitalist"。
  input.via = "user";

  /** 只接受已知任务根，其余回落本看板自己的根；关停写停止哨兵，不进指令队列。 */
  const targetRoot =
    typeof parsed.root === "string" && parsed.root.trim()
      ? listTaskRoots(ctx.opts.root).includes(resolve(parsed.root.trim()))
        ? resolve(parsed.root.trim())
        : ctx.opts.root
      : ctx.opts.root;

  if (input.action === "stop") {
    /** 先写停止哨兵再结束进程；结束失败时监工下一轮调度 仍会自行退出。 */
    const rec = loadSupervisor(targetRoot);
    requestSupervisorStop(targetRoot, "看板指标条：用户关停");
    let killedPid = 0;
    const pid = Number(rec?.pid ?? 0);
    if (pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
        killedPid = pid;
      } catch {
      }
    }
    recordEvent(targetRoot, "supervisor_stop", { by: "user", via: "board", pid: killedPid });
    ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    ctx.res.end(
      JSON.stringify({
        ok: true,
        action: "stop",
        root: targetRoot,
        killed: killedPid,
        effective: killedPid
          ? `已立即关停（结束进程 ${killedPid}）；进度已保存，重新执行 capitalist supervise 后按恢复计划继续`
          : "停止请求已写入，监工在下一 tick 退出",
      }),
    );
    return;
  }

  if (input.action === "stop-all") {
    const roots = listTaskRoots(ctx.opts.root);
    const stopped: string[] = [];
    const killed: number[] = [];
    const skipped: string[] = [];
    for (const r of roots) {
      const rec = loadSupervisor(r);
      if (!rec) {
        skipped.push(r);
        continue;
      }
      requestSupervisorStop(r, "看板：用户关停所有");
      stopped.push(r);
      const pid = Number(rec.pid);
      if (pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
          killed.push(pid);
        } catch {
        }
      }
    }
    recordEvent(ctx.opts.root, "supervisor_stop_all", {
      by: "user",
      via: "board",
      roots: stopped.length,
      killed,
    });
    ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    ctx.res.end(
      JSON.stringify({
        ok: true,
        action: "stop-all",
        roots: stopped.length,
        killed: killed.length,
        skipped: skipped.length,
        effective: stopped.length
          ? `已立即关停 ${stopped.length} 个监工${killed.length ? `（结束 ${killed.length} 个进程）` : ""}；进度已保存，重新执行 capitalist supervise 后按恢复计划继续`
          : "没有可关停的监工：这些任务根上都没有运行中的监工记录",
      }),
    );
    return;
  }

  if (input.action === "restart") {
    const capitalist = loadSupervisor(targetRoot) as Record<string, unknown> | null;
    if (!capitalist || !Number(capitalist.pid)) {
      ctx.res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      ctx.res.end(
        JSON.stringify({
          ok: false,
          error: "这个任务根上没有运行中的监工记录（从未启动或已归档），没有可重启的进程；请先 capitalist supervise",
        }),
      );
      return;
    }
    const last = restartAt.get(targetRoot) ?? 0;
    if (Date.now() - last < RESTART_COOLDOWN_MS) {
      ctx.res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      ctx.res.end(JSON.stringify({ ok: false, error: "刚发起过重启，等新进程起来再看（15 秒内不重复拉起）" }));
      return;
    }
    restartAt.set(targetRoot, Date.now());

    const cli = process.argv[1] ?? "";
    const target = String(capitalist.target ?? "").trim() || "监工";
    const args = [cli, "supervise", target, "--root", targetRoot];
    const contract = String(capitalist.contract ?? "").trim();
    if (contract) args.push("--contract", contract);
    const workers = Number(capitalist.max_workers);
    if (Number.isFinite(workers) && workers > 0) args.push("--workers", String(workers));
    /*
     * 工作进程宿主不在重启参数里：新进程按自身宿主环境重新判定，与首次启动同一口径。
     * 透传旧的 worker_host 会让判定结果被历史值锁定。
     */
    /* 透传宿主声明（--agent）。 */
    const declaredHost = hostOverrideOf();
    if (declaredHost) args.push("--agent", declaredHost);

    /** 先把拉起器派出去，再请求停止；宿主端口不能被继承。 */
    const env = { ...process.env };
    delete env.SERVER__PORT;
    env.CAPITALIST_RELAUNCH_PID = String(Number(capitalist.pid));
    env.CAPITALIST_RELAUNCH_ARGS = JSON.stringify(args);
    env.CAPITALIST_RELAUNCH_CWD = targetRoot;
    let launcherPid = 0;
    try {
      const launcher = spawn(process.execPath, ["-e", RESTART_LAUNCHER], {
        cwd: targetRoot,
        detached: true,
        stdio: "ignore",
        env,
      });
      launcher.unref();
      launcherPid = launcher.pid ?? 0;
      recordEvent(targetRoot, "supervisor_restarted", { pid: launcherPid, via: "relauncher", target, contract });
    } catch (e) {
      recordEvent(targetRoot, "supervisor_restart_failed", {
        error: e instanceof Error ? e.message : String(e),
      });
      ctx.res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      ctx.res.end(
        JSON.stringify({
          ok: false,
          error: `重启失败：拉起器没有启动（${e instanceof Error ? e.message : String(e)}）。旧监工仍在运行，没有停。`,
        }),
      );
      return;
    }

    requestSupervisorStop(targetRoot, "看板：用户重启（新进程由拉起器接管）");
    recordEvent(targetRoot, "supervisor_restart_requested", { by: "user", via: "board", target, contract });

    ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    ctx.res.end(
      JSON.stringify({
        ok: true,
        action: "restart",
        root: targetRoot,
        effective: "已请求关闭，3 秒后由看板进程拉起新的监工（新 pid）；期间在途工作进程按正常收尾",
      }),
    );
    return;
  }

  if (input.action === "next-model") {
    const model = String(input.arg ?? "").trim();
    const p = join(targetRoot, ".capitalist", "next_model.json");
    try {
      if (!model) rmSync(p, { force: true });
      else writeJson(p, { model, at: new Date().toISOString(), by: "user" });
      recordEvent(targetRoot, "next_model_set", { model, by: "user" });
    } catch (e) {
      ctx.res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      ctx.res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    ctx.res.end(
      JSON.stringify({
        ok: true,
        action: "next-model",
        model,
        effective: model
          ? `之后的派单都使用 ${model}（常驻，直到再次更换或清除）`
          : "已清除派单模型，之后的派单回到契约/默认模型",
      }),
    );
    return;
  }

  if (input.action === "capitalist-model") {
    const model = String(input.arg ?? "").trim();
    const rec = loadSupervisor(targetRoot);
    if (!rec) {
      ctx.res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      ctx.res.end(JSON.stringify({ ok: false, error: "这个任务根没有监工记录，无法设置监工模型" }));
      return;
    }
    saveSupervisor(targetRoot, { ...rec, supervisor_model: model });
    recordEvent(targetRoot, "supervisor_model_set", { model, by: "user" });
    ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    ctx.res.end(
      JSON.stringify({
        ok: true,
        action: "capitalist-model",
        model,
        effective: model
          ? `监工对话层改用 ${model}，下一轮调用即生效（不用重启）`
          : "监工对话层回到宿主默认模型",
      }),
    );
    return;
  }

  const r = appendSupervisorDirective(targetRoot, input);
  if (!r.ok) {
    ctx.res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    ctx.res.end(JSON.stringify({ ok: false, error: r.error }));
    return;
  }
  const rejected = r.rec.result && r.rec.result.ok === false ? r.rec.result.reason : "";
  ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  ctx.res.end(
    JSON.stringify({
      ok: !rejected,
      id: r.rec.id,
      action: r.rec.action,
      arg: r.rec.arg,
      text: r.rec.text,
      ...(rejected ? { rejected: true, reason: rejected } : { effective: "下一个 tick 生效" }),
      detail: r.rec.result?.detail ?? "",
    }),
  );
});
}

/** 看板重启限流：同一任务根在冷却期内只重启一次，避免连续点击打爆进程。 */
const RESTART_LAUNCHER = `
const { spawn } = require("node:child_process");
const args = JSON.parse(process.env.CAPITALIST_RELAUNCH_ARGS || "[]");
const oldPid = Number(process.env.CAPITALIST_RELAUNCH_PID || 0);
const cwd = process.env.CAPITALIST_RELAUNCH_CWD || process.cwd();
const deadline = Date.now() + 25000;
function gone() {
  if (!oldPid) return true;
  try { process.kill(oldPid, 0); return false; } catch { return true; }
}
function tick() {
  if (gone() || Date.now() > deadline) {
    try {
      const c = spawn(process.execPath, args, { cwd: cwd, detached: true, stdio: "ignore", windowsHide: true });
      c.unref();
    } catch (e) {}
    return;
  }
  setTimeout(tick, 200);
}
setTimeout(tick, 400);
`;

/** 看板重启限流：同一任务根在冷却期内只重启一次，避免连续点击打爆进程。 */
const RESTART_COOLDOWN_MS = 15_000;
const restartAt = new Map<string, number>();

/** /api/command */
export function handleCommand(ctx: BoardCtx): void {
// 写操作只接受本机回环来源。
const peer = ctx.req.socket.remoteAddress ?? "";
const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
if (!loopback) {
  ctx.res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: "命令接口只接受本机回环地址" }));
  return;
}
if (ctx.req.method !== "POST") {
  ctx.res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
  ctx.res.end(JSON.stringify({ error: "只接受 POST" }));
  return;
}
let body = "";
ctx.req.on("data", (chunk: Buffer) => {
  body += chunk.toString("utf8");
  if (body.length > 1_000_000) ctx.req.destroy();
});
ctx.req.on("end", () => {
  let parsed: unknown;
  try {
    parsed = body.trim() ? JSON.parse(body) : {};
  } catch {
    ctx.res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    ctx.res.end(JSON.stringify({ error: "JSON 解析失败" }));
    return;
  }
  const r = runCommand(ctx.opts.root, parsed);
  ctx.res.writeHead(r.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  ctx.res.end(JSON.stringify(r.body));
});
return;
}

/** /api/confirm-dispatch */
export function handleConfirmDispatch(ctx: BoardCtx): void {
const peer = ctx.req.socket.remoteAddress ?? "";
const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
if (!loopback) {
  ctx.res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: "结单接口只接受本机回环地址" }));
  return;
}
if (ctx.req.method !== "POST") {
  ctx.res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
  ctx.res.end(JSON.stringify({ error: "只接受 POST" }));
  return;
}
let raw = "";
ctx.req.on("data", (c: Buffer) => {
  raw += c.toString("utf8");
  if (raw.length > 10_000) ctx.req.destroy();
});
ctx.req.on("end", () => {
  const json = (obj: unknown, code = 200): void => {
    ctx.res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    ctx.res.end(JSON.stringify(obj));
  };
  let id = "";
  try {
    id = String((JSON.parse(raw) as { id?: string }).id ?? "").trim();
  } catch {
    json({ error: "请求体不是合法 JSON" }, 400);
    return;
  }
  if (!id) {
    json({ error: "缺少派单 id" }, 400);
    return;
  }
  const cur = readDispatches(ctx.opts.root).find((d) => String(d.id) === id);
  if (!cur) {
    json({ error: `没有这张单：${id}` }, 404);
    return;
  }
  const note = String(cur.review_note ?? cur.note ?? "") || "用户确认结单";
  const done = finishDispatch(ctx.opts.root, id, "done", note);
  if (!done) {
    json({ error: `这张单已经结过了：${id}` }, 409);
    return;
  }
  recordEvent(ctx.opts.root, "dispatch_confirmed", {
    dispatch: id,
    stage: done.stage,
    shard: done.shard ?? "",
    worker: done.worker ?? "",
  });
  json({ ok: true, id });
});
return;
}
