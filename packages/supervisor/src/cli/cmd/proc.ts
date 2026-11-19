/**
 * 监工进程与工作进程相关的命令：启动/停止监工、领单、上报、查看与中断 worker。
 *
 * 与 `main.ts` 分开：这些命令读写的是进程状态而不是任务状态，失败原因也集中在进程层面
 * （没起、没了、被接管）。
 */

import { closeSync, existsSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "../../core/record/json";
import { supervisorDir } from "../../core/record/paths";

import { supervisorDisplayState, SUPERVISOR_STATE_LABEL } from "../../core/record/state";
import { closeTask, promoteTask, stopWorker, listDirectives, directiveMatches, directiveShortRef, isDirectiveOpen, markDirectiveOutcome, dropDirectivesFor, DIRECTIVE_OUTCOMES, type DirectiveOutcome } from "../../core/dispatch/commands";
import { dispatchOfThreadNo } from "../../supervisor/usage/threadNo";
import { recordEvent } from "../../core/record/ledger";
import { appendMq, wakeSupervisor } from "../../core/dispatch/mq";
import { DIRECTIVE_STALE_MS, DIRECTIVE_OUTCOME_GUARD_MS } from "../../core/guard/limits";
import {
  claimDispatch,
  dispatchPath,
  finishDispatch,
  firstOpenDispatch,
  isSupervisorAlive,
  listWorkers,
  loadSupervisor,
  loadWorker,
  markReported,
  newWorkerId,
  pausedDispatches,
  pidAlive,
  readDispatches,
  registerWorker,
  requestSupervisorStop,
  saveWorker,
  wakeDispatch,
  workerLogPath,
} from "../../core/record/supervisor";
import { writeJsonl } from "../../core/record/json";
/* 手领单与监工派单用同一份“动手前先核对现状”：两个入口各写一套，worker 拿到的口径就不一样。 */
import { buildGroundingBlock } from "../../supervisor/worker/worker";
import { releaseAll } from "../../core/record/fileLock";
/* “这一单是不是要求重启监工”的判据，与收工闸共用一份。 */
import { isRestartSupervisorDispatch } from "../../core/record/restartIntent";
import type { Dispatch, WorkerRecord } from "../../core/record/supervisor";
import { t } from "../lang";
import { flagBool, flagString, type Parsed } from "../args";
import { rootOrDie } from "./context";

/** 报完成之后的待确认窗口。到点没人管就自动结束。 */
const REVIEW_WINDOW_MS = 3 * 60 * 1000;
import { die, write, writeJson } from "../output";

/**
 * 后台启动监工。
 *
 * 已移除。监工在终端前台常驻，由用户执行命令启动；WorkBuddy 会话在沙箱里，会话内不提供启动入口。
 */

/** 读取工作进程日志末尾的退出原因。 */
function workerExitReason(root: string, w: WorkerRecord): string {
  try {
    const file = workerLogPath(root, w.id);
    if (!existsSync(file)) return "";
    const size = statSync(file).size;
    if (size === 0) return "";
    const take = Math.min(size, 8192);
    const buf = Buffer.alloc(take);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, take, size - take);
    } finally {
      closeSync(fd);
    }
    const tail = buf.toString("utf8");
    const err = tail.match(/"errors"\s*:\s*\[\s*"((?:[^"\\]|\\.){0,400})"/);
    if (err && err[1]) {
      const text = String(JSON.parse(`"${err[1]}"`)).replace(/\s+/g, " ").trim();
      if (text) return text.slice(0, 160);
    }
    const code = tail.match(/"errors_info"\s*:\s*\[\s*\{[^}]*"status"\s*:\s*(\d{3})/);
    if (code && code[1]) return t(`upstream HTTP ${code[1]}`, `上游返回 HTTP ${code[1]}`);
    return "";
  } catch {
    return "";
  }
}

/** 请求监工停止。 */
export function cmdSuperviseStop(p: Parsed): number {
  const root = rootOrDie(p);
  const rec = loadSupervisor(root);
  if (!rec) die(t("No supervisor record in this task root. Run capitalist supervise first.", "这个任务根没有监工记录（先跑 capitalist supervise）"));
  const force = flagBool(p, "force");
  if (!requestSupervisorStop(root, force ? "forced stop by user" : "stopped by user", force)) {
    die(t("Failed to write the stop request", "停止请求写入失败"));
  }
  write(
    force
      ? t(`Stop requested (pid ${rec.pid}). Running workers will be stopped.\n`, `已请求强制停止监工（pid ${rec.pid}）：在途工作进程一并结束。\n`)
      : t(`Stop requested (pid ${rec.pid}). No new dispatches; exits after running ones finish.\n`, `已请求停止监工（pid ${rec.pid}）：停止派发新派单，在途派单结束后退出。\n`),
  );
  return 0;
}

/** 就地改某条派单的字段（与 loop.ts 的同名逻辑一致：读-改-写整份台账）。 */
function patchDispatchRow(root: string, id: string, patch: Partial<Dispatch>): void {
  const rows = readDispatches(root);
  const idx = rows.findIndex((d) => d.id === id);
  if (idx < 0) return;
  rows[idx] = { ...rows[idx], ...patch } as Dispatch;
  writeJsonl(dispatchPath(root), rows);
}

/** 从派单台账取这张单的阶段/分片/派生链，收工闸靠它判断“哪些插话属于这一片”。 */
function loadDispatchScope(root: string, id: string): { stage: string; shard: string; lineage: string } {
  const d = readDispatches(root).find((x) => String(x.id) === id);
  return {
    stage: String(d?.stage ?? ""),
    shard: String(d?.shard ?? ""),
    lineage: String((d as { lineage?: string } | undefined)?.lineage ?? id),
  };
}

/** “重启监工”这类单据的证据闸。 */
function restartEvidenceGap(root: string, id: string): string {
  const d = readDispatches(root).find((x) => String(x.id) === id);
  if (!isRestartSupervisorDispatch(String(d?.action ?? ""))) return "";
  const capitalist = loadSupervisor(root);
  const startedAt = Date.parse(String(capitalist?.started_at ?? ""));
  const dispatchedAt = Date.parse(String(d?.at ?? ""));
  if (!isSupervisorAlive(root)) {
    return t("Supervisor is not running: no restart happened, or it did not start again", "监工未运行：重启未发生，或重启后未启动");
  }
  if (!Number.isFinite(startedAt) || !Number.isFinite(dispatchedAt) || startedAt <= dispatchedAt) {
    return t(
      `Same supervisor instance (pid ${capitalist?.pid ?? "?"}, started ${capitalist?.started_at ?? "unknown"}); no restart since this dispatch`,
      `仍是同一台监工（pid ${capitalist?.pid ?? "?"}，启动于 ${capitalist?.started_at ?? "未知"}），派单之后没有重启过`,
    );
  }
  return "";
}

/** 解析 `--outcome` 参数。 */
function parseOutcomeArgs(raw: string): { ref: string; outcome: DirectiveOutcome; note: string }[] {
  const out: { ref: string; outcome: DirectiveOutcome; note: string }[] = [];
  for (const seg of String(raw ?? "").split(/[;；\n]+/)) {
    const s = seg.trim();
    if (!s) continue;
    const eq = s.indexOf("=");
    if (eq <= 0) continue;
    const ref = s.slice(0, eq).trim();
    const rest = s.slice(eq + 1).trim();
    const m = /^([a-z_]+)\s*(?:[:：]\s*([\s\S]*))?$/i.exec(rest);
    if (!m) continue;
    const outcome = String(m[1]).toLowerCase() as DirectiveOutcome;
    if (!DIRECTIVE_OUTCOMES.includes(outcome)) continue;
    out.push({ ref, outcome, note: String(m[2] ?? "").trim() });
  }
  return out;
}

/** 等监工对这份报告的裁决。 */
async function awaitVerdict(
  root: string,
  id: string,
  maxMs: number,
): Promise<"accepted" | "rejected" | "escalated" | "error" | "timeout"> {
  const t0 = Date.now();
  const rejectFile = join(supervisorDir(root), "inbox", `reject-${id}.json`);
  for (;;) {
    if (Date.now() - t0 >= maxMs) return "timeout";
    /* 3 秒一次：监工调度周期为 5 秒，更密的轮询没有收益。 */
    await new Promise((r) => setTimeout(r, 3000));
    /*
     * 就地打回：监工发现原进程还活着，就把原因写成一次性回执，不结束、不重派。
     * 读走即删，同一份打回只该退一次，否则 worker 每报一次都被这条旧结论挡回来。
     */
    const reject = readJson<{ why?: string } | null>(rejectFile, null);
    if (reject) {
      try {
        rmSync(rejectFile, { force: true });
      } catch {
        /* 删不掉不影响判断：下一轮还会读到，最多多重试一次 */
      }
      lastRejectWhy = String(reject.why ?? "");
      return "rejected";
    }
    const cur = readDispatches(root).find((d) => String(d.id) === id);
    const st = String(cur?.status ?? "");
    if (st === "done" || st === "closed") return "accepted";
    /* 暂停中的单按升级处理：不按打回处理，工作进程不再改动。 */
    if (st === "open" && String((cur as { paused_by?: string } | undefined)?.paused_by ?? "") === "supervisor") {
      return "escalated";
    }
    if (st === "open") return "rejected";
    if (st === "failed") {
      const why = String((cur as { note?: string } | undefined)?.note ?? "");
      return why.startsWith("报告未通过审查") ? "rejected" : "error";
    }
  }
}

/** 最近一次就地打回的原因；没有就地打回时为空。 */
let lastRejectWhy = "";

/** 打回的原因：就地打回时用刚读到的回执，否则读派单 note；都没有就如实说没写。 */
function verdictReason(root: string, id: string): string {
  if (lastRejectWhy) return lastRejectWhy;
  const d = readDispatches(root).find((x) => String(x.id) === id);
  const note = String((d as { note?: string } | undefined)?.note ?? "").trim();
  return note || t("(supervisor left no reason)", "（监工未写原因）");
}

export async function cmdReport(p: Parsed): Promise<number> {
  const id = p.positional[0];
  if (!id)
    die(
      t(
        'Usage: capitalist report <dispatch-id> --status done|failed --note "<what was done>" [--evidence "<changes and test results>"]' +
          ' [--added "<new user requirements>"] [--outcome "<ref>=done|not_mine|blocked;…"]',
        '用法：capitalist report <派单id> --status done|failed --note "<做了什么>" [--evidence "<改动与验证结果>"]' +
          ' [--added "<用户新增的需求>"] [--outcome "<编号>=done|not_mine|blocked;…"]',
      ),
    );
  const root = rootOrDie(p);
  const status = flagString(p, "status") === "failed" ? "failed" : "done";
  const note = flagString(p, "note");
  const added = (flagString(p, "added") ?? "").trim();
  const evidence = (flagString(p, "evidence") ?? "").trim().slice(0, 4000);

  const outcomeRaw = (flagString(p, "outcome") ?? "").trim();
  const outcomes = parseOutcomeArgs(outcomeRaw);
  if (outcomeRaw && outcomes.length === 0) {
    die(
      t(
        'Invalid --outcome. Write --outcome "<ref>=done"; separate multiple entries with semicolons.' +
          ` The outcome must be one of ${DIRECTIVE_OUTCOMES.join(" / ")} (a colon and a short note are allowed).`,
        'outcome 格式不对。写成 --outcome "<编号>=done"，多条用分号隔开；' +
          `结论只能是 ${DIRECTIVE_OUTCOMES.join(" / ")}（可在结论后用冒号补一句说明）。`,
      ),
    );
    return 1;
  }
  const okOutcomes: string[] = [];
  const badOutcomes: string[] = [];
  for (const o of outcomes) {
    const r = markDirectiveOutcome(root, o.ref, o.outcome, { note: o.note, by: id });
    if (r.ok) okOutcomes.push(`${o.ref}=${o.outcome}`);
    else badOutcomes.push(`${o.ref}：${r.reason}`);
  }
  if (okOutcomes.length) write(t(`${okOutcomes.length} directive outcome(s) recorded: ${okOutcomes.join(", ")}\n`, `已登记 ${okOutcomes.length} 条插话结论：${okOutcomes.join("，")}\n`));
  for (const bad of badOutcomes) write(t(`1 outcome not recorded: ${bad}\n`, `有 1 条结论未写入：${bad}\n`));

  const selfWorkerId = process.env.CAPITALIST_WORKER_ID ?? "";
  if (selfWorkerId) releaseAll(root, selfWorkerId);

  /** 报“完成”不直接结束，先挂成待确认。 */
  if (status === "done") {
    const gap = restartEvidenceGap(root, id);
    if (gap) {
      write(t(`Not accepted: ${gap}\n`, `不能算完成：${gap}\n`));
      write(t("This dispatch can only be closed after a real supervisor restart (new pid and start time).\n", "这类单只有一种合法完成方式：监工真的重启过（新的 pid、新的启动时间）。\n"));
      write(t("Workers must not restart the supervisor; it schedules them. Options:\n", "工作进程不重启监工：这会终止正在调度它的进程。处理方式：\n"));
      write(t("  1) Start it externally (scripts\\restart-supervisor.bat or a scheduled task);\n", "  1) 由外部拉起（scripts\\restart-supervisor.bat 或计划任务）；\n"));
      write(t("  2) Or run capitalist reload to persist progress, then restart it externally;\n", "  2) 或先 capitalist reload 把进度落盘，再由外部重起；\n"));
      write(t(`  3) After the restart is confirmed, close it with capitalist close ${id} --note "<new pid / start time>".\n`, `  3) 确认已重启后，用 capitalist close ${id} --note "<新 pid / 重启时间>" 手动结束任务。\n`));
      return 1;
    }
    const target = loadDispatchScope(root, id);
    /** 收工闸与送达用同一套匹配（`directiveMatches`），不各写一份。 */
    const me = String(process.env.CAPITALIST_WORKER_ID ?? "");
    const pending = listDirectives(root).filter((x) => {
      /** “还没落实”而不是“还没被领走”。 */
      if (!isDirectiveOpen(x)) return false;
      const mine = directiveMatches(x, {
        shard: target.shard,
        stage: target.stage,
        dispatchId: id,
        lineage: target.lineage,
        ...(me ? { workerId: me } : {}),
      });
      if (!mine) return false;
      /*
       * 送达太久还没结论：不再拿它挡收工。
       *
       * 新语义多了一条死锁路径（收到不回报 -> 永远报不了完成）。留这个窗口放行，
       * 让单能结出去；缺的那几条由验收判定在材料里点出来，不由收工闸拦截。
       */
      const dAt = Date.parse(String((x as { delivered_at?: string }).delivered_at ?? ""));
      if (Number.isFinite(dAt) && Date.now() - dAt >= DIRECTIVE_OUTCOME_GUARD_MS) return false;
      /** 只挡“刚登记、还有机会被下一次派单带走”的。 */
      const at = Date.parse(String((x as { at?: string }).at ?? ""));
      return !Number.isFinite(at) || Date.now() - at < DIRECTIVE_STALE_MS;
    });
    if (pending.length > 0) {
      write(t(`Cannot finish yet: ${pending.length} directive(s) lack an outcome\n`, `暂不能结束：还有 ${pending.length} 项要求未给出结论\n`));
      /*
       * 直接把命令行拼好。
       *
       * 这道闸挡的是“没回报”，不是“没做”，挡回一次就该让 worker 能一次补齐。
       * 只列原文不列命令的话，它会按自己的理解重写一遍格式，再被挡一次，来回几次就
       * 变成新的卡点（历史上有过卡整夜的先例）。
       */
      const args: string[] = [];
      for (const x of pending) {
        const ref = directiveShortRef(x);
        args.push(`${ref}=done`);
        write(`  - [${ref}] ${String(x.text ?? "").slice(0, 140)}\n`);
      }
      write(t("Report one outcome per directive, then run capitalist report:\n", "逐条回报结论后再 capitalist report：\n"));
      write(`  capitalist report ${id} --status ${status} --note "…" --outcome "${args.join(";")}"\n`);
      write(t("Use not_mine for directives owned elsewhere (state the owner); use blocked and name the blocker.\n", "本单不属于自己的写 not_mine 并说明归属；无法执行的写 blocked 并说明卡点；\n"));
      write(t("If one is hard to judge, register it with capitalist ask; the gate lets registered questions pass.\n", "不确定怎么算的，用 capitalist ask 说明；收工闸对已登记的问题放行。\n"));
      return 1;
    }

    /** 先判断监工是否在线：不在线时自行结束，不空等。 */
    if (!isSupervisorAlive(root)) {
      const why = "监工不在，无人裁决，按现状结束";
      const forced = finishDispatch(root, id, "done", note ? `${note}（${why}）` : why);
      if (!forced) {
        die(t(`Dispatch not found or already closed: ${id}`, `派单不存在或已了结：${id}`));
        return 1;
      }
      const fw = forced.worker ? loadWorker(root, forced.worker) : null;
      if (fw) saveWorker(root, { ...fw, status: "done" });
      recordEvent(root, "dispatch_done", {
        dispatch: id,
        stage: forced.stage,
        shard: forced.shard ?? "",
        worker: forced.worker ?? "",
        note: why,
        by: "self",
      });
      write(t(`Supervisor is not running, so no verdict is possible. ${id} closed as-is.\n`, `监工未运行，无法裁决：${id} 已按现状结束。\n`));
      if (note) write(t(`Note: ${note}\n`, `备注：${note}\n`));
      write(t("After the supervisor starts, `capitalist tasks` shows it accepted. If that is wrong, reopen it with capitalist dispatch.\n", "监工启动后 `capitalist tasks` 显示该项已验收；结论不符时执行 capitalist dispatch 重开派单。\n"));
      return 0;
    }

    const rv = markReported(root, id, note ?? "", evidence);
    if (!rv) {
      die(t(`Dispatch not found or already closed: ${id}`, `派单不存在或已了结：${id}`));
      return 1;
    }
    const w = rv.worker ? loadWorker(root, rv.worker) : null;
    /*
     * 报完成不等于该单结束：监工裁决之前它仍算在途。这里把进程标成 done 会让看板
     * 直接显示“已完成”，而报告可能正被退回重做。进程还在等裁决就保持运行态，
     * 退出后由监工回收；真正结束由监工的裁决写入派单台账。
     */
    if (w && !(w.pid > 0 && pidAlive(w.pid))) saveWorker(root, { ...w, status: "exited" });
    /*
     * 用户在本单执行期间新增/更正的要求，记在单上而不是并进 note。
     *
     * note 回答“这一单是怎么做的”，`added_reqs` 回答“这一单现在要做什么”。两者混成
     * 一段，审报告的人会把新增要求当成已完成项；分开之后，监工审报告时能同时看到
     * “原要求”和“后来加的要求”，按后者验。
     */
    if (added) {
      const lines = added
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      patchDispatchRow(root, id, { added_reqs: lines } as Partial<Dispatch>);
      recordEvent(root, "dispatch_added_reqs", {
        dispatch: id,
        stage: rv.stage,
        shard: rv.shard ?? "",
        worker: rv.worker ?? "",
        reqs: lines,
      });
    }
    recordEvent(root, "dispatch_reported", {
      dispatch: id,
      stage: rv.stage,
      shard: rv.shard ?? "",
      worker: rv.worker ?? "",
      note: note ?? "",
      added: added ? added.slice(0, 400) : "",
      evidence: evidence ? evidence.slice(0, 600) : "",
    });
    try {
      /** 证据只放证据。 */
      appendMq(root, {
        from: String(rv.worker ?? ""),
        dispatch: rv.id,
        stage: rv.stage,
        shard: String(rv.shard ?? ""),
        kind: "done",
        severity: "warn",
        needs: "none",
        text: String(note ?? "").trim() || "（工作进程未写说明）",
        ...(evidence ? { evidence } : {}),
      });
      /* 等监工裁决：要等它发出去（不等的话 CLI 退出会把请求带走）。 */
      await wakeSupervisor(root).catch(() => false);
    } catch {
      /* 队列写不进去不影响结束流程：审查是增强，不是前置条件 */
    }
    write(t(`Reported ${id}; waiting for the supervisor's verdict (it reviews the report and evidence before closing).\n`, `已上报完成 ${id}，等监工裁决（它看完报告与证据再决定结不结束，不再有倒计时）\n`));
    if (note) write(t(`Note: ${note}\n`, `说明：${note}\n`));
    if (added) write(t(`New requirement recorded; review follows it: ${added.slice(0, 200)}\n`, `已记录新增要求，监工按最新要求审这一单：${added.slice(0, 200)}\n`));
    write(t("The dispatch stays in flight until the verdict. Do not start another one for the same work.\n", "这一单在监工裁决前仍然算在途：不要再派一张去做同一件事。\n"));

    const verdict = await awaitVerdict(root, id, 240_000);
    if (verdict === "accepted") {
      write(t("Accepted. Dispatch closed.\n", "监工已验收，本单已结。\n"));
      return 0;
    }
    if (verdict === "rejected") {
      write(t(`Report rejected. Do not re-dispatch; keep working in this process.\n${verdictReason(root, id)}\n`, `监工退回本报告：不要重派，在本进程继续修改。\n${verdictReason(root, id)}\n`));
      return 1;
    }
    if (verdict === "escalated") {
      write(t(`Escalated to the user: ${id}\n${verdictReason(root, id)}\n`, `已转用户决策：${id}\n${verdictReason(root, id)}\n`));
      write(t("It will not be re-dispatched. After the user answers, wake it from the board or with capitalist wake --user.\n", "本单不再重派。用户答复后由看板唤醒，或 capitalist wake --user 唤醒后再执行。\n"));
      return 1;
    }
    if (verdict === "error") {
      write(t(`Error (not a rejection). Stop as recorded by the supervisor:\n${verdictReason(root, id)}\n`, `本单出现异常（非打回），按监工记录停手：\n${verdictReason(root, id)}\n`));
      write(t("Once the blocker is clear, describe it with capitalist ask. Do not open a new dispatch.\n", "确认卡在哪之后用 capitalist ask 说明，不要自己重开一张。\n"));
      return 0;
    }
    write(t("No verdict yet (the supervisor is busy). Do not re-report; keep working on what remains.\n", "裁决未出（监工正忙）。不要重报同一份，继续完成剩余部分；\n"));
    write(t("Blocked: capitalist ask \"<what blocks it>\" and stop. Finished: wait for the verdict; do not redo the same work.\n", "确实卡住：capitalist ask \"<卡在哪>\" 后停手；确实做完：等监工结论，不要重复改同一处。\n"));
    return 1;
  }

  // 此分支只处理 failed；done 已置为待确认并返回。
  const d = finishDispatch(root, id, status, note);
  if (!d) die(t(`Dispatch not found or already closed: ${id}`, `派单不存在或已了结：${id}`));

  const worker = d.worker ?? "";
  const rec = worker ? loadWorker(root, worker) : null;
  if (rec) {
    saveWorker(root, {
      ...rec,
      status: "failed",
      ...(rec.exit_code ? {} : { exit_code: -1 }),
    });
  }

  recordEvent(root, "dispatch_failed", {
    dispatch: id,
    stage: d.stage,
    shard: d.shard ?? "",
    worker,
    note: note ?? "",
    source: rec?.host === "manual" ? "manual" : "report",
  });

  write(t(`Reported ${id}: ${status}${note ? `, ${note}` : ""}\n`, `已上报 ${id}：${status}${note ? `，${note}` : ""}\n`));
  if (rec) write(t(`worker ${rec.id} marked failed\n`, `worker ${rec.id} 已标记为 failed\n`));
  return 0;
}

/**
 * 外部会话领单。
 *
 * 给没有可用 CLI 入口的宿主用：worker 是用户另开的独立会话，通过这条命令把自己绑到
 * 一张单上。领单是抢占式的，同一张单的第二个领取者得到空结果。
 */
export function cmdNext(p: Parsed): number {
  const root = rootOrDie(p);
  const d = firstOpenDispatch(root);
  if (!d) {
    write(t("No dispatch to claim.\n", "没有待领的派单。\n"));
    return 0;
  }

  const session = flagString(p, "session") ?? newWorkerId(root, d.id);
  const claimed = claimDispatch(root, d.id, session, session);
  if (!claimed) die(t("Another worker just claimed it. Run capitalist next again.", "这张单刚被别的 worker 领走，重新 capitalist next"));

  const now = new Date().toISOString();
  registerWorker(root, {
    id: session,
    host: "manual",
    pid: process.pid,
    session,
    dispatch: claimed.id,
    shard: claimed.shard ?? "",
    stage: claimed.stage,
    started_at: now,
    heartbeat_at: now,
    heartbeat_ts: Date.now() / 1000,
    status: "running",
    log: "",
  });

  write(
    t(`Dispatch ${claimed.id} (${claimed.stage}${claimed.shard ? `/${claimed.shard}` : ""})\n`, `派单 ${claimed.id}（${claimed.stage}${claimed.shard ? `/${claimed.shard}` : ""}）\n`) +
      `${claimed.action}\n\n` +
      `${buildGroundingBlock(claimed).join("\n")}\n\n` +
      t(`When done: capitalist report ${claimed.id} done --note "<what was done>" --evidence "<changes / tests / result>"\n`, `完成后：capitalist report ${claimed.id} done --note "<做了什么>" --evidence "<改了哪几处 / 跑了什么 / 结果>"\n`) +
      t(`Blocked: capitalist ask "<question>" or capitalist block <type> "<what blocks it>"\n`, `卡住：capitalist ask "<问题>" 或 capitalist block <类型> "<卡在哪>"\n`),
  );
  return 0;
}

/**
 * 唤醒暂停的派单。
 *
 * 省略目标时唤醒本任务根全部暂停单。目标写法与 `capitalist close` 一致：派单 id、分片名
 * 或 `shard:<名>`。唤醒只解除暂停标记，不改阶段、不清重派计数；唤醒后的单按正常队列顺序
 * 参与调度，失败仍按原有退避与上限重派。
 */
export function cmdWake(p: Parsed): number {
  const root = rootOrDie(p);
  const target = String(p.positional[0] ?? "").trim();

  /* 唤醒目标为上次中断的旧派单，该派单可能已经过时；与 capitalist resume 一致，唤醒需要用户动作。 */
  if (!flagBool(p, "user") && !(process.stdin.isTTY && process.stdout.isTTY)) {
    write(
      t(
        "Waking a paused dispatch needs a user action.\n" +
          "Not running in an interactive terminal, so it stays paused.\n" +
          "To wake it explicitly: capitalist wake --user [<dispatch-id|shard>], or wake it from the board.\n",
        "拒绝：唤醒暂停的派单需要用户动作。\n" +
          "当前不在交互终端（宿主会话里的命令执行），按启动规则保持暂停。\n" +
          "用户明确要求唤醒时：capitalist wake --user [<派单id|分片>]；或由用户在看板逐单唤醒。\n",
      ),
    );
    return 1;
  }

  const paused = pausedDispatches(root);
  if (paused.length === 0) {
    write(t("No paused dispatches.\n", "没有处于暂停状态的派单。\n"));
    return 0;
  }

  const picked = target
    ? paused.filter(
        (d) =>
          d.id === target ||
          String(d.shard ?? "") === target ||
          `shard:${String(d.shard ?? "")}` === target,
      )
    : paused;
  if (picked.length === 0) {
    write(t(`No matching paused dispatch: ${target}\n`, `没有匹配的暂停派单：${target}\n`));
    write(t(`Paused: ${paused.map((d) => d.id).join(", ")}\n`, `暂停中：${paused.map((d) => d.id).join("、")}\n`));
    return 1;
  }

  const lines: string[] = [];
  for (const d of picked) {
    const r = wakeDispatch(root, d.id);
    if (!r) continue;
    lines.push(`${r.id}  ${r.from === r.to ? r.to : t(`${r.from} -> ${r.to}`, `${r.from} 改为 ${r.to}`)}`);
    recordEvent(root, "dispatch_wake", {
      dispatch: r.id,
      stage: d.stage,
      shard: d.shard ?? "",
      from: r.from,
      to: r.to,
      by: "user",
    });
  }
  write(t(`${lines.length} dispatch(es) woken; they join the queue from the next round.\n`, `已唤醒 ${lines.length} 张派单，下一轮调度起按队列顺序参与。\n`));
  for (const line of lines) write(`  ${line}\n`);
  if (existsSync(join(supervisorDir(root), "pause.json"))) {
    write(t("Global pause is still in effect (.capitalist/pause.json); run capitalist resume before dispatching.\n", "全局暂停仍有效（.capitalist/pause.json），执行 capitalist resume 后才会派单。\n"));
  }
  return 0;
}

/**
 * 列出工作进程与监工状态。
 *
 * `--json` 输出原始记录。
 */
export function cmdWorkers(p: Parsed): number {
  const root = rootOrDie(p);
  const rows = listWorkers(root);

  if (flagBool(p, "json")) {
    writeJson(rows);
    return 0;
  }
  if (rows.length === 0) {
    write(t("No worker records\n", "没有 worker 记录\n"));
    return 0;
  }
  for (const w of rows) {
    const mode = w.mode === "visible" ? t("  [window]", "  [窗口]") : "";
    write(
      `${w.id}  ${w.status.padEnd(8)}  pid ${String(w.pid).padEnd(7)}  ${w.host.padEnd(9)}  ${w.stage}  ${w.dispatch}${mode}\n`,
    );
    // 退出/失败的 worker 附一句原因：只显示 exited 等于让人去翻日志。
    if (w.status === "exited" || w.status === "failed") {
      const why = workerExitReason(root, w);
      if (why) write(`  ↳ ${why}\n`);
    }
  }
  const supervisorRec = loadSupervisor(root);
  const supervisorInfo = supervisorDisplayState(root);
  if (supervisorRec) {
    write(
      t(
        `\nSupervisor: ${SUPERVISOR_STATE_LABEL[supervisorInfo.state]} (pid ${supervisorInfo.pid}) ${supervisorInfo.detail}, concurrency ${supervisorRec.max_workers}\n`,
        `\n监工：${SUPERVISOR_STATE_LABEL[supervisorInfo.state]}（pid ${supervisorInfo.pid}）${supervisorInfo.detail}，并行度 ${supervisorRec.max_workers}\n`,
      ),
    );
  }
  return 0;
}

/**
 * 中断指定工作进程。
 *
 * 结束进程与把它的派单一并按失败结束，两件事都在 core/commands.stopWorker 里做。
 * 只标 worker 不结束会留下 claimed 僵尸：监工以为有人还在干，这张单不再重派，界面上的
 * 进行中状态一直转着。
 */
export function cmdStopWorker(p: Parsed): number {
  const id = p.positional[0];
  if (!id) die(t("Usage: capitalist stop-worker <worker-id> [--requeue] | capitalist stop-worker --help", "用法：capitalist stop-worker <worker-id> [--requeue] ｜ capitalist stop-worker --help"));
  const root = rootOrDie(p);
  const requeue = flagBool(p, "requeue");
  const reason = flagString(p, "reason") ?? "";
  const r = stopWorker(root, id, { requeue, ...(reason ? { reason } : {}) });
  if (!r) die(t(`No such worker: ${id} (see capitalist workers)`, `没有该 worker 记录：${id}（用 capitalist workers 查看现有 worker）`));

  const termNote = r.killed ? t(", SIGTERM sent", "，已发送 SIGTERM") : r.alreadyTerminal ? t(", already terminal", "，进程已处于终态") : t(", process gone or unkillable", "，进程已不在或无法终止");
  write(
    t(`Worker ${r.id} (pid ${r.pid}) stopped${termNote}.\n`, `已中断工作进程 ${r.id}（pid ${r.pid}）${termNote}。\n`) +
      (r.dispatch
        ? requeue
          ? t(`Dispatch ${r.dispatch} requeued; it restarts next round.\n`, `派单 ${r.dispatch} 已退回待派，下一轮调度重新拉起。\n`)
          : t(`Dispatch ${r.dispatch} closed as failed.\n`, `派单 ${r.dispatch} 已按失败结束（不留 claimed 僵尸）。\n`)
        : t("This worker had no open dispatch.\n", "该 worker 没有在途派单。\n")) +
      (requeue
        ? t("Effect: the dispatch is re-dispatched next round; the session continues on the same lane with history intact.\n", "后果：下一轮调度重派这一单，会话按同一 lane 续接，历史不丢失。\n")
        : t("Effect: the dispatch is re-dispatched next round unless the shard is taken over (capitalist takeover) or blocked (capitalist block).\n", "后果：下一轮调度会重派这一单，除非该片被接管（capitalist takeover）或登记了阻塞（capitalist block）。\n")),
  );
  return 0;
}

/**
 * 手动结束任务：`capitalist close <派单id|worker-id|分片>`。
 *
 * 与 `stop-worker` 的差别是调度后果：那个按失败结束、下一轮调度会重派，这个关成终态
 * `closed`，调度层不再为它重新派单。排队中的单没有进程，所以三步里只有“结束”这一步。
 */
export function cmdClose(p: Parsed): number {
  const target = p.positional[0];
  if (!target) die(t('Usage: capitalist close <dispatch-id|worker-id|shard> [--reason "why"]', '用法：capitalist close <派单id|worker-id|分片> [--reason "为什么关"]'));
  const root = rootOrDie(p);
  const reason = flagString(p, "reason") ?? "";
  const r = closeTask(root, target, { reason, by: "user" });
  if (!r) {
    die(
      t(
        `Nothing to close: ${target} (check the board queue or capitalist workers; dispatches already done / failed / closed cannot be closed again)`,
        `没有可结束的单：${target}（用看板任务队列或 capitalist workers 查看；已 done / failed / closed 的单不能再关）`,
      ),
    );
  }
  /*
   * 结束任务即终止该单的追加投递。
   *
   * 否则每轮调度都会看到“未消费的追加且目标已结束”，把刚结束的单重新置为 open 补投递，
   * 用户看到的就是取消后立刻变回“待重派”。用户手动结束是明确意图，优先级高于补投递。
   */
  const dropped = dropDirectivesFor(
    root,
    String(r.dispatch),
    reason ? `用户结束任务：${reason}` : "用户手动结束任务，追加内容不再投递",
  );

  if (flagBool(p, "json")) {
    writeJson({ ok: true, ...r });
    return 0;
  }
  const where = r.shard ? `${r.shard}` : t("(whole stage)", "整阶段");
  write(
    t(`Closed ${r.dispatch} (${where}), ${r.from} -> closed.\n`, `已结束 ${r.dispatch}（${where}），原状态 ${r.from} -> closed。\n`) +
      (r.worker
        ? t(`Worker ${r.worker} (pid ${r.pid}) ${r.killed ? "SIGTERM sent" : "already terminal or gone"}.\n`, `工作进程 ${r.worker}（pid ${r.pid}）${r.killed ? "已发送 SIGTERM" : "已处于终态或已不在"}。\n`)
        : t("It was still queued with no process and has been removed from the queue.\n", "这一单还在排队，没有运行中的进程，已从队列撤下。\n")) +
      t("Record: .capitalist/inbox/dispatch.jsonl now has it closed (closed_at / closed_by / note); event dispatch_closed written to .capitalist/events.jsonl.\n", "记录：.capitalist/inbox/dispatch.jsonl 该单状态 closed（closed_at / closed_by / note），事件 dispatch_closed 已写入 .capitalist/events.jsonl。\n") +
      (dropped.length
        ? t(`${dropped.length} directive(s) aimed at it were marked no longer delivered (otherwise it would be set back to open).\n`, `${dropped.length} 条指向它的追加内容已标记不再投递（否则该单会被重新置为 open）。\n`)
        : "") +
      t("Effect: no re-dispatch. To reopen: capitalist update inbox/dispatch <id> status open.\n", "后果：监工不再为它重新派单；要重开请用 capitalist update inbox/dispatch <id> status open。\n"),
  );
  return 0;
}

/** 手动插队：`capitalist promote <派单id|worker-id|分片>`。 */
export function cmdPromote(p: Parsed): number {
  const raw = p.positional[0];
  if (!raw) die(t("Usage: capitalist promote <dispatch-id|worker-id|shard|#task-no>", "用法：capitalist promote <派单id|worker-id|分片|#任务号>"));
  const root = rootOrDie(p);
  const noM = /^\s*#\s*(\d{1,4})\b/.exec(raw);
  const byNo = noM ? dispatchOfThreadNo(root, Number(noM[1])) : undefined;
  const target = byNo ? String(byNo.id) : raw;
  const r = promoteTask(root, target, { by: "user" });
  if (!r) die(t(`No such dispatch: ${raw} (see capitalist tasks or the board queue)`, `没有这张单：${raw}（用 capitalist tasks / 看板任务队列查看派单 id）`));
  if (!r.ok) die(t(`Promote failed: ${r.reason}`, `插队失败：${r.reason}`));

  if (flagBool(p, "json")) {
    writeJson({ ...r });
    return 0;
  }
  const where = r.shard ? `${r.shard}` : t("(whole stage)", "整阶段");
  const live = listWorkers(root).filter((w) => w.status === "running" || w.status === "starting").length;
  const cap = Math.max(1, Number(loadSupervisor(root)?.max_workers ?? 1) || 1);
  write(
    t(
      `Promoted ${r.dispatch} (${where})${r.already ? " (already at front, refreshed)" : ""}; skipped ${r.ahead} queued dispatch(es).\n`,
      `已置顶 ${r.dispatch}（${where}）${r.already ? "· 重复置顶，已刷新到队首" : ""}：越过 ${r.ahead} 张排队单。\n`,
    ) +
      (r.behind
        ? t(`An immediate-run dispatch (${r.behind}) is running; this one waits at the front and starts when it finishes.\n`, `立即执行 ${r.behind} 已运行中，这一单按置顶排队；它结束后按队列顺序派发。\n`)
        : live < cap
          ? t(`${live}/${cap} slots free; the process starts next round (within 5 s).\n`, `当前 ${live}/${cap} 个槽有空，下一轮（5 秒内）拉起进程。\n`)
          : t(`${live}/${cap} slots busy: the supervisor suspends one running task to free a slot (shown as “yielded”); it resumes in order afterwards.\n`, `当前 ${live}/${cap} 个槽均已占用：监工下一轮挂起一个运行中的任务腾出槽位，该任务显示“已让位”，结束后按原顺序恢复。\n`)) +
      t("Record: urgent / promoted_at / promoted_by written to .capitalist/inbox/dispatch.jsonl; event dispatch_promoted recorded.\n", "记录：.capitalist/inbox/dispatch.jsonl 写 urgent / promoted_at / promoted_by，事件 dispatch_promoted 已写入。\n"),
  );
  return 0;
}
