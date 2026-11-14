import { attachmentsIn, stripAttachments } from "../../core/message/attachments";
import { directPath, isWorkerRef } from "../../core/dispatch/commands";
import { appendJsonl, writeJson } from "../../core/record/json";
import { recordEvent } from "../../core/record/ledger";
import { newMessageId } from "../../core/message/messages";
import { loadState } from "../../core/record/state";
import { clearStopFlag, listWorkers, readDispatches, Dispatch } from "../../core/record/supervisor";
import { pausePath } from "../loop";
import { dispatchNoTable } from "../usage/threadNo";
import { buildThreadMessages } from "./messages";
import { buildThreads } from "./threads";
import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
/**
 * 命令引用与派单操作：定位被引用的指令、改写引用、重开派单、调 CLI。
 *
 * 是命令层的执行细节，不组装视图，也不发 HTTP。
 */
export function quoteDispatchLabel(root: string, msgId: string): string {
  const id = String(msgId ?? "").trim();
  if (!id) return "";
  const hits = readDispatches(root).filter((x) => {
    const list = Array.isArray((x as { src_msgs?: string[] }).src_msgs)
      ? ((x as { src_msgs?: string[] }).src_msgs as string[])
      : [];
    return list.includes(id) || String((x as { src_msg?: string }).src_msg ?? "") === id;
  });
  if (hits.length === 0) return "";
  const noTable = dispatchNoTable(root);
  const nos = hits.map((d) => noTable.get(String(d.id)) ?? "").filter(Boolean);
  return nos.length ? nos.map((n) => `#${n}`).join("、") : "";
}

export function sayArgsOf(input: {
  text: string;
  thread?: string;
  msgId?: string;
  shard?: string;
  lineage?: string;
  dispatch?: string;
}): string[] {
  const args = ["say", input.text];
  /** 排队行的线程 id 是 shard:<分片>，写 --thread 前先还原成分片。 */
  const rawThread = String(input.thread ?? "").trim();
  const fromThread = /^shard:(.+)$/.exec(rawThread)?.[1] ?? "";
  const thread = fromThread ? "" : rawThread;
  const shard = String(input.shard ?? "").trim() || fromThread;
  const lineage = String(input.lineage ?? "").trim();
  const dispatch = String(input.dispatch ?? "").trim();
  if (dispatch) args.push("--target", dispatch);
  else if (thread) args.push("--target", thread);
  if (lineage) args.push("--lineage", lineage);
  if (shard) args.push("--shard", shard);
  if (thread) args.push("--thread", thread);
  if (input.msgId) args.push("--msg-id", input.msgId);
  return args;
}

export function writeQuotedDirect(
  root: string,
  input: {
    text: string;
    shard?: string;
    thread?: string;
    quote: string;
    quoteText: string;
    msgId?: string;
    lineage?: string;
    target?: string;
  },
): boolean {
  const rec: Record<string, unknown> = {
    at: new Date().toISOString(),
    at_ts: Date.now() / 1000,
    type: "direct",
    text: input.text,
    shard: input.shard ? input.shard : null,
    quote: input.quote,
    quote_text: input.quoteText,
    consumed: false,
  };
  const quoteAtts = attachmentsIn(input.text);
  if (quoteAtts.length) rec.atts = quoteAtts;
  rec.msg_id = input.msgId || newMessageId();
  if (input.lineage) rec.lineage = input.lineage;
  if (input.target) rec.target = input.target;
  if (input.thread) {
    if (isWorkerRef(input.thread)) rec.thread = input.thread;
    else rec.lane = input.thread;
  }
  const stage = loadState(root)?.stage;
  if (stage) rec.stage = stage;
  return appendJsonl(directPath(root), rec);
}

export function reopenDispatch(root: string, thread: string, shard = ""): { ok: boolean; reason: string; id?: string } {
  const rows = readDispatches(root);
  let last: Dispatch | undefined;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const d = rows[i];
    if (d && String(d.worker ?? "") === thread) {
      last = d;
      break;
    }
  }
  if (!last && shard) {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const d = rows[i];
      if (d && String(d.shard ?? "") === shard) {
        last = d;
        break;
      }
    }
  }
  if (!last) return { ok: false, reason: "未找到对应的派单记录" };
  if (last.status === "open" || last.status === "claimed") return { ok: true, reason: "" };
  if (
    last.status !== "done" &&
    last.status !== "failed" &&
    last.status !== "review" &&
    last.status !== "closed"
  ) {    return { ok: false, reason: `该派单当前状态为 ${last.status}，无法重派` };
  }
  const r = runCli(["update", "inbox/dispatch", String(last.id), "status", "open", "--root", root]);
  if (r.code !== 0) {
    return { ok: false, reason: (r.stderr || "").slice(0, 120) || "update 没返回原因" };
  }
  /** 唤醒要盖时间戳，否则阶段推进时 supersedeStaleDispatches 会在下一轮作废在途单。 */
  runCli(["update", "inbox/dispatch", String(last.id), "wake_at", new Date().toISOString(), "--root", root]);
  recordEvent(root, "dispatch_wake", {
    dispatch: last.id,
    shard: last.shard ?? "",
    worker: last.worker ?? "",
    from: last.status,
  });
  return { ok: true, reason: "", id: String(last.id) };
}

/** 调用 dist/cli/main.js，参数以数组传递，不经过 shell、不拼字符串。 */
export function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  /* 本文件编译后在 dist/supervisor/board/，CLI 在 dist/cli/，上两级才是 dist。 */
  const cli = join(__dirname, "..", "..", "cli", "main.js");
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  return {
    code: typeof r.status === "number" ? r.status : 1,
    stdout: String(r.stdout ?? "").trim(),
    stderr: String(r.stderr ?? "").trim() || String(r.error ?? ""),
  };
}

/** 暂停落 .capitalist/pause.json，形状与 capitalist pause 一致，读方只有 loop.ts 的 readPause。 */
export function setPause(root: string, reason: string): void {
  const rec = { at: new Date().toISOString(), reason: reason || "看板暂停调度", by: "board" };
  writeJson(pausePath(root), rec);
  recordEvent(root, "pause_set", { reason: rec.reason, by: rec.by });
}

/** 解除暂停删除 .capitalist/pause.json；文件不存在时按成功处理，不记事件。 */
export function clearPause(root: string): void {
  const file = pausePath(root);
  if (!existsSync(file)) return;
  try {
    unlinkSync(file);
  } catch (err) {
    throw new Error(`暂停状态删除失败：${err instanceof Error ? err.message : String(err)}`);
  }
  clearStopFlag(root);
  recordEvent(root, "pause_cleared", { by: "board" });
}

export function workerOfThread(root: string, threadId: string, shard: string): string {
  const t = buildThreads(root).find((x) => x.id === threadId);
  if (t && t.worker) return t.worker;
  if (shard) {
    const w = listWorkers(root)
      .filter((x) => (x.shard ?? "") === shard && (x.status === "running" || x.status === "starting"))
      .pop();
    if (w) return w.id;
  }
  return "";
}

/** 接管与交还的粒度是分片；只给 id 时必须反查分片。 */
export function shardOfThread(root: string, id: string): string {
  if (!id) return "";
  const t = buildThreads(root).find((x) => x.id === id);
  if (t) return t.shard || "";
  return id.startsWith("shard:") ? id.slice(6) : "";
}

export function resolveQuoteText(root: string, thread: string, ref: string, fallback: string): string {
  const cut = (s: string): string =>
    stripAttachments(String(s || "")).replace(/\s*\n\s*/g, " ").trim().slice(0, 200);
  try {
    const { messages } = buildThreadMessages(root, thread, "", { limit: 500, logTailBytes: 512 * 1024 });
    const hit = messages.find((m) => m.id === ref);
    if (hit) {
      const t = cut(hit.text);
      if (t) return t;
    }
  } catch {
    /** 投影失败时退回前端摘要。 */
  }
  return cut(fallback);
}
