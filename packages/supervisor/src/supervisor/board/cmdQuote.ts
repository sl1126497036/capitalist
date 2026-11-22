import { attachmentsIn, stripAttachments } from "../../core/message/attachments";
import { appendDirective, isWorkerRef } from "../../core/dispatch/commands";
import { recordEvent } from "../../core/record/ledger";
import { msgId } from "../../core/message/msgId";
import { taskNoOfDispatchId } from "../../core/record/tasks";
import { loadState } from "../../core/record/state";
import { chatDirectionOf } from "./chatDirection";
import { listWorkers, readDispatches, Dispatch } from "../../core/record/supervisor";
import { pauseAll, resumeAll, type PauseOutcome, type ResumeOutcome } from "../../core/record/pause";
import { dispatchNoTable } from "../usage/threadNo";
import { dispatchNoLabel } from "../../core/record/idMap";
import { buildThreadMessages } from "./messages";
import { buildThreads } from "./threads";
import { spawnSync } from "node:child_process";
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
    /* 引用目标就是这张单本身（老引用存派单号）。 */
    if (String(x.id ?? "") === id) return true;
    const list = Array.isArray((x as { src_msgs?: string[] }).src_msgs)
      ? ((x as { src_msgs?: string[] }).src_msgs as string[])
      : [];
    return list.includes(id) || String((x as { src_msg?: string }).src_msg ?? "") === id;
  });
  if (hits.length === 0) return "";
  const noTable = dispatchNoTable(root);
  const nos = hits.map((d) => noTable.get(String(d.id)) ?? "").filter(Boolean);
  return nos.length ? nos.map((n) => dispatchNoLabel(n)).join("、") : "";
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
    /** 请求声明的承接方；缺省按会话归属判定，与对话路由读同一个入口。 */
    via?: string;
  },
): boolean {
  /*
   * 只走 appendDirective 这一个写入口。
   *
   * 早先本函数手搓记录直接写盘：没有自身编号、没有 `at` 同毫秒顺延、没有 `direct_inject`
   * 事件，方向还写死成“用户发给工作进程”。同一毫秒连发两条时引用会指向同一行，结论也会
   * 落到相邻记录上；监工面板代发的话还会被记成用户发给工作进程。
   */
  const no = taskNoOfDispatchId(String(input.target ?? "")) || "S0";
  const identity =
    String(input.msgId ?? "").trim() ||
    msgId(
      no,
      chatDirectionOf({
        ...(input.thread !== undefined ? { thread: input.thread } : {}),
        ...(input.via !== undefined ? { via: input.via } : {}),
      }),
    );
  const rec = appendDirective(root, {
    text: input.text,
    shard: input.shard ? input.shard : null,
    ...(input.thread ? (isWorkerRef(input.thread) ? { thread: input.thread } : { lane: input.thread }) : {}),
    stage: loadState(root)?.stage ?? "",
    ...(input.lineage ? { lineage: input.lineage } : {}),
    ...(input.target ? { target: input.target } : {}),
    msgId: identity,
    quote: input.quote,
    quoteText: input.quoteText,
    via: "user",
  });
  return Boolean(rec);
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
  ) {    return { ok: false, reason: "该派单当前状态不允许重派" };
  }
  const r = runCli(["update", "inbox/dispatch", String(last.id), "status", "open", "--root", root]);
  if (r.code !== 0) {
    return { ok: false, reason: (r.stderr || "").slice(0, 120) || "update 未返回原因" };
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

/**
 * 暂停与恢复走 `core/record/pause.ts` 的同一对函数：看板不再自行写文件，
 * 否则派单标记与全局暂停会各写一半。
 */
export function setPause(root: string, reason: string): PauseOutcome {
  return pauseAll(root, "board", reason || "看板暂停调度");
}

/** 解除暂停并清除派单标记；失败时抛错，由调用方回给用户。 */
export function clearPause(root: string): ResumeOutcome {
  const r = resumeAll(root, "board");
  if (!r.ok) throw new Error(`暂停状态删除失败：${r.error || "未知原因"}`);
  return r;
}

export function workerOfThread(root: string, threadId: string, shard: string): string {
  const id = String(threadId ?? "").trim();
  /*
   * 入参可能是线程 id（t/xxxx），也可能是工作进程 id（"4"）：
   * 看板的中断与换模型按钮下发的是 `t.worker || t.id`，直接拿进程 id 来找。
   * 先按进程 id 查一次，再按线程解析；都不中才改按分片查找。
   */
  if (id) {
    const direct = listWorkers(root).find(
      (w) => String(w.id) === id && (w.status === "running" || w.status === "starting"),
    );
    if (direct) return direct.id;
  }
  const t = id ? buildThreads(root).find((x) => x.id === id) : undefined;
  /* 线程上的 worker 可能已经退出（历史线程），只有仍在运行/启动中的才可作为中断目标。 */
  if (t && t.worker) {
    const live = listWorkers(root).find(
      (w) => String(w.id) === String(t.worker) && (w.status === "running" || w.status === "starting"),
    );
    if (live) return live.id;
  }
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
    /* 老引用存的是派单号（`19-1`）：派单卡改为消息编号后，按 `no` 字段再认一次。 */
    const hit = messages.find((m) => m.id === ref || (m.no && String(m.no) === ref));
    if (hit) {
      const t = cut(hit.text);
      if (t) return t;
    }
  } catch {
    /** 投影失败时退回前端摘要。 */
  }
  return cut(fallback);
}
