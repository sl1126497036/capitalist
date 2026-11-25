/**
 * 权限申请接口。
 *
 * 工作面板按这张表弹出待裁决项：监工判定不了的（`escalated`）以及还在等监工处理的
 * （`pending`）分两组给出。裁决由用户提交，写入同一份申请台账并通知工作进程。
 *
 * 只对本机开放：裁决等于批准一次越界操作，不能由远端代替操作。
 */

import { answerAsk } from "../../../core/dispatch/inbox";
import { appendDecision, readGuardRequests, type GuardRequest } from "../../../core/guard/requests";
import { notifyWorker } from "../../guard/judge";
import { dispatchNoTable } from "../../usage/threadNo";
import { maskBoardText } from "../render";
import { isLoopback, sendJson, type BoardCtx } from "../types";

/**
 * 对外视图。仅保留判定所需信息，命令截断到 400 字。
 *
 * 权限申请文本由工作进程填写，理由常包含其读取过的路径（`workers/6-P1/brief.md`），
 * 路径数组同样。两类字段统一经 {@link maskBoardText} 改写，与线程消息口径一致：
 * 进程号不展示在界面，派单号按界面口径补 `#`。
 */
function view(rec: GuardRequest, nos?: Map<string, string>): Record<string, unknown> {
  const text = (v: unknown): string => maskBoardText(String(v ?? ""), nos);
  const paths = Array.isArray(rec.paths) ? rec.paths.map((p) => text(p)) : [];
  return {
    id: rec.id,
    kind: rec.kind,
    action: rec.action,
    tool: rec.tool,
    paths,
    command: text(rec.command),
    reason: text(rec.reason),
    worker: rec.worker,
    dispatch: rec.dispatch,
    status: rec.status,
    why: text(rec.why),
    alternative: text(rec.alternative),
    ask: text(rec.ask),
    at: rec.at,
  };
}

/** /api/guard */
export function handleGuard(ctx: BoardCtx): void {
  if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD") {
    sendJson(ctx, { error: "只支持 GET" }, 405);
    return;
  }
  if (!isLoopback(ctx)) {
    sendJson(ctx, { error: "权限申请只对本机开放" }, 403);
    return;
  }
  const rows = readGuardRequests(ctx.opts.root);
  const nos = dispatchNoTable(ctx.opts.root);
  sendJson(ctx, {
    /* 已补理由、等监工处理。没有理由的申请不展示：用户看不到判断依据。 */
    pending: rows.filter((r) => r.status === "open" && r.reason.trim() !== "").map((r) => view(r, nos)),
    /* 监工无法判定，等用户裁决。 */
    escalated: rows.filter((r) => r.status === "escalated").map((r) => view(r, nos)),
  });
}

/** 用户裁决的入参。 */
interface DecisionBody {
  id?: string;
  verdict?: string;
  why?: string;
  alternative?: string;
}

/**
 * /api/guard/decision
 *
 * 用户裁决：批准或拒绝一次申请。批准只对这一次动作有效，与监工给出的批准同等效力。
 */
export function handleGuardDecision(ctx: BoardCtx): void {
  if (ctx.req.method !== "POST") {
    sendJson(ctx, { error: "只接受 POST" }, 405);
    return;
  }
  if (!isLoopback(ctx)) {
    sendJson(ctx, { error: "裁决只接受本机请求" }, 403);
    return;
  }

  let raw = "";
  ctx.req.on("data", (chunk: Buffer) => {
    raw += chunk.toString("utf8");
    if (raw.length > 20_000) ctx.req.destroy();
  });
  ctx.req.on("end", () => {
    let body: DecisionBody;
    try {
      body = JSON.parse(raw) as DecisionBody;
    } catch {
      sendJson(ctx, { error: "请求不是合法 JSON" }, 400);
      return;
    }
    const id = String(body.id ?? "").trim();
    const verdict = String(body.verdict ?? "").trim();
    if (!id || (verdict !== "allow" && verdict !== "deny")) {
      sendJson(ctx, { error: "缺少申请编号，或结论不是 allow / deny" }, 400);
      return;
    }

    const rec = readGuardRequests(ctx.opts.root).find((r) => r.id === id);
    if (!rec) {
      sendJson(ctx, { error: `未找到编号为 ${id} 的申请` }, 404);
      return;
    }
    if (rec.status === "allowed" || rec.status === "denied") {
      sendJson(ctx, { error: `申请 ${id} 已有结论`, status: rec.status }, 409);
      return;
    }

    const why = String(body.why ?? "").trim();
    const alternative = String(body.alternative ?? "").trim();
    appendDecision(ctx.opts.root, id, verdict, "user", why || "用户裁决", alternative, rec.ask);

    /* 转用户裁决时登记过问题，裁完一并关闭，否则监工一直按“待裁决”暂停派单。 */
    if (rec.ask) answerAsk(ctx.opts.root, rec.ask, verdict === "allow" ? "允许这次操作" : "不允许这次操作");

    notifyWorker(
      ctx.opts.root,
      { worker: rec.worker, dispatch: rec.dispatch, paths: rec.paths },
      verdict === "allow"
        ? `【用户已批准】${rec.paths.join("、")}\n按原命令重新执行一次。`
        : [
            `【用户已拒绝】${rec.paths.join("、")}`,
            alternative ? `替代方案：${alternative}` : "无替代方案时，暂停操作并等待用户进一步说明。",
          ].join("\n"),
    );

    sendJson(ctx, { ok: true, id, verdict });
  });
}
