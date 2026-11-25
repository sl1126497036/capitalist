/**
 * 生命周期分发。
 *
 * 一次 hook 调用在一个进程内完成：解析、判定、记录，不起子进程。
 *
 * 任何异常都放行为退出码 0，并把降级写进事件台账。
 */

import { join } from "node:path";

import type { HookDecision, HookFacet, UnifiedEvent } from "./contract";
import { autoAdopt, loadWatchRules } from "../core/platform/autowatch";
import { buildBrief, type BriefLang } from "../core/message/brief";
import { claimDirectives, directiveShortRef, laneKeyOf } from "../core/dispatch/commands";
import { type Policy, evaluate, loadPolicy } from "../core/policy/policy";
import { readJsonl } from "../core/record/json";
import {
  currentSession,
  openViolations,
  recordEvent as writeEvent,
  recordReview,
  recordToolEvent,
  recordViolation as writeViolation,
  touchSession,
} from "../core/record/ledger";
import { detectAction, extractLocalPaths, localCheck, normLocal, tightenLocal } from "../core/guard/localGuard";
import type { LocalCheckExtra } from "../core/guard/localGuard";
import { skillAllowRoots } from "../supervisor/skills";
/* 重复越界的升级提示与申请台账共用一份文案。 */
import { escalation } from "../core/guard/requests";
import {
  acquireWithWait,
  checkStale,
  noteRead,
  release as releaseLock,
  releaseTransient,
} from "../core/record/fileLock";
import { findRoot, supervisorDir } from "../core/record/paths";
import { skillDirs, watchConfigPath } from "./locations";
import { decide } from "../core/guard/permission";
import { deleteGate, outsideGate, type GuardBase } from "./guardGate";
import { loadState, resolveModeFor } from "../core/record/state";
import { isSupervisorAlive, listWorkers, loadWorker, readDispatches, touchWorker } from "../core/record/supervisor";
import type { ActionKind, GateResult, LocalDecision } from "../core/types";

/**
 * 未纳管时的注入文案。
 *
 * 首句声明 hook 已在运行，随后给出纳管入口。文案使用产品名 capitalist。
 */
const HINT_UNWATCHED: Record<BriefLang, string> = {
  zh:
    "【capitalist 已生效，本会话未纳管】hook 正在运行，当前目录没有任务根。" +
    "普通问答忽略本行；长流程任务可回复“给这个项目开监督”，" +
    '或执行 `capitalist start "<目标>" --policy <守卫名>`。',
  en:
    "【capitalist active · no task root】The hook is running; this directory has no task root. " +
    'Ignore this line for ordinary questions. For a long-running task, say "set up capitalist ' +
    'for this project" or run `capitalist start "<goal>" --policy <name>`.',
};

const INJECT_HEAD: Record<BriefLang, string> = {
  zh: "【capitalist 已生效】（以下为状态注入，不要向用户复述）",
  en: "【capitalist active】(state injected below — do not repeat it to the user)",
};

/** 推理过程用哪门语言写：与用户交流所用语言一致，界面会将推理原样展示。 */
const THINK_LANG: Record<BriefLang, string> = {
  zh: "思考过程用用户语言写：界面会将推理原样展示给用户。",
  en: "Write your reasoning in the user's language: the board shows it verbatim.",
};

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
    '- When uncertain: register the question with `capitalist ask "<q>"`, then stop. This is a legitimate pause.',
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

function lockCfg(policy: Policy): LockCfg {
  const raw = (policy as unknown as Record<string, unknown>).file_locks;
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
 * 命令行的切分与识别在 core/guard/cmdParse。
 *
 * 这里只保留判定流程；解析规则属于纯文本处理，与红线、边界判定分开维护。
 */

/** 引号内不切分的分词与分段在 cmdParse 中实现。 */

/** 引号感知的分词已移到 cmdParse。 */

/** 入口路径识别已移到 cmdParse。 */

/** 单段识别已移到 cmdParse。 */

/**
 * 看板对话会话的 id 前缀。换代会生成 `capitalist-chat-c<代次>`，前缀一致。
 */
const CHAT_SESSION_RX = /^capitalist-chat\b/;

/**
 * 对话层不许执行的边界动作：换守卫。
 *
 * 禁用动作只是权宜之计：根本问题是“用户没下令，任务根与守卫的绑定却变了”，那由建单入口的
 * 判据解决，与对话层能跑什么命令无关。禁用过多会阻断用户口述的需求（登记、派单、结束、
 * 唤醒都是对话层该执行的），所以名单只留 `adopt`。`advance` 已随阶段机制移除，正则里仍
 * 留着它，是为了拦住照旧版本文案发出的旧命令。
 */
const CHAT_WRITE_RX = /(^|[\s;&|/])capitalist(\.js)?\s+(advance|adopt)\b/;

import { isJustifyInvocation } from "../core/guard/cmdParse";
export { isJustifyInvocation };

interface Ctx {
  root: string;
  policy: Policy;
  state: NonNullable<ReturnType<typeof loadState>>;
  mode: ReturnType<typeof resolveModeFor>;
}

function loadCtx(event: UnifiedEvent): Ctx | null {
  const root = findRoot(event.cwd);
  if (!root) return null;
  const state = loadState(root);
  if (!state) return null;
  const policy = loadPolicy(state.policy_path) ?? loadPolicy(state.policy, skillDirs());
  if (!policy) return null;
  return { root, policy, state, mode: resolveModeFor(root, policy) };
}

/** 记一条动作事件。台账写失败不影响判定。 */
function recordEvent(ctx: Ctx, event: UnifiedEvent, extra: Record<string, unknown>, kind = "tool"): void {
  recordToolEvent(
    ctx.root,
    {
      point: event.point,
      tool: event.tool,
      session: event.sessionId,
      desc: String(event.toolInput?.description ?? event.toolInput?.intent ?? ""),
    },
    extra,
    kind,
  );
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
      dispatchId,
      lineage: d.lineage ?? dispatchId,
      workerId: workerId(),
      /** 线程键：用户在看板某条线程里追加的话落的是这个键，不是派单 id、更不是 worker id。 */
      lane: laneKeyOf(d as { shard?: string | null; lineage?: string; id?: string }),
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
      `【用户追加 · 派单 ${dispatchId}】执行期间收到用户追加的内容，本次工具调用已被拦截，用于先完成本条送达。`,
      `编号：${directiveShortRef(rec)}`,
      "先判断是否属于本单要求，再按结论处理：",
      "  是 -> 按下面的内容调整做法（与原要求冲突时以追加内容为准），随后继续原任务；",
      "  不是 -> 不调整本单做法，但收尾时须将该编号标注为 not_mine，并说明其归属任务。",
      `回报方式：capitalist report … --outcome "${directiveShortRef(rec)}=done"` +
        "（也可 not_mine / blocked，多条用分号隔开）。未给出结论的本单无法通过收工闸。",
      "被暂停的调用仍需执行时重新发起。",
      "",
      rec.text,
    ].join("\n"),
    event.point,
    event.sessionId,
  );
}

/* 申请入队与回执在 agent/guardGate。 */

/** on_action：唯一能在执行前拦住的位置。红线与本机边界分别判定，两者都要过。 */
function onAction(hook: HookFacet, event: UnifiedEvent, ctx: Ctx, offline = false): HookDecision {
  const selfWorker = process.env.CAPITALIST_WORKER_ID ?? "";
  if (selfWorker) releaseTransient(ctx.root, selfWorker);

  const delivered = offline ? null : deliverPendingDirectives(hook, event, ctx);
  if (delivered) return delivered;

  const isFileTool = FILE_TOOLS.has(event.tool);
  const isShell = SHELL_TOOLS.has(event.tool);

  // 文件类工具只判路径归属，其他工具不判
  if (isFileTool) {
    const p = String(event.toolInput.file_path ?? event.toolInput.path ?? "");
    if (!p.trim()) return hook.passthrough();
    const act: ActionKind = ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(event.tool)
      ? "write"
      : "read";
    const base = judgeLocal(hook, event, ctx, [p], act, offline);
    /* 已被边界或红线拦截的动作不再申请锁。 */
    if (!allowedBy(base)) return base;
    return guardFileLock(hook, event, ctx, [p], act) as HookDecision;
  }

  if (!isShell) return hook.passthrough();
  const cmd = String(event.toolInput.command ?? "");
  if (!cmd.trim()) return hook.passthrough();

  const gate = evaluate(ctx.policy, cmd);
  const act = detectAction(cmd);

  /*
   * 看板对话会话只回答问题。
   *
   * 对话模型的职责是解释状态、答疑问，不替用户做决定。历史实现放任它调用 `capitalist record`
   * 与流程推进命令，结果是一条“回个收到”就能写需求台账并改变执行流程，而用户没有下发
   * 任何任务。改台账、动队列一律由用户在面板操作。
   */
  if (CHAT_SESSION_RX.test(String(event.sessionId ?? "")) && CHAT_WRITE_RX.test(cmd)) {
    recordEvent(ctx, event, { cmd: cmd.slice(0, 400), decision: "BLOCK", reason: "chat_write" });
    return hook.deny(
      "【对话层】看板对话只回答问题，不改台账、不改变执行流程。\n" +
        "要派单或推进，请用户在面板操作；对话里说明状态与下一步即可。",
      event.point,
      event.sessionId,
    );
  }

  // `justify` 是登记理由的通道本身。用一条尚未登记的路径去判这条命令，会形成“要放行必须
  // 先放行”的死循环。红线仍照判。
  if (isJustifyInvocation(cmd)) {
    recordEvent(ctx, event, { cmd: cmd.slice(0, 400), decision: gate.decision, local: "allow" });
    return gate.decision === "BLOCK" ? hook.deny(describeBlock(ctx.policy, gate, cmd), event.point, event.sessionId) : hook.passthrough();
  }

  /*
   * 删除一律先申请：任务根内的删除同样要上报。目标不明确（通配符、没给目标）直接拒绝，
   * 无法说明删除目标就无法核对影响。
   */
  if (act === "delete") return deleteGate(guardBase(ctx, event, hook, offline), cmd);

  const local = localCheck(ctx.policy, ctx.root, extractLocalPaths(cmd, ctx.root), act, skillExtra(ctx.root));
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
      label: "访问本机禁区",
      evidence: cmd,
      decision: "BLOCK",
      kind: "local",
    });
    return hook.deny(
      `【本机边界拦截】这条命令要访问的位置不允许：${why}\n` +
        "敏感区一律拒绝访问。需要访问其他范围时，先按本单说明【六、受阻时如何申报】提交申请，由监工裁决。" +
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
      `${describeBlock(ctx.policy, gate, cmd)}${escalation(v.nth)}`,
      event.point,
      event.sessionId,
    );
  }

  if (localTightened === "justify") {
    return outsideGate(guardBase(ctx, event, hook, offline), local.hits.map((h) => h.path), act, event.tool);
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
        "说明拟执行的动作、影响范围与回滚方式，等待用户答复；未获授权不得执行。" +
        escalation(v.nth),
      event.point,
      event.sessionId,
    );
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
 * 文件锁守卫：执行前获取锁、写前校验版本。
 *
 * 挂在 on_action 上，这是唯一能在执行前拦住的位置。行为分三种：
 *
 *   读：只登记“谁在哪个版本读的”（默认不加锁，多读天然并发）；
 *   写：获取排他锁，并校验所读版本是否仍为当前版本；
 *   人（没有 CAPITALIST_WORKER_ID）：不参与锁，否则会阻断用户自身的操作。
 *
 * 被拒时给的是可执行的三步，不是“失败了”，worker 是通用 agent，它需要知道
 * 明确下一步动作才不会无限等待（用户曾明确提过“否则会无限等待”）。
 */
function guardFileLock(
  hook: HookFacet,
  event: UnifiedEvent,
  ctx: Ctx,
  paths: string[],
  act: ActionKind,
): { code: number; stdout?: string | undefined } {
  const cfg = lockCfg(ctx.policy);
  const holder = process.env.CAPITALIST_WORKER_ID ?? "";
  const mode = act === "write" ? "write" : "read";

  if (!holder) {
    /* 用户手工输入的命令 / 看板会话：读要留版本痕迹，以便 worker 知晓所读内容已被修改。 */
    if (mode === "read") for (const p of paths) noteRead(ctx.root, "user", p);
    return hook.passthrough();
  }

  if (mode === "read") {
    for (const p of paths) noteRead(ctx.root, holder, p);
    if (!cfg.enabled || !cfg.strictRead) return hook.passthrough();
  } else if (!cfg.enabled) {
    return hook.passthrough();
  }

  /* 排序后依次申请：两个 worker 哪怕目标集合相同，获取锁的顺序也一致，不会形成反向持有的环。 */
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
    /* 记录读取失败时取 0，落盘时会回落到 hook 进程号 */
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
      const who = r.holder || "其他进程";
      recordEvent(ctx, event, { lock: "denied", mode, path: p, holder: who, ahead: r.ahead ?? 0 });
      return hook.deny(
        [
          `【文件锁】${p} 当前被 ${who} 持有${mode === "write" ? "写锁" : "读锁"}，等待 ${cfg.waitMs}ms 未获锁，前方等待 ${r.ahead ?? 0} 个。`,
          "",
          "不要无限等待，也不要反复重试同一个调用：",
          "  1) 先做与该文件无关的工作（修改其他文件、运行测试）；",
          "  2) 若仅剩此一项待处理，间隔一段时间后重试一次；",
          `  3) 持续无法获取时，capitalist ask "${p} 被 ${who} 长期占用" 登记后停止执行，等待监工裁决。`,
        ].join("\n"),
        event.point,
        event.sessionId,
      );
    }
    got.push(p);
  }

  /*
   * 写之前校验版本，且必须放在获取锁之后：等锁期间，上一个持有者可能已经改动目标，此时写入会用旧内容覆盖新改动，需要拦截。
   */
  if (mode === "write") {
    for (const p of ordered) {
      const st = checkStale(ctx.root, holder, p);
      if (!st.stale) continue;
      releaseGot();
      recordEvent(ctx, event, { lock: "stale", path: p, by: st.by ?? "" });
      return hook.deny(
        [
          `【文件已被改】${p} 在读取之后被${st.by ? ` ${st.by} ` : "他人"}修改。`,
          st.why ? `· ${st.why}` : "",
          "",
          "请重新读取该文件，基于最新内容修改；避免以旧内容覆盖他人改动。",
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

/** 拦截编排需要的最小环境。 */
function guardBase(ctx: Ctx, event: UnifiedEvent, hook: HookFacet, offline: boolean): GuardBase {
  return {
    hook,
    event,
    root: ctx.root,
    policy: ctx.policy,
    offline,
    violate: (a) => recordViolation(ctx, event, { ...a, kind: "local" }),
  };
}

/**
 * 只读白名单的技能根。
 *
 * 技能分散在各宿主配置目录下（`.claude` / `.codebuddy` / `.workbuddy`），路径随宿主与安装
 * 位置变化，所以按分类判定：落在任一宿主的技能目录、或插件缓存里的技能包内，就按资料读取处理。
 */
function skillExtra(root: string): LocalCheckExtra {
  const r = skillAllowRoots(root);
  return { skillRoots: r.skills, skillCacheRoots: r.cache };
}

function judgeLocal(
  hook: HookFacet,
  event: UnifiedEvent,
  ctx: Ctx,
  paths: string[],
  act: ActionKind,
  offline: boolean,
): HookDecision {
  const local = localCheck(ctx.policy, ctx.root, paths, act, skillExtra(ctx.root));
  const decision: LocalDecision = tightenLocal(ctx.mode, local.decision, act, decide);
  if (decision === "allow") return hook.passthrough();

  if (decision === "deny") {
    const why = local.hits.map((h) => `${h.path}（${h.why}）`).join("；");
    const v = recordViolation(ctx, event, {
      rule: `LOCAL-${act.toUpperCase()}`,
      label: "访问本机禁区",
      evidence: why,
      decision: "BLOCK",
      kind: "local",
    });
    const modeNote =
      local.decision !== "deny" ? `\n（当前档位 ${ctx.mode} 收紧了这一动作，规则原判为放行）` : "";
    return hook.deny(
      `【本机边界拦截】${event.tool} 要访问的位置不允许：${why}${modeNote}\n` +
        "敏感信息（密钥/凭据/浏览器数据/个人文档/系统目录）一律不得访问；删除不得超出任务根。" +
        escalation(v.nth),
      event.point,
      event.sessionId,
    );
  }

  return outsideGate(guardBase(ctx, event, hook, offline), local.hits.map((h) => h.path), act, event.tool);
}

/** 组装拦截文案。档位收紧导致的拒绝与规则禁止分开标注。 */
function describeBlock(policy: Policy, gate: GateResult, cmd: string): string {
  const hit = gate.hits.filter((h) => !h.defer);
  const head = hit.map((h) => `[${h.id}] ${h.label}`).join("\n");
  const fix = hit
    .map((h) => h.fix || policy.redlines.find((r) => r.id === h.id)?.fix || "")
    .filter(Boolean)
    .join("\n");
  return (
    `【红线拦截】\n${head}\n命中：…${hit[0]?.snippet ?? cmd.slice(0, 80)}…\n` +
    (fix ? `正确做法：${fix}\n` : "") +
    "请改用不越界的路径；如有不确定项，用 capitalist ask 登记问题，由监工裁决。"
  );
}

/** on_idle / on_start：注入简报。工作进程分支同时续写心跳。 */
function onIdle(hook: HookFacet, event: UnifiedEvent, ctx: Ctx): HookDecision {
  const lang = pickLang(event.prompt);

  const wid = workerId();
  if (wid) {
    // 工作进程的存活由监工按心跳判定，不续写心跳时长任务会被当作失效进程回收。
    touchWorker(ctx.root, wid, { status: "running" });
    /*
     * 工作进程上下文只含“这一单”，不注入全局简报。全局任务树状态、门槛、下一步属于监工视角，
     * 注入工作进程会与派单正文里的任务说明混杂，形成“上面是监工、下面又是工作进程”的杂糅。
     * 派单正文由 worker 启动 argv 的 buildPrompt 生成，与本处注入互不相干。
     *
     * 身份标头只报派单号、不报进程号：进程号是实现细节，报给工作进程会让它在回复里复述，
     * 用户看到的应是派单号。
     */
    const dno = process.env.CAPITALIST_DISPATCH_ID ?? "";
    const dlabel = dno ? `派单 ${dno}` : "";
    return hook.inject(
      `${
        lang === "zh"
          ? `【capitalist${dlabel ? ` | ${dlabel}` : ""}】（监工已派单；仅执行本单，完成后执行 capitalist report）`
          : `【capitalist${dlabel ? ` | ${dlabel}` : ""}】(dispatched; do only this task, run \`capitalist report\` when done)`
      }\n${THINK_LANG[lang]}`,
      event.point,
      event.sessionId,
    );
  }

  const brief = buildBrief({
    root: ctx.root,
    state: ctx.state,
    policy: ctx.policy,
    mode: ctx.mode,
    lang,
  });
  return hook.inject(`${INJECT_HEAD[lang]}\n${brief}\n\n${INJECT_RULES[lang]}`, event.point, event.sessionId);
}

function workerId(): string {
  return process.env.CAPITALIST_WORKER_ID ?? "";
}

/**
 * 当前会话之外是否有监工在运行，且存在存活的工作进程。
 *
 * 两个条件同时成立时，本会话按监控方处理，收工闸放行。收工闸只约束执行侧。
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
 *   1. 有未裁决的提问，合法停顿，放行
 *   2. 登记阻塞，合法停顿，放行
 *   3. 同一问题第 3 次：拦截
 *   4. 其余放行
 *
 * 收工本身由工作进程的 `capitalist report` 决定，这里只判“停下是否说得通”。
 */
function onStop(hook: HookFacet, event: UnifiedEvent, ctx: Ctx): HookDecision {
  // 工作进程的结束由它自己的 `capitalist report` 决定。
  if (workerId()) return hook.passthrough();

  // 监工在运行且有存活的工作进程时，本会话按监控方处理。收工闸只约束执行侧。
  if (executionElsewhere(ctx.root)) return hook.passthrough();

  const cur = currentSession(ctx.root, event.sessionId);
  if (cur?.retired) return hook.passthrough();

  const openAsks = readJsonl<Record<string, unknown>>(
    join(supervisorDir(ctx.root), "inbox", "qa.jsonl"),
  ).filter((q) => q.type === "ask" && q.status === "open");
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
        "  2) 监工裁决放行并确认已改正后：capitalist correct --rule <规则>\n" +
        "继续执行只会让同一问题反复出现。",
      event.point,
      event.sessionId,
    );
  }

  return hook.passthrough();
}

/** 入口。异常一律放行，并把降级写进事件台账。 */
export function dispatch(hook: HookFacet, event: UnifiedEvent): HookDecision {
  try {
    /*
     * 只接管监工拉起的进程：工作进程由 worker.ts 注入 CAPITALIST_WORKER_ID，
     * 用户自己开启的会话没有这个变量。
     *
     * 这道判断排在“监工是否在线”之前。监工可能正在运行，但用户在同一个仓库里用自己的会话
     * 执行命令时，不该被边界检查要求登记理由。理由是为工作进程保留记录的，人的操作没有
     * 执行者会读这份理由。没有这道判断，仓库里常驻的 hook 会把每个会话都当成受管进程，
     * 这也是“没开监工也在登记理由”的来源（残留的 supervisor.json 会被判为在线）。
     */
    if (!process.env.CAPITALIST_WORKER_ID) return hook.passthrough();

    /*
     * 监工不在线时仍要判动作类事件：工作进程由监工拉起，已经脱离宿主沙箱，越界与删除
     * 只能靠这一层拦。判定所需的守卫与任务状态仍在任务根里，读得到。
     *
     * 其余事件不接管：没有监工就没有派单、没有待裁决，注入简报也无从执行。
     */
    const watchRoot = findRoot(event.cwd);
    const offline = Boolean(watchRoot && !isSupervisorAlive(watchRoot));
    if (offline && event.point !== "on_action") return hook.passthrough();

    let ctx = loadCtx(event);

    // 未纳管目录：注入类事件先尝试自动纳管，再决定是否输出未纳管提示。
    if (!ctx && (event.point === "on_idle" || event.point === "on_start")) {
      if (autoAdopt(event.cwd, loadWatchRules(watchConfigPath()), skillDirs())) ctx = loadCtx(event);
    }

    if (!ctx) {
      // 只有注入类事件给提示。动作类事件放行：没有任务根就没有可判定的守卫。
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
        return onAction(hook, event, ctx, offline);
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
