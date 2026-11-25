/**
 * 越界与删除申请的裁决。
 *
 * 由监工的判定通道完成，不用规则表：同一请求在不同派单里影响不同，是否可执行取决于
 * 当前目标、影响面与有无替代做法，这些只有读懂上下文才能判断。
 *
 * 模型不可用或输出无法解析时转用户裁决，不默认批准。
 */

import { existsSync } from "node:fs";

import { appendDirective } from "../../core/dispatch/commands";
import { appendAsk } from "../../core/dispatch/inbox";
import {
  appendDecision,
  readGuardRequests,
  reasonedGuardRequests,
  type GuardRequest,
} from "../../core/guard/requests";
import { normLocal } from "../../core/guard/localGuard";
import { isInside } from "../../core/record/paths";
import { loadSupervisor, readDispatches } from "../../core/record/supervisor";
import { askModel } from "../channel/llm";
import { parseActions } from "../judge/brain";
import { brainSessionOf } from "../judge/brainLane";
import { supervisorModelOf } from "../judge/supervisorModel";

/** 每轮最多裁决几条：模型调用是分钟级，积压时按先后顺序逐轮消化。 */
const MAX_PER_TICK = 2;

/** 动作名。 */
const ACTIONS = ["allow", "deny", "escalate"] as const;

/** 裁决所需的事实。路径只写位置与存在性，不含文件内容。 */
function factsOf(root: string, rec: GuardRequest): string[] {
  const rootNorm = normLocal(root);
  const dispatch = readDispatches(root).find((d) => d.id === rec.dispatch);
  const paths = rec.paths.map((p) => {
    const np = normLocal(p, root);
    const where = isInside(np, rootNorm) ? "任务根内" : "任务根外";
    return `${p}（${where}，${existsSync(np) ? "存在" : "不存在"}）`;
  });
  const sameKind = readGuardRequests(root)
    .filter((r) => r.id !== rec.id && r.kind === rec.kind && r.status !== "open" && r.decidedTs > 0)
    .slice(-3)
    .map((r) => `${r.paths.join("、")}：${r.status === "allowed" ? "批准" : "拒绝"}（${r.why || "未写理由"}）`);

  return [
    `操作类型：${rec.kind === "delete" ? "删除" : "任务根外访问"}，动作 ${rec.action}，工具 ${rec.tool}`,
    `目标：${paths.join("；") || "（未记录）"}`,
    `命令：${rec.command || "（文件工具，无命令）"}`,
    `申请理由：${rec.reason || "（未补充）"}`,
    `工作进程：${rec.worker || "未知"}；派单：${rec.dispatch || "无"}`,
    dispatch ? `派单目标：${String(dispatch.action ?? "").slice(0, 300)}` : "派单目标：无记录",
    dispatch ? `所属分片：${String(dispatch.shard ?? "").trim() || "（未划分片）"}` : "",
    `同类申请最近结论：${sameKind.length > 0 ? sameKind.join("；") : "无"}`,
  ];
}

/** 提示词。判断口径写在前面，输出格式与判定层其它调用一致。 */
function buildPrompt(facts: string[]): string {
  return [
    "你是 capitalist 的权限裁决者。一个工作进程请求在任务根外操作，或删除文件，需要你判断是否批准。",
    "",
    "【事实】",
    ...facts.map((f) => `- ${f}`),
    "",
    "【判断依据】",
    "1. 这次操作是否服务于当前派单的目标。与目标无关的访问不批准。",
    "2. 影响是否可逆。删除、覆盖、写入系统目录这类不可逆操作从严。",
    "3. 有没有不越界就能完成的替代做法。存在替代做法即拒绝并写出做法。",
    "4. 凭据只看用途是否成立，不要求对方提供内容；用途不成立时拒绝。",
    "5. 无法判定时转给用户，不要默认批准。",
    "",
    "【输出。三选一写一条 DO 动作，最后一行写 WHY 理由】",
    "  DO allow",
    "  DO deny <替代做法，没有则留空>",
    "  DO escalate <要问用户的一句话>",
    "  WHY <一句话>",
  ].join("\n");
}

/**
 * 通知工作进程。
 *
 * 批准与拒绝都要写明下一步，否则它会重复触发同一条命令。裁决来自监工或用户时
 * 走同一份实现，避免两处拼出不同的措辞。
 */
export function notifyWorker(
  root: string,
  target: { worker: string; dispatch: string; paths: string[] },
  text: string,
): void {
  const dispatch = readDispatches(root).find((d) => d.id === target.dispatch);
  appendDirective(root, {
    text,
    shard: dispatch?.shard ?? null,
    ...(target.dispatch ? { lineage: target.dispatch } : {}),
    ...(target.dispatch || target.worker ? { target: target.dispatch || target.worker } : {}),
    via: "capitalist",
    /* 权限通知发给工作进程，界面按转告口吻显示。 */
    audience: "worker",
  });
}

/** 转用户裁决：写进待裁决队列，工作进程停手等回答。 */
function escalateToUser(root: string, rec: GuardRequest, question: string, why: string): string {
  const dispatch = readDispatches(root).find((d) => d.id === rec.dispatch);
  return appendAsk(
    root,
    question || `是否允许这次操作：${rec.paths.join("、")}`,
    [
      `申请：${rec.id}`,
      `动作：${rec.kind === "delete" ? "删除" : "任务根外访问"}（${rec.action}）`,
      `目标：${rec.paths.join("、")}`,
      `理由：${rec.reason}`,
      `命令：${rec.command}`,
      why ? `监工判断：${why}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    dispatch?.shard ?? "",
  );
}

/**
 * 裁决一条申请。
 *
 * @returns 是否写下了裁决。
 */
async function judgeOne(
  root: string,
  rec: GuardRequest,
  out: (line: string) => void,
): Promise<boolean> {
  const facts = factsOf(root, rec).filter(Boolean);
  const lane = brainSessionOf(root, "guard");
  const r = await askModel({
    prompt: buildPrompt(facts),
    sessionId: lane.id,
    cwd: root,
    effort: "high",
    model: supervisorModelOf(root),
  });

  const parsed = r.ok ? parseActions(r.text ?? "", ACTIONS) : null;
  const picked = parsed?.actions[0];

  if (!picked) {
    /* 通道不可用或输出不合格式：不作猜测，交用户裁决。 */
    const why = r.ok ? "监工判定输出无法解析" : String(r.text ?? "判定通道不可用").slice(0, 200);
    const ask = escalateToUser(root, rec, "", why);
    appendDecision(root, rec.id, "escalate", "supervisor", why, "", ask);
    out(`[监工] 权限申请 ${rec.id} 转用户裁决：${why}`);
    return true;
  }

  const why = parsed?.why || "";
  if (picked.name === "allow") {
    appendDecision(root, rec.id, "allow", "supervisor", why);
    notifyWorker(
      root,
      { worker: rec.worker, dispatch: rec.dispatch, paths: rec.paths },
      `【权限已批准】${rec.paths.join("、")}\n按原命令重试。${why ? `\n理由：${why}` : ""}`,
    );
    out(`[监工] 权限申请 ${rec.id} 批准：${rec.paths.join("、")}`);
    return true;
  }

  if (picked.name === "deny") {
    const alternative = picked.arg.trim();
    appendDecision(root, rec.id, "deny", "supervisor", why, alternative);
    notifyWorker(
      root,
      { worker: rec.worker, dispatch: rec.dispatch, paths: rec.paths },
      [
        `【权限被拒】${rec.paths.join("、")}`,
        why ? `理由：${why}` : "",
        alternative ? `改用这个做法：${alternative}` : "没有可替代的做法时，停止操作等待用户裁决。",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    out(`[监工] 权限申请 ${rec.id} 拒绝${alternative ? `，建议：${alternative}` : ""}`);
    return true;
  }

  const question = picked.arg.trim();
  const ask = escalateToUser(root, rec, question, why);
  appendDecision(root, rec.id, "escalate", "supervisor", why, "", ask);
  out(`[监工] 权限申请 ${rec.id} 转用户裁决${question ? `：${question}` : ""}`);
  return true;
}

/**
 * 处理本轮可裁决的申请。
 *
 * 只处理已补充理由的：没有理由时无从判断用途，等待其补充。
 *
 * @returns 本轮裁决条数。
 */
export async function judgeGuardRequests(args: {
  root: string;
  out: (line: string) => void;
  max?: number;
}): Promise<number> {
  const pending = reasonedGuardRequests(args.root).slice(0, args.max ?? MAX_PER_TICK);
  let done = 0;
  for (const rec of pending) {
    try {
      if (await judgeOne(args.root, rec, args.out)) done += 1;
    } catch (err) {
      /* 单条失败不阻断其它条；下一轮重试，不写裁决。 */
      args.out(`[监工] 权限申请 ${rec.id} 裁决失败：${String((err as Error).message ?? err)}`);
    }
  }
  return done;
}
