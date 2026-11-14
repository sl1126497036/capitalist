#!/usr/bin/env node
/**
 * `capitalist` 命令行入口。
 *
 * 本文件做三件事：解析参数、分发给具体命令、把退出码交回 shell。各命令的实现各管一件事，
 * 参数取值统一走 `args.ts`，输出统一走 `output.ts`。
 *
 * hook 是另一个进程（host/main.ts），与本文件共享 `core/` 但不共享生命周期：hook 在工作
 * 进程内按事件调用，必须快且不能抛；本文件是交互式命令，出错必须说清楚。
 */

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { buildBrief } from "../core/message/brief";
import { runCheck } from "../core/contract/checks";
import { appendDirective, activeTakeover, listDirectives, releaseShard, takeoverShard } from "../core/dispatch/commands";
import {
  contractNames,
  instanceLeaseStatus,
  isLastStage,
  leaseTaskName,
  loadContract,
  nextStageId,
  stageById,
} from "../core/contract/contract";
import { enterStage, newState } from "../core/contract/init";
import { INBOX_LEDGER, readInbox } from "../core/dispatch/inbox";
import { appendJsonl, readJson, readJsonl, writeJson } from "../core/record/json";
import { recordEvent, recordViolation } from "../core/record/ledger";
import { findRoot, isInside, supervisorDir } from "../core/record/paths";
import { skillDirs } from "../agent/locations";
import { describeMode, modeNames, normalizeMode } from "../core/guard/permission";
import { generateContract, describeGenerated } from "../supervisor/genContract";
import { loadState, resolveModeFor, saveState, statePath, supervisorDisplayState, SUPERVISOR_STATE_LABEL, updateState } from "../core/record/state";
import { applyMerges, ensureTaskForDispatch, planMerges, readTasks, summaryLine, syncTaskForDispatch, taskSummary, type TaskState } from "../core/record/tasks";
import {
  cmdAnswer,
  cmdBlock,
  cmdCorrect,
  cmdFire,
  cmdLedger,
  cmdNotify,
  cmdRetire,
  cmdReview,
  cmdScope,
  cmdSessions,
  cmdWorker,
  cmdSetNext,
  cmdUnblock,
  cmdUpdate,
} from "./cmd/records";
import { clearStopFlag, isSupervisorAlive, loadSupervisor, loadWorker, pausedDispatches, pidAlive, readDispatches } from "../core/record/supervisor";
import { all } from "../agent/registry";
import { deriveCapabilities } from "../agent/contract";
import { flagBool, flagNumber, flagString, flagTokens, parse, positionalText, type Parsed } from "./args";
import { loadOrDie, rootOrDie } from "./cmd/context";
import { die, write } from "./output";
import { COMMAND_HELP, HELP, VERSION } from "./help";
import { cmdBoard, cmdFeed } from "./cmd/boardCmd";
import { cmdAuthCheck } from "./cmd/authCheck";
import { cmdGate, cmdJustify, cmdLocalCheck } from "./cmd/precheck";
import { cmdClose, cmdNext, cmdPromote, cmdReport, cmdStopWorker, cmdSuperviseStop, cmdWake, cmdWorkers, detachSupervisor } from "./cmd/proc";
import { cmdLock } from "./cmd/lockCmd";
import { cmdReload } from "./cmd/reloadCmd";
import { cmdTree } from "./cmd/tree";

function cmdStart(p: Parsed): number {
  const target = p.positional[0] ?? die("用法：capitalist start <目标> --contract <任务列表名>");
  const rootFlag = flagString(p, "root");
  const existing = findRoot(rootFlag);

  if (existing) {
    const st = loadState(existing);
    write(`已有任务根：${existing}\n目标：${st?.target ?? "?"} ｜ 阶段：${st?.stage ?? "?"}\n`);
    return cmdStatus({ cmd: "status", positional: [], flags: { root: existing } });
  }

  const spec = flagString(p, "contract");
  return createRoot(target, spec ?? "generic", spec === undefined, rootFlag);
}

function cmdInit(p: Parsed): number {
  const target = p.positional[0] ?? die("用法：capitalist init <目标> --contract <任务列表名>");
  const spec = flagString(p, "contract");
  return createRoot(target, spec ?? "generic", spec === undefined, flagString(p, "root"));
}

/** 换目标重开。 */
function cmdRestart(p: Parsed): number {
  const target = p.positional[0];
  if (!target) die('用法：capitalist restart "<目标>" --contract <任务列表名>');

  const root = flagString(p, "root") ?? process.cwd();
  const dir = supervisorDir(root);

  if (existsSync(join(dir, "state.json"))) {
    if (isSupervisorAlive(root)) die("监工运行中：先执行 capitalist supervise-stop，退出后再执行 restart");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    renameSync(dir, `${dir}.closed.${stamp}`);
    write(`旧任务根已归档：${dir}.closed.${stamp}\n`);
  }

  const spec = flagString(p, "contract");
  const contract = loadContract(spec ?? "generic", skillDirs());
  if (!contract) die(`找不到任务列表：${spec ?? "generic"}`);

  mkdirSync(join(dir, "inbox"), { recursive: true });
  saveState(root, newState(target, contract, !spec));
  write(`任务根：${root}\n任务列表：${contract.name}（${contract.domain || "未标注领域"}）\n目标：${target}\n`);
  return 0;
}

/** 建任务根。 */
function createRoot(target: string, spec: string, fallback: boolean, rootArg?: string): number {
  const contract = loadContract(spec);
  if (!contract) {
    die(`找不到任务列表：${spec}\n可用任务列表：${contractNames(skillDirs()).join(", ") || "(无)"}`);
  }
  const root = rootArg ?? process.cwd();
  if (existsSync(statePath(root))) die(`已存在受监督任务：${root}（用 capitalist status 查看）`);

  const stage = contract.stages[0];
  if (!stage) die(`任务列表 ${contract.name} 没有定义任何阶段`);

  const state = newState(target, contract, fallback);
  mkdirSync(join(supervisorDir(root), "inbox"), { recursive: true });
  saveState(root, state);

  write(
    `任务根：${root}\n任务列表：${contract.name}（${contract.domain || "未标注领域"}）\n` +
      `阶段：${stage.id} ${stage.name}\n下一步：${stage.next ?? ""}\n`,
  );
  if (fallback) {
    const others = contractNames(skillDirs()).filter((n) => n !== "generic").join("|") || "…";
    write(
      `\n未指定领域任务列表，已回落到通用任务列表（generic）。\n` +
        `      通用红线生效，但“这个领域什么算做完”没有定义。\n` +
        `      若这是明确领域任务：capitalist adopt --contract <${others}>\n`,
    );
  }
  return 0;
}

function cmdAdopt(p: Parsed): number {
  const spec = flagString(p, "contract") ?? die("用法：capitalist adopt --contract <名|路径>");
  const root = rootOrDie(p);
  const { state } = loadOrDie(root);
  const contract = loadContract(spec, skillDirs());
  if (!contract) die(`找不到任务列表：${spec}\n可用任务列表：${contractNames(skillDirs()).join(", ") || "(无)"}`);

  const prev = state.contract;
  const keepStage = flagBool(p, "keep-stage");
  const ok = updateState(root, (s) => {
    s.contract = contract.name;
    s.contract_path = contract.file;
    s.contract_fallback = false;
    if (!keepStage) {
      const stage = contract.stages[0];
      if (stage) enterStage(s, stage);
    }
  });
  if (ok === null) die("状态写入冲突，重试后仍未成功：请再执行一次");

  const after = loadState(root) ?? state;
  write(
    `任务列表：${prev} -> ${contract.name}（${contract.domain || "未标注领域"}）\n阶段：${after.stage}\n下一步：${after.next_action}\n`,
  );
  return 0;
}

/** 推进阶段。 */
function cmdAdvance(p: Parsed): number {
  const root = rootOrDie(p);
  const { state, contract } = loadOrDie(root);
  const sid = state.stage;
  const stage = stageById(contract, sid);
  const check = runCheck(stage?.done as Record<string, unknown> | undefined, root);
  const force = flagBool(p, "force");

  if (!check.ok && !force) {
    recordViolation(root, {
      rule: "STAGE_SKIP",
      label: `${sid} 阶段门槛没达标就想推进`,
      fix: `先把这些门槛项补齐再 advance：${check.missing.slice(0, 5).join("；")}`,
      evidence: check.missing.join("；"),
      decision: "REJECT",
      kind: "flow",
      session: process.env.CAPITALIST_SESSION_ID ?? "",
      stage: sid,
    });
    process.stderr.write(`${sid} ${stage?.name ?? ""} 未达门槛，不推进：\n`);
    for (const m of check.missing) process.stderr.write(`  - ${m}\n`);
    process.stderr.write('\n确需强制推进（会记入事件日志）：capitalist advance --force\n');
    return 2;
  }

  if (!check.ok) {
    recordEvent(root, "force_advance", { from: sid, missing: check.missing });
    recordViolation(root, {
      rule: "STAGE_SKIP_FORCE",
      label: `用 --force 跳过 ${sid} 的阶段验收`,
      fix: "强制推进前把遗留项与理由写入 memory.md；跳过验收会留下未核对的风险。",
      evidence: check.missing.join("；"),
      decision: "FORCED",
      kind: "flow",
      session: process.env.CAPITALIST_SESSION_ID ?? "",
      stage: sid,
    });
    write(`强制推进，遗留 ${check.missing.length} 项未满足\n`);
  }

  if (isLastStage(contract, sid)) {
    write(`已是最后阶段 ${sid}。收工条件满足时允许收工。\n`);
    return 0;
  }

  const nid = nextStageId(contract, sid);
  const next = nid ? stageById(contract, nid) : undefined;
  if (!next) die(`任务列表 ${contract.name} 里找不到 ${sid} 的下一阶段`);

  if (updateState(root, (s) => enterStage(s, next)) === null) {
    die("状态写入冲突，重试后仍未成功：请再执行一次");
  }
  write(
    `阶段推进：${sid} -> ${next.id} ${next.name}\n` +
      (next.goal ? `目标：${next.goal}\n` : "") +
      `下一步：${next.next ?? ""}\n`,
  );
  return 0;
}

/**
 * 记录业务数据到 `.capitalist/<名>.jsonl`。
 *
 * 写入点是契约里 `done` 检查读取的同一批文件，因此路径必须落在 `.capitalist/` 内：允许 `../`
 * 逃逸等于让记录变成任意位置写，与红线层冲突。
 */
function cmdRecord(p: Parsed): number {
  const [file, json] = p.positional;
  if (!file || json === undefined) die('用法：capitalist record <名> \'{"字段":"值"}\'');
  const root = rootOrDie(p);

  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (err) {
    die(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }

  const name = file.endsWith(".jsonl") ? file : `${file}.jsonl`;
  const target = join(supervisorDir(root), name);
  if (!isInside(target, supervisorDir(root))) die(`只能记到 .capitalist/ 以内：${name}`);

  if (!appendJsonl(target, obj)) die(`写入失败：${target}`);
  write(`已记录到 .capitalist/${name}\n`);
  return 0;
}

/** 登记待裁决问题。登记后收工闸放行，这是唯一的合法停顿出口。 */
function cmdAsk(p: Parsed): number {
  const text = (positionalText(p) || flagString(p, "text") || "").trim();
  if (!text) die('用法：capitalist ask "<问题>"');
  const root = rootOrDie(p);
  const { state } = loadOrDie(root);

  const id = flagString(p, "id") || `Q${Math.floor(Date.now() / 1000) % 100000}`;

  let shard = (flagString(p, "shard") ?? "").trim();
  if (!shard) {
    const wid = process.env.CAPITALIST_WORKER_ID ?? "";
    if (wid) shard = String(loadWorker(root, wid)?.shard ?? "");
  }

  appendJsonl(join(supervisorDir(root), "inbox", "qa.jsonl"), {
    at: new Date().toISOString(),
    at_ts: Date.now() / 1000,
    type: "ask",
    id,
    status: "open",
    text,
    context: flagString(p, "context") ?? "",
    stage: state.stage,
    ...(shard ? { shard } : {}),
    session: process.env.CAPITALIST_SESSION_ID ?? "",
  });

  write(`问题已登记 问${id}\n现在可以停下（这是合法停顿）。回来用：capitalist inbox ${id}\n`);
  return 0;
}

/** 查看待裁决问题。 */
function cmdInbox(p: Parsed): number {
  const root = rootOrDie(p);
  const want = p.positional[0];
  const { rows: all, ignored, skipped } = readInbox(root);
  const rows = all
    .filter((q) => q.type === "ask" && q.status === "open")
    .filter((q) => (want ? q.id === want : true));

  if (ignored.length > 0) {
    // 自检行放在最前面：先说明“台账里有坏行被跳过”，后面的列表才不会被误读成全部。
    write(
      `已忽略 ${ignored.length} 条畸形记录（不参与裁决）：` +
        `${ignored
          .slice(0, 5)
          .map((i) => `第 ${i.line} 行 ${i.reason}`)
          .join("；")}${ignored.length > 5 ? " …" : ""}\n`,
    );
    if (skipped.length > 0) {
      write(`（同目录只读 ${INBOX_LEDGER}，已跳过 ${skipped.length} 个非台账文件：${skipped.slice(0, 5).join("、")}）\n`);
    }
  }

  if (rows.length === 0) {
    write("没有待裁决问题\n");
    return 0;
  }
  for (const q of rows) {
    /* 用“问N”不用 `#N`：`#N` 是任务编号（界面与监工共用同一套），两者混用会串号。 */
    write(`问${q.id} [${String(q.stage ?? "")}] ${q.text}\n`);
  }
  return 0;
}

/** 任务池：已派、已验收、剩余项数。 */
function cmdTasks(p: Parsed): number {
  const root = rootOrDie(p);
  /** 回填：把已经存在的派单台账投影成任务项。 */
  if (flagBool(p, "backfill")) {
    const ds = readDispatches(root);
    for (const d of ds) {
      ensureTaskForDispatch(root, d);
      syncTaskForDispatch(root, d);
    }
    write(`已按 ${ds.length} 条历史派单回填任务池\n`);
  }
  /** 同义归并：把“同一件事被反复追加”产生的重复项并成一条。 */
  if (flagBool(p, "merge")) {
    const groups = planMerges(root);
    const total = groups.reduce((n, g) => n + g.drop.length, 0);
    if (groups.length === 0) {
      write("没有发现同义重复项\n");
      return 0;
    }
    write(`可归并 ${groups.length} 组，涉及 ${total} 项重复\n`);
    for (const g of groups.slice(0, 25)) {
      write(`  ${g.keep} ← ${g.drop.length} 项：${g.title.slice(0, 56)}\n`);
    }
    if (groups.length > 25) write(`  …另有 ${groups.length - 25} 组\n`);
    if (!flagBool(p, "apply")) {
      write("\n这只是预览。确认后加 --apply 执行（被并走的项转 void，不删除，可追溯）\n");
      return 0;
    }
    const n = applyMerges(root, groups);
    write(`已归并：${groups.length} 组，${n} 项转为已关闭（merged_into 指向代表项）\n`);
  }
  const s = taskSummary(root);
  const rows = readTasks(root);
  if (flagBool(p, "json")) {
    write(`${JSON.stringify({ ...s, tasks: rows }, null, 2)}\n`);
    return 0;
  }
  write(`${summaryLine(s)}\n`);
  if (rows.length === 0) {
    write("（任务池是空的：还没有派过单。每建一张派单会自动登记一项。）\n");
    return 0;
  }
  /** 排序按“还欠着的”优先：失败 -> 待确认 -> 进行中 -> 待派 -> 已验收 -> 已关闭。 */
  const order: TaskState[] = ["failed", "submitted", "dispatched", "pending", "accepted", "void"];
  const label: Record<TaskState, string> = {
    failed: "失败待重试",
    submitted: "待确认（自称做完，未验收）",
    dispatched: "进行中",
    pending: "待派",
    accepted: "已验收",
    void: "已关闭",
  };
  for (const st of order) {
    const list = rows.filter((t) => t.state === st);
    if (list.length === 0) continue;
    write(`\n[${label[st]}] ${list.length} 项\n`);
    for (const t of list.slice(-40)) {
      const tag = t.tags.length > 0 ? `  #${t.tags.join(",")}` : "";
      write(`  ${t.id}  ${t.title}${tag}\n`);
    }
    if (list.length > 40) write(`  …另有 ${list.length - 40} 项\n`);
  }
  return 0;
}

function cmdStatus(p: Parsed): number {
  const root = rootOrDie(p);
  const { state, contract } = loadOrDie(root);
  const mode = resolveModeFor(root, contract, flagString(p, "mode"));
  const stage = stageById(contract, state.stage);
  const check = runCheck(stage?.done as Record<string, unknown> | undefined, root);
  const capitalist = supervisorDisplayState(root);
  // 随监工起的那份看板地址：只判一次活就能读，不必再去探测端口。
  // 监工已停（或 --no-board）时没有地址，也就没有这一行。
  const boardUrl = capitalist.state === "online" ? loadSupervisor(root)?.board_url : undefined;
  // 实例租约（R-22）：与文本模式同源同字段，脚本里两种模式行为相同。
  const lease = instanceLeaseStatus(root, leaseTaskName(root));
  // 手动暂停（.capitalist/pause.json）：两种模式同源暴露，脚本与文本行为一致。
  const pause = readPause(root);

  if (flagBool(p, "json")) {
    write(
      `${JSON.stringify(
        {
          root,
          mode,
          stage: state.stage,
          exit_ok: check.ok,
          missing: check.missing,
          paused: pause,
          state,
          supervisor: {
            state: capitalist.state,
            pid: capitalist.pid,
            detail: capitalist.detail,
            heartbeat_age_sec: capitalist.heartbeat_age_sec,
            board_url: boardUrl ?? null,
          },
          lease: {
            holder_pid: lease.holder?.pid ?? null,
            holder_instance: lease.holder?.instance_id ?? null,
            instance_count: lease.instance_count,
            heartbeat_age_sec: lease.heartbeat_age_sec,
            warn: lease.warn,
          },
        },
        null,
        2,
      )}\n`,
    );
    return check.ok ? 0 : 2;
  }

  write(`${buildBrief({ root, state, contract, mode, missing: check.missing })}\n`);

  const supervisorLabel = SUPERVISOR_STATE_LABEL[capitalist.state];
  write(`\n监工：${supervisorLabel}${capitalist.state === "online" ? `（pid ${capitalist.pid}，${capitalist.detail}）` : ` —— ${capitalist.detail}`}\n`);
  // 看板地址只在监工在线时给：已停的监工没有在监听的端口，印出来等于引导用户点一个空地址。
  if (boardUrl) write(`看板：${boardUrl}\n`);

  if (pause) write(`已暂停 · 自 ${pause.at} · 原因：${pause.reason}（不派新单、进程已停；恢复：capitalist resume）\n`);

  /* 暂停单来自上次中断，与新派单互不阻塞；单独一行列出唤醒方式。 */
  const pausedRows = pausedDispatches(root);
  if (pausedRows.length > 0) {
    write(
      `暂停单 ${pausedRows.length} 张（上次中断未完成，不自动执行）：` +
        `capitalist wake --user 全部唤醒，或 capitalist wake --user <派单id> 逐张唤醒\n`,
    );
  }

  // 实例租约（R-22）：谁占着这个任务根、有几个实例、心跳多新。
  // 实例数大于 1 说明同根并存多个监工，会重复派单，立即告警。
  if (lease.holder) {
    write(
      `实例：持有者 pid ${lease.holder.pid}（${lease.holder.instance_id}） ｜ 实例数 ${lease.instance_count} ｜ 心跳 ${lease.heartbeat_age_sec}s 前\n`,
    );
  } else {
    write(`实例：无存活持有者 ｜ 实例数 ${lease.instance_count}\n`);
  }
  if (lease.warn) write(`警告：${lease.warn}\n`);

  /** 任务池汇总：已派、已验收、剩余项数。 */
  const tkSum = taskSummary(root);
  if (tkSum.total > 0) write(`${summaryLine(tkSum)}\n`);

  // 指令与接管状态输出“已登记，下次派单生效”。
  const pending = listDirectives(root).filter((r) => r.consumed !== true);
  if (pending.length > 0) {
    write(`待生效指令：${pending.length} 条（只对下一次派单生效，尚未拼入 action）\n`);
  }
  const tk = activeTakeover(root);
  if (tk.all || tk.shards.length > 0) {
    const scope = tk.all ? "整个任务根" : `分片 ${tk.shards.join("、")}`;
    write(`接管中：${scope}（原因：${tk.reason}）；监工暂停该片自动重派与自动验收\n`);
  }

  const ws = checkWorkspacePrepare(root);
  if (!ws.ok) {
    write(`\n⚠ 工作区准备失败（${ws.impl}）：${ws.message}\n${ws.fix}\n`);
  }

  // 退出码表达“门槛过没过”，与 --json 一致：脚本里两种模式行为相同才算说得清
  return check.ok ? 0 : 2;
}

function cmdBrief(p: Parsed): number {
  const root = rootOrDie(p);
  const { state, contract } = loadOrDie(root);
  const mode = resolveModeFor(root, contract, flagString(p, "mode"));
  const stage = stageById(contract, state.stage);
  const check = runCheck(stage?.done as Record<string, unknown> | undefined, root);
  let text = `${buildBrief({ root, state, contract, mode, missing: check.missing })}\n`;
  // 暂停期间必须抑制“下一步”：执行侧照常拿到 next_action，会误以为可以继续开工。
  const pause = readPause(root);
  if (pause) {
    text +=
      `\n▸ 任务已暂停（自 ${pause.at}，原因：${pause.reason}）：监工暂停派单，上面的“下一步”暂不执行。\n` +
      `  等待操作者执行 capitalist resume；恢复之前不要继续开工。\n`;
  }
  write(text);
  return 0;
}

function cmdMode(p: Parsed): number {
  const root = rootOrDie(p);
  const { state, contract } = loadOrDie(root);
  const effective = resolveModeFor(root, contract, flagString(p, "mode"));

  const value = p.positional[0];
  if (!value) {
    if (flagBool(p, "json")) {
      write(`${JSON.stringify({ mode: effective, stored: state.permission_mode ?? null, available: modeNames() }, null, 2)}\n`);
      return 0;
    }
    write(`生效档位：${effective}，${describeMode(effective)}\n\n可用档位：\n`);
    for (const m of modeNames()) {
      write(` ${m === effective ? "*" : " "} ${m.padEnd(13)} ${describeMode(m)}\n`);
    }
    return 0;
  }

  const next = normalizeMode(value);
  if (!next) die(`未知档位：${value}\n可用：${modeNames().join(", ")}`);
  if (updateState(root, (s) => { s.permission_mode = next; }) === null) {
    die("状态写入冲突，重试后仍未成功：请再执行一次");
  }
  write(`档位：${effective} 改为 ${next}（${describeMode(next)}）\n`);
  if (next === "bypass") {
    write("bypass 档位放宽档位与本机边界判定，任务列表红线仍按原级别拦截。该档位仅用于受控环境。\n");
  }
  return 0;
}

function cmdSay(p: Parsed): number {
  const text = (positionalText(p) || flagString(p, "text") || "").trim();
  const name = p.cmd === "direct" ? "direct" : "say";
  if (!text) die(`用法：capitalist ${name} "<文本>" [--shard <分片>] [--thread <线程>] ｜ capitalist ${name} --help`);
  if (text.length > 4000) die("文本过长（上限 4000 字）");
  const root = rootOrDie(p);
  const shard = flagString(p, "shard") || null;
  const thread = flagString(p, "thread") || undefined;
  /*
   * `--thread` 是进程（`W-…`），`--lane` 是线程（`阶段/分片`）。
   *
   * 两个不是一回事：进程是一次性的，退出即作废；线程随任务走，重派出来的新进程照样
   * 认这条话。落错字段的后果是那句话永久领不到（见 core/commands 的 Directive.thread）。
   */
  const lane = flagString(p, "lane") || undefined;
  /* 血缘：无分片单靠它认领这条话，见 core/dispatch/commands.ts 的 directiveMatches。 */
  const lineage = flagString(p, "lineage") || undefined;
  /* 目标派单由看板按工作进程解析后传入，也接受分片名。 */
  const target = flagString(p, "target") || undefined;
  /* 消息标识：看板发送时生成，派单建单时按它回查这条消息自己的附件。 */
  const msgId = flagString(p, "msg-id") || undefined;
  const state = loadState(root);
  /** 阶段取目标派单所属阶段。 */
  const targetStage = target ? stageOfTarget(root, target) : "";
  const rec = appendDirective(root, {
    text,
    shard,
    thread,
    lane,
    stage: targetStage || state?.stage || "",
    ...(lineage ? { lineage } : {}),
    ...(target ? { target } : {}),
    ...(msgId ? { msgId } : {}),
  });
  if (!rec) die("写入失败：.capitalist/direct.jsonl");

  const scope = target
    ? `目标单 ${target}`
    : shard
      ? `分片 ${shard}`
      : thread
        ? `进程 ${thread}`
        : lane
          ? `线程 ${lane}`
          : "下次任意派单";
  write(
    `追加消息已登记（${scope}）。\n` +
      `生效时机：未开工的单在启动时并入原派单；执行中的单由 hook 在下一次工具调用前送达，执行进程不中断。\n` +
      `送达即标记已用，不会重复注入；登记与送达在台账 direct_inject / direct_deliver 事件里可查。\n`,
  );
  return 0;
}

/** 一条“说给某一单”的话落在哪个阶段。 */
function stageOfTarget(root: string, target: string): string {
  const rows = readDispatches(root);
  const byId = rows.find((d) => String(d.id) === target);
  if (byId) return String(byId.stage ?? "");
  const w = loadWorker(root, target);
  if (!w) return "";
  const d = rows.find((x) => String(x.id) === String(w.dispatch ?? ""));
  return String(d?.stage ?? w.stage ?? "");
}

/**
 * 接管某分片。
 *
 * 接管只改变监工行为：落 `.capitalist/takeover.json`（记 root / shard / at / reason / active），
 * 调度层每轮调度 读它，被接管的片不自动重派、也不自动验收。不是只改界面文案。
 * 接管不终止已运行中的进程，要中断进程用 `capitalist stop-worker`。
 */
function cmdTakeover(p: Parsed): number {
  const root = rootOrDie(p);
  const shard = p.positional[0] ?? (flagString(p, "shard") || null);
  const reason = flagString(p, "reason") || "用户手动接管";
  const rec = takeoverShard(root, { shard, reason, by: "user" });
  const scope = rec.shard ? `分片 ${rec.shard}` : "整个任务根（所有分片）";
  write(
    `已接管 ${scope}（原因：${rec.reason}）。\n` +
      `监工从下一轮调度起：不自动重派该片、不自动验收该片，等 capitalist release 恢复。\n` +
      `接管只改变监工行为，不终止运行中的进程；中断进程使用 capitalist stop-worker <id>。\n`,
  );
  return 0;
}

/** 交还被接管的片，恢复自动重派与自动验收。省略分片 = 交还全部。 */
function cmdRelease(p: Parsed): number {
  const root = rootOrDie(p);
  const shard = p.positional[0] ?? (flagString(p, "shard") || null);
  const { released } = releaseShard(root, shard);
  if (released.length === 0) {
    write(shard ? `分片 ${shard} 没有被接管，无需交还。\n` : "当前没有处于接管状态的片，无需交还。\n");
    return 0;
  }
  write(
    `已交还 ${released.map((s) => (s === "*" ? "整个任务根" : `分片 ${s}`)).join("、")}。\n` +
      `生效时机：下一轮调度起监工恢复该片的自动重派与自动验收。\n`,
  );
  return 0;
}


/** `.capitalist/pause.json` 的内容：存在即处于暂停态，删除即恢复。 */
interface PauseFile {
  at: string;
  reason: string;
  by?: string;
}

/** 暂停文件的绝对路径：`<root>/.capitalist/pause.json`。 */
function pausePath(root: string): string {
  return join(supervisorDir(root), "pause.json");
}

/** 读暂停文件；缺失或损坏都视为未暂停（不因写坏一次把状态卡死）。 */
function readPause(root: string): PauseFile | null {
  const raw = readJson<Partial<PauseFile> | null>(pausePath(root), null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    at: String(raw.at ?? ""),
    reason: String(raw.reason ?? ""),
    ...(raw.by === undefined ? {} : { by: String(raw.by) }),
  };
}

/** 手动暂停派单。 */
function cmdPause(p: Parsed): number {
  const root = rootOrDie(p);
  loadOrDie(root);
  const reason = (flagString(p, "reason") ?? positionalText(p) ?? "").trim();
  const rec: PauseFile = { at: new Date().toISOString(), reason: reason || "未填写原因", by: "user" };
  try {
    writeJson(pausePath(root), rec);
  } catch (err) {
    die(`暂停状态写入失败：${err instanceof Error ? err.message : String(err)}`);
  }
  recordEvent(root, "pause_set", { reason: rec.reason, by: rec.by });
  write(
    `已暂停（自 ${rec.at}，原因：${rec.reason}）。\n` +
      `监工从下一轮调度起不再派新单；运行中的进程停止，对应派单退回排队，恢复后按原顺序重派。\n` +
      `已暂停的旧派单不随恢复调度解除暂停，需通过 capitalist wake --user 单独唤醒。恢复调度：capitalist resume\n`,
  );
  return 0;
}

/**
 * 解除暂停：删除 .capitalist/pause.json，下一轮调度 起监工恢复派单（不自动认领契约分片）。
 *
 * 恢复派单是用户动作。非交互环境（宿主会话里代执行命令）默认拒绝，避免将启动信号
 * 视为用户授权；用户明确要求时通过 `--user` 恢复，看板“恢复调度”按钮调用接口，不经过这里。
 */
function cmdResume(p: Parsed): number {
  const root = rootOrDie(p);
  loadOrDie(root);
  const file = pausePath(root);
  if (!existsSync(file)) {
    write("当前没有处于暂停状态，无需恢复。\n");
    return 0;
  }
  const byUser = flagBool(p, "user");
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!byUser && !interactive) {
    write(
      "拒绝：恢复派单需要用户动作。\n" +
        "当前不在交互终端（宿主会话里的命令执行），按启动规则保持暂停，队列原样保留。\n" +
        "用户明确要求恢复时：capitalist resume --user；或在看板点击“恢复调度”。\n",
    );
    return 1;
  }
  try {
    rmSync(file);
  } catch (err) {
    die(`暂停状态删除失败：${err instanceof Error ? err.message : String(err)}`);
  }
  clearStopFlag(root);
  recordEvent(root, "pause_cleared", { by: byUser ? "user(--user)" : "user(tty)" });
  write(
    "已恢复：监工从下一轮调度起恢复派单，只执行派入的派单，不按契约自动建单。" +
      "被暂停的旧派单仍需通过 capitalist wake --user 唤醒。\n",
  );
  return 0;
}

/**
 * `capitalist hosts`：按注册表打印每个 impl 的身份与能力。
 *
 * 能力矩阵由 facet 推导，`--selftest` 打印事件映射，两者读同一份 impl。
 * 输出列全部宿主，并标出各宿主的拦截、注入与工作进程启动能力。
 */
function cmdHosts(p: Parsed): number {
  const rows = all().map((impl) => {
    const caps = deriveCapabilities(impl);
    const flags = [
      caps.hookBlock ? "block" : null,
      caps.hookInject ? "inject" : null,
      caps.structuredDeny ? "json-deny" : "exit-deny",
      caps.install ? (caps.installNeedsConfirm ? "install(需确认)" : "install") : null,
      caps.workerLaunch ? (caps.workerAutoDetect ? "worker(auto)" : "worker(显式)") : null,
      caps.workspacePrepare ? "workspace" : null,
    ].filter((x): x is string => x !== null);
    return {
      id: impl.id,
      label: impl.label,
      aliases: impl.aliases,
      configDir: `~/${impl.configDir}/${impl.settingsFile}`,
      worker: impl.worker?.key ?? null,
      capabilities: flags,
    };
  });

  if (flagBool(p, "json")) {
    write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }

  const idW = Math.max(4, ...rows.map((r) => r.id.length));
  const labelW = Math.max(5, ...rows.map((r) => r.label.length));
  write(`${"id".padEnd(idW)}  ${"名称".padEnd(labelW)}  能力\n`);
  for (const r of rows) {
    write(`${r.id.padEnd(idW)}  ${r.label.padEnd(labelW)}  ${r.capabilities.join(" ")}`);
    if (r.worker) write(`  [worker=${r.worker}]`);
    write(`\n${"".padEnd(idW + labelW + 6)}配置 ${r.configDir}`);
    if (r.aliases.length > 0) write(`  别名 ${r.aliases.join(",")}`);
    write("\n");
  }
  write("\n# 能力由 impl 声明的 facet 推导；事件映射用 capitalist-hook --selftest --agent <id> 查看。\n");
  return 0;
}


interface WorkspaceCheck {
  ok: boolean;
  impl: string | null;
  message: string;
  fix: string | null;
}

/**
 * 工作区准备自检。
 *
 * 宿主首次进入某目录会写一份项目配置（settings.json 之类）。在受限目录（EPERM / 只读 /
 * 被占用）下会失败，失败信息会升级成明确警告，并给出按平台可执行的修复方式。
 *
 * 复用宿主声明的 workspace facet 执行准备动作。成功时配置就位，失败时返回原始错误信息。
 * 该操作幂等，配置已存在时不重写。
 */
function checkWorkspacePrepare(root: string): WorkspaceCheck {
  const impls = all().filter((i) => i.workspace);
  if (impls.length === 0) return { ok: true, impl: null, message: "", fix: null };
  for (const impl of impls) {
    let r: { ok: boolean; added: boolean; message: string };
    try {
      r = impl.workspace!.prepare(root);
    } catch (err) {
      return {
        ok: false,
        impl: impl.id,
        message: `工作区准备抛出异常：${err instanceof Error ? err.message : String(err)}`,
        fix: workspaceFixHint(root, String((err as Error)?.message ?? "")),
      };
    }
    if (!r.ok) {
      return { ok: false, impl: impl.id, message: r.message, fix: workspaceFixHint(root, r.message) };
    }
  }
  return { ok: true, impl: null, message: "", fix: null };
}

/** 把工作区准备失败的原始信息翻成可操作的修复建议。 */
function workspaceFixHint(root: string, msg: string): string {
  const isPerm = /EPERM|EACCES|permission|权限|拒绝|access/i.test(msg);
  if (isPerm) {
    return [
      "工作区配置目录写入被拒绝（权限 / 只读 / 被占用）。可操作的修复：",
      `  1. 确认当前用户对任务根有写权限（Windows：右键目录->属性->安全；或 icacls "${root}"）`,
      "  2. 关闭可能占用配置文件（settings.json / 项目配置）的进程：编辑器、其它 agent 会话、IDE",
      "  3. 若任务根在只读挂载或受控目录，换一个可写目录重新 capitalist start",
      "  4. 修复后执行 capitalist status 复检，或重新 capitalist supervise",
    ].join("\n");
  }
  return "查看上面的失败信息并修复后重试：capitalist status ｜ capitalist supervise";
}

async function main(): Promise<number> {
  // 版本与帮助这两个通用开关先归一：`-v` / `-h` 不带双横线，解析器会把它们当命令名，
  // 落到“未知命令”分支上。
  const argv = process.argv.slice(2).map((a) => (a === "-h" ? "--help" : a));
  if (argv.includes("--version") || argv.includes("-v") || argv.includes("-V")) {
    write(`capitalist ${VERSION}\n`);
    /* 只读上次 check-update 的缓存，不联网：脚本里调 --version 不应因此等待。 */
    const { cachedUpdateNotice } = await import("../supervisor/updateCheck");
    const hint = cachedUpdateNotice(VERSION);
    if (hint) write(`${hint}\n`);
    return 0;
  }

  const p = parse(argv);
  if (!p.cmd) {
    write(HELP);
    return 0;
  }

  // 单命令帮助：capitalist <cmd> --help 打印该命令的口径（含生效时机），不跑实际逻辑。
  if (flagBool(p, "help")) {
    write(`${COMMAND_HELP[p.cmd] ?? HELP}\n`);
    return 0;
  }

  const workerId = String(process.env.CAPITALIST_WORKER_ID ?? "").trim();
  if (workerId) {
    const WORKER_ALLOWED = new Set([
      "report",
      "ask",
      "notify",
      "block",
      "say",
      "record",
      "ledger",
      "inbox",
      "status",
      "tasks",
      "brief",
      "gate",
      "local-check",
    ]);
    if (!WORKER_ALLOWED.has(p.cmd)) {
      write(
        `这个命令属于监工，工作进程不能执行：${p.cmd}\n` +
          `工作进程能做的只有上报与查看：report / ask / notify / block / say / record / status / tasks。\n` +
          `要改变调度（关闭、暂停、派单、推进阶段）请用 capitalist notify 说明诉求，由监工裁决。\n`,
      );
      return 3;
    }
  }

  switch (p.cmd) {
    case "start":
      return cmdStart(p);
    case "init":
      return cmdInit(p);
    case "restart":
      return cmdRestart(p);
    case "adopt":
      return cmdAdopt(p);
    case "advance":
      return cmdAdvance(p);
    case "set-next":
      return cmdSetNext(p);
    case "scope":
      return cmdScope(p);
    case "record":
      return cmdRecord(p);
    case "update":
      return cmdUpdate(p);
    case "ledger":
      return cmdLedger(p);
    case "tree":
      return cmdTree(p);
    case "ask":
      return cmdAsk(p);
    case "inbox":
      return cmdInbox(p);
    case "answer":
      return cmdAnswer(p);
    case "block":
      return cmdBlock(p);
    case "notify":
      return cmdNotify(p);
    case "unblock":
      return cmdUnblock(p);
    case "review":
      return cmdReview(p);
    case "correct":
      return cmdCorrect(p);
    case "sessions":
      return cmdSessions(p);
    case "worker":
      return cmdWorker(p);
    case "retire":
      return cmdRetire(p);
    case "status":
      return cmdStatus(p);
    case "tasks":
      return cmdTasks(p);
    case "brief":
      return cmdBrief(p);
    case "mode":
      return cmdMode(p);
    case "gate":
      return cmdGate(p);
    case "fire":
      return cmdFire(p);
    case "local-check":
      return cmdLocalCheck(p);
    case "justify":
      return cmdJustify(p);
    case "hosts":
      return cmdHosts(p);
    case "check-update": {
      const { checkUpdate } = await import("../supervisor/updateCheck");
      const r = await checkUpdate(VERSION, { force: flagBool(p, "force") });
      if (!r.ok) {
        write(`${r.message}\n`);
        return 1;
      }
      write(`本地版本  ${r.status.local}\n`);
      write(`npm 上最新 ${r.status.latest}\n`);
      if (r.status.outdated) {
        write(`\n有新版本。升级：npm i -g capitalist\n`);
        write(`升级后重跑 capitalist install：hook 里记的是入口脚本的绝对路径。\n`);
      } else {
        write(`\n已是最新版本。\n`);
      }
      if (r.cached) write(`（结论来自缓存 ${r.status.checkedAt}，加 --force 重新联网）\n`);
      return 0;
    }
    case "serve": {
      const { cmdServe } = await import("./cmd/serveCmd");
      return await cmdServe(p);
    }
    case "install": {
      const { runInstall } = await import("../install/install");
      const { resolveAgents } = await import("../install/prompt");
      const root = flagString(p, "root") ?? process.cwd();
      const dryRun = flagBool(p, "dry-run");
      const chosen = await resolveAgents({
        action: "install",
        explicit: agentList(p),
        all: flagBool(p, "all"),
        /* dry-run 只报计划、不改配置 */
        interactive: !dryRun && !flagBool(p, "yes") && process.stdin.isTTY === true,
        root,
      });
      /* 未选择宿主时不做任何写入：退出码非零，脚本与自动化据此判定“未安装”。 */
      if (chosen === null) return 1;
      return runInstall({
        hosts: chosen,
        dryRun,
        verbose: flagBool(p, "verbose"),
        root,
      });
    }
    case "uninstall": {
      const { runUninstall } = await import("../install/install");
      const { resolveAgents } = await import("../install/prompt");
      const root = flagString(p, "root") ?? process.cwd();
      const chosen = await resolveAgents({
        action: "uninstall",
        explicit: agentList(p),
        all: flagBool(p, "all"),
        interactive: !flagBool(p, "yes") && process.stdin.isTTY === true,
        root,
      });
      if (chosen === null) return 0;
      return runUninstall({
        hosts: chosen,
        keepSkill: flagBool(p, "keep-skill"),
        verbose: flagBool(p, "verbose"),
        root,
      });
    }
    case "supervise": {
      /*
       * 唯一一次读取宿主登录态，且只在令牌下发开启时执行。
       *
       * 下发缺省关闭：工作进程与对话通道使用宿主 CLI 自身的登录态，插件不读取任何凭据，
       * 也不触发访问询问。置 `CAPITALIST_TOKEN_INJECT=1` 恢复下发。
       *
       * 开启下发时：读取由本进程发起，不接收外部传入的令牌；令牌只写进本进程环境，由
       * 监工、对话通道与工作进程共用。令牌不进 argv、不写文件、不写日志、不写 supervisor.json。
       */
      {
        const tok = await import("../supervisor/channel/officialToken");
        if (!tok.tokenInjectionEnabled()) {
          write("[监工] 未下发宿主令牌：工作进程与对话通道使用宿主自身的登录态。\n");
          try {
            const diagRoot = flagString(p, "root") ?? process.cwd();
            writeJson(join(supervisorDir(diagRoot), "auth-diag.json"), { injection: "off" });
          } catch {
            /* 诊断写失败不影响启动 */
          }
        } else if (!tok.tokenInjectorPresent()) {
          write("[监工] 未下发宿主令牌：注入组件不存在。\n");
          try {
            const diagRoot = flagString(p, "root") ?? process.cwd();
            writeJson(join(supervisorDir(diagRoot), "auth-diag.json"), tok.hostTokenDiag());
          } catch {
            /* 诊断写失败不影响启动 */
          }
        } else {
          const source = tok.warmHostToken();
          /*
           * 诊断落盘：只写判定与错误码，供重启后回看读取落在哪一层；不含令牌。
           * 读取失败的提示只出现在 stdout，进程转到后台后无从复查。
           */
          try {
            const diagRoot = flagString(p, "root") ?? process.cwd();
            writeJson(join(supervisorDir(diagRoot), "auth-diag.json"), tok.hostTokenDiag());
          } catch {
            /* 诊断写失败不影响启动 */
          }
          if (source !== "none") {
            write("[监工] 已取得宿主令牌：对话与派单直接使用，不会再询问。\n");
          } else {
            const failure = tok.officialTokenFailure();
            const code = String(tok.hostTokenDiag()["errorCode"] ?? "");
            write(
              failure === "missing"
                ? "[监工] 未取得宿主令牌：宿主登录态不可见。若宿主已登录，说明沙箱使存在性判定误报为不存在，见 .capitalist/auth-diag.json。\n"
                : failure === "encrypted"
                  ? "[监工] 未取得宿主令牌：宿主登录态为加密格式，无法取出访问令牌。\n"
                  : `[监工] 未取得宿主令牌：授权请求被拒或未响应${code ? `（${code}）` : ""}，重启监工并在弹窗中选择“本次会话内始终允许”。\n`,
            );
          }
        }
      }
      const supervisorRoot = flagString(p, "root") ?? process.cwd();
      /*
       * 已有监工在运行时返回其 pid、心跳与看板地址，不返回启动失败提示。
       * 判活按 pid：心跳停顿可能只是卡在一次长调用上。
       * --force 明示要接管时跳过这一步，交给主循环的接管逻辑。
       */
      const running = flagBool(p, "force") ? null : runningSupervisorNotice(supervisorRoot);
      if (running) {
        write(`${running}\n`);
        return 0;
      }
      const ws = checkWorkspacePrepare(supervisorRoot);
      if (!ws.ok) {
        write(`⚠ 工作区准备失败（${ws.impl}）：${ws.message}\n${ws.fix}\n`);
        write("（工作区未就绪时 worker 可能停在确认页，不会自动执行；按上述说明修复后启动。）\n");
      }

      const { detectWorkerHost } = await import("../supervisor/worker/worker");
      const { ensureHooks } = await import("../install/install");
      /*
       * `--agent` 显式声明监工运行所在的宿主，优先级高于环境特征。
       * CodeBuddy CLI 只注入 `CLAUDE_*`、不注入 `CODEBUDDY_HOST`，与 Claude Code 同形，
       * 按环境特征判定为 claude-code 并按该族取凭证；显式声明可覆盖该判定。
       */
      {
        const reg = await import("../agent/registry");
        const declHost = String(flagString(p, "agent") ?? "").trim();
        if (declHost) {
          /* `claude` 等别名先归一为 impl id 再查询。 */
          const impl = reg.byId(reg.normalize(declHost) ?? declHost);
          if (!impl) {
            write(`⚠ 未知宿主：${declHost}。可用取值：${reg.all().map((x) => x.id).join(" / ")}\n`);
            return 1;
          }
          reg.setHostOverride(impl.id);
          write(`[监工] 宿主按显式声明取：${impl.id}\n`);
        }
      }
      /*
       * 工作进程宿主由宿主环境判定，命令行不再接受覆盖。旧参数仍出现在调用里时只作提示，
       * 不改变取值。
       */
      const detectedWorker = detectWorkerHost();
      if (p.flags["worker-host"] !== undefined) {
        write(
          `[监工] --worker-host 已移除：工作进程按宿主自动判定${
            detectedWorker ? `，本次为 ${detectedWorker}` : "，当前未找到可用入口"
          }。\n`,
        );
      }
      const healHosts = [detectedWorker].filter(
        (h): h is string => !!h && h !== "custom",
      );
      /*
       * hook 自动补装：非 Windows 默认执行，装完插件直接启动即可，不必先单独跑 install。
       * Windows 保持显式 `--with-hooks`：hook 为每次工具调用起一个短命进程，那边表现为持续闪窗。
       * 两种平台都能用 `--no-hooks` 关掉。
       */
      const wantHooks =
        flagBool(p, "with-hooks") ||
        process.env.CAPITALIST_WITH_HOOKS === "1" ||
        process.platform !== "win32";
      const skipHooks = !wantHooks || flagBool(p, "no-hooks");
      if (skipHooks) {
        write("[监工] 不装 hook：心跳由“pid + 日志增长”回落，红线预检走工作进程档位\n");
      }
      if (healHosts.length > 0 && !skipHooks) {
        // 写项目级 settings.local.json：用户级那份由宿主自己维护，hooks 键保不住。
        const healed = ensureHooks(healHosts, supervisorRoot);
        if (healed.installed.length > 0) {
          write(`[监工] 已补装 hook：${healed.installed.join("、")}\n`);
        }
        for (const f of healed.failed) write(`[监工] hook 补装失败（${f.id}）：${f.message}\n`);
      }
      if (flagBool(p, "detach")) return await detachSupervisor(supervisorRoot);
      /*
       * “启动默认不派单”放在主循环里判定：队列里还有待办时，把上次未完成的派单逐张标记暂停；
       * 没有待办就直接待命在线（不派单、不轮询、不退出），等用户派单。
       * 暂停是派单级标记，宿主侧新派入的单不受影响。
       */
      let contractSpec = flagString(p, "contract") ?? "";
      if (!contractSpec && loadState(supervisorRoot) === null && String(p.positional[0] ?? "").trim()) {
        const gen = await generateContract({
          root: supervisorRoot,
          target: String(p.positional[0] ?? ""),
          ...(detectedWorker ? { host: detectedWorker } : {}),
          ...(flagString(p, "effort") ? { effort: String(flagString(p, "effort")) } : {}),
        });
        write(describeGenerated(gen) + "\n");
        if (gen.ok) contractSpec = gen.path;
      }

      const { runSupervisor } = await import("../supervisor/loop");
      return runSupervisor({
        root: supervisorRoot,
        target: p.positional[0],
        contractSpec: contractSpec || undefined,
        autoDispatch: flagBool(p, "auto-dispatch"),
        ...(process.env.CAPITALIST_HOST_TOKEN ? { token: process.env.CAPITALIST_HOST_TOKEN } : {}),
        tickSec: flagNumber(p, "tick"),
        workerTimeoutSec: flagNumber(p, "worker-timeout"),
        stuckSec: flagNumber(p, "stuck-sec"),
        workers: flagNumber(p, "workers"),
        workerModel: flagString(p, "worker-model"),
        workerEffort: flagString(p, "effort"),
        supervisorModel: flagString(p, "capitalist-model"),
        defaultModel: flagString(p, "default-model"),
        modelDenylist: flagString(p, "model-denylist"),
        supervisorContextLimit: flagTokens(p, "capitalist-context"),
        workerCmd: flagString(p, "worker-cmd"),
        workerVisible: flagBool(p, "worker-visible"),
        force: flagBool(p, "force"),
        spawnWorkers: flagBool(p, "no-spawn") ? false : undefined,
        // 主循环里的 hook 周期补装同样要跟着这个开关：否则启动时说“不装”，跑满 60 秒
        // 又写回去，闪窗与“配置被重置”都会复发。
        installHooks: !skipHooks,
        // 看板默认随监工起；--no-board 显式关掉（不监听任何端口）。
        board: flagBool(p, "no-board") ? false : undefined,
        // 访问 key 缺省不校验，--secure 启用。
        boardSecure: flagBool(p, "secure") ? true : undefined,
        // 看板重启的合并窗口与最小间隔：默认 8s / 60s，可被命令行或环境变量压缩。
        boardQuietMs: flagNumber(p, "board-quiet-ms"),
        boardMinGapMs: flagNumber(p, "board-min-gap-ms"),
        once: flagBool(p, "once"),
      });
    }
    case "supervise-stop":
      return cmdSuperviseStop(p);
    /*
     * 诊断命令：只读一次宿主凭证并输出判定，不启动监工。
     *
     * 读取要在一次工具调用内完成，询问才会挂到这次调用上；因此单独成命令，避免与
     * 后台常驻进程的启动时序纠缠。输出不含令牌，只给长度。
     */
    case "auth-probe": {
      const tok = await import("../supervisor/channel/officialToken");
      const source = tok.warmHostToken();
      write(`${JSON.stringify({ source, ...tok.hostTokenDiag() }, null, 2)}\n`);
      return source === "none" ? 1 : 0;
    }
    case "auth-check": {
      const { cmdAuthCheck } = await import("./cmd/authCheck");
      return cmdAuthCheck(p);
    }
    /*
     * 内部命令：由监工在启动时自己拉起（见 supervisor/guard.ts 的 ensureGuard），
     * 不进 help、也不需要用户手动跑。
     *
     * 它的唯一职责是“监工被硬杀之后，把它拉起的 worker 收掉”。硬杀（taskkill /F、
     * 任务管理器结束进程）不执行任何信号处理器，所以监工自己没机会清理，只能靠这个
     * 独立进程盯着监工的 pid。
     */
    case "guard": {
      const gRoot = p.positional[0] ?? "";
      const gPid = Number(p.positional[1]);
      if (!gRoot || !Number.isInteger(gPid) || gPid <= 0) {
        return die("用法：capitalist guard <root> <capitalist-pid>（内部命令，由监工自动拉起）");
      }
      const { runGuard } = await import("../supervisor/worker/guard");
      runGuard(gRoot, gPid);
      // 常驻：main() 一 resolve，入口就会 process.exit，守护进程需拦截该行为。
      return await new Promise<number>(() => {});
    }
    case "next":
      return cmdNext(p);
    case "wake":
      return cmdWake(p);
    case "report":
      return cmdReport(p);
    case "say":
      return cmdSay(p);
    case "direct":
      return cmdSay(p);
    case "takeover":
      return cmdTakeover(p);
    case "release":
      return cmdRelease(p);
    case "pause":
      return cmdPause(p);
    case "resume":
      return cmdResume(p);
    case "stop-worker":
      return cmdStopWorker(p);
    case "close":
      return cmdClose(p);
    case "promote":
      return cmdPromote(p);
    case "workers":
      return cmdWorkers(p);
    case "auth":
      /*
       * 令牌导出已移除：插件不把令牌写到磁盘。保留子命令名只为给旧脚本一句可读的说明，
       * 不再读写任何文件。
       */
      write("该命令已移除：插件不从磁盘保存或读取令牌，认证由启动时读取的宿主凭证完成。\n");
      return 0;
    case "board":
      return cmdBoard(p);
    case "feed":
      return cmdFeed(p);
    case "reload":
      return cmdReload(p);
    case "lock":
      return cmdLock(p);
    default:
      process.stderr.write(`未知命令：${p.cmd}\n\n${HELP}`);
      return 1;
  }
}

/**
 * 取 `--agent` 的完整宿主列表。
 *
 * 选项解析器给每个键只留一个值，所以 `--agent a b` 里的 `b`
 * 会落到位置参数上。`install` / `uninstall` 本身不接受位置参数，这里把它们并回列表，
 * 否则多值写法会静默只装第一个。逗号写法（`--agent a,b`）保持原样可用。
 */
/**
 * 已有监工运行中时的提示文案：pid、轮次、心跳，外加看板地址。
 *
 * 判活按 pid 不按心跳窗口：心跳停顿可能只是它卡在一次长调用上，进程还在。
 * @returns 没有运行中的监工时返回 null。
 */
function runningSupervisorNotice(root: string): string | null {
  const rec = loadSupervisor(root);
  if (!rec || rec.status !== "running") return null;
  if (rec.pid === process.pid || !pidAlive(rec.pid)) return null;
  const age = Math.max(0, Math.round(Date.now() / 1000 - rec.heartbeat_ts));
  const url = String(rec.board_url ?? "").trim();
  return [
    `[监工] 已经在运行：pid ${rec.pid}，第 ${rec.ticks} 轮，心跳 ${age} 秒前。`,
    url ? `[监工] 看板：${url}` : "[监工] 看板未开启（启动时指定了 --no-board）。",
    "[监工] 重新开启方式：先执行 capitalist supervise-stop，或使用 --force 接管。",
  ].join("\n");
}

function agentList(p: Parsed): string | undefined {
  const first = flagString(p, "agent");
  const rest = p.positional.filter((x) => !x.startsWith("-"));
  const all = [first, ...rest].filter((x): x is string => Boolean(x && x.trim()));
  if (all.length === 0) return undefined;
  return all.join(",");
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
