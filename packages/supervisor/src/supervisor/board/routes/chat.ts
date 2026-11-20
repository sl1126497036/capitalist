/**
 * 看板对话路由：接收本机回环过来的对话请求，转成监工指令并回写消息。
 *
 * 只处理 HTTP 收发与入参校验，指令执行交给命令层。
 */

import { BoardCtx, isLoopback, sendJson } from "../types";
import { hostOverrideOf } from "../../../agent/registry";
import { WorkerHost } from "../../worker/worker";
import { bindAttachments } from "../../../core/message/attachments";
import { recordEvent } from "../../../core/record/ledger";
import { MAX_SAY_CHARS } from "../../../core/guard/limits";
import { recentShots, recordUserMessage } from "../../../core/message/messages";
import { msgId, msgTaskNo } from "../../../core/message/msgId";
import { clearQuotaExhausted, markQuotaExhausted } from "../../../core/guard/quota";
import { loadState } from "../../../core/record/state";
import { listWorkers, loadSupervisor, loadWorker, readDispatches, Dispatch } from "../../../core/record/supervisor";
import { taskNoOfDispatchId } from "../../../core/record/tasks";
import { enterSupervisorAction } from "../../worker/activity";
import { chatVerdictOf, settleChat, ChatVerdict } from "../../view/chatSettle";
import { appendSupervisorDirective } from "../../channel/direct";
import { askModelStream, isQuotaText, parseReply } from "../../channel/llm";
import { readPause } from "../../../core/record/pause";
import { memoryLines } from "../../context/memory";
import { supervisorReplyView } from "../../view/msgView";
import { estimateSessionContextTokens, recentUserLines, recordSupervisorContext, reloadBrief, severeSupervisorEventLines, supervisorChatTurnSessionId } from "../../context/reload";
import { taskNoLabel } from "../../../core/record/idMap";
import { noteSupervisorModelUsed } from "../assets";
import { cStr, cId, pickShots } from "../cmdArgs";
import { preemptedPromptLines, replyPreempted } from "../chatPreempt";
import { taskNoLines, workerRuntimeLines, workerDigest, settledLines } from "../cmdContext";
import { writeQuotedDirect, runCli, resolveQuoteText, quoteDispatchLabel, sayArgsOf } from "../cmdQuote";
import { serializeSupervisorChat, supervisorPolicy, workerSessionId } from "../commands";
import { chatAuthHint } from "../models";
import { reopenDirective, resolveThreadAction } from "../threadAction";
import { maskBoardText, maskStream, targetFromText } from "../render";
import { dispatchNoTable } from "../../usage/threadNo";
import { dispatchTitle } from "../snapshot";
import { dispatchModel, readDispatchesBoard } from "../sources";
import { buildThreads } from "../threads";
import { buildSupervisorStatus } from "../views";
import { findSkill, listSkills } from "../../skills";
import { supervisorModelOf } from "../../judge/supervisorModel";

/**
 * 会携带技能的动作：这些动作最终把正文下发成派单，技能名随正文一起下发。
 * `skip` / `set-next` 等不改派单正文的动作不追加，避免写入无关记录。
 */
const SKILL_ACTIONS = new Set(["dispatch", "amend", "fix", "diagnose"]);

export function handleCapitalistChat(ctx: BoardCtx): void {
  const loopback = isLoopback(ctx);
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
    const exec = async (signal: AbortSignal): Promise<void> => {
      let text = "";
      let thread = "";
      let via = "";
      let quote = "";
      let quoteFallback = "";
      let skills: string[] = [];
      try {
        const body = JSON.parse(raw) as {
          text?: string;
          thread?: string;
          via?: string;
          quote?: string;
          quote_text?: string;
          skills?: unknown[];
        };
        text = String(body.text ?? "").trim();
        thread = String(body.thread ?? "").trim();
        via = String(body.via ?? "").trim();
        quote = cId(body.quote, "quote") ?? "";
        quoteFallback = cStr(body.quote_text);
        /* 界面选中的技能：只取名字，最多五个，顺序即用户在界面上的选择顺序。 */
        skills = Array.isArray(body.skills)
          ? body.skills.map((s) => String(s ?? "").trim()).filter(Boolean).slice(0, 5)
          : [];
      } catch {
        sendJson(ctx, { error: "请求体不是合法 JSON" }, 400);
        return;
      }
      if (!text) {
        sendJson(ctx, { error: "没有内容" }, 400);
        return;
      }

      /**
       * 用户在界面选中的技能，随派单正文下发。
       *
       * 工作进程按正文里的技能名匹配并注入对应 SKILL.md，所以固定写进正文，
       * 不依赖对话层改写。
       */
      const skillLine = skills.length
        ? `\n\n使用技能：${skills.join("、")}（按该技能的 SKILL.md 执行）`
        : "";

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
      const talkNoNum = talkDispatch ? taskNoOfDispatchId(talkDispatch) : 0;
      const talkNo = talkNoNum > 0 ? String(talkNoNum) : "";
      const mine = thread
        ? [
            "",
            "【你现在对话的对象】",
            taskShard || taskStage || taskTitle
              ? `任务：${taskTitle || "（未命名）"}`
              : "任务：（未能定位，按全局状态回答）",
            me
              ? `当前状态：${me.status} ｜ 已运行 ${Math.round((me.duration_sec ?? 0) / 60)} 分钟`
              : "该单的执行进程已退出 ｜ 任务仍在，可以重开",
            `最近输出：${String(me?.last || "").slice(0, 300) || "（尚无输出）"}`,
            ...(() => {
              if (!me?.worker) return [];
              const rec = loadWorker(ctx.opts.root, String(me.worker));
              const dg = rec ? workerDigest(rec) : "";
              return dg ? [`执行进度：${dg}`] : [];
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
                  "【用户按了“监工介入”】提问发生在该进程的会话里，携带上面的任务编号直接回答；",
                  "本次提问不登记回该派单，也不转给该进程，由监工直接回复。",
                  `用户所指即当前派单（${talkNo ? taskNoLabel(Number(talkNo)) : "编号未定位"}）。回答只围绕该单：状态、正在执行的内容、未完成的部分。`,
                  "不提及其他派单，避免被当作在描述当前派单。",
                  "确需提及别的派单时，先说明其与所问无关。",
                  talkNo
                    ? `用户说“插队 / 排到前面”：DO: queue ${taskNoLabel(Number(talkNo))}：仅插入队首，运行中的派单不受影响。`
                    : "用户说“插队 / 排到前面”：先按【任务编号表】找号，再写 DO: queue #NN。",
                  talkNo
                    ? `用户说“立即执行 / 马上跑 / 别等”：DO: promote ${taskNoLabel(Number(talkNo))}：抢占槽位，运行中的派单退回队首，本单结束后继续执行。`
                    : "用户说“立即执行 / 马上跑”：DO: promote #NN：抢占槽位。",
                  "要新建派单并立刻抢占槽位（不等排队）：DO: dispatch --now <内容>（--now 表示立即执行，会挂起运行中的派单）。",
                  "要继续执行该单：排队中用 queue 或 promote；已结束用 DO: redo #<本单编号>，沿用原单与原会话，不新建单。",
                  "要补充或更正要求：DO: amend #<本单编号> <内容>；只有用户明确说“另开一单 / 新任务”才 dispatch。",
                  "不要为启动某一单而新建派单去改动机制；用户明确要求时除外。",
                  "不要用 retry：retry 的参数是分片 id，不是任务号，adhoc 单传进去会被拒。",
                ]
              : []),
          ]
        : [];

      if (thread && via !== "capitalist") {
        /*
         * 技能随补充内容一起注入。
         *
         * 经 `say` 下发，正文并入该单动作，工作进程在下一个动作间隙收到；正文含技能名时，
         * 工作进程按名加载对应 SKILL.md。消息流记录原文，技能另记一份，
         * 气泡据此展示，技能行不写入正文。
         */
        const sayText = skills.length ? `${text}${skillLine}` : text;
        const userMsg = recordUserMessage(ctx.opts.root, {
          text,
          thread,
          ...(skills.length ? { skills } : {}),
          ...(quote ? { quote } : {}),
          ...(quote ? { quoteText: resolveQuoteText(ctx.opts.root, thread, quote, quoteFallback) } : {}),
          ...(talkDispatch ? { taskNo: taskNoOfDispatchId(talkDispatch) || "S0" } : {}),
          direction: "U2W",
        });
        const targetDispatch =
          String(me?.dispatch ?? threadDispatch?.id ?? "") || targetFromText(ctx.opts.root, text);
        const targetLineage = String(me?.lineage ?? threadDispatch?.lineage ?? "");
        /**
         * 该线程的派单记录。
         * 线程按派生链键组织时 `threadDispatch` 取不到，需按线程上的派单 id 再查一次，
         * 否则“排队中的单”会被当作“已结束的单”，用户的补充要求会丢失。
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
        /* 逐字回放要按事件流下发；缺少这些头时，浏览器会缓冲到响应结束才渲染。 */
        ctx.res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        /**
         * 收尾：写入一条回复事件并结束本轮。
         * 正文为空表示本轮只登记了指令，没有对话内容。
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
            msg_id: msgId(msgTaskNo(userMsg.id) || "S0", "S"),
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
              text: sayText,
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
              text: sayText,
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
              ? "已登记到当前派单，执行中的进程会在下一个动作间隙收到"
              : "已登记到当前派单，启动后一并下发",
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
          liveSession ||
          workerSessionId(String(me?.stage ?? taskStage), String(me?.shard ?? taskShard), talkDispatch);
        const prompt = [
          "该线程对应的任务已结束，用户在此会话发来消息时直接回答。",
          "",
          "【该单情况】",
          `任务：${taskTitle || "（未命名）"}`,
          `状态：${me ? me.status : "已结束"}${me?.settled ? "（已结束）" : ""}`,
          `最近输出：${String(me?.last ?? "").slice(0, 300) || "（尚无输出）"}`,
          ...(readPause(ctx.opts.root) !== null
            ? ["", "【监工当前处于“暂停派单”】任何派单 / 插队 / 立即执行指令都不会执行。"]
            : []),
          "",
          "【怎么回答】",
          "- 使用用户语言，简短直接，一到三句；不要客套，不要复述用户的话",
          "- 思考过程也用用户语言写：界面会把推理过程原样展开给用户看",
          "- 只依据本会话已有的上下文和下面这条消息回答；不知道就回答不知道，不编造",
          "- 会话归属：本会话续接派单执行进程，与 WorkBuddy 窗口的对话互不共享上下文。",
          "  被问是否与 WorkBuddy 窗口共用会话时，答不是，并说明这是执行进程的会话；运行环境中的 WorkBuddy 变量继承自启动方，不代表同一会话。",
          "  用户没问就不主动提。",
          "- 该单已结束：只回答问题，不改文件、不改派单；需要重派时按当前单的上下文用量判断，上下文充足则直接复用，否则新开一单",
          "- 排版用 Markdown：加粗写 **文字**，列表行首写 - 或 1.，代码用反引号包起来；标题写成 ## 文字（井号后留空格），任务编号写作 #12",
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
        sse({ kind: "status", text: "正在续接会话" });
        const beat = setInterval(() => {
          sse({ kind: "status", text: `正在续接会话` });
        }, 3_000);
        const chatHost = chatHostOf(ctx.opts.root);
        /* 流式正文同样经统一出口处理：该路径是进程号逐字显示的主要泄漏点。 */
        const stream = maskStream((f) => sse(f), dispatchNoTable(ctx.opts.root));
        const r = await askModelStream({
          prompt,
          sessionId,
          cwd: ctx.opts.root,
          ...(chatHost ? { host: chatHost } : {}),
          effort: loadSupervisor(ctx.opts.root)?.effort ?? "high",
          model: supervisorModelOf(ctx.opts.root),
          ...(ctx.opts.token ? { token: ctx.opts.token } : {}),
          signal,
          onDelta: stream.onDelta,
        }).finally(() => {
          stream.flush();
          clearInterval(beat);
          leaveChat();
        });
        if (r.aborted) {
          replyPreempted(ctx, { msgId: userMsg.id, text, thread, from: "worker", sse });
          return;
        }
        if (!r.ok) {
          const quota = isQuotaText(r.text);
          if (quota) markQuotaExhausted(ctx.opts.root, r.text);
          /*
           * 通道拒绝要写入一条回复：只写 applied 时内容仅进状态行，
           * 本轮结束后状态行随即被完成文案覆盖，用户看到的是“发了没回”。
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
      /** 先把指令记入流，再算候选图；顺序反了本条消息的图不在编号表里。 */
      const userMsg = recordUserMessage(ctx.opts.root, {
        text,
        thread,
        ...(skills.length ? { skills } : {}),
        ...(quote ? { quote } : {}),
        ...(quote ? { quoteText: resolveQuoteText(ctx.opts.root, thread, quote, quoteFallback) } : {}),
        ...(talkDispatch ? { taskNo: taskNoOfDispatchId(talkDispatch) || "S0" } : {}),
        direction: via === "capitalist" ? "U2S" : "U2W",
      });
      const past = recentShots(ctx.opts.root, { thread });
      const ownShots = past.filter((s) => s.msg_id === userMsg.id);
      const shots = ownShots.map((s, i) => ({ ...s, index: i + 1 }));

      /** 队列为空：没有派单在执行，没有排队项，没有失败项，属待命态。 */
      const idleQueue = running.length === 0 && queued === 0 && failed === 0;

      const contextLines = [
        ...(capitalist.stage_name ? [`阶段：${capitalist.stage_name}`] : []),
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
        ...preemptedPromptLines(ctx.opts.root),
        ...settledLines(ctx.opts.root),
        `并行度：${capitalist.parallel ?? "?"} ｜ 运行中 ${running.length} 个${
          running.length
            ? `（${running.map((t) => `${taskNoLabel(Number(t.no))} ${t.title || t.shard || t.id}${t.worker ? ` · ${t.worker}` : ""}`).join("、")}）`
            : ""
        } ｜ 排队 ${queued} ｜ 异常 ${failed}`,
        ...(idleQueue ? ["队列状态：空（待命，没有派单在执行，也没有排队项）"] : []),
        `下一步：${state?.next_action ? String(state.next_action).slice(0, 300) : "（空）"}`,
        `线程总数：${threads.length} ｜ 已完成 ${threads.filter((t) => t.status === "done" || t.status === "exited").length}`,
        ...(brief && via !== "capitalist"
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

      /**
       * 可用技能：技能不专属工作进程。
       *
       * 监工自己动手的场合（查状态、写契约、改文案）读完 SKILL.md 直接执行；
       * 需要落地的改动把技能名写进派单正文，工作进程按名加载全文。由模型按技能说明与
       * 用户描述判断归谁，判断不了时问用户，不预设归属。
       */
      const skillLines = (() => {
        const list = listSkills(ctx.opts.root);
        if (!list.length) return [];
        return [
          "",
          "【可用技能】技能既可能由监工自己执行，也可能派给工作进程，按技能说明与用户描述判断；判断不了时问用户。",
          "  监工自己动手时先读该技能的 SKILL.md（宿主配置目录下 <技能名>/SKILL.md）再执行；",
          "  需要落地的改动把技能名写进派单正文，工作进程会按名加载该技能全文。",
          ...list.slice(0, 40).map((s) => `  - ${s.name}${s.desc ? `：${s.desc}` : ""}`),
        ];
      })();

      const prompt = [
        "你是 capitalist 监工的对话层，直接回复用户提问。",
        "",
        "【当前真实状态】",
        contextLines,
        ...(skills.length
          ? [
              "",
              `【用户在界面选中的技能】${skills
                .map((s) => {
                  const hit = findSkill(ctx.opts.root, s);
                  return hit ? `${s}（${hit.path}）` : s;
                })
                .join("、")}`,
              "派单时沿用这个名字，不改写成别的技能；需要监工自己执行时按上面的路径读 SKILL.md。",
            ]
          : []),
        ...skillLines,
        "",
        "【怎么回答】",
        "- 使用用户语言，简短直接，一到三句，不要客套、不要重复用户的话",
        "- 思考过程也用用户语言写：界面会把推理过程原样展开给用户看",
        "- 陈述语气：写明对象与结果。不用第二人称“你”，不用“已记这一单，没打断它”这类口语化说法，",
        "  不拟人、不承诺、不陈述自身工作。",
        "- 只依据上面的状态回答；状态里没有的信息就回答“不知道”，不编造",
        "- 会话归属：每轮对话由监工单独启动一个进程，与 WorkBuddy 窗口的对话互不共享上下文。",
        "  被问是否与 WorkBuddy 窗口共用会话时，答不是，并说明这是监工的对话；运行环境中的 WorkBuddy 变量继承自启动方，不代表同一会话。",
        "  用户没问就不主动提。",
        "- 心跳流水（supervisor_tick）不作为状态来源；用户问“为什么没动 / 卡在哪 / 是不是坏了”时，",
        "  读台账和日志查明，属对话层职责：直接查比派单更快且更准。",
        "- 但“对谁做”必须明确到具体对象：以用户所指为准（哪个、哪一处），不按类别推断。",
        "  写派单前先确认具体对象并给出位置；指不出唯一对象时 capitalist ask，不猜测",
        "- 用户输入按指令执行；不纠正用户表述，不解释识别规则",
        ...(idleQueue
          ? [
              "",
              "【当前处于待命，队列为空】",
              "- 没有派单在执行，也没有排队项。用户打招呼或问状态时，说明当前空闲，并提示可以直接描述要做的事，",
              "  或选择一个技能，随消息一起派发。",
              "- 不写“收工”“条件满足”“可以结束”：没有开工就不存在收工。阶段门槛、占位文件、值守条件这类说法也不写。",
            ]
          : []),
        "",
        "【格式硬要求，逐条执行】",
        "1. 排版用 Markdown：加粗写 **文字**，列表行首写 - 或 1.，代码用反引号；不用表格、缩进代码块与 HTML 标签。",
        "2. 标题写成 ## 文字，井号后留空格；任务编号写作 #12，井号后不加空格。",
        "3. 不要提内部文件名和路径（以 .capitalist/ 开头的那种），也不要提任务列表、分片 id、收工条件、",
        "   闸门判据、阻塞编号这类内部词。用户要听的是“什么情况、该怎么办”。【可用截图】里的路径供挑图使用，回复里同样不要写出来。",
        "4. 最多三句，不总结、不追问、不列举选项。",
        "5. DO: 行与 ATT: 行各占单独一行，写在正文最后；它们不会显示给用户，写在正文中间会把话切断。",
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
                return hit ? [`该消息已派成 ${hit}：引用用于修正该单。`] : [];
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
      /*
       * 监工介入（via === "capitalist"）不得复用工作进程的 ai_session：
       * 复用会把工作进程的完整上下文（含“你是独立的工作进程”等系统提示）带进监工对话，
       * 形成监工与工作进程两套角色杂糅。监工介入一律走监工自己的会话，
       * 工作进程的执行内容只通过上面的 mine 块摘要（最近输出 / workerDigest）以纯文本进入 prompt。
       */
      const sessionId =
        via === "capitalist"
          ? supervisorChatTurnSessionId(ctx.opts.root)
          : me
            ? liveSession ||
              workerSessionId(String(me.stage ?? ""), String(me.shard ?? ""), String(me.dispatch ?? ""))
            : /*
               * 监工会话（capitalist-chat 系）：每一轮进来先过单轮注入上限。会话记录超限时
               * 换代到 `capitalist-chat-w<ws>-c<gen>`，不让历史与历史轮次的工具输出无限累积重发
               * （reload.ts 的 supervisorChatTurnSessionId；换代时写入 context_compacted 事件）。
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
      /* 流式正文同样经统一出口处理：该路径是进程号逐字显示的主要泄漏点。 */
      const stream = maskStream((f) => sse(f), dispatchNoTable(ctx.opts.root));
      const r = await askModelStream({
        prompt,
        sessionId,
        cwd: ctx.opts.root,
        ...(chatHost ? { host: chatHost } : {}),
        effort: loadSupervisor(ctx.opts.root)?.effort ?? "high",
        model: supervisorModelOf(ctx.opts.root),
        ...(ctx.opts.token ? { token: ctx.opts.token } : {}),
        signal,
        onDelta: stream.onDelta,
      }).finally(() => {
        stream.flush();
        clearInterval(beat);
        leaveChat();
      });
      /* 新消息抢占了本轮：按“未执行”收尾，要求仍留在待处理清单里。 */
      if (r.aborted) {
        replyPreempted(ctx, { msgId: userMsg.id, text, thread, from: "supervisor", sse });
        return;
      }
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
        /* 状态帧之外再写入一条回复：失败原因要留在消息流里，不能只靠会被完成文案覆盖的状态行。 */
        recordEvent(ctx.opts.root, "supervisor_reply", {
          ask: text,
          reply: hurt,
          want: "",
          applied: "",
          thread,
          from: "supervisor",
          msg_id: msgId(msgTaskNo(userMsg.id) || "S0", "S"),
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
        /* 用户在线程里提的要求归属该线程对应的派单，已结束的先重开（见 threadAction.ts）。 */
        const talkTarget = String(talkDispatch ?? "").trim();
        const threadDisp = talkTarget
          ? readDispatchesBoard(ctx.opts.root).find((x) => String(x.id) === talkTarget)
          : undefined;
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
           * 推翻说明随派单正文下发，工作进程与验收据此知道本次是刻意推翻旧口径，
           * 否则会按“两套并存”处理。回执仍用原文，不把该说明写进气泡。
           */
          const withSkill = SKILL_ACTIONS.has(String(act.action)) ? `${arg}${skillLine}` : arg;
          const revised = resolveThreadAction({
            text,
            talkTarget,
            talkNo,
            action: String(act.action),
            arg: act.revoke ? `${withSkill}\n\n本次作废：${act.revoke}` : withSkill,
            status: String(threadDisp?.status ?? ""),
          });
          const actionName = revised.action;
          const directiveArg = revised.arg;
          if (revised.reopenFirst) {
            const r = appendSupervisorDirective(
              ctx.opts.root,
              reopenDirective({ talkNo, talkTarget, msgId: userMsg.id }),
            );
            if (r.ok) okIds.push(String(r.rec?.id ?? ""));
            else {
              const head = String(r.error || "重开失败").split("可用动作")[0] ?? "";
              failNotes.push(`redo：${head.replace(/[：:，,]\s*$/, "")}`);
              continue;
            }
          }
          /** skip 把整个阶段记成待补项跳过，不代为确认。 */
          const w = appendSupervisorDirective(ctx.opts.root, {
            action: actionName,
            arg: directiveArg,
            confirm: actionName !== "skip",
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
            /* 可用动作清单属于内部信息，不进入用户可见文案。 */
            const head = String(w.error || "动作未执行").split("可用动作")[0] ?? "";
            const why = head.replace(/[：:，,]\s*$/, "");
            failNotes.push(`${actionName}：${why}`);
            continue;
          }
          const why = w.rec.result?.ok === false ? w.rec.result.reason : "";
          if (why) {
            failNotes.push(`${actionName}：${why}`);
            continue;
          }
          acted = true;
          okIds.push(String(w.rec?.id ?? ""));
          okTexts.push(arg);
          if (!settleAction) {
            settleAction = actionName;
            settleVerdict = chatVerdictOf(actionName, arg);
          }
        }
        if (okIds.length) {
          directiveId = okIds[0]!;
          settleDispatch = okIds[0]!;
          dispatchText = okTexts.join("\n");
          applied = multi
            ? `已执行 ${okIds.length} 项动作`
            : settleAction === "dispatch"
              ? "已加入队列"
              : `已执行 ${settleAction}${okTexts[0] ? `：${okTexts[0].slice(0, 60)}` : ""}`;
        }
        if (failNotes.length) {
          /* 失败原因只写入“被拒”行，不并入回复正文。 */
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
        msg_id: msgId(msgTaskNo(userMsg.id) || "S0", "S"),
      });
      /** 实时帧与重建走同一个视图函数（msgView.ts），刷新前后逐字一致。 */
      /*
       * 收尾帧与流式增量使用同一口径：模型正文、执行说明与建议都经出口改写，
       * 避免增量已改写而整段回放又出现进程号。
       */
      const nos = dispatchNoTable(ctx.opts.root);
      const show = (v: unknown): string => maskBoardText(String(v ?? ""), nos);
      const display = show(supervisorReplyView({ reply, want, applied, acted, dispatch_text: dispatchText }));
      sse({ kind: "done", reply: display, display, want: show(want), applied: show(applied), ...(settled.unhandled ? { unhandled: true } : {}) });
      ctx.res.end();
    };
    if (askedThread) void exec(new AbortController().signal);
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
