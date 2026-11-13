/**
 * 生命周期分发。
 *
 * 一次 hook 调用在一个进程内完成：解析、判定、记录，不起子进程。
 *
 * 任何异常都放行为退出码 0，并把降级写进事件台账。
 */

import { join } from "node:path";

import type { HookDecision, HookFacet, UnifiedEvent } from "./contract";
import { autoAdopt, loadWatchRules } from "../core/autowatch";
import { buildBrief, type BriefLang } from "../core/brief";
import { runCheck } from "../core/checks";
import { claimDirectives, directiveRef, laneKeyOf } from "../core/commands";
import { type Contract, evaluate, isLastStage, loadContract } from "../core/contract";
import { readJsonl } from "../core/json";
import {
  currentSession,
  openViolations,
  recordEvent as writeEvent,
  recordReview,
  recordViolation as writeViolation,
  touchSession,
} from "../core/ledger";
import { detectAction, extractLocalPaths, localCheck, localDeleteCheck, normLocal, tightenLocal } from "../core/localGuard";
import {
  acquireWithWait,
  checkStale,
  noteRead,
  release as releaseLock,
  releaseTransient,
} from "../core/fileLock";
import { findRoot, supervisorDir } from "../core/paths";
import { skillDirs, watchConfigPath } from "./locations";
import { decide } from "../core/permission";
import { loadState, resolveModeFor } from "../core/state";
import { isSupervisorAlive, listWorkers, loadWorker, readDispatches, touchWorker } from "../core/supervisor";
import type { ActionKind, GateResult, LocalDecision } from "../core/types";

/**
 * 未纳管时的注入文案。
 *
 * 首句声明 hook 已在运行，随后给出纳管入口。文案使用产品名 capitalist。
 */
const HINT_UNWATCHED: Record<BriefLang, string> = {
  zh:
    "【capitalist 已生效 · 本会话未纳管】hook 正在运行，当前目录没有任务根。" +
    "普通问答忽略本行；长流程任务可回复“给这个项目开监督”，" +
    '或执行 `capitalist start "<目标>" --contract <任务列表名>`。',
  en:
    "【capitalist active · no task root】The hook is running; this directory has no task root. " +
    'Ignore this line for ordinary questions. For a long-running task, say "set up capitalist ' +
    'for this project" or run `capitalist start "<goal>" --contract <name>`.',
};

const INJECT_HEAD: Record<BriefLang, string> = {
  zh: "【capitalist 已生效】（以下为状态注入，不要向用户复述）",
  en: "【capitalist active】(state injected below — do not repeat it to the user)",
};

const THINK_ZH = "思考过程用中文写：界面会把推理原样展开给用户看，用英文写无法阅读。";

const INJECT_RULES: Record<BriefLang, string> = {
  zh:
    "执行纪律：\n" +
    "- 所有 capitalist 命令由本进程执行。\n" +
    "- 状态已由监工计算。按“下一步”执行，不向用户询问后续动作。\n" +
    '- 存在不确定项时：capitalist ask "<问题>" 登记后停止执行，等待监工裁决。',
  en:
    "Rules:\n" +
    "- Run every `capitalist` command yourself; never ask the user to type one.\n" +
    "- This state was computed for you. Do not ask what to do next; follow `next`.\n" +
    '- Unsure: register the question with `capitalist ask "<q>"`, then stop. That is a legitimate pause.',
};

function pickLang(prompt: string): BriefLang {
  if (!prompt.trim()) return "zh";
  return /[\u4e00-\u9fff]/.test(prompt) ? "zh" : "en";
}

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "bash", "shell", "sh", "zsh", "Terminal"]);


interface LockCfg {
  enabled: boolean;
  strictRead: boolean;
  waitMs: number;
  ttlSec: number;
}

function lockCfg(contract: Contract): LockCfg {
  const raw = (contract as unknown as Record<string, unknown>).file_locks;
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    enabled: o.enabled !== false,
    strictRead: o.strict_read === true,
    /* 默认只等 2 秒：hook 阻塞的是工作进程的一次工具调用，等待过久会使该次调用失效。 */
    waitMs: Math.max(0, num(o.wait_ms, 2000)),
    ttlSec: Math.max(10, num(o.ttl_sec, 120)),
  };
}

/** hook 决策是不是“放行”。deny 的 code 也是 0（靠 stdout 的 JSON 表达），所以要看 stdout。 */
function allowedBy(d: { code: number; stdout?: string | undefined }): boolean {
  return d.code === 0 && !d.stdout;
}

/**
 * 命令行入口名。`capitalist` 与 `cap` 是同一个 bin 的两个别名（见 package.json 的 `bin`）。
 */
const CLI_ENTRY = new Set(["capitalist", "capitalist.js", "capitalist.cjs", "cap", "cap.js", "cap.cjs"]);

/** 包管理器的临时执行前缀。`npx capitalist justify …` 与直接调用等价。 */
const RUNNER_ENTRY = new Set(["npx", "pnpx", "bunx"]);

/** `node` 一类解释器，其后第一个非开关参数是脚本路径。 */
const NODE_ENTRY = /^node(js)?(\.exe)?$/i;

/** 取路径最后一段，统一正斜杠并转小写。 */
function baseName(p: string): string {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return (i < 0 ? s : s.slice(i + 1)).toLowerCase();
}

/** 引号内的分隔符不参与切分。 */
function shellSegments(cmd: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote = "";
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i] as string;
    if (quote) {
      if (ch === "\\" && quote === '"') {
        buf += ch;
        const nx = cmd[i + 1];
        if (nx !== undefined) {
          buf += nx;
          i += 1;
        }
        continue;
      }
      if (ch === quote) quote = "";
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "&" || ch === "|") {
      out.push(buf);
      buf = "";
      const nx = cmd[i + 1];
      if ((ch === "&" || ch === "|") && nx === ch) i += 1;
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.filter((s) => s.trim() !== "");
}

/** 引号感知的分词：引号内的空白不切分，引号本身不进入结果。 */
function shellTokens(seg: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote = "";
  for (let i = 0; i < seg.length; i += 1) {
    const ch = seg[i] as string;
    if (quote) {
      if (ch === "\\" && quote === '"') {
        const nx = seg[i + 1];
        if (nx !== undefined) {
          buf += nx;
          i += 1;
        }
        continue;
      }
      if (ch === quote) {
        quote = "";
        continue;
      }
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf !== "") out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf !== "") out.push(buf);
  return out;
}

/**
 * 脚本路径是不是本项目的命令行入口。
 *
 * 认三种写法：直接是 bin 别名、路径里带 `cli` 的 `main.js`、与本 hook 同包的
 * `dist/cli/main.js` 绝对路径。第三种的判据是真实路径比对，避免把任意项目的
 * `main.js` 当成登记入口。
 */
function isProjectCli(script: string): boolean {
  const p = script.replace(/\\/g, "/");
  const base = baseName(p);
  if (CLI_ENTRY.has(base)) return true;
  if (!/^main\.(js|cjs|mjs)$/.test(base)) return false;
  if (/\/cli\//.test(p)) return true;
  const actual = normLocal(p, process.cwd());
  const own = normLocal(join(__dirname, "..", "cli", "main.js"));
  return actual !== "" && actual === own;
}

/** 单段命令是否在调用 `justify`。 */
function isJustifySegment(seg: string): boolean {
  const t = shellTokens(seg);
  let i = 0;
  while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i] as string)) i += 1;
  while (i < t.length && RUNNER_ENTRY.has(baseName(t[i] as string))) i += 1;

  const head = t[i];
  if (head === undefined) return false;

  let argAt = i + 1;
  if (NODE_ENTRY.test(baseName(head))) {
    let j = i + 1;
    while (j < t.length && (t[j] as string).startsWith("-")) {
      /* `-e` / `-p` 后面跟的是代码而不是脚本文件，这类调用不是登记动作。 */
      if (/^(--?e|--?p|--eval|--print)(=|$)/.test(t[j] as string)) return false;
      j += 1;
    }
    const script = t[j];
    if (script === undefined || !isProjectCli(script)) return false;
    argAt = j + 1;
  } else if (!CLI_ENTRY.has(baseName(head))) {
    return false;
  }

  return t[argAt] === "justify";
}

/**
 * 看板对话会话的 id 前缀。换代会生成 `capitalist-chat-c<代次>`，前缀一致。
 */
const CHAT_SESSION_RX = /^capitalist-chat\b/;

/**
 * 对话层不许执行的动作：只保留改状态机的两个。
 *
 * 禁动作是治症状：真正的问题是“一张单都没有就把阶段往下走”，那由 `advanceStage` 的派单
 * 判据解决，与对话层能跑什么命令无关。禁得太多会挡住用户口述的需求（登记、派单、结项、
 * 唤醒都是对话层该执行的），所以名单只留 `advance` 与 `adopt`。
 */
const CHAT_WRITE_RX = /(^|[\s;&|/])capitalist(\.js)?\s+(advance|adopt)\b/;

/**
 * 命令里是否有一次 `justify` 调用。
 *
 * 该命令免判本机边界：否则会出现“要放行必须先放行”的死锁，登记通道自身反而无法使用。
 * 识别因此宁严不宽：错认会让任意命令借 `justify` 字样绕过边界检查。
 *
 * 逐段识别：`rm -rf x && capitalist justify x "理由"` 只有第二段是登记动作。
 *
 * @param cmd shell 命令原文。
 */
export function isJustifyInvocation(cmd: string): boolean {
  return shellSegments(cmd).some(isJustifySegment);
}

interface Ctx {
  root: string;
  contract: Contract;
  state: NonNullable<ReturnType<typeof loadState>>;
  mode: ReturnType<typeof resolveModeFor>;
}

function loadCtx(event: UnifiedEvent): Ctx | null {
  const root = findRoot(event.cwd);
  if (!root) return null;
  const state = loadState(root);
  if (!state) return null;
  const contract = loadContract(state.contract_path) ?? loadContract(state.contract, skillDirs());
  if (!contract) return null;
  return { root, contract, state, mode: resolveModeFor(root, contract) };
}

/** 记一条动作事件。台账写失败不影响判定。 */
function recordEvent(ctx: Ctx, event: UnifiedEvent, extra: Record<string, unknown>, kind = "tool"): void {
  // 工作进程拉起时注入了 CAPITALIST_WORKER_ID / CAPITALIST_DISPATCH_ID，宿主 CLI 与它起的 hook 都会继承。
  const worker = process.env.CAPITALIST_WORKER_ID ?? "";
  const dispatch = process.env.CAPITALIST_DISPATCH_ID ?? "";
  /** 宿主给命令类工具带的描述文字一并落盘。 */
  const desc = String(event.toolInput?.description ?? event.toolInput?.intent ?? "").trim();
  writeEvent(ctx.root, kind, {
    point: event.point,
    tool: event.tool,
    session: event.sessionId,
    ...(worker ? { worker } : {}),
    ...(dispatch ? { dispatch } : {}),
    ...(desc ? { desc: desc.slice(0, 200) } : {}),
    ...extra,
  });
}

/**
 * 记一条违规。
 *
 * 会话 id 写进台账，用于按会话统计越界次数；第几次由 ledger 去重后给出。
 */
function recordViolation(
  ctx: Ctx,
  event: UnifiedEvent,
  args: { rule: string; label: string; fix?: string | undefined; evidence: string; decision?: string | undefined; kind?: string },
): { nth: number; level: number } {
  return writeViolation(ctx.root, {
    rule: args.rule,
    label: args.label,
    fix: args.fix,
    evidence: args.evidence,
    decision: args.decision,
    kind: args.kind ?? "command",
    session: event.sessionId,
    stage: ctx.state.stage,
  });
}

function deliverPendingDirectives(
  hook: HookFacet,
  event: UnifiedEvent,
  ctx: Ctx,
): HookDecision | null {
  const dispatchId = process.env.CAPITALIST_DISPATCH_ID ?? "";
  if (!workerId() || !dispatchId) return null;

  const d = readDispatches(ctx.root).find((x) => x.id === dispatchId);
  if (!d) return null;

  let taken: ReturnType<typeof claimDirectives> = [];
  try {
    taken = claimDirectives(ctx.root, {
      shard: d.shard ?? "",
      stage: d.stage || ctx.state.stage,
      dispatchId,
      lineage: d.lineage ?? dispatchId,
      workerId: workerId(),
      /** 线程键：用户在看板某条线程里追加的话落的是这个键，不是派单 id、更不是 worker id。 */
      lane: laneKeyOf(d as { stage?: string; shard?: string | null; lineage?: string; id?: string }),
      via: "hook",
      /*
       * 一次只领一条：这条通道一次只铺一条给模型（下面 `taken[0]`），领多了等于把
       * 后面的标成已送达却没真送到，队列里再也找不回来。剩下的下个工具调用继续送。
       */
      limit: 1,
    });
  } catch {
    return null; // 送达失败不拦工具调用，下一轮重试
  }
  const rec = taken[0];
  if (!rec) return null;

  recordEvent(ctx, event, { text: rec.text.slice(0, 400), via: "hook" }, "direct_deliver");
  return hook.deny(
    [
      `【用户追加 · 派单 ${dispatchId}】执行期间收到用户追加的内容，本次工具调用暂停一次以完成送达。`,
      `编号：${directiveRef(rec)}`,
      "先判断这条是不是对“这一单”的要求，然后按结论处理：",
      "  是 -> 按下面的内容调整做法（与原要求冲突时以追加内容为准），然后继续原任务；",
      "  不是 -> 不要改这一单的做法，但收尾时必须把这个编号报成 not_mine 并说明该归哪一单。",
      `回报方式：capitalist report … --outcome "${directiveRef(rec)}=done"` +
        "（也可 not_mine / blocked，多条用分号隔开）。没给结论的这一单过不了收工闸。",
      "被暂停的调用仍需执行时重新发起。",
      "",
      rec.text,
    ].join("\n"),
    event.point,
    event.sessionId,
  );
}

/** on_action：唯一能在执行前拦住的位置。红线与本机边界分别判定，两者都要过。 */
function onAction(hook: HookFacet, event: UnifiedEvent, ctx: Ctx): HookDecision {
  const selfWorker = process.env.CAPITALIST_WORKER_ID ?? "";
  if (selfWorker) releaseTransient(ctx.root, selfWorker);

  const delivered = deliverPendingDirectives(hook, event, ctx);
  if (delivered) return delivered;

  const isFileTool = FILE_TOOLS.has(event.tool);
  const isShell = SHELL_TOOLS.has(event.tool);

  // 文件类工具只判路径归属，其它工具不判
  if (isFileTool) {
    const p = String(event.toolInput.file_path ?? event.toolInput.path ?? "");
    if (!p.trim()) return hook.passthrough();
    const act: ActionKind = ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(event.tool)
      ? "write"
      : "read";
    const base = judgeLocal(hook, event, ctx, [p], act);
    /* 已被边界或红线拦截的动作不再申请锁。 */
    if (!allowedBy(base)) return base;
    return guardFileLock(hook, event, ctx, [p], act) as HookDecision;
  }

  if (!isShell) return hook.passthrough();
  const cmd = String(event.toolInput.command ?? "");
  if (!cmd.trim()) return hook.passthrough();

  const gate = evaluate(ctx.contract, cmd);
  const act = detectAction(cmd);

  /*
   * 看板对话会话只回答问题。
   *
   * 对话模型的职责是解释状态、答疑问，不替用户做决定。历史实现放任它调用 `capitalist record`
   * 与 `capitalist advance`，结果是一条“回个收到”就能写需求台账并推进阶段，而用户没有下发
   * 任何任务，阶段已经变了。改台账、动队列、推进阶段一律由用户在面板操作。
   */
  if (CHAT_SESSION_RX.test(String(event.sessionId ?? "")) && CHAT_WRITE_RX.test(cmd)) {
    recordEvent(ctx, event, { cmd: cmd.slice(0, 400), decision: "BLOCK", reason: "chat_write" });
    return hook.deny(
      "【对话层】看板对话只回答问题，不改台账、不推进阶段。\n" +
        "要派单或推进，请用户在面板操作；对话里说明状态与下一步即可。",
      event.point,
      event.sessionId,
    );
  }

  // `justify` 是登记理由的通道本身。用一条尚未登记的路径去判这条命令，会形成“要放行必须
  // 先放行”的死循环。红线仍照判。
  if (isJustifyInvocation(cmd)) {
    recordEvent(ctx, event, { cmd: cmd.slice(0, 400), decision: gate.decision, local: "allow" });
    return gate.decision === "BLOCK" ? hook.deny(describeBlock(ctx.contract, gate, cmd), event.point, event.sessionId) : hook.passthrough();
  }

  // 删除类红线只标识“这是一次删除”，判定归更具体的路径检查，因此路径检查先跑。
  if (gate.hits.some((h) => h.defer === "local_delete")) {
    const del = localDeleteCheck(ctx.contract, ctx.root, cmd);
    if (del.decision === "deny") {
      recordEvent(ctx, event, { cmd: cmd.slice(0, 400), decision: "BLOCK", reason: "local_delete" });
      const v = recordViolation(ctx, event, {
        rule: "LOCAL-DELETE",
        label: "删除越界",
        evidence: del.hits.map((h) => `${h.path} ${h.why}`).join("；"),
        decision: "BLOCK",
        kind: "local",
      });
      return hook.deny(
        `【删除拦截】只能删任务根以内的东西：\n` +
          del.hits.map((h) => `  ${h.path}\n    ${h.why}`).join("\n") +
          "\n要动根外的内容，先问用户，不要自己决定。" +
          escalation(v.nth),
        event.point,
        event.sessionId,
      );
    }
  }

  const local = localCheck(ctx.contract, ctx.root, extractLocalPaths(cmd, ctx.root), act);
  const localTightened = tightenLocal(ctx.mode, local.decision, act, decide);

  recordEvent(ctx, event, {
    cmd: cmd.slice(0, 400),
    decision: gate.decision,
    local: localTightened,
  });

  // 越界删除先于红线判定：它判的是范围，不是规则命中
  if (localTightened === "deny") {
    const why = local.hits.map((h) => `${h.path}（${h.why}）`).join("；") || "触犯本机边界";
    const v = recordViolation(ctx, event, {
      rule: "LOCAL-BOUNDARY",
      label: "碰本机禁止区",
      evidence: cmd,
      decision: "BLOCK",
      kind: "local",
    });
    return hook.deny(
      `【本机边界拦截】这条命令要碰的位置不允许：${why}\n` +
        "敏感区一律不碰；任务根以外的本机内容一律不删。换一条不碰它的做法。" +
        escalation(v.nth),
      event.point,
      event.sessionId,
    );
  }

  if (gate.decision === "BLOCK") {
    const hit = gate.hits.filter((h) => !h.defer);
    const v = recordViolation(ctx, event, {
      rule: hit[0]?.id ?? "REDLINE",
      label: hit[0]?.label ?? "命中红线",
      fix: hit[0]?.fix ?? "",
      evidence: cmd,
      decision: "BLOCK",
    });
    return hook.deny(
      `${describeBlock(ctx.contract, gate, cmd)}${escalation(v.nth)}`,
      event.point,
      event.sessionId,
    );
  }

  if (localTightened === "justify") {
    const p = local.hits[0]?.path ?? "";
    return hook.deny(
      `【本机边界】这条命令超出允许范围：${local.hits.map((h) => h.path).join("、")}\n` +
        `先登记理由：capitalist justify "${p}" "<为什么必须碰它>"\n` +
        "登记后重试原命令即放行；放行时记入待复核队列（capitalist review 查看）。",
      event.point,
      event.sessionId,
    );
  }

  if (gate.decision === "NEED_USER") {
    const hit = gate.hits.filter((h) => !h.defer);
    const v = recordViolation(ctx, event, {
      rule: hit[0]?.id ?? "REDLINE",
      label: hit[0]?.label ?? "需报备",
      fix: hit[0]?.fix ?? "",
      evidence: cmd,
      decision: "NEED_USER",
    });
    return hook.deny(
      `【需当次授权】${hit.map((h) => h.label).join("；")}\n` +
        "说清要做哪个动作 / 影响面 / 怎么回滚，等用户回话；未获授权不得执行。" +
        escalation(v.nth),
      event.point,
      event.sessionId,
    );
  }

  if (localTightened === "allow_outside") {
    recordReview(ctx.root, {
      rule: "LOCAL-OUTSIDE",
      label: "越界放行（已登记理由）",
      why: local.hits.map((h) => h.why).join("；"),
      evidence: cmd,
      decision: gate.decision,
      session: event.sessionId,
    });
  }

  const writeTargets = act === "write" ? shellWriteTargets(cmd, ctx.root) : [];
  if (writeTargets.length > 0) {
    return guardFileLock(hook, event, ctx, writeTargets, "write") as HookDecision;
  }

  return hook.passthrough();
}

function shellWriteTargets(cmd: string, root: string): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    const s = String(raw || "").trim().replace(/^['"]|['"]$/g, "");
    if (!s || s.startsWith("-") || s === "/dev/null") return;
    if (/[$*?{}]/.test(s)) return;
    out.add(s);
  };

  for (const m of cmd.matchAll(/(?:^|[\s;&|])(?:\d?>>?|&>)\s*([^\s;&|<>]+)/g)) add(m[1] ?? "");

  for (const m of cmd.matchAll(/\btee\b([^;|&]*)/g)) {
    for (const w of String(m[1] ?? "").split(/\s+/)) if (!w.startsWith("-")) add(w);
  }

  if (/\b(?:sed|perl)\b[^;|&]*\s-[a-zA-Z]*i/.test(cmd)) {
    for (const m of cmd.matchAll(/\b(?:sed|perl)\b([^;|&]*)/g)) {
      const args = String(m[1] ?? "").split(/\s+/).filter((w) => w && !w.startsWith("-"));
      if (args.length > 0) add(args[args.length - 1] ?? "");
    }
  }

  for (const m of cmd.matchAll(/\b(?:rm|touch|truncate|mv|cp|git\s+checkout|git\s+restore)\b([^;|&]*)/g)) {
    const args = String(m[1] ?? "").split(/\s+/).filter((w) => w && !w.startsWith("-"));
    if (args.length > 0) add(args[args.length - 1] ?? "");
  }

  /* 相对路径按任务根解析，才能和文件工具用同一把锁（同一个 key）。 */
  return [...out].map((p) => (p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p) ? p : join(root, p)));
}

/**
 * 文件锁守卫：执行前拿锁、写前校验版本。
 *
 * 挂在 on_action 上，这是唯一能在执行前拦住的位置。行为分三种：
 *
 *   读：只登记“谁在哪个版本读的”（默认不加锁，多读天然并发）；
 *   写：拿排他锁 + 校验“我读到的版本还是不是现在这个”；
 *   人（没有 CAPITALIST_WORKER_ID）：不参与锁，否则会把用户自己的操作挡住。
 *
 * 被拒时给的是可执行的三步，不是“失败了”，worker 是通用 agent，它需要知道
 * 现在该干什么才不会死等（用户明确提过“否则会死等”）。
 */
function guardFileLock(
  hook: HookFacet,
  event: UnifiedEvent,
  ctx: Ctx,
  paths: string[],
  act: ActionKind,
): { code: number; stdout?: string | undefined } {
  const cfg = lockCfg(ctx.contract);
  const holder = process.env.CAPITALIST_WORKER_ID ?? "";
  const mode = act === "write" ? "write" : "read";

  if (!holder) {
    /* 人自己敲的命令 / 看板会话：读要留版本痕迹，好让 worker 知道自己读的东西被改过。 */
    if (mode === "read") for (const p of paths) noteRead(ctx.root, "user", p);
    return hook.passthrough();
  }

  if (mode === "read") {
    for (const p of paths) noteRead(ctx.root, holder, p);
    if (!cfg.enabled || !cfg.strictRead) return hook.passthrough();
  } else if (!cfg.enabled) {
    return hook.passthrough();
  }

  /* 排序后依次申请：两个 worker 哪怕目标集合相同，拿锁顺序也一致，不会形成反向持有的环。 */
  const ordered = [...new Set(paths)].sort();
  const got: string[] = [];
  const releaseGot = () => {
    for (const p of got) releaseLock(ctx.root, p, holder);
    got.length = 0;
  };

  /* 锁表里记 worker 的 pid（不是 hook 自己的）：判活与面板显示都要靠它。 */
  let wpid = 0;
  try {
    wpid = loadWorker(ctx.root, holder)?.pid ?? 0;
  } catch {
    /* 记录读不到就给 0，落盘时会回落到 hook 进程号 */
  }

  for (const p of ordered) {
    const r = acquireWithWait(ctx.root, p, mode, holder, {
      ttlSec: cfg.ttlSec,
      strictRead: cfg.strictRead,
      transient: true,
      waitMs: cfg.waitMs,
      pid: wpid,
    });
    if (!r.ok) {
      releaseGot();
      const who = r.holder || "别的进程";
      recordEvent(ctx, event, { lock: "denied", mode, path: p, holder: who, ahead: r.ahead ?? 0 });
      return hook.deny(
        [
          `【文件锁】${p} 现在由 ${who} 拿着${mode === "write" ? "写锁" : "读锁"}，等了 ${cfg.waitMs}ms 没等到，前面还排着 ${r.ahead ?? 0} 个。`,
          "",
          "不要死等，也不要反复重试同一个调用：",
          "  1) 先做不涉及这个文件的事（读别的、改别的、跑测试）；",
          "  2) 确实只剩这一件事，过一会儿再试一次；",
          `  3) 一直拿不到就 capitalist ask "${p} 被 ${who} 长期占用" 登记后停手，等监工裁决。`,
        ].join("\n"),
        event.point,
        event.sessionId,
      );
    }
    got.push(p);
  }

  /*
   * 写之前校验版本。必须在拿到锁之后：等锁的这段时间里，上一个持有者完全可能
   * already 表示目标已变更，写入会用旧内容覆盖新改动，需拦截。
   */
  if (mode === "write") {
    for (const p of ordered) {
      const st = checkStale(ctx.root, holder, p);
      if (!st.stale) continue;
      releaseGot();
      recordEvent(ctx, event, { lock: "stale", path: p, by: st.by ?? "" });
      return hook.deny(
        [
          `【文件已被改】${p} 在读取之后被${st.by ? ` ${st.by} ` : "别人"}改过了。`,
          st.why ? `· ${st.why}` : "",
          "",
          "先重新 Read 这个文件，基于新内容再改；不要拿旧内容覆盖别人的改动。",
        ]
          .filter(Boolean)
          .join("\n"),
        event.point,
        event.sessionId,
      );
    }
  }

  recordEvent(ctx, event, { lock: "held", mode, files: ordered.length });
  return hook.passthrough();
}

/** 同一问题反复出现时的追加提示。第 1 次不提示，第 3 次要求登记后再停。 */
function escalation(nth: number): string {
  if (nth <= 1) return "";
  if (nth === 2) return "\n\n（同一问题第 2 次：换做法，不要重试同一条。）";
  return '\n\n（同一问题第 3 次：停手，先 capitalist ask "<为什么反复这样干>" 登记，等监工裁决。）';
}

/** 文件类工具的路径判定：读与写按同一套边界，放行时记一条待复核项。 */
function judgeLocal(
  hook: HookFacet,
  event: UnifiedEvent,
  ctx: Ctx,
  paths: string[],
  act: ActionKind,
): HookDecision {
  const local = localCheck(ctx.contract, ctx.root, paths, act);
  const decision: LocalDecision = tightenLocal(ctx.mode, local.decision, act, decide);
  if (decision === "allow") return hook.passthrough();

  if (decision === "allow_outside") {
    recordReview(ctx.root, {
      rule: "LOCAL-OUTSIDE",
      label: `越界放行（${event.tool}）`,
      why: local.hits.map((h) => h.why).join("；"),
      evidence: paths.join(" "),
      session: event.sessionId,
    });
    return hook.passthrough();
  }

  if (decision === "deny") {
    const why = local.hits.map((h) => `${h.path}（${h.why}）`).join("；");
    const v = recordViolation(ctx, event, {
      rule: `LOCAL-${act.toUpperCase()}`,
      label: "碰本机禁止区",
      evidence: why,
      decision: "BLOCK",
      kind: "local",
    });
    const modeNote =
      local.decision !== "deny" ? `\n（当前档位 ${ctx.mode} 收紧了这一动作，规则原判为放行）` : "";
    return hook.deny(
      `【本机边界拦截】${event.tool} 要碰的位置不允许：${why}${modeNote}\n` +
        "敏感信息（密钥/凭据/浏览器数据/个人文档/系统目录）一律不碰；删除不许出任务根。" +
        escalation(v.nth),
      event.point,
      event.sessionId,
    );
  }

  const p = local.hits[0]?.path ?? "";
  return hook.deny(
    `【本机边界】${event.tool} 要碰的位置超出允许范围：${local.hits.map((h) => h.path).join("、")}\n` +
      `先说明理由：capitalist justify "${p}" "<为什么必须碰它>"\n` +
      "登记后才能过；放行时记入待复核队列（capitalist review 查看）。",
    event.point,
    event.sessionId,
  );
}

/** 组装拦截文案。档位收紧导致的拒绝与规则禁止分开标注。 */
function describeBlock(contract: Contract, gate: GateResult, cmd: string): string {
  const hit = gate.hits.filter((h) => !h.defer);
  const head = hit.map((h) => `[${h.id}] ${h.label}`).join("\n");
  const fix = hit
    .map((h) => h.fix || contract.redlines.find((r) => r.id === h.id)?.fix || "")
    .filter(Boolean)
    .join("\n");
  return (
    `【红线拦截】\n${head}\n命中：…${hit[0]?.snippet ?? cmd.slice(0, 80)}…\n` +
    (fix ? `正确做法：${fix}\n` : "") +
    "换一条不越界的路径；不确定时 capitalist ask 由监工裁决。"
  );
}

/** on_idle / on_start：注入简报。工作进程分支同时续写心跳。 */
function onIdle(hook: HookFacet, event: UnifiedEvent, ctx: Ctx): HookDecision {
  const lang = pickLang(event.prompt);
  const stage = ctx.contract.stages.find((s) => s.id === ctx.state.stage);
  const check = runCheck(stage?.done as Record<string, unknown> | undefined, ctx.root);
  const brief = buildBrief({
    root: ctx.root,
    state: ctx.state,
    contract: ctx.contract,
    mode: ctx.mode,
    missing: check.missing,
    lang,
  });

  const wid = workerId();
  if (wid) {
    // 工作进程的存活由监工按心跳判定，不续写心跳时长任务会被当作死进程回收。
    touchWorker(ctx.root, wid, { status: "running", stage: ctx.state.stage });
    return hook.inject(
      `【capitalist · worker ${wid}】（监工已派单；只做这一单，结束时 capitalist report）\n${brief}\n\n${THINK_ZH}`,
      event.point,
      event.sessionId,
    );
  }

  return hook.inject(`${INJECT_HEAD[lang]}\n${brief}\n\n${INJECT_RULES[lang]}`, event.point, event.sessionId);
}

function workerId(): string {
  return process.env.CAPITALIST_WORKER_ID ?? "";
}

/**
 * 当前会话之外是否有监工在运行，且手上有存活的工作进程。
 *
 * 两个条件同时成立时，本会话按监控方处理，收工闸放行。阶段闸只约束执行侧。
 */
function executionElsewhere(root: string): boolean {
  if (!isSupervisorAlive(root)) return false;
  return listWorkers(root).some((w) => w.status === "running" || w.status === "starting");
}

/**
 * on_stop：收工闸。
 *
 * 判定顺序：
 *   0. 会话已退役，不再执行，放行
 *   1. 本阶段登记的提问，合法停顿，放行
 *   2. 登记阻塞，合法停顿，放行
 *   3. 同一问题第 3 次，拦
 *   4. 阶段闸，末阶段看不达标，中间阶段看有没有该推进却没推进
 *
 * 第 1 步按阶段过滤：登记在旧阶段的提问只豁免该阶段，不影响后续阶段。
 */
function onStop(hook: HookFacet, event: UnifiedEvent, ctx: Ctx): HookDecision {
  // 工作进程的结束由它自己的 `capitalist report` 决定，不由阶段闸决定。
  if (workerId()) return hook.passthrough();

  // 监工在运行且有存活的工作进程时，本会话按监控方处理。收工闸只约束执行侧。
  if (executionElsewhere(ctx.root)) return hook.passthrough();

  const sid = ctx.state.stage;
  const stage = ctx.contract.stages.find((s) => s.id === sid);

  const cur = currentSession(ctx.root, event.sessionId);
  if (cur?.retired) return hook.passthrough();

  const openAsks = readJsonl<Record<string, unknown>>(
    join(supervisorDir(ctx.root), "inbox", "qa.jsonl"),
  ).filter((q) => q.type === "ask" && q.status === "open" && (!q.stage || q.stage === sid));
  if (openAsks.length > 0) return hook.passthrough();

  if (Array.isArray(ctx.state.blockers) && ctx.state.blockers.length > 0) {
    return hook.passthrough();
  }

  const l3 = openViolations(ctx.root, event.sessionId).filter((v) => Number(v.nth ?? 0) >= 3);
  if (l3.length > 0) {
    const first = l3[0] as (typeof l3)[number];
    recordEvent(ctx, event, { decision: "STOP_BLOCKED_L3", rules: l3.map((v) => v.rule) }, "stop");
    return hook.deny(
      `【违规升级】同一问题已经第 ${String(first.nth)} 次：${String(first.label ?? first.rule)}\n` +
        "反复越界时按以下顺序处理：\n" +
        '  1) capitalist ask "<重复原因>" 登记后停止执行，等待监工裁决\n' +
        "  2) 确认已改正后：capitalist correct --rule <规则>\n" +
        "继续跑只会把问题带进下一阶段。",
      event.point,
      event.sessionId,
    );
  }

  const check = runCheck(stage?.done as Record<string, unknown> | undefined, ctx.root);

  if (isLastStage(ctx.contract, sid)) {
    if (check.ok) return hook.passthrough();
    recordEvent(ctx, event, { decision: "STOP_BLOCKED", missing: check.missing }, "stop");
    return hook.deny(
      `【收工闸】${sid} ${stage?.name ?? ""} 收工条件未满足，先补齐再收工：\n` +
        `${check.missing.map((m) => `  - ${m}`).join("\n")}\n` +
        '无法完成时：capitalist ask "<阻塞原因>" 登记后停止执行，等待监工裁决。',
      event.point,
      event.sessionId,
    );
  }

  if (check.ok) {
    recordEvent(ctx, event, { decision: "STAGE_NOT_ADVANCED", stage: sid }, "stop");
    return hook.deny(
      `【阶段闸】${sid} ${stage?.name ?? ""} 已达标。先 capitalist advance 推进，不要停在这里。`,
      event.point,
      event.sessionId,
    );
  }

  recordEvent(ctx, event, { decision: "STOP_BLOCKED", missing: check.missing }, "stop");
  return hook.deny(
    `【阶段闸】${sid} ${stage?.name ?? ""} 未完成，不得收工。\n` +
      `缺：\n${check.missing.map((m) => `  - ${m}`).join("\n")}\n` +
      `下一步：${ctx.state.next_action || stage?.next || "（任务列表未给出）"}\n` +
      '存在不确定项时：capitalist ask "<问题>" 登记后停止执行，等待监工裁决。',
    event.point,
    event.sessionId,
  );
}

/** 入口。异常一律放行，并把降级写进事件台账。 */
export function dispatch(hook: HookFacet, event: UnifiedEvent): HookDecision {
  try {
    let ctx = loadCtx(event);

    // 未纳管目录：注入类事件先尝试自动纳管，再决定是否输出未纳管提示。
    if (!ctx && (event.point === "on_idle" || event.point === "on_start")) {
      if (autoAdopt(event.cwd, loadWatchRules(watchConfigPath()), skillDirs())) ctx = loadCtx(event);
    }

    if (!ctx) {
      // 只有注入类事件给提示。动作类事件放行：没有任务根就没有可判定的契约。
      if (event.point === "on_idle" || event.point === "on_start") {
        return hook.inject(HINT_UNWATCHED[pickLang(event.prompt)], event.point, event.sessionId);
      }
      return hook.passthrough();
    }

    // 登记会话：并行时用于判断哪些会话在运行。写失败不阻断判定。
    if (event.sessionId) {
      try {
        touchSession(ctx.root, event.sessionId);
      } catch {
        /* 见上 */
      }
    }

    switch (event.point) {
      case "on_action":
        return onAction(hook, event, ctx);
      case "on_idle":
      case "on_start":
        return onIdle(hook, event, ctx);
      case "on_stop":
        return onStop(hook, event, ctx);
      case "on_compact":
        return hook.passthrough();
      default:
        return hook.passthrough();
    }
  } catch (err) {
    try {
      const root = findRoot(event.cwd);
      if (root) {
        writeEvent(root, "hook_error", {
          point: event.point,
          session: event.sessionId,
          error: String(err instanceof Error ? err.message : err).slice(0, 400),
        });
      }
    } catch {
      /* 记账也失败时放弃：hook 不阻断宿主 */
    }
    return hook.passthrough();
  }
}
