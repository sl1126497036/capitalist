/**
 * 看板对话路由：接收本机回环过来的对话请求，转成监工指令并回写消息。
 *
 * 只处理 HTTP 收发与入参校验，指令执行交给命令层。
 */

import { BoardCtx } from "../types";
import { hostOverrideOf } from "../../../agent/registry";
import { WorkerHost } from "../../worker";
import { bindAttachments } from "../../../core/attachments";
import { recordEvent } from "../../../core/ledger";
import { MAX_SAY_CHARS } from "../../../core/limits";
import { recentShots, recordUserMessage } from "../../../core/messages";
import { clearQuotaExhausted, markQuotaExhausted } from "../../../core/quota";
import { loadState } from "../../../core/state";
import { listWorkers, loadSupervisor, loadWorker, readDispatches, Dispatch } from "../../../core/supervisor";
import { enterSupervisorAction } from "../../activity";
import { chatVerdictOf, settleChat, ChatVerdict } from "../../chatSettle";
import { appendSupervisorDirective } from "../../direct";
import { askModelStream, isQuotaText, parseReply } from "../../llm";
import { readPause } from "../../loop";
import { memoryLines } from "../../memory";
import { supervisorReplyView } from "../../msgView";
import { estimateSessionContextTokens, recentUserLines, recordSupervisorContext, reloadBrief, severeSupervisorEventLines, supervisorChatTurnSessionId } from "../../reload";
import { dispatchNoTable } from "../../threadNo";
import { noteSupervisorModelUsed } from "../assets";
import { cStr, cId, pickShots } from "../cmdArgs";
import { taskNoLines, workerRuntimeLines, workerDigest, settledLines } from "../cmdContext";
import { writeQuotedDirect, runCli, resolveQuoteText, quoteDispatchLabel, sayArgsOf } from "../cmdQuote";
import { serializeSupervisorChat, supervisorPolicy, workerSessionId } from "../commands";
import { chatAuthHint } from "../models";
import { targetFromText } from "../render";
import { dispatchTitle } from "../snapshot";
import { dispatchModel, readDispatchesBoard } from "../sources";
import { buildThreads } from "../threads";
import { buildSupervisorStatus } from "../views";

export function handleCapitalistChat(ctx: BoardCtx): void {
  const peer = ctx.req.socket.remoteAddress ?? "";
  const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  if (!loopback) {
    ctx.res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    ctx.res.end(JSON.stringify({ error: "对话接口只接受本机回环地址" }));
    return;
  }
  if (ctx.req.method !== "POST") {
    ctx.res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
    ctx.res.end(JSON.stringify({ error: "只接受 POST" }));
    return;
  }
  let raw = "";
  ctx.req.on("data", (chunk: Buffer) => {
    raw += chunk.toString("utf8");
    if (raw.length > 40_000) ctx.req.destroy();
  });
  ctx.req.on("end", () => {
    const askedThread = (() => {
      try {
        return String((JSON.parse(raw) as { thread?: string }).thread ?? "").trim();
      } catch {
        return "";
      }
    })();
    const exec = async (): Promise<void> => {
      const json = (obj: unknown, code = 200): void => {
        ctx.res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        ctx.res.end(JSON.stringify(obj));
      };
      let text = "";
      let thread = "";
      let via = "";
      let quote = "";
      let quoteFallback = "";
      try {
        const body = JSON.parse(raw) as { text?: string; thread?: string; via?: string; quote?: string; quote_text?: string };
        text = String(body.text ?? "").trim();
        thread = String(body.thread ?? "").trim();
        via = String(body.via ?? "").trim();
        quote = cId(body.quote, "quote") ?? "";
        quoteFallback = cStr(body.quote_text);
      } catch {
        json({ error: "请求体不是合法 JSON" }, 400);
        return;
      }
      if (!text) {
        json({ error: "没有内容" }, 400);
        return;
      }

      const state = loadState(ctx.opts.root);
      const capitalist = buildSupervisorStatus(ctx.opts.root);
      const threads = buildThreads(ctx.opts.root);
      const running = threads.filter((t) => t.status === "running" || t.status === "starting");
      const queued = threads.filter((t) => t.status === "queued").length;
      const failed = threads.filter((t) => t.status === "failed").length;
      const me = thread ? threads.find((t) => t.id === thread) : null;
      const threadWorker = thread && !me ? listWorkers(ctx.opts.root).find((w) => w.id === thread) : null;
      const threadDispatch = threadWorker?.dispatch
        ? readDispatches(ctx.opts.root).find((d) => String(d.id) === String(threadWorker.dispatch))
        : null;
      const taskStage = String(me?.stage ?? threadDispatch?.stage ?? state?.stage ?? "");
      const taskShard = String(me?.shard ?? threadDispatch?.shard ?? "");
      const taskTitle = String(me?.title ?? (threadDispatch ? dispatchTitle(threadDispatch) : "") ?? "");
      const talkDispatch = String(me?.dispatch ?? threadDispatch?.id ?? "");
      const talkNo = talkDispatch ? dispatchNoTable(ctx.opts.root).get(talkDispatch) ?? "" : "";
      const mine = thread
        ? [
            "",
            "【你现在对话的对象】",
            taskShard || taskStage
              ? `任务：${taskStage}/${taskShard || "(整阶段)"}${taskTitle ? ` · ${taskTitle}` : ""}`
              : "任务：(未能定位，按全局状态回答)",
            me
              ? `当前状态：${me.status} ｜ 已运行 ${Math.round((me.duration_sec ?? 0) / 60)} 分钟`
              : "这一单的执行进程已退出 ｜ 这条任务还在，可以重开",
            `它这一单的标题：${taskTitle || "(未记录)"}`,
            `它最近输出的一句话：${String(me?.last || "").slice(0, 300) || "(还没输出)"}`,
            ...(() => {
              if (!me?.worker) return [];
              const rec = loadWorker(ctx.opts.root, String(me.worker));
              const dg = rec ? workerDigest(rec) : "";
              return dg ? [`它已经做到哪：${dg}`] : [];
            })(),
            ...(readPause(ctx.opts.root) !== null
              ? [
                  "",
                  "【监工当前处于“暂停派单”】任何派单 / 插队 / 立即执行指令都不会执行。",
                  "用户要推进任务，必须先恢复派单（看板指标条的“恢复调度”按钮，或 capitalist resume）。",
                  "回答时先说明暂停状态，再回答该问题。",
                ]
              : []),
            ...(via === "capitalist"
              ? [
                  "",
                  "【用户按了“监工介入”】提问发生在这个进程的会话里，携带上面的任务编号直接回答，",
                  "这句话不登记回该派单，也不转给该进程；由监工直接回复。",
                  "用户所指即当前这一单。回答只围绕它：什么状态、在做什么、还差什么。",
                  "不对比其他派单，不解释其他运行中的派单，避免被理解为在描述当前派单。",
                  "确实需要提到别的单时，先说明“那是另一单，与所问无关”。",
                  talkNo
                    ? `用户说“插队 / 排到前面”：DO: queue #${talkNo}——仅插入队首，运行中的派单不受影响。`
                    : "用户说“插队 / 排到前面”：先按【任务编号表】找号，再写 DO: queue #NN。",
                  talkNo
                    ? `用户说“立即执行 / 马上跑 / 别等”：DO: promote #${talkNo}——抢占槽位，运行中的派单退回队首，本单结束后继续执行。`
                    : "用户说“立即执行 / 马上跑”：DO: promote #NN——这才抢占槽位。",
                  "要新建一单并立刻抢占槽位（不等排队）：DO: dispatch --now <内容>（--now 表示立即执行，会挂起运行中的派单）。",
                  "要重做这一单：还在排队就 queue 或 promote；已经终结就 DO: dispatch 并按原任务重写一遍。",
                  "不要为让某一单启动而新建一单改动机制：那是另一件事，除非用户明确要求。",
                  "不要用 retry：retry 的参数是分片 id，不是任务号，adhoc 单传进去会被拒。",
                ]
              : []),
          ]
        : [];

      if (thread && via !== "capitalist") {
        const userMsg = recordUserMessage(ctx.opts.root, {
          text,
          thread,
          ...(quote ? { quote } : {}),
          ...(quote ? { quoteText: resolveQuoteText(ctx.opts.root, thread, quote, quoteFallback) } : {}),
        });
        const targetDispatch =
          String(me?.dispatch ?? threadDispatch?.id ?? "") || targetFromText(ctx.opts.root, text);
        const targetLineage = String(me?.lineage ?? threadDispatch?.lineage ?? "");
        /**
         * 这一单的派单记录。
         * 线程按血缘键组织时 `threadDispatch` 取不到，只能按线程上的派单 id 再查一次，
         * 否则“排队中的单”会被当成“已结束的单”，用户的补充要求会答完就没了。
         */
        const disp = ((): Dispatch | null => {
          if (threadDispatch) return threadDispatch;
          if (!me?.dispatch) return null;
          return readDispatchesBoard(ctx.opts.root).find((d) => String(d.id) === String(me.dispatch)) ?? null;
        })();
        const sse = (obj: unknown): void => {
          try {
            ctx.res.write(`data: ${JSON.stringify(obj)}\n\n`);
          } catch {
          }
        };
        /* 逐字回放要按事件流下发；不带这几个头，浏览器会攒到结束才渲染。 */
        ctx.res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        /**
         * 收尾：落一条回复事件并结束这一轮。
         * 正文为空表示这一轮只是登记指令，没有对话内容。
         */
        const finish = (args: { reply: string; applied: string; dispatch?: string; error?: string }): void => {
          settleChat(ctx.opts.root, {
            msg_id: userMsg.id,
            verdict: args.reply ? "answered_only" : "amended",
            text,
            thread,
            ...(args.dispatch ? { dispatch: args.dispatch } : {}),
            ...(args.error ? { error: args.error } : {}),
          });
          recordEvent(ctx.opts.root, "supervisor_reply", {
            ask: text,
            reply: args.reply,
            want: "",
            applied: args.applied,
            thread,
            from: "worker",
          });
          sse({ kind: "done", reply: args.reply, display: args.reply, want: "", applied: args.applied });
          ctx.res.end();
        };
        if (text.length > MAX_SAY_CHARS) {
          finish({
            reply: "",
            applied: `消息共 ${text.length} 字，超出单次派单可携带的上限，请分段发送`,
            error: "超出单条上限",
          });
          return;
        }
        const onDuty = Boolean(me && (me.status === "running" || me.status === "starting"));
        /** 会话 id 取自该派单最近一次执行记录。 */
        const ranWorker = targetDispatch
          ? [...listWorkers(ctx.opts.root)].reverse().find((w) => String(w.dispatch ?? "") === targetDispatch)
          : undefined;
        /** 消息并入派单的条件：进程运行中、派单在排队，或派单尚未启动。 */
        const justQueued = String(me?.status ?? "") === "queued";
        const neverLaunched = !me && String(disp?.status ?? "") === "open";
        if (onDuty || justQueued || neverLaunched) {
          let sayOk = true;
          let sayErr = "";
          if (quote) {
            sayOk = writeQuotedDirect(ctx.opts.root, {
              text,
              shard: String(me?.shard ?? ""),
              thread,
              quote,
              quoteText: resolveQuoteText(ctx.opts.root, thread, quote, quoteFallback),
              msgId: userMsg.id,
              ...(targetLineage ? { lineage: targetLineage } : {}),
              ...(targetDispatch ? { target: targetDispatch } : {}),
            });
            if (!sayOk) sayErr = "指令写入失败";
            else {
              recordEvent(ctx.opts.root, "direct_inject", {
                thread,
                shard: String(me?.shard ?? ""),
                text: text.slice(0, 120),
              });
            }
          } else {
            const sayArgs = sayArgsOf({
              text,
              thread,
              msgId: userMsg.id,
              shard: String(me?.shard ?? ""),
              lineage: targetLineage,
              dispatch: targetDispatch,
            });
            sayArgs.push("--root", ctx.opts.root);
            const say = runCli(sayArgs);
            sayOk = say.code === 0;
            if (!sayOk) sayErr = (say.stderr || "").slice(0, 120) || "命令行未返回原因";
          }
          if (!sayOk) {
            finish({ reply: "", applied: `登记失败：${sayErr}`, dispatch: targetDispatch, error: sayErr });
            return;
          }
          finish({
            reply: "",
            applied: onDuty
              ? "已登记到当前派单 · 执行中的进程会在下一个动作间隙收到这条内容"
              : "已登记到这一单 · 启动后会带上这条内容",
            dispatch: targetDispatch,
          });
          return;
        }
        /* 已结束派单的普通消息：在原会话中回复。 */
        /** 会话 id 取自该派单最近一次执行记录。 */
        const liveSession = String(
          (ranWorker as unknown as { ai_session?: string } | null)?.ai_session ?? "",
        ).trim();
        const sessionId =
          liveSession || workerSessionId(String(me?.stage ?? taskStage), String(me?.shard ?? taskShard));
        const prompt = [
          "这条线程对应一个已经结束的任务，用户在此会话发来消息，直接回答。",
          "",
          "【这一单的情况】",
          `任务：${taskStage}/${taskShard || "(整阶段)"}${taskTitle ? ` · ${taskTitle}` : ""}`,
          `状态：${me ? me.status : "已结束"}${me?.settled ? "（已结项）" : ""}`,
          `它这一单的标题：${taskTitle || "(未记录)"}`,
          `它最近输出的一句话：${String(me?.last ?? "").slice(0, 300) || "(还没输出)"}`,
          ...(readPause(ctx.opts.root) !== null
            ? ["", "【监工当前处于“暂停派单”】任何派单 / 插队 / 立即执行指令都不会执行。"]
            : []),
          "",
          "【怎么回答】",
          "- 用中文，简短直接，一到三句；不要客套，不要复述用户的话",
          "- 思考过程也用中文写：界面会把推理过程原样展开给用户看",
          "- 只依据本会话已有的上下文和下面这条消息回答；不知道就回答不知道，不编造",
          "- 这一单已经结束：只回答问题，不要改文件、不要改派单；需要继续动手时，说明需要在队列里重开这一单",
          "- 不要用任何 Markdown：不用粗体星号、不用井号标题、不用三反引号，行首不加列表符号",
          "- 不要提内部文件名和路径（以 .capitalist/ 开头的那种），也不要提任务列表、分片、收工条件、闸门判据、阻塞编号这类内部词",
          "",
          `用户消息：${text}`,
          ...(quote
            ? [
                "",
                `【用户引用了消息 #${quote}，原文如下】`,
                resolveQuoteText(ctx.opts.root, thread, quote, quoteFallback) || "（原文未取回，仅编号）",
              ]
            : []),
        ].join("\n");
        const leaveChat = enterSupervisorAction("chat");
        /* 续接会话期间没有正文增量，每 3 秒推一次状态帧供界面显示。 */
        const startedAt = Date.now();
        sse({ kind: "status", text: "正在续接这一单的会话" });
        const beat = setInterval(() => {
          sse({ kind: "status", text: `正在续接这一单的会话` });
        }, 3_000);
        const chatHost = chatHostOf(ctx.opts.root);
        const r = await askModelStream({
          prompt,
          sessionId,
          cwd: ctx.opts.root,
          ...(chatHost ? { host: chatHost } : {}),
          effort: loadSupervisor(ctx.opts.root)?.effort ?? "high",
          model: dispatchModel(disp ?? undefined) || undefined,
          ...(ctx.opts.token ? { token: ctx.opts.token } : {}),
          onDelta: (d) => sse(d),
        }).finally(() => {
          clearInterval(beat);
          leaveChat();
        });
        if (!r.ok) {
          const quota = isQuotaText(r.text);
          if (quota) markQuotaExhausted(ctx.opts.root, r.text);
          /*
           * 通道拒绝要落成一条回复：只写 applied 时它仅进状态行，
           * 这一轮结束后状态行随即被完成文案覆盖，用户看到的就是“发了没回”。
           */
          const hurt = quota ? r.text : `对话通道不可用：${r.text}${chatAuthHint(ctx.opts.root)}`;
          finish({ reply: hurt, applied: "", error: hurt });
          return;
        }
        clearQuotaExhausted(ctx.opts.root);
        noteSupervisorModelUsed(ctx.opts.root, r.context_model ?? "");
        finish({ reply: r.text.trim(), applied: "" });
        return;
      }

      const brief = reloadBrief(ctx.opts.root);
      /** 先把发言记入流，再算候选图；顺序反了本条消息的图不在编号表里。 */
      const userMsg = recordUserMessage(ctx.opts.root, {
        text,
        thread,
        ...(quote ? { quote } : {}),
        ...(quote ? { quoteText: resolveQuoteText(ctx.opts.root, thread, quote, quoteFallback) } : {}),
      });
      const past = recentShots(ctx.opts.root, { thread });
      const ownShots = past.filter((s) => s.msg_id === userMsg.id);
      const shots = ownShots.map((s, i) => ({ ...s, index: i + 1 }));

      const contextLines = [
        `阶段：${state?.stage ?? "?"}${capitalist.stage_name ? ` ${capitalist.stage_name}` : ""}`,
        ...mine,
        ...taskNoLines(threads),
        ...workerRuntimeLines(ctx.opts.root),
        ...(() => {
          const lines = recentUserLines(ctx.opts.root);
          return lines.length
            ? [
                "",
                "【最近收到的消息（正序，最后一条为当前消息）】派单前先核对：该事项是否已派过、上一轮派的对象是否相同。",
                ...lines,
              ]
            : [];
        })(),
        ...settledLines(ctx.opts.root),
        `并行度：${capitalist.parallel ?? "?"} ｜ 运行中 ${running.length} 个${
          running.length
            ? `（${running.map((t) => `#${t.no} ${t.title || t.shard || t.id}${t.worker ? ` · ${t.worker}` : ""}`).join("、")}）`
            : ""
        } ｜ 排队 ${queued} ｜ 异常 ${failed}`,
        `下一步：${state?.next_action ? String(state.next_action).slice(0, 300) : "(空)"}`,
        `线程总数：${threads.length} ｜ 已完成 ${threads.filter((t) => t.status === "done" || t.status === "exited").length}`,
        ...(brief
          ? ["", "【重载后继承的上下文（压缩过，已完成且证据齐全的不要重做）】", brief]
          : []),
        ...(() => {
          const lines = memoryLines(ctx.opts.root, `${text} ${mine.join(" ")}`);
          return lines.length ? ["", ...lines] : [];
        })(),
        ...(() => {
          const lines = severeSupervisorEventLines(ctx.opts.root);
          return lines.length ? ["", "【最近严重异常（只含严重项；心跳与过程流水不在此列）】", ...lines] : [];
        })(),
      ].join("\n");

      const prompt = [
        "你是 capitalist 监工的对话层，直接回复用户提问。",
        "",
        "【当前真实状态】",
        contextLines,
        "",
        "【怎么回答】",
        "- 用中文，简短直接，一到三句，不要客套、不要重复用户的话",
        "- 思考过程也用中文写：界面会把推理过程原样展开给用户看，用英文写用户看不懂",
        "- 陈述语气：写明对象与结果。不用第二人称“你”，不用“已记这一单，没打断它”这类口语化说法，",
        "  不拟人、不承诺、不陈述自身工作。",
        "- 只依据上面的状态回答；状态里没有的信息就回答“不知道”，不编造",
        "- 心跳流水（supervisor_tick）不作为状态来源；用户问“为什么没动 / 卡在哪 / 是不是坏了”时，",
        "  读台账和日志查明，属对话层职责——直接查比派单更快且更准。",
        "- 但“对谁做”必须落到具体对象：以用户所指的那个东西为准（哪个、哪一处），不按类别推断。",
        "  写派单前先确认是**哪一个**、能把它的位置指出来；指不出唯一对象时 capitalist ask，不猜测",
        "- 用户输入按指令执行；不纠正用户表述，不解释识别规则",
        "",
        "【格式硬要求，逐条执行】",
        "1. 不要用任何 Markdown 语法：不用粗体星号、不用井号标题、不用三反引号代码块、不用行首列表符号。",
        "   这个界面只显示纯文本，Markdown 符号会原样显示。",
        "2. 不要提内部文件名和路径（以 .capitalist/ 开头的那种），也不要提任务列表、分片 id、收工条件、",
        "   闸门判据、阻塞编号这类内部词。用户要听的是“什么情况、该怎么办”。【可用截图】里的路径供挑图使用，回复里同样不要写出来。",
        "3. 最多三句，不总结、不追问、不列举选项。",
        "4. DO: 行与 ATT: 行各占单独一行，写在正文最后；它们不会显示给用户，写在正文中间会把话切断。",
        "",
        /** 是否工作进程会话只看 thread 有没有值，不看 me 是否存在。 */
        supervisorPolicy({ shots, viaSupervisor: via === "capitalist", currentMsgId: userMsg.id, ownOnly: ownShots.length > 0 }),
        "",
        `用户消息：${text}`,
        ...(quote
          ? [
              "",
              `【用户引用了消息 #${quote}，原文如下】`,
              resolveQuoteText(ctx.opts.root, thread, quote, quoteFallback) || "（原文未取回，仅编号）",
              ...(() => {
                const hit = quoteDispatchLabel(ctx.opts.root, quote);
                return hit ? [`这条消息已派成 ${hit}——引用它用于修正那一单。`] : [];
              })(),
            ]
          : []),
      ].join("\n");

      ctx.res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const sse = (obj: unknown): void => {
        try {
          ctx.res.write(`data: ${JSON.stringify(obj)}\n\n`);
        } catch {
        }
      };

      /** 优先用工作进程记录上的 ai_session；老记录缺该字段才回落基名。 */
      const liveSession = String((me as unknown as { ai_session?: string } | null)?.ai_session ?? "").trim();
      const sessionId = me
        ? liveSession || workerSessionId(String(me.stage ?? ""), String(me.shard ?? ""))
        : /*
           * 监工会话（capitalist-chat 系）：每一轮进来先过单轮注入上限。会话记录超限时
           * 换代到 `capitalist-chat-c<gen>`，不让历史与历史轮次的工具输出无限累积重发
           * （reload.ts 的 supervisorChatTurnSessionId；换代会落 context_compacted 事件）。
           */
          supervisorChatTurnSessionId(ctx.opts.root);
      const leaveChat = enterSupervisorAction("chat");
      /*
       * 模型输出首个 token 前不写入任何字节，界面显示为无回复。
       * 先立刻给一帧状态，之后每 3 秒续一次；正文增量仍由 onDelta 直接推。
       */
      sse({ kind: "status", text: "正在思考" });
      const beat = setInterval(() => sse({ kind: "status", text: "正在思考" }), 3_000);
      const chatHost = chatHostOf(ctx.opts.root);
      const r = await askModelStream({
        prompt,
        sessionId,
        cwd: ctx.opts.root,
        ...(chatHost ? { host: chatHost } : {}),
        effort: loadSupervisor(ctx.opts.root)?.effort ?? "high",
        model: loadSupervisor(ctx.opts.root)?.supervisor_model || undefined,
        ...(ctx.opts.token ? { token: ctx.opts.token } : {}),
        onDelta: (d) => sse(d),
      }).finally(() => {
        clearInterval(beat);
        leaveChat();
      });
      if (!me) {
        if (r.context_used) {
          recordSupervisorContext(ctx.opts.root, r.context_used, r.context_window ?? 0, r.context_model ?? "");
        } else {
          const estimated = estimateSessionContextTokens(sessionId);
          if (estimated !== null) {
            recordSupervisorContext(ctx.opts.root, estimated, r.context_window ?? 0, r.context_model ?? "", true);
          }
        }
      }
      if (!r.ok) {
        const quota = isQuotaText(r.text);
        if (quota) markQuotaExhausted(ctx.opts.root, r.text);
        const hurt = quota ? r.text : `对话通道不可用：${r.text}${chatAuthHint(ctx.opts.root)}`;
        settleChat(ctx.opts.root, {
          msg_id: userMsg.id,
          verdict: "answered_only",
          text,
          thread,
          error: hurt,
        });
        /* 状态帧之外再落一条回复：失败原因要留在消息流里，不能只靠会被完成文案覆盖的状态行。 */
        recordEvent(ctx.opts.root, "supervisor_reply", {
          ask: text,
          reply: hurt,
          want: "",
          applied: "",
          thread,
          from: "supervisor",
        });
        sse({ kind: "error", text: hurt });
        ctx.res.end();
        return;
      }
      clearQuotaExhausted(ctx.opts.root);
      noteSupervisorModelUsed(ctx.opts.root, r.context_model ?? "");
      const parsed = parseReply(r.text);
      const reply = parsed.reply;
      const want = parsed.want;
      let applied = "";
      let settleVerdict: ChatVerdict = "answered_only";
      let settleDispatch = "";
      let settleAction = "";
      let settleError = "";
      let multiDirectiveIds: string[] = [];
      let acted = false;
      let directiveId = "";
      let dispatchText = "";

      if (parsed.acts.length) {
        const multi = parsed.acts.length > 1;
        const anyAtt = parsed.acts.some((a) => a.shots !== undefined);
        const okTexts: string[] = [];
        const okIds: string[] = [];
        const failNotes: string[] = [];
        for (const act of parsed.acts) {
          /* 没有动作即纯对话，不当作失败上报。 */
          if (!act.action || act.action === "none") continue;
          const picks = anyAtt ? (act.shots ?? []) : undefined;
          const chosen = pickShots(picks, anyAtt && multi ? [] : userMsg.atts, shots);
          if (act.shots) {
            recordEvent(ctx.opts.root, "attachments_picked", {
              action: act.action,
              msg_id: userMsg.id,
              picks: act.shots,
              kept: chosen,
              candidates: shots.map((s) => s.path),
            });
          }
          const arg = bindAttachments(act.arg, chosen).text;
          /*
           * 推翻说明随单进入正文：工作进程与验收需要知道本次是刻意推翻旧口径，
           * 否则会按“两套并存”处理。回执仍用原文，不把该行带进气泡。
           */
          const directiveArg = act.revoke ? `${arg}\n\n本次作废：${act.revoke}` : arg;
          /** skip 把整个阶段记成欠账跳过，不代为确认。 */
          const w = appendSupervisorDirective(ctx.opts.root, {
            action: act.action,
            arg: directiveArg,
            confirm: act.action !== "skip",
            msg_id: userMsg.id,
            atts: chosen,
            target:
              targetFromText(ctx.opts.root, text) || String(me?.dispatch ?? threadDispatch?.id ?? ""),
            ...(parsed.parent ? { parent: parsed.parent } : {}),
            ...(parsed.parentReason ? { parent_reason: parsed.parentReason } : {}),
            ...(parsed.after ? { after: parsed.after } : {}),
            via: "capitalist",
          });
          if (!w.ok) {
            /* 白名单清单属于内部信息，不进入用户可见文案。 */
            const head = String(w.error || "动作未执行").split("白名单")[0] ?? "";
            const why = head.replace(/[：:，,]\s*$/, "");
            failNotes.push(`${String(act.action)}：${why}`);
            continue;
          }
          const why = w.rec.result?.ok === false ? w.rec.result.reason : "";
          if (why) {
            failNotes.push(`${act.action}：${why}`);
            continue;
          }
          acted = true;
          okIds.push(String(w.rec?.id ?? ""));
          okTexts.push(arg);
          if (!settleAction) {
            settleAction = act.action;
            settleVerdict = chatVerdictOf(act.action, arg);
          }
        }
        if (okIds.length) {
          directiveId = okIds[0]!;
          settleDispatch = okIds[0]!;
          dispatchText = okTexts.join("\n");
          applied = multi
            ? `已落成 ${okIds.length} 张单`
            : settleAction === "dispatch"
              ? "已加入队列"
              : `已执行 ${settleAction}${okTexts[0] ? `：${okTexts[0].slice(0, 60)}` : ""}`;
        }
        if (failNotes.length) {
          /* 失败原因只进“被拒”行，不并入回复正文。 */
          settleError = `未执行：${failNotes.join("；")}`;
        }
        if (okIds.length > 1) multiDirectiveIds = okIds;
      } else if (want) {
        const arg = bindAttachments(want, userMsg.atts).text;
        dispatchText = arg;
        const w = appendSupervisorDirective(ctx.opts.root, {
          action: "set-next",
          arg,
          confirm: false,
          via: "capitalist",
          msg_id: userMsg.id,
          atts: userMsg.atts,
        });
        if (w.ok) {
          acted = true;
          directiveId = String(w.rec?.id ?? "");
          applied = "已登记为下一步要求，下一轮生效";
          settleVerdict = "queued";
          settleAction = "set-next";
          settleDispatch = directiveId;
        } else {
          applied = `登记失败：${w.error}`;
          settleError = applied;
        }
      }
      const settled = settleChat(ctx.opts.root, {
        msg_id: userMsg.id,
        verdict: settleVerdict,
        text,
        thread,
        ...(settleDispatch ? { dispatch: settleDispatch } : {}),
        ...(multiDirectiveIds.length ? { dispatches: multiDirectiveIds } : {}),
        ...(settleAction ? { action: settleAction } : {}),
        ...(settleError ? { error: settleError } : {}),
      });
      recordEvent(ctx.opts.root, "supervisor_reply", {
        ask: text,
        reply,
        want,
        applied,
        ...(acted ? { acted: true } : {}),
        ...(acted && dispatchText ? { dispatch_text: dispatchText } : {}),
        ...(acted && directiveId ? { directive: directiveId } : {}),
        ...(multiDirectiveIds.length ? { directives: multiDirectiveIds } : {}),
        thread,
        from: "supervisor",
      });
      /** 实时帧与重建走同一个视图函数（msgView.ts），刷新前后逐字一致。 */
      const display = supervisorReplyView({ reply, want, applied, acted, dispatch_text: dispatchText });
      sse({ kind: "done", reply: display, display, want, applied, ...(settled.unhandled ? { unhandled: true } : {}) });
      ctx.res.end();
    };
    if (askedThread) void exec();
    else void serializeSupervisorChat(exec);
  });
}

/** 对话所用宿主：优先取监工记录里的值，其次取运行时覆盖值。 */
export function chatHostOf(root: string): WorkerHost | null {
  const saved = String(loadSupervisor(root)?.host ?? "").trim();
  if (saved) return saved as WorkerHost;
  const live = hostOverrideOf();
  return live ? (live as WorkerHost) : null;
}
