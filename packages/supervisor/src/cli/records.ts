/**
 * 记录类命令：裁决回填、违规纠正、会话、复核、就绪标记、台账。
 *
 * 与 `main.ts` 分开是因为这些命令只读写 `.capitalist/` 下的记录，不做判定，也不碰 hook 热路径。
 * 放在一起会让入口文件混两种节奏：判定要快且不能抛，命令出错必须说清楚。
 *
 * 字段与 Python 引擎保持一致（`inbox/qa.jsonl`、`violations.jsonl`、
 * `review.jsonl`、`sessions.json`、`ledger.jsonl`）。两边读同一份目录，字段漂移等于换个
 * 实现就看不到历史。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { runCheck } from "../core/checks";
import { evaluate, loadContract, type Contract } from "../core/contract";
import { appendJsonl, readJsonl, writeJson, writeJsonl } from "../core/json";
import {
  loadSessions,
  openReviews,
  openViolations,
  recordReview,
  recordViolation,
  resolveReviews,
  resolveViolations,
  retireSession,
  type ReviewRecord,
} from "../core/ledger";
import { appendMq, wakeSupervisor } from "../core/mq";
import { findRoot, supervisorDir } from "../core/paths";
import { loadWorker } from "../core/supervisor";
import { parseWorkerLog } from "../supervisor/workerLog";
import { skillDirs } from "../agent/locations";
import { loadState, updateState } from "../core/state";
import type { RedlineHit, TaskState } from "../core/types";
import { flagBool, flagString, type Parsed } from "./args";

interface CmdCtx {
  root: string;
  state: TaskState;
  contract: Contract;
}

/** 台账里证据的四项。少一项就不算“已证实”。 */
const EVIDENCE_FIELDS = ["baseline", "probe", "diff", "repro"] as const;

function ctxOrDie(p: Parsed): CmdCtx {
  const root = flagString(p, "root") ?? findRoot();
  if (!root) throw new Error("当前不在任何受监督任务内。开工：capitalist start <目标> --contract <任务列表名>");
  const state = loadState(root);
  if (!state) throw new Error(`${root} 下没有可用的 .capitalist/state.json`);
  const contract = loadContract(state.contract_path) ?? loadContract(state.contract, skillDirs());
  if (!contract) throw new Error(`任务列表文件丢失：${state.contract_path}`);
  return { root, state, contract };
}

function qaPath(root: string): string {
  return join(supervisorDir(root), "inbox", "qa.jsonl");
}

function envSession(): string {
  return process.env.CAPITALIST_SESSION_ID ?? "";
}


/**
 * 监工回填指导。
 *
 * 这是唯一能把话从监工传回执行侧的通道：关掉提问、写一条 answer、并把指导写进
 * `next_action`，执行侧下一轮注入的简报里就是这句话。
 *
 * 整文件覆盖写（与 Python 一致）：需要改已有 ask 的 status，追加式做不到。代价是与并发的
 * `capitalist ask` 有秒级竞争窗口。两者都是低频人工操作，接受这个窗口换取两端对 `qa.jsonl` 的
 * 理解完全一致。
 */
export function cmdAnswer(p: Parsed): number {
  const [id, ...rest] = p.positional;
  const guidance = rest.join(" ") || flagString(p, "text") || "";
  if (!id || !guidance) throw new Error('用法：capitalist answer <问题id> "<指导>"');

  const { root } = ctxOrDie(p);
  const file = qaPath(root);
  const rows = readJsonl<Record<string, unknown>>(file);

  let hit = false;
  let hitText = "";
  for (const r of rows) {
    if (r.type !== "ask") continue;
    // 三种定位方式：id 精确匹配、正文全文匹配、正文片段匹配。后两种是给“没有 id 的
    // 历史记录”留的出口，早期监工登记 ask 不写 id，只能按 id 关的话它就永远关不掉，
    // 而 open ask 会让监工一直暂停派单。
    const text = String(r.text ?? r.question ?? "");
    const matched = r.id === id || (text !== "" && (text === id || text.includes(id)));
    if (!matched) continue;
    r.status = "answered";
    r.answered_at = new Date().toISOString();
    hit = true;
    hitText = text;
  }
  if (!hit) throw new Error(`没找到问题 ${id}（capitalist inbox 看当前待裁决）`);

  // 同一问题只保留最新一条指导
  for (const r of rows) {
    if (r.type === "answer" && r.qid === id) r.status = "superseded";
  }
  rows.push({
    at: new Date().toISOString(),
    at_ts: Date.now() / 1000,
    type: "answer",
    qid: id,
    status: "new",
    text: guidance,
  });

  writeJsonl(file, rows);

  // 重派上限这类 ask，裁决本身就是“放行该片”：把那批失败划到线下。不划的话重派计数
  // 仍超上限时，监工下一轮调度会重新登记同一条 ask，答复未登记即视为未答复，阶段持续卡住。
  const capLabel = /重派上限\s+([^\s：:，,]+)/.exec(hitText)?.[1] ?? null;
  if (capLabel) {
    updateState(root, (s) => {
      const map = { ...((s.retry_resets as Record<string, string> | undefined) ?? {}) };
      map[capLabel] = new Date().toISOString();
      s.retry_resets = map;
    });
    process.stdout.write(`已重置分片 ${capLabel} 的重派计数：已记录的失败不再计入上限。\n`);
  }

  if (updateState(root, (s) => { s.next_action = guidance; }) === null) {
    throw new Error("状态写入冲突，指导已回填但下一步没更新：请重试 capitalist answer");
  }

  process.stdout.write(`已回填 问${id}：${guidance}\n下一步已更新，执行侧下一轮读取。\n`);
  return 0;
}

/**
 * 监工登记：这条违规已经改正了。
 *
 * 不消解时收工闸会持续按第 3 次拦截。
 */
export function cmdCorrect(p: Parsed): number {
  const { root } = ctxOrDie(p);
  const rule = flagString(p, "rule");
  const note = flagString(p, "note") ?? "";
  // 没显式指定会话时传 undefined，让消解覆盖所有会话的同类违规。
  // 传空串会被当成“只匹配 session 为空的记录”，而 hook 写的记录 session 都不为空。
  const session = envSession() || undefined;

  const n = resolveViolations(root, { rule, session, note });
  if (n === 0) {
    process.stdout.write(`没有需要纠正的记录（${rule ? `规则 ${rule}` : "当前会话"}）\n`);
    return 0;
  }
  process.stdout.write(`已标记纠正：违规 ${n} 条${rule ? `（规则 ${rule}）` : "（当前会话全部）"}\n`);

  const left = openViolations(root, session);
  if (left.length > 0) {
    process.stdout.write(`仍有 ${left.length} 条未消解：\n`);
    for (const v of left) process.stdout.write(`  ${v.rule}（第 ${v.nth} 次）${v.label ?? ""}\n`);
  }
  return 0;
}


/**
 * 某一个工作进程的动作时间线。
 *
 * 给监工的“上下文索引”用的：对话层只看到一行摘要（车道 / 余量 / 已经干过什么），
 * 无法判定该事项是否执行过时，用本命令查看明细，不推断，也不重新建单。
 *
 * 输出三块：身份（哪一单、哪条车道、什么状态）-> 统计（改过哪些文件、跑过几次构建测试）
 * -> 时间线（最近 15 条动作，正序）。全部来自 worker 自己的日志与记录，不做推断。
 */
export function cmdWorker(p: Parsed): number {
  const { root } = ctxOrDie(p);
  const id = String(p.positional[0] ?? "").trim();
  if (!id) throw new Error("用法：capitalist worker <进程号>（进程号见看板任务卡或 capitalist status）");
  const w = loadWorker(root, id);
  if (!w) throw new Error(`没有这个进程：${id}`);

  const lane = String((w as unknown as { ai_session?: string }).ai_session ?? "");
  const label = w.dispatch ? readJsonl<{ id: string; title?: string; status?: string }>(
    join(supervisorDir(root), "inbox", "dispatch.jsonl"),
  ).find((d) => String(d.id) === String(w.dispatch)) : null;
  process.stdout.write(
    `进程 ${w.id} · ${w.status}${w.exit_code !== null && w.exit_code !== undefined ? `（exit ${w.exit_code}）` : ""}\n`,
  );
  process.stdout.write(`派单 ${w.dispatch || "（无）"}${label?.title ? ` · ${label.title}` : ""}\n`);
  process.stdout.write(`车道 ${lane || "（未登记）"}\n`);

  const log = String(w.log ?? "");
  if (!log || !existsSync(log)) {
    process.stdout.write("没有日志，看不到动作\n");
    return 0;
  }
  let parts: ReturnType<typeof parseWorkerLog>;
  try {
    parts = parseWorkerLog(readFileSync(log, "utf8").split(/\r?\n/), { stream: true });
  } catch (e) {
    process.stdout.write(`日志读不出来：${(e as Error).message}\n`);
    return 0;
  }

  const edits = new Set<string>();
  const reads = new Set<string>();
  const acts: string[] = [];
  let build = 0;
  let test = 0;
  for (const t of parts.tools) {
    const s = String(t).replace(/^▸\s*/, "").replace(/\s+/g, " ").trim();
    if (!s) continue;
    acts.push(s);
    if (/^修改\s/.test(s)) edits.add(s.replace(/^修改\s*/, ""));
    else if (/^读取\s/.test(s)) reads.add(s.replace(/^读取\s*/, ""));
    else if (/build|构建|tsc|vite|webpack/i.test(s)) build += 1;
    else if (/test|测试|pytest|jest|vitest/i.test(s)) test += 1;
  }
  process.stdout.write(
    `动作 ${acts.length} 条：改过 ${edits.size} 个文件、读过 ${reads.size} 个、构建 ${build} 次、测试 ${test} 次\n`,
  );
  if (edits.size) process.stdout.write(`改过：${[...edits].join("、")}\n`);
  const tail = acts.slice(-15);
  if (tail.length) {
    process.stdout.write("时间线（最近 15 条）：\n");
    for (const a of tail) process.stdout.write(`  ${a}\n`);
  }
  return 0;
}

/**
 * 列出当前任务根上登记过的会话。
 *
 * 多进程并行时这是“谁运行中”的唯一视图。
 */
export function cmdSessions(p: Parsed): number {
  const { root } = ctxOrDie(p);
  const all = loadSessions(root);
  const ids = Object.keys(all);
  if (ids.length === 0) {
    process.stdout.write("还没有登记任何会话（hook 跑过一次之后才会有）\n");
    return 0;
  }
  for (const id of ids) {
    const s = all[id];
    if (!s) continue;
    const mark = s.retired ? "已退役" : "运行中";
    process.stdout.write(
      `${id.slice(0, 12).padEnd(13)} ${s.role.padEnd(10)} ${mark.padEnd(5)} last=${s.last_seen}${
        s.note ? `  ${s.note}` : ""
      }\n`,
    );
  }
  return 0;
}

/** 退役一个会话（交接 / 换进程）。 */
export function cmdRetire(p: Parsed): number {
  const { root } = ctxOrDie(p);
  const id = p.positional[0] ?? envSession();
  if (!id) throw new Error("用法：capitalist retire <会话id> [--note 交接说明]（或设置 CAPITALIST_SESSION_ID）");
  const ok = retireSession(root, id, flagString(p, "note") ?? "");
  if (!ok) throw new Error(`没登记过这个会话：${id}`);
  process.stdout.write(`已退役 ${id}。新会话接手前先看 capitalist status 与 .capitalist/ 下的记录。\n`);
  return 0;
}


/**
 * 待复核项。
 *
 * 越界但被授权放行的动作都在这里，不复查等于没约束。
 */
export function cmdReview(p: Parsed): number {
  const { root } = ctxOrDie(p);
  const [action, match] = p.positional;

  if (action === "resolve") {
    if (!match) throw new Error("用法：capitalist review resolve <序号|证据片段>");
    const n = resolveReviews(root, match);
    if (n === 0) throw new Error(`没有匹配的待复核项：${match}`);
    process.stdout.write(`已消解 ${n} 条待复核项。\n`);
    return 0;
  }

  const rows = openReviews(root);
  if (rows.length === 0) {
    process.stdout.write("没有待复核项\n");
    return 0;
  }
  rows.forEach((r: ReviewRecord, i: number) => {
    process.stdout.write(
      `[${i}] ${r.rule ?? ""} ${r.label ?? ""}\n    ${String(r.evidence ?? "").slice(0, 160)}\n` +
        (r.why ? `    原因：${r.why}\n` : ""),
    );
  });
  process.stdout.write(`\n共 ${rows.length} 条。确认合规后：capitalist review resolve <序号>\n`);
  return 0;
}


/**
 * 通用就绪标记，写 `.capitalist/scope.json`。
 *
 * 契约用 `json_keys` 检查它，因此这条命令是阶段能不能推进的前置。
 * 形式是 `key=value`（与 Python 一致）。
 */
export function cmdScope(p: Parsed): number {
  const pairs = p.positional.filter((x) => x.includes("="));
  if (pairs.length === 0) throw new Error("用法：capitalist scope assets=1 rules=1 grading=1");

  const { root, state, contract } = ctxOrDie(p);
  const file = join(supervisorDir(root), "scope.json");
  const cur = readJsonlSafe(file);

  for (const pair of pairs) {
    const [k, v = ""] = pair.split("=", 2);
    const key = (k ?? "").trim();
    if (!key) continue;
    const val = v.trim();
    cur[key] =
      ["1", "true", "yes", "on"].includes(val)
        ? true
        : ["0", "false", "no", "off"].includes(val)
          ? false
          : val;
  }
  cur["updated_at"] = new Date().toISOString();
  writeJson(file, cur);

  process.stdout.write("就绪标记（.capitalist/scope.json）：\n");
  for (const [k, v] of Object.entries(cur)) {
    if (k === "updated_at") continue;
    process.stdout.write(`  ${v ? "[x]" : "[ ]"} ${k} = ${String(v)}\n`);
  }

  const stage = contract.stages.find((s) => s.id === state.stage);
  const check = runStageCheck(stage?.done, root);
  process.stdout.write(
    `\n本阶段门槛：${check.ok ? "已满足 -> capitalist advance" : `未满足：${check.missing.slice(0, 3).join("；")}`}\n`,
  );
  return 0;
}

function readJsonlSafe(file: string): Record<string, unknown> {
  try {
    if (!existsSync(file)) return {};
    const d = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}


/**
 * 只改“下一步”这一句，不动阶段与计数。
 */
export function cmdSetNext(p: Parsed): number {
  const text = p.positional.join(" ") || flagString(p, "text");
  if (!text) throw new Error('用法：capitalist set-next "<下一步做什么>"');
  const { root } = ctxOrDie(p);
  if (updateState(root, (s) => { s.next_action = text; }) === null) {
    throw new Error("状态写入冲突，重试后仍未成功：请再执行一次");
  }
  process.stdout.write(`下一步：${text}\n`);
  return 0;
}

/**
 * 就地改 jsonl 中某条记录的字段。
 *
 * 例如把 status 从 pending 改成 done。匹配字段由 `--key` 指定，默认按 id 匹配。
 */
export function cmdUpdate(p: Parsed): number {
  const [file, id, field, ...rest] = p.positional;
  const value = rest.join(" ");
  /** `--clear` 删字段，而不是写空串。 */
  const clear = flagBool(p, "clear");
  if (!file || !id || !field || (value === "" && !clear)) {
    throw new Error('用法：capitalist update <名> <id> <字段> <值> [--key id] ｜ 删字段用 --clear');
  }

  const { root } = ctxOrDie(p);
  const name = file.endsWith(".jsonl") ? file : `${file}.jsonl`;
  const target = join(supervisorDir(root), name);
  const key = flagString(p, "key") ?? "id";

  const rows = readJsonl<Record<string, unknown>>(target);
  let n = 0;
  for (const r of rows) {
    if (String(r[key]) !== id) continue;
    if (clear) delete r[field];
    else r[field] = value === "true" ? true : value === "false" ? false : value;
    n += 1;
  }
  if (n === 0) throw new Error(`${name} 里没有 ${key}=${id}`);
  writeJsonl(target, rows);
  process.stdout.write(`已更新 ${n} 条：${id}.${field} ${clear ? "（已删除）" : `= ${value}`}\n`);
  return 0;
}


/**
 * 证据台账。
 *
 * `confirmed` 有硬门槛：四项证据缺一项就自动降级为 `unconfirmed` 并记违规。
 * 这道门槛拦不住“已验证”这三个字，但能让缺证据的结论留下降级痕迹。
 */
export function cmdLedger(p: Parsed): number {
  const { root, state } = ctxOrDie(p);
  const file = join(supervisorDir(root), "ledger.jsonl");
  const action = p.positional[0] ?? "list";

  if (action === "add") {
    const claim = flagString(p, "claim");
    if (!claim) throw new Error('用法：capitalist ledger add --claim "<结论>" [--type X] [--verdict confirmed|unconfirmed] [--baseline f --probe f --diff f --repro f]');

    const evidence: Record<string, string> = {};
    for (const f of EVIDENCE_FIELDS) {
      const v = flagString(p, f);
      if (!v) continue;
      evidence[f] = readEvidence(v);
    }

    const entry: Record<string, unknown> = {
      id: flagString(p, "id") ?? `L${Math.floor(Date.now() / 1000) % 100000}`,
      claim,
      type: flagString(p, "type") ?? "UNKNOWN",
      verdict: flagString(p, "verdict") ?? "unconfirmed",
      evidence,
      owner: flagString(p, "owner") ?? "worker",
      at: new Date().toISOString(),
      at_ts: Date.now() / 1000,
    };

    if (entry.verdict === "confirmed") {
      const lack = EVIDENCE_FIELDS.filter((f) => !evidence[f]);
      if (lack.length > 0) {
        entry.verdict = "unconfirmed";
        entry.downgraded_reason = `缺：${lack.join("、")}`;
        process.stdout.write(`证据不全，自动降级为 unconfirmed（缺 ${lack.join("、")}）\n`);
        recordViolation(root, {
          rule: "EVIDENCE_FAKE",
          label: "证据不全就想标 confirmed 定论",
          fix: "补齐 baseline / probe / diff / repro 四项再加账；证据不全时标记 unconfirmed，不把推测写成已验证。",
          evidence: `${String(entry.id)} ${claim.slice(0, 80)}`,
          decision: "DOWNGRADED",
          kind: "flow",
          session: envSession(),
          stage: state.stage,
        });
      }
    }

    appendJsonl(file, entry);
    process.stdout.write(`入账 ${String(entry.id)} [${String(entry.verdict)}] ${claim.slice(0, 60)}\n`);
    return 0;
  }

  const rows = readJsonl<Record<string, unknown>>(file);

  if (action === "list") {
    if (rows.length === 0) {
      process.stdout.write("台账为空\n");
      return 0;
    }
    for (const r of rows) {
      process.stdout.write(
        `${String(r.id ?? "").padEnd(10)} ${String(r.verdict ?? "").padEnd(12)} ${String(r.type ?? "").padEnd(16)} ${String(r.claim ?? "").slice(0, 66)}\n`,
      );
    }
    return 0;
  }

  if (action === "assert") {
    const id = flagString(p, "id") ?? p.positional[1];
    if (!id) throw new Error("用法：capitalist ledger assert --id <台账id>");
    const hit = rows.find((r) => r.id === id);
    if (!hit) throw new Error(`没找到 ${id}`);
    const ev = (hit.evidence ?? {}) as Record<string, unknown>;
    const lack = EVIDENCE_FIELDS.filter((f) => !ev[f]);
    process.stdout.write(
      lack.length === 0 ? `${id}：证据完整\n` : `${id}：证据不全，缺 ${lack.join("、")}\n`,
    );
    return lack.length === 0 ? 0 : 2;
  }

  throw new Error(`未知动作：${action}（可用 add / list / assert）`);
}


/**
 * 记一条真阻塞：在等外部条件（验证码、账号、授权、外部回复）。
 *
 * 与 `ask` 的区别：ask 是不知道该怎么办、等对方定；block 是知道怎么办但现在做不了，卡在
 * 别人手上。两者都让收工闸放行，但后者不需要裁决。
 */
/** 向监工申报一件事（`.capitalist/mq/reports.jsonl`）。 */
export async function cmdNotify(p: Parsed): Promise<number> {
  const kind = String(p.positional[0] ?? "").trim();
  const text = (p.positional.slice(1).join(" ") || flagString(p, "text") || "").trim();
  if (!kind || !text) {
    throw new Error('用法：capitalist notify <类型> "<内容>" [--evidence "..."] [--needs none|decision|intervention]');
  }
  const { root } = ctxOrDie(p);
  const wid = String(process.env.CAPITALIST_WORKER_ID ?? "");
  const w = wid ? loadWorkerSafe(root, wid) : null;
  const needsRaw = String(flagString(p, "needs") ?? "").trim().toLowerCase();
  const needs = needsRaw === "decision" || needsRaw === "intervention" ? needsRaw : "none";
  const sevRaw = String(flagString(p, "severity") ?? "").trim().toLowerCase();
  const severity =
    sevRaw === "info" || sevRaw === "warn" || sevRaw === "critical"
      ? sevRaw
      : kind === "progress"
        ? "info"
        : kind === "blocked" || kind === "risk"
          ? "critical"
          : "warn";

  const msg = appendMq(root, {
    from: wid,
    dispatch: String(process.env.CAPITALIST_DISPATCH_ID ?? w?.dispatch ?? ""),
    stage: String(w?.stage ?? ""),
    shard: String(w?.shard ?? ""),
    kind,
    severity,
    text,
    needs,
    ...(flagString(p, "evidence") ? { evidence: String(flagString(p, "evidence")).slice(0, 4000) } : {}),
  });

  process.stdout.write(
    `已申报 申报${msg.id}（${kind} · ${severity}${needs === "none" ? "" : ` · 需要${needs === "decision" ? "裁决" : "干预"}`}）\n`,
  );
  if (needs === "none") process.stdout.write("继续执行，不必等待回复。\n");
  else process.stdout.write("申报已登记，监工正在判断；可先行处理与它无关的部分。\n");

  /** 推送唤醒：要等它发出去再退出。 */
  await wakeSupervisor(root).catch(() => false);
  return 0;
}

/** 读 worker 记录，读不到返回 null（`notify` 不该因为记录缺失就失败）。 */
function loadWorkerSafe(root: string, id: string): { stage?: string; shard?: string; dispatch?: string } | null {
  try {
    return loadWorker(root, id) ?? null;
  } catch {
    return null;
  }
}

export function cmdBlock(p: Parsed): number {
  const type = p.positional[0];
  const reason = p.positional.slice(1).join(" ") || flagString(p, "reason");
  if (!type || !reason) throw new Error('用法：capitalist block <类型> "<卡在哪>"');

  const { root } = ctxOrDie(p);
  const ok = updateState(root, (s) => {
    const list = Array.isArray(s.blockers) ? [...(s.blockers as unknown[])] : [];
    list.push({ type, reason, since: new Date().toISOString() });
    s.blockers = list;
  });
  if (ok === null) throw new Error("状态写入冲突，重试后仍未成功：请再执行一次");

  process.stdout.write(`已登记阻塞[${type}]：${reason}\n条件满足后执行：capitalist unblock --type ${type}\n`);
  return 0;
}

/**
 * 清除阻塞。
 *
 * `--all` 清全部，否则按 type 清。
 */
export function cmdUnblock(p: Parsed): number {
  const type = flagString(p, "type") ?? p.positional[0];
  const all = flagBool(p, "all");
  if (!all && !type) throw new Error("用法：capitalist unblock --type <类型> 或 capitalist unblock --all");

  const { root } = ctxOrDie(p);
  let before = 0;
  let after = 0;
  const ok = updateState(root, (s) => {
    const list = Array.isArray(s.blockers) ? (s.blockers as Array<Record<string, unknown>>) : [];
    before = list.length;
    const kept = all ? [] : list.filter((b) => b.type !== type);
    s.blockers = kept;
    after = kept.length;
  });
  if (ok === null) throw new Error("状态写入冲突，重试后仍未成功：请再执行一次");

  process.stdout.write(`阻塞：${before} 改为 ${after}\n`);
  return 0;
}


/** 发枪前的最后一道闸。 */
export function cmdFire(p: Parsed): number {
  const reqFile = flagString(p, "req");
  if (!reqFile) {
    throw new Error('用法：capitalist fire --req <请求文件> [--authorized "<用户授权原话>"] [--gap 秒]');
  }
  if (!existsSync(reqFile)) throw new Error(`找不到 ${reqFile}`);

  const text = readFileSync(reqFile, "utf8");
  const { root, state, contract } = ctxOrDie(p);
  const res = evaluate(contract, text);
  const hits = res.hits.filter((h) => !h.defer);

  if (res.decision === "BLOCK") {
    for (const h of hits) {
      recordViolation(root, {
        rule: h.id,
        label: h.label,
        fix: contract.redlines.find((r) => r.id === h.id)?.fix ?? "",
        evidence: text,
        decision: "BLOCK",
        session: envSession(),
        stage: state.stage,
      });
    }
    reportHits(hits);
    process.stdout.write("不发。\n");
    return 3;
  }

  if (res.decision === "NEED_USER") {
    const authorized = flagString(p, "authorized");
    if (!authorized) {
      for (const h of hits) {
        recordViolation(root, {
          rule: h.id,
          label: h.label,
          fix: contract.redlines.find((r) => r.id === h.id)?.fix ?? "",
          evidence: text,
          decision: "NEED_USER",
          session: envSession(),
          stage: state.stage,
        });
      }
      reportHits(hits);
      process.stdout.write('\n未提供用户授权原话，不发。授权后：--authorized "<原话>"\n');
      return 2;
    }

    appendJsonl(join(supervisorDir(root), "authz.jsonl"), {
      at: new Date().toISOString(),
      at_ts: Date.now() / 1000,
      req: basename(reqFile),
      user_words: authorized,
      hit_ids: hits.map((h) => h.id),
      stage: state.stage,
    });
    for (const h of hits) {
      recordReview(root, {
        rule: h.id,
        label: `越界放行：${h.label}`,
        why: "这条本来要报备，用户已授权。核授权范围和实际动作对不对得上——别出现“批了 A、做了 B”。",
        evidence: `${text} ｜ 授权原话：${authorized}`,
        decision: "AUTHORIZED",
        session: envSession(),
      });
    }
    process.stdout.write(`已记录用户授权：${authorized}\n`);
  }

  if (res.decision !== "PASS") reportHits(hits);

  // 限速：连续请求之间留间隔，避免目标服务过载。需等待就等待，不发无效请求。
  const gap = Number(flagString(p, "gap") ?? 0) || 0;
  const lastFile = join(supervisorDir(root), "last_fire.txt");
  if (gap > 0 && existsSync(lastFile)) {
    const last = Number(readFileSync(lastFile, "utf8").trim());
    if (Number.isFinite(last) && last > 0) {
      const delta = Date.now() / 1000 - last;
      if (delta < gap) {
        const wait = Math.ceil((gap - delta) * 10) / 10;
        process.stdout.write(`限速：等待 ${wait}s\n`);
        sleepSync(wait * 1000);
      }
    }
  }
  writeFileSync(lastFile, String(Date.now() / 1000), "utf8");

  process.stdout.write(`已发枪：${basename(reqFile)}\n`);
  return 0;
}

/**
 * 同步睡眠。
 *
 * fire 是命令行工具，等完再返回。
 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 环境不支持时放弃等待：限速是保护目标，不是正确性前提 */
  }
}

function reportHits(hits: readonly RedlineHit[]): void {
  for (const h of hits) {
    process.stdout.write(`[${h.level}] ${h.id} ${h.label}\n   命中：…${h.snippet}…\n`);
  }
}

/**
 * 证据参数可以是文件路径（读内容），也可以是原文字。
 */
function readEvidence(v: string): string {
  try {
    return existsSync(v) ? readFileSync(v, "utf8").slice(0, 4000) : v;
  } catch {
    return v;
  }
}

/**
 * 阶段门槛检查。
 */
function runStageCheck(
  done: Record<string, unknown> | undefined,
  root: string,
): { ok: boolean; missing: string[] } {
  return runCheck(done, root);
}
