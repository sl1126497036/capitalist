import { listDirectives } from "../../core/dispatch/commands";
import { mqPath } from "../../core/dispatch/mq";
import { Dispatch, WorkerRecord } from "../../core/record/supervisor";
import { dispatchNoTable } from "../usage/threadNo";
import { readWorkerEvents, FRESH_LOG_SEC, logIdleSec, chunkWorkerLines, readJsonlFromTail } from "./logs";
import { fingerprint, toolSummary, verdictText } from "./render";
import { ThreadMessage } from "./snapshot";
import { BOARD_READ_TTL_MS, atTs, attachmentsOf, eventsFile, listWorkersBoard, readDispatchesBoard } from "./sources";
import { taskKeyOf } from "./state";
import { statSync } from "node:fs";

/**
 * 看板消息流：把派单记录、监工指令、工作进程日志汇成一条有序消息。
 *
 * 依赖线程快照作为数据源，但不参与线程列表与计数，两者互不引用。
 */
export interface ThreadContext {
  dispatches: Dispatch[];
  workers: WorkerRecord[];
  directives: ReturnType<typeof listDirectives>;
  eventsByDispatch: Map<string, Array<Record<string, unknown>>>;
  eventsByWorker: Map<string, Array<Record<string, unknown>>>;
  /** 事件台账的 text 只留前 400 字，任务面板按申报 id 回查原文显示。 */
  mqById: Map<string, Record<string, unknown>>;
  triaged: Set<string>;
  /** 派单 id 到任务编号只读一次编号表，与任务列表同源。 */
  nos: Map<string, string>;
}

export const messageContextCache = new Map<string, { at: number; ctx: ThreadContext }>();

/** 一轮页面构建里，线程消息会按线程各取一次上下文；同一任务根 800ms 内复用。 */
export function messageContext(root: string): ThreadContext {
  const hit = messageContextCache.get(root);
  if (hit && Date.now() - hit.at < BOARD_READ_TTL_MS) return hit.ctx;
  const ctx = buildMessageContext(root);
  messageContextCache.set(root, { at: Date.now(), ctx });
  return ctx;
}

export function buildMessageContext(root: string): ThreadContext {
  const dispatches = readDispatchesBoard(root);
  const workers = listWorkersBoard(root);
  const directives = listDirectives(root);
  const eventsByDispatch = new Map<string, Array<Record<string, unknown>>>();
  const eventsByWorker = new Map<string, Array<Record<string, unknown>>>();
  const triage: Array<Record<string, unknown>> = [];
  const triaged = new Set<string>();

  const mqById = new Map<string, Record<string, unknown>>();
  for (const r of readJsonlFromTail(mqPath(root), 4_000_000)) {
    const id = String(r.id ?? "");
    if (id) mqById.set(id, r);
  }

  for (const e of readJsonlFromTail(eventsFile(root), 512_000)) {
    if (String(e.event ?? e.kind ?? "") === "mq_triage") triage.push(e);
    const d = String(e.dispatch ?? "");
    const w = String(e.worker ?? "");
    if (d) {
      const list = eventsByDispatch.get(d);
      if (list) list.push(e);
      else eventsByDispatch.set(d, [e]);
    }
    if (w) {
      const list = eventsByWorker.get(w);
      if (list) list.push(e);
      else eventsByWorker.set(w, [e]);
    }
  }

  for (const e of triage) {
    const msgId = String(e.msg ?? "");
    if (msgId) triaged.add(msgId);
    const rep = mqById.get(msgId);
    const d = String(rep?.dispatch ?? "");
    const w = String(e.from ?? "");
    if (d) {
      const list = eventsByDispatch.get(d);
      if (list) list.push(e);
      else eventsByDispatch.set(d, [e]);
    }
    if (w) {
      const list = eventsByWorker.get(w);
      if (list) list.push(e);
      else eventsByWorker.set(w, [e]);
    }
  }
  return { dispatches, workers, directives, eventsByDispatch, eventsByWorker, mqById, triaged, nos: dispatchNoTable(root) };
}

export interface ThreadMessageOptions {
  limit?: number;
  since?: number;
  logTailBytes?: number;
}

export function buildThreadMessages(
  root: string,
  threadId: string,
  shard: string,
  opts: ThreadMessageOptions = {},
): { messages: ThreadMessage[]; total: number; next_since: number } {
  return threadMessages(messageContext(root), threadId, shard, opts);
}

export function threadMessages(
  ctx: ThreadContext,
  threadId: string,
  shard: string,
  opts: ThreadMessageOptions = {},
): { messages: ThreadMessage[]; total: number; next_since: number } {
  let s = shard;
  let taskStage = "";
  if (!s && threadId.startsWith("shard:")) s = threadId.slice(6);
  let lineageTail = "";
  if (threadId.includes("/")) {
    const parts = threadId.split("/");
    /** 阶段从任务键里取，调用方另给 shard 也要能认回原键。 */
    taskStage = String(parts[0] ?? "").trim().toLowerCase();
    if (!s) {
      const tail = String(parts[1] ?? "").trim().toLowerCase();
      if (tail === "main") {
        s = "";
      } else if (/^x[0-9a-z]{3,}$/.test(tail) && !ctx.workers.some((w) => String(w.shard ?? "").trim().toLowerCase() === tail)) {
        s = "";
        lineageTail = tail.slice(1);
      } else {
        s = tail;
      }
    }
  }

  const msgs: ThreadMessage[] = [];
  const dispatches = ctx.dispatches;
  const workers = ctx.workers;
  const sameTask = (w: { stage: string; shard?: string | null }): boolean =>
    (!taskStage || String(w.stage || "").toLowerCase() === taskStage) &&
    String(w.shard ?? "").toLowerCase() === String(s ?? "").toLowerCase();
  const keyOfWorker = (w: WorkerRecord): string => {
    const d = w.dispatch ? dispatches.find((x) => x.id === w.dispatch) : undefined;
    /** 与建端同一份实现（taskKeyOf），不另算一份。 */
    return taskKeyOf(w.stage, w.shard, String((d as { lineage?: string } | undefined)?.lineage ?? ""));
  };
  const wantKey = threadId.trim().toLowerCase();
  /** 带斜杠的是任务键，其余是老的工作进程 id 或 shard:xxx。 */
  const isTaskKey = threadId.includes("/");
  const byKey = isTaskKey
    ? [...workers]
        .filter((w) => keyOfWorker(w) === wantKey)
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0]
    : undefined;
  const sameLineage = lineageTail
    ? [...workers]
        .filter((w) => {
          if (taskStage && String(w.stage || "").trim().toLowerCase() !== taskStage) return false;
          if (String(w.shard ?? "").trim()) return false;
          const d = w.dispatch ? dispatches.find((x) => x.id === w.dispatch) : undefined;
          const lin = String((d as { lineage?: string } | undefined)?.lineage ?? "");
          /** 精确比尾号，不用 endsWith。 */
          return lin !== "" && lin.slice(-6) === lineageTail;
        })
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0]
    : undefined;
  const worker =
    workers.find((w) => w.id === threadId) ??
    byKey ??
    sameLineage ??
    (!isTaskKey && (s || taskStage)
      ? [...workers].filter(sameTask).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0]
      : undefined);
  const tid = threadId || worker?.id || (s ? `shard:${s}` : "");

  const keyOfDispatch = (d: Dispatch): string =>
    taskKeyOf(d.stage, d.shard, String((d as { lineage?: string }).lineage ?? ""));
  const related = new Set<string>();
  for (const d of dispatches) {
    if (worker) {
      if (d.worker === worker.id || d.id === worker.dispatch) related.add(d.id);
      continue;
    }
    if (isTaskKey) {
      /** 无执行者的任务键线程按同一个键认领派单。 */
      if (keyOfDispatch(d) === wantKey) related.add(d.id);
      continue;
    }
    if (s && d.shard === s) related.add(d.id);
    else if (!s && d.id === threadId) related.add(d.id);
  }

  for (const d of dispatches) {
    if (!related.has(d.id)) continue;
    const dur = d.done_at ? Math.max(0, atTs(d.done_at) - atTs(d.at)) : undefined;
    const dAtts = attachmentsOf({ atts: d.atts, text: d.action });
    const dNo = ctx.nos.get(d.id) ?? "";
    msgs.push({
      id: `D-${d.id}`,
      at: d.at,
      role: "supervisor",
      kind: "dispatch",
      text: d.action,
      tool: "",
      cmd: d.action,
      status: d.status,
      thread: tid,
      ...(dNo ? { no: dNo } : {}),
      ...(dAtts.length ? { atts: dAtts } : {}),
      ...(dur !== undefined ? { duration_sec: Math.round(dur) } : {}),
    });
  }

  if (worker) {
    const events = readWorkerEvents(worker.log, opts.logTailBytes);
    const lines = events.text;
    const relatedDispatch = dispatches.find((d) => d.id === worker.dispatch);
    const t0 = atTs(worker.started_at) || atTs(relatedDispatch?.at) || Date.now() / 1000;
    const logTouched = ((): number => {
      try {
        return statSync(worker.log).mtimeMs / 1000;
      } catch {
        return 0;
      }
    })();
    const t1 = relatedDispatch?.done_at
      ? atTs(relatedDispatch.done_at)
      : logTouched > 0
        ? logTouched
        : atTs(worker.heartbeat_at) || t0 + lines.length;
    const span = Math.max(t1 - t0, 1);

    if (lines.length === 0 && events.tools.length === 0) {
      const live = worker.status === "running" || worker.status === "starting";
      const idle = logIdleSec(worker.log);
      const fresh = Number.isFinite(idle) && idle < FRESH_LOG_SEC;
      msgs.push({
        id: `${worker.id}#empty`,
        at: new Date(t1 * 1000).toISOString(),
        role: "worker",
        kind: "tool",
        text: live
          ? fresh
            ? "进程运行中 · 正在输出"
            : `进程运行中 · 日志 ${Math.round(idle)}s 前更新`
          : "进程已结束 · 无输出文本 · 日志仅含宿主运行记录",
        tool: "",
        cmd: "",
        status: worker.status,
        thread: tid,
        lines: 0,
      });
    }

    if (events.tools.length > 0) {
      msgs.push({
        id: `${worker.id}#tools`,
        at: new Date(t1 * 1000).toISOString(),
        role: "worker",
        kind: "tool",
        text: events.tools.slice(-8).join("\n"),
        tool: "",
        cmd: "",
        status: worker.status,
        thread: tid,
        lines: events.tools.length,
        idle_sec: Number.isFinite(logIdleSec(worker.log)) ? Math.round(logIdleSec(worker.log)) : -1,
      });
    }

    /*
     * 思考按“用户插话”切块，不按段切。
     *
     * 原先合并成一条：用户中途追加要求后，新一轮的思考也落进同一条里，看不出前后是两轮。
     * 但每段单独成条又会把一次连续推理拆成十几张卡，读起来更零散。正确的粒度是插话边界：
     * 同一段插话区间内的思考合并，越过一次插话才另起一块。
     *
     * 思考段本身没有时间戳，按段序号在 t0..t1 之间插值；首段的插入时刻晚于 t0，使“启动进程”
     * 稳定排在思考之前，不依赖同一时刻的插入顺序。
     *
     * 插话归属：`target` 指向本单或本进程，或在这条进程会话里发出；认不出的不参与切块，
     * 免得其他线程的插话干扰切块。
     *
     * 只卡 `t0` 下限，不卡 `t1` 上限：插话刚发出时日志还没更新，`t1` 仍是旧 mtime，
     * 卡上限会把这条插话排除在外，后面就判不出“插话后还没有新思考”。对切块无副作用：
     * 段的时间都在 `t0..t1` 内插值，`t > t1` 的插话永远不满足 `t < at`，序号不变。
     */
    const thinkSayTimes = ctx.directives
      .filter((d) => {
        const target = String(d.target ?? "");
        const from = String(d.thread ?? "");
        if (target) return target === String(worker.dispatch ?? "") || target === String(worker.id ?? "");
        return Boolean(from) && from === String(worker.id ?? "");
      })
      .map((d) => d.at_ts)
      .filter((t) => t > t0)
      .sort((a, b) => a - b);

    if (events.thinking.length > 0) {
      const blocks: { at: number; body: string[] }[] = [];
      events.thinking.forEach((body, i) => {
        const at = t0 + (span * (i + 1)) / (events.thinking.length + 1);
        /* 已经越过几次插话，就属于第几块。 */
        const idx = thinkSayTimes.filter((t) => t < at).length;
        while (blocks.length <= idx) blocks.push({ at, body: [] });
        const block = blocks[idx]!;
        if (block.body.length === 0) block.at = at;
        block.body.push(body);
      });
      blocks.forEach((block, i) => {
        if (block.body.length === 0) return;
        const body = block.body.join("\n");
        msgs.push({
          id: `${worker.id}#think-${i}`,
          at: new Date(block.at * 1000).toISOString(),
          role: "worker",
          kind: "thinking",
          text: body,
          tool: "",
          cmd: "",
          status: worker.status,
          thread: tid,
          lines: body.split("\n").length,
        });
      });

      /*
       * 插话已送达、但工作进程还没产出新的思考：最后一段（越过全部插话的那一块）此时是空的，
       * 界面停在插话前那张思考卡上，刷新后也看不出这次插话生效，看起来像没发出去。
       * 补一条占位块，给插话留下可见落点；新思考一到，这个位置自然被真内容占掉，占位消失。
       *
       * 判据用“块序号 = 已越过几次插话”这一既有语义，不做时间比较：思考段本身没有真实
       * 时间戳，`at` 是在 `t0..t1` 之间按序号插值出来的，拿它和 `at_ts` 比会误判。
       * 占位只在已有思考块时补：宿主不输出推理时不该凭空造一张“思考过程”。
       */
      const pendingIdx = thinkSayTimes.length;
      const lastSay = pendingIdx > 0 ? thinkSayTimes[pendingIdx - 1]! : 0;
      const tail = blocks[pendingIdx];
      if (lastSay > 0 && (!tail || tail.body.length === 0)) {
        const live = ["running", "starting", "claimed"].includes(String(worker.status ?? ""));
        /* 排在所有已有思考块之后：插值时间可能晚于插话时刻，取两者较大值再让一步。 */
        const lastAt = blocks.reduce((mx, b) => (b.body.length > 0 ? Math.max(mx, b.at) : mx), t0);
        const at = Math.max(lastSay, lastAt + 0.001);
        const text = live ? "插话已送达，正在重新思考" : "插话已送达，下一轮派单时生效";
        msgs.push({
          id: `${worker.id}#think-pending`,
          at: new Date(at * 1000).toISOString(),
          role: "worker",
          kind: "thinking",
          text,
          tool: "",
          cmd: "",
          status: worker.status,
          thread: tid,
          lines: 1,
        });
      }
    }

    const chunks = chunkWorkerLines(lines);
    let offset = 0;
    for (let ci = 0; ci < chunks.length; ci++) {
      const block = chunks[ci] ?? [];
      const at = t0 + (span * (offset + block.length)) / (lines.length + 1);
      msgs.push({
        id: `${worker.id}#${offset}`,
        at: new Date(at * 1000).toISOString(),
        role: "worker",
        kind: "output",
        text: block.join("\n"),
        tool: "",
        cmd: "",
        status: worker.status,
        thread: tid,
        lines: block.length,
      });
      offset += block.length;
    }
    if (events.debug.length > 0) {
      msgs.push({
        id: `${worker.id}#engine`,
        at: new Date(t1 * 1000).toISOString(),
        role: "worker",
        kind: "engine",
        text: events.debug.join("\n"),
        tool: "",
        cmd: "",
        status: worker.status,
        thread: tid,
        lines: events.debug.length,
        hidden: events.hidden,
      });
    }
  }

  const picked = new Set<Record<string, unknown>>();
  for (const id of related) {
    for (const e of ctx.eventsByDispatch.get(id) ?? []) picked.add(e);
  }
  if (worker) {
    for (const e of ctx.eventsByWorker.get(worker.id) ?? []) picked.add(e);
  }
  for (const e of picked) {
    const name = String(e.event ?? e.kind ?? "");
    if (name === "tool") {
      const t = toolSummary(e);
      msgs.push({
        id: `T-${fingerprint(e)}`,
        at: String(e.at ?? ""),
        role: "worker",
        kind: "tool",
        text: t.text,
        tool: String(e.tool ?? ""),
        cmd: t.cmd,
        status: String(e.decision ?? ""),
        thread: tid,
      });
      continue;
    }
    if (name === "dispatch_open") continue;
    const text = verdictText(e, ctx.mqById, ctx.nos);
    if (!text.trim()) continue;
    msgs.push({
      id: `E-${fingerprint(e)}`,
      at: String(e.at ?? ""),
      role: "supervisor",
      kind: "verdict",
      text,
      tool: "",
      cmd: "",
      /** 申报自己不带处理状态，按是否存在 mq_triage 标注。 */
      status: name === "mq_message" ? (ctx.triaged.has(String(e.id ?? "")) ? "done" : "pending") : String(e.event ?? e.kind ?? ""),
      event: name,
      thread: tid,
    });
  }

  const threadKeysOfDirective = (r: {
    thread?: unknown;
    shard?: unknown;
    target?: unknown;
    lineage?: unknown;
  }): Set<string> => {
    const keys = new Set<string>();
    const thread = String(r.thread ?? "").trim();
    const target = String(r.target ?? "").trim();
    const lineage = String(r.lineage ?? "").trim();
    const rshard = String(r.shard ?? "").trim();
    if (rshard) keys.add(`shard:${rshard.toLowerCase()}`);
    if (thread) {
      keys.add(thread);
      const w = workers.find((x) => x.id === thread);
      if (w) keys.add(keyOfWorker(w));
    }
    if (!target && !lineage && !rshard) return keys;
    for (const d of dispatches) {
      const dl = String((d as { lineage?: string }).lineage ?? "");
      if (target && target !== d.id && target !== String(d.worker ?? "")) continue;
      if (lineage && lineage !== dl) continue;
      if (rshard && String(d.shard ?? "") !== rshard) continue;
      keys.add(keyOfDispatch(d));
      if (d.worker) keys.add(String(d.worker));
    }
    if (rshard) {
      for (const d of dispatches) {
        if (String(d.shard ?? "") === rshard) keys.add(keyOfDispatch(d));
      }
      if (taskStage) keys.add(taskKeyOf(taskStage, rshard));
    }
    return keys;
  };
  for (const r of ctx.directives) {
    const keys = threadKeysOfDirective(r);
    /** 归属一个都算不出来的老记录不上屏。 */
    if (keys.size === 0) continue;
    if (!keys.has(threadId) && !keys.has(wantKey) && !keys.has(tid)) continue;
    const took = r.consumed === true ? String((r as { consumed_by?: unknown }).consumed_by ?? "").trim() : "";
    const tookNo = took ? ctx.nos.get(took) ?? "" : "";
    msgs.push({
      id: `S-${fingerprint(r)}`,
      at: String(r.at ?? ""),
      role: (r as { via?: unknown }).via === "capitalist" ? "supervisor" : "user",
      kind: "say",
      text: String(r.text ?? ""),
      tool: "",
      cmd: "",
      status: r.consumed
        ? (() => {
            const via = String((r as { consumed_via?: unknown }).consumed_via ?? "");
            /* 无进程领走的记录不能显示成“已并入派单”，否则用户会以为内容已进入执行。 */
            if (via === "dropped") return "未投递 · 所属单已随阶段推进作废";
            const viaHook = via === "hook";
            const base = viaHook ? "已送达执行中的进程" : "已并入派单";
            const outcome = String((r as { outcome?: unknown }).outcome ?? "");
            const tail =
              outcome === "done"
                ? " · 已落实"
                : outcome === "not_mine"
                  ? " · 判为不属本单"
                  : outcome === "blocked"
                    ? " · 卡住"
                    : (r as { delivered?: unknown }).delivered === true
                      ? " · 待结论"
                      : "";
            return base + tail;
          })()
        : (() => {
            const targetId = String((r as { target?: unknown }).target ?? "");
            const td = targetId ? ctx.dispatches.find((x) => String(x.id) === targetId) : undefined;
            const ts = String(td?.status ?? "");
            if (!td) return "已登记，随归属单带入";
            if (ts === "open") return "随派单启动带入";
            if (ts === "claimed" || ts === "reported" || ts === "review") return "已登记，进程下一次动作间隙送达";
            return "待补投递";
          })(),
      ...(tookNo ? { no: tookNo } : {}),
      thread: tid,
      ...(attachmentsOf(r).length ? { atts: attachmentsOf(r) } : {}),
    });
  }

  msgs.sort((a, b) => atTs(a.at) - atTs(b.at) || a.text.localeCompare(b.text));
  const normBody = (s: unknown): string =>
    String(s ?? "")
      .replace(/^\[附件\][^\n]*$/gm, "")
      .replace(/\s+/g, "")
      .toLowerCase();
  const saidBodies = msgs
    .filter((m) => (m.role === "user" || m.role === "supervisor") && m.kind === "say")
    .map((m) => normBody(m.text))
    .filter((s) => s.length > 0);
  const deduped = msgs.filter((m) => {
    if (m.kind !== "verdict") return true;
    const text = String(m.text ?? "");
    if (!/^派单 \S+ 追加内容/.test(text)) return true;
    const body = normBody(text.replace(/^派单 \S+ 追加内容(?:（未给出正文）)?[：:]?/, ""));
    if (body.length < 8) return true;
    return !saidBodies.some((saidBody) => saidBody.startsWith(body));
  });
  const nonEmpty = deduped.filter((m) => m.text.trim() !== "");
  const total = nonEmpty.length;
  const sinceTs = opts.since !== undefined && Number.isFinite(opts.since) && opts.since > 0 ? opts.since : 0;
  /*
   * 思考块的 `at` 是按段序号在 `t0..t1` 之间插值出来的，不是真实时刻。新块生成后它的时间
   * 常常早于游标，用 `> since` 过滤会让它永远进不了增量结果——界面上表现为「这一段一直
   * 没有思考过程，只有工具行」，刷新页面才会出现。思考块数量受插话次数约束（通常 1–3 块），
   * 每轮全量带上代价可控；前端按消息 id 合并，重复下发不会多出气泡。
   */
  const fresh =
    sinceTs > 0 ? nonEmpty.filter((m) => m.kind === "thinking" || atTs(m.at) > sinceTs) : nonEmpty;
  const limit = Math.min(Math.max(opts.limit ?? 400, 1), 2000);
  const messages = fresh.length > limit ? fresh.slice(fresh.length - limit) : fresh;
  // 游标只前进不后退，没有新增时停在调用方传入的 since。
  let next_since = sinceTs;
  for (const m of messages) {
    /* 思考块的时间是插值，不能拿它推进游标：会把游标推到真实进度之前，后面的消息反而漏掉。 */
    if (m.kind === "thinking") continue;
    const ts = atTs(m.at);
    if (ts > next_since) next_since = ts;
  }
  return { messages, total, next_since };
}

