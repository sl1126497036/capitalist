/**
 * 工作进程的启动器：按宿主适配启动命令，参数由各 impl 的 WorkerFacet 给出，本文件只负责进程编排。
 *
 * 工作进程有独立 pid、会话与上下文，执行与验收分属不同进程。
 *
 * 宿主的会话环境变量原样继承会占用其 HTTP 端口，按 impl 声明的规则剔除；Windows 的 `.cmd` shim 需经 shell 启动，prompt 与目录信任确认共用 stdin。
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import {
  type Dispatch,
  type WorkerRecord,
  listWorkers,
  loadWorker,
  newWorkerId,
  pidAlive,
  readDispatches,
  registerWorker,
  saveWorker,
  touchWorker,
  workerLogPath,
} from "../../core/record/supervisor";
import { handoffLines, lastSettledOf, squashOutcome } from "../../core/record/outcome";
import { workers as workersLoc } from "../../core/record/locations";
import type { HostImpl, WorkerSession } from "../../agent/contract";
import { byId, currentHost, siblings, workerByKey, workerHosts } from "../../agent/registry";
import { laneOfWorker, pickLane } from "../judge/sessionLane";
import { closeOutRules } from "../judge/closeOut";
import { listSkills } from "../skills";

export { listSkills };
import { buildPreflightBlock, hasPreflight, preflightAtOf } from "./preflight";
import { bindAttachments } from "../../core/message/attachments";

/**
 * 工作进程宿主的取值集合，由各 impl 的 `WorkerFacet.key` 决定。
 *
 * 取值写入 `.capitalist/workers/<id>/record.json` 与监工记录，属历史兼容面：只增不改，旧任务根里
 * 的取值要能被读回。命令行不暴露该取值，由宿主环境判定。
 */
export type WorkerHost = string;

/** 启动工作进程的入参。 */
export interface LaunchOptions {
  root: string;
  target: string;
  host: WorkerHost;
  dispatch: Dispatch;
  /** 显式指定可执行文件，跳过 PATH 探测 */
  bin?: string;
  /** 由监工预先分配，便于领单与启动失败时对账 */
  id?: string;
  /** 透传给宿主的模型名。不指定就用宿主自己的默认配置。 */
  model?: string | undefined;
  /** 推理强度；不指定时用宿主默认。 */
  effort?: string | undefined;
  /** 自定义启动命令模板（含 {prompt}）。给了就不按 host 拼参数。 */
  cmd?: string | undefined;
  /**
   * 宿主登录态中的访问令牌。
   *
   * 只用于写进子进程环境，变量名由 impl 的 `authEnvVar` 声明；不写日志、不写工作进程记录。
   * 缺省不传表示沿用宿主登录态。
   */
  token?: string | undefined;
}


/**
 * 启动结果。
 *
 * `record` 是刚登记的工作进程记录；`child` 为可见窗口模式时为 null。
 */
export interface Launched {
  record: WorkerRecord;
  /** 可见窗口模式不持有工作进程句柄，为 null。 */
  child: ChildProcess | null;
}

/**
 * 按“当前宿主的族”探测可用工作进程宿主。
 *
 * 监工运行于宿主进程内，工作进程必须与宿主同族：同族共用客户端登录态，跨族会借用另一个
 * 产品线的账号。判定不出当前宿主时（纯命令行环境）才退回按 `detectPriority` 选取，
 * 此时没有宿主登录态可用，仅依据 CLI 是否存在判定。
 *
 * 桌面端外壳类宿主不声明 `detectPriority`，没有可靠的非交互入口，探测会得到无响应的
 * 进程；此类宿主由同族 CLI 承担工作进程，不接受命令行指定。
 */
export function detectWorkerHost(): WorkerHost | null {
  const current = currentHost();
  if (!current) {
    for (const impl of workerHosts()) {
      if (impl.worker?.detectPriority === undefined) continue;
      if (findBin(impl.worker.key)) return impl.worker.key;
    }
    return null;
  }

  const self = byId(current);
  const candidates = [
    // 当前宿主具备非交互入口时优先，避免由同族实现承担工作进程时改变行为。
    ...(self?.worker?.detectPriority !== undefined ? [self] : []),
    ...siblings(current),
  ];
  for (const impl of candidates) {
    if (impl.worker?.detectPriority === undefined) continue;
    if (findBin(impl.worker.key)) return impl.worker.key;
  }
  return null;
}

/** 取工作进程宿主取值对应的 impl；`custom` 与未知取值都返回 null。 */
export function workerImpl(host: WorkerHost): HostImpl | null {
  return workerByKey(host);
}

/** 在 PATH 上查找宿主可执行文件；`CAPITALIST_WORKER_BIN` 优先，找不到返回 null。 */
export function findBin(host: WorkerHost): string | null {
  const override = process.env.CAPITALIST_WORKER_BIN;
  if (override) return override;

  const impl = workerImpl(host);
  const names = impl ? impl.worker?.binNames(process.platform) ?? [] : [host];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * 宿主注入、不传给工作进程的变量前缀，由各 impl 的 `worker.envDropPrefixes` 汇总，`CAPITALIST_` 为框架自身前缀。
 * 前缀剔除只适用于整个命名空间都属于宿主会话的变量。
 */
export function envDropPrefixes(): string[] {
  const own = new Set(["CAPITALIST_"]);
  for (const impl of workerHosts()) {
    for (const p of impl.worker?.envDropPrefixes ?? []) own.add(p.toUpperCase());
  }
  return [...own];
}

/** 按完整名剔除的变量，由各 impl 的 `worker.envDropNames` 汇总。 */
export function envDropNames(): Set<string> {
  const own = new Set<string>();
  /* 宿主注入的本地代理会使宿主 CLI 在 setProxy 崩溃，须按完整名剔除。 */
  for (const n of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) own.add(n);
  for (const impl of workerHosts()) {
    for (const n of impl.worker?.envDropNames ?? []) own.add(n.toUpperCase());
  }
  return own;
}

/** 变量名是否命中宿主会话的剔除规则。 */
function isDropped(name: string): boolean {
  const up = name.toUpperCase();
  if (envDropNames().has(up)) return true;
  return envDropPrefixes().some((p) => up.startsWith(p));
}

/**
 * 工作进程继承监工会话的整份环境，再剔除宿主会话标记；剔除规则由 impl 按语义声明。
 * 只透传一组固定的系统变量会削掉 CLI 自身的配置项，使进程无会话输出。
 */
export function workerEnv(extra?: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string" || v === "") continue;
    if (isDropped(k)) continue;
    /* 宿主令牌仅以宿主声明的认证变量名出现在子进程中，该内部传递变量不传递给下游进程。 */
    if (k === "CAPITALIST_HOST_TOKEN") continue;
    env[k] = v;
  }

  // 把宿主 node 的 bin 目录前置到 PATH：工作进程靠 `capitalist report / ask / block` 回写结果，capitalist 与 node 同目录。
  const nodeDir = dirname(process.execPath);
  if (nodeDir) {
    env.PATH = env.PATH ? `${nodeDir}${delimiter}${env.PATH}` : nodeDir;
  }

  for (const [k, v] of Object.entries(extra ?? {})) {
    if (typeof v === "string" && v !== "") env[k] = v;
  }
  return env;
}

/** 被剔除的宿主变量名，写入工作进程日志供追溯（不含值）。 */
export function droppedHostEnv(): string[] {
  return Object.keys(process.env).filter(isDropped).sort();
}


/** 组装启动参数（prompt 走 argv）；宿主差异收敛在 impl 的 `WorkerFacet`。 */
export function buildArgs(
  host: WorkerHost,
  prompt: string,
  model?: string,
  session?: WorkerSession,
  effort?: string,
): string[] {
  const facet = workerImpl(host)?.worker;
  if (!facet) return [prompt]; // custom：参数只有 prompt，入口由调用方给出
  return facet.argv({
    prompt,
    ...(model ? { model } : {}),
    ...(session ? { session } : {}),
    ...(effort ? { effort } : {}),
  });
}

/**
 * 同 `buildArgs`，但 prompt 由 stdin 送入；仅在 impl 显式声明 `preferStdin` 时启用。
 * 返回 null 表示宿主不走管道或管道语义未确认，由调用方回落到 argv。
 */
export function buildArgsStdin(
  host: WorkerHost,
  model?: string,
  session?: WorkerSession,
  effort?: string,
): string[] | null {
  const facet = workerImpl(host)?.worker;
  if (!facet?.argvStdin || !facet.preferStdin) return null;
  return facet.argvStdin({ ...(model ? { model } : {}), ...(session ? { session } : {}), ...(effort ? { effort } : {}) });
}

/** 可执行文件是否必须经 shell 才能 spawn（Windows 批处理 shim 等）。 */
export function needsShell(bin: string, host?: WorkerHost): boolean {
  const facet = host ? workerImpl(host)?.worker : undefined;
  return facet?.needsShell?.(bin, process.platform) ?? (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin));
}


/**
 * 把 `--worker-cmd` 模板拆成 argv：先按空白拆分再替换 `{prompt}`，否则含空格与换行的 prompt 会被拆成多个参数。
 * 不经 shell，避免把 prompt 内容当命令执行。
 */
export function parseWorkerCmd(tpl: string, prompt: string): { bin: string; args: string[] } {
  const unquote = (s: string): string => s.replace(/^["']/, "").replace(/["']$/, "");
  const parts = tpl.trim().split(/\s+/).map(unquote);
  const bin = parts[0] ?? "";
  return { bin, args: parts.slice(1).map((p) => p.replace("{prompt}", prompt)) };
}

/**
 * 派单说明只写这一单的边界，不写领域手法；`adopt` / `supervise` 会改流程状态，禁止出现在派单说明里。
 * 派单标题随 `dispatch` 原样带入 prompt，工作进程不解析。
 */
/**
 * 判定这一单是否续接上一次会话；会话 id 按分片或派生链派生并固定，监工或机器重启都不影响续接。
 * 宿主用 `--resume <id>` 续接会话。
 */
export function resolveSession(root: string, dispatch: Dispatch): WorkerSession {
  /* 会话身份与占用判定交给 `sessionLane`，这里只判定当前会话是否被占用：同一会话同时只允许一个进程续用，否则两条执行流会写乱同一份上下文。 */
  return pickLane(root, dispatch, (sessionId) =>
    listWorkers(root).some(
      (w) =>
        (w.status === "running" || w.status === "starting") &&
        laneOfWorker(w) === sessionId &&
        /*
         * `w.pid` 为 0 表示当时没有取到 pid。旧实现直接调 `process.kill(0, 0)`，POSIX 下那会
         * 探测整个进程组且恒返回成功，把“没取到 pid”当成“还在运行”，长期占用会话；
         * 现在按不存在处理，会话可以正常复用。
         */
        (w.mode === "visible" || pidAlive(w.pid)),
    ),
  );
}

/**
 * 派单正文之外拼接的追加段：用户插话与验收清单，发车前按固定标题写入 action 末尾。
 * 续跑提示词只重发追加段：正文已在会话上下文里（指纹按正文计算，见 `sessionLane`），重发会让工作进程重复已完成的工作，而追加段在会话里不存在。
 */
/**
 * action 中续跑必须重发的追加段标记。前两个为用户插话与验收清单，不属于任务正文。
 * 第三个兼容旧台账中把卡点拼在 action 末尾的记录；新单的卡点走 `retry_context` 字段。
 * 第二个只取前缀：完整 `BLOCKER_MARKER` 定义在下方，此处引用会触发 TDZ。
 */
export const ACTION_TAIL_MARKERS = [
  "\n\n【用户插话 · 只对本次派单生效】",
  "\n\n【验收清单",
  "\n\n【上一轮卡点",
];

export function actionTail(action: string): string {
  let at = -1;
  for (const m of ACTION_TAIL_MARKERS) {
    const i = action.indexOf(m);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  return at < 0 ? "" : action.slice(at);
}

/**
 * 重派与续跑共用的卡点段：旧正文原样重发，仅在末尾追加一条不超过 {@link BLOCKER_MAX_CHARS} 字的短消息。
 * 两处入口共用同一成文函数，口径一致。
 */
export const BLOCKER_MARKER = "【上一轮卡点，不是新要求，无需重做】";
/** 追加段字数上限。 */
export const BLOCKER_MAX_CHARS = 300;

/** 上一轮留下的痕迹。三个字段分别来自失败自报、判定理由、上报/审阅记录。 */
export interface BlockerInfo {
  /** 该单自报的失败原因（`capitalist report … failed --note`）。 */
  note?: string;
  /** 监工对这条链“还能不能试”的判断理由（`retry_why`）。 */
  retry_why?: string;
  /** 上报或审阅留下的记录（`review_note`）。 */
  review_note?: string;
}

/**
 * 把台账上的一张单压成卡点素材。
 * 取不到原因时返回空对象，由 {@link buildSkipBlocker} 写成“上一轮未记录失败原因”，让工作进程先复现再开始修改。
 */
export function blockerInfoOf(d: Partial<Dispatch> | undefined | null): BlockerInfo {
  if (!d) return {};
  return {
    note: squashOutcome(d.note, 400),
    retry_why: squashOutcome(d.retry_why, 400),
    review_note: squashOutcome(d.review_note, 400),
  };
}

/**
 * 取同一条链上一张失败单的卡点素材；没有失败前身时返回 null。
 * 先按派生链查找，重派建单会写入新的 `lineage` 而接不上，故退回按分片匹配。
 */
export function findPreviousBlocker(
  root: string,
  cur: { id?: string | undefined; shard?: string | undefined; lineage?: string | undefined },
): BlockerInfo | null {
  const chain = String(cur.lineage ?? cur.id ?? "").trim();
  const shard = String(cur.shard ?? "").trim();
  let hit: Dispatch | undefined;
  for (const d of readDispatches(root)) {
    if (cur.id && d.id === cur.id) continue;
    if (d.status !== "failed") continue;
    const sameChain = chain !== "" && String(d.lineage ?? d.id) === chain;
    const sameShard = shard !== "" && String(d.shard ?? "") === shard;
    if (!sameChain && !sameShard) continue;
    hit = d;
  }
  return hit ? blockerInfoOf(hit) : null;
}

/** 卡点段正文（不含标题）；标题与段落渲染由 `appendSection` 统一负责，正文只写上一轮停下的原因与这次要避开的路径。 */
export function blockerLines(info?: BlockerInfo | null): string[] {
  const parts = [info?.retry_why, info?.note, info?.review_note]
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return ["上一轮未记录失败原因。须先复现一次，确认卡点位置后再修改；避免重复上一轮做法；已完成的产出物不重做。"];
  }
  const lead = "上一轮中止于：";
  const how = "不重复上一轮的路径：卡点仍在时改用其他可行路径；卡点已解除时从上次进度继续；已完成的产出物不重做。";
  const budget = Math.max(
    24,
    BLOCKER_MAX_CHARS - BLOCKER_MARKER.length - 1 - lead.length - how.length - 1,
  );
  return [`${lead}${squashOutcome(parts.join("；"), budget)}`, how];
}

/** 卡点段成文（标题 + 正文）。重派建单与发车提示词共用同一构造口。 */
export function buildSkipBlocker(info?: BlockerInfo | null): string {
  return `${BLOCKER_MARKER}\n${blockerLines(info).join("\n")}`;
}

/**
 * 派单上写好的卡点段（`retry_context` 字段，见 core/record/supervisor.ts 的字段说明），发车时由提示词拼接，不写入 action。
 * 写入 action 会改动会话指纹（`sessionLane` 按 action 计算），使重派换会话、丢失上下文；取不到返回空串。
 */
export function retryContextOf(d: Partial<Dispatch> | null | undefined): string {
  return String((d as { retry_context?: string } | null)?.retry_context ?? "").trim();
}

/**
 * 重派时的“本次验收”段，按上次未通过的项动态生成；卡点段走独立字段 `retry_context`，二者都不写进 action 以免改动会话指纹、断掉续接。
 * 卡点在重派建单时生成整段存入 `retry_context`，发车时由 `buildPrompt` / `buildResumePrompt` 拼进提示词（见 `retryContextOf`）。
 */
export function buildAcceptBlock(d: Dispatch): string[] {
  const accept = String((d as { retry_accept?: string }).retry_accept ?? "").trim();
  if (!accept) return [];
  return [
    "",
    "【本次验收】上一轮未通过项优先，其余按原验收清单，不降低标准",
    accept,
    "报告时逐条说明该项当前如何满足；未做到的如实说明，不写“已优化”这类无法核对的说法。",
    "核对方式按下面的结束口径：以产出物核对为准。",
  ];
}

/**
 * 本单验收判据段（`ACCEPTANCE:` 行随派单落盘）。
 *
 * 与 {@link buildAcceptBlock} 的分工：那一段是“上一轮打回的未通过项”，本段是“建单时声明的完成口径”。
 * 两者都在时先看未通过项，再看本单口径，最后才是通用结束口径。未声明时不占位。
 */
export function buildDispatchAcceptBlock(d: Dispatch): string[] {
  const acc = String((d as { acceptance?: string }).acceptance ?? "").trim();
  if (!acc) return [];
  return [
    "【本单验收判据】建单时声明，优先于下面的通用结束口径",
    acc,
    "  报告逐条对照本判据说明如何满足；写法无法核对的，按未完成处理。",
  ];
}

/** 结束口径正文在 `closeOut.ts`，与监工判定层共用一份，避免执行侧与审查侧出现两套标准；三个提示词入口都从本导出取用。 */
export function buildCloseOutRules(heading?: string): string[] {
  return closeOutRules(heading);
}

/**
 * “动手前先核对现状”约束，合并 `preflight.ts` 与本地的两份同义条目为一份五条。
 * `at` 可用时写入第 4 条供工作进程比较 mtime；修复单与续跑共用本导出。
 */
export function buildGroundingBlock(d?: { at?: string } | null, heading = "【二、动手前先核对现状】"): string[] {
  const at = preflightAtOf(d);
  return [
    heading,
    "  派单正文是建单时的快照，现状可能已变化。执行前依次核对：",
    "  1. 读本单作用对象的当前状态（文件、数据、页面、台账），同时了解相关上下文；",
    "     不把派单正文当独立任务执行。",
    "  2. 派单要求的事情若已完成，不要重做：在报告中指出已完成的位置与要求的差异；",
    "     只做了一半的只补缺，不整体重做。",
    "  3. 本单要求若与已验收的做法相反（要恢复一项已被撤销的做法），先读 `.capitalist/ledger/tasks.jsonl` 里",
    "     同一线程已结束任务的 `note`（裁决结论写着当时定的口径），按本单最新要求做，",
    "     并在报告里写明推翻了哪一条，不留两套并存的实现。",
    at
      ? `  4. 本单作用对象为文件时：文件的修改时间晚于本单创建时刻 ${at.iso}，按最新内容处理，不按旧快照覆盖。`
      : "  4. 本单作用对象为文件时：文件在本单创建之后被修改过，按最新内容处理，不按旧快照覆盖。",
    "  5. 现状与派单描述冲突、或读后无法对应：先用 capitalist ask / capitalist notify question 申报，不猜测处理。",
  ];
}

/** 边界段，首次派单与续跑共用一份，避免两条入口的边界不一致。 */
function buildBoundaryBlock(id: string): string[] {
  return [
    "【三、边界】",
    `  1. 仅执行本单：需要复查要求时读取 .capitalist/workers/${id}/brief.md；`,
    "     .capitalist/ledger/tasks.jsonl 只读本任务号的行（同一任务此前的结论），按本单派单号的 `任务号-` 前缀过滤，",
    "     不读其他任务的派单记录；不读 .capitalist/inbox/*.jsonl、其他 .capitalist/workers/* 或其他 brief。",
    "     其他进程的日志与报告不作为证据；不将其他任务的产出视为本单产出，本单未执行即视为未完成。",
    "  2. 本任务台账里 done / closed 的单属历史，非待办：按历史结论核对已修改的内容，",
    "     不按历史描述“恢复”或“实现”任何内容。产物现状以实际为准，不以截图、旧日志、旧派单正文为准；",
    "     历史描述与本单冲突时以本单为准，并在报告里写明冲突点。",
    "  3. 不执行 capitalist adopt / capitalist supervise，也不手动修改 .capitalist/ 下的文件。",
    "     那三项属于监工，工作进程代为执行会使执行与验收职责不分。",
    `  4. 因外部条件受阻（验证码、账号、授权）：capitalist block <类型> "<受阻原因>" 后停手。`,
    /*
     * 界面只发行任务号与派单号，进程号属于调度内部标识。此条为软约束：模型仍可能
     * 在叙述中包含编号，看板出口另设统一改写作为兜底（见 board/render 的
     * maskWorkerIds），两处配合，提示词不单独承担该约束。
     */
    "  5. 不提进程编号：报告、申报与插话中不写（形如 6-P1）。指代自身用“本进程”，",
    "     指代同一任务中先前那次执行用“上一轮进程”；标明归属时用任务号（#06）或派单号（#06-2）。",
  ];
}

/**
 * 申报与求助段，首次派单与续跑共用一份。`capitalist report` 只认派单 id，不认进程 id；brief 文件与进程记录用的是进程 id。
 */
function buildHelpBlock(dispatchId: string): string[] {
  return [
    "【六、受阻时如何申报】申报后继续执行剩余部分：",
    `  capitalist notify stuck "<受阻原因、已尝试的措施>"        同一件事连续失败两次、找不到执行入口、报错含义不明`,
    `  capitalist notify question "<问题>" --needs decision   要求自相矛盾、优先级不明、是否应执行不明`,
    `  capitalist notify risk "<为什么觉得越界>"               可能越界：删数据、改发布配置、修改他人负责的文件`,
    `  capitalist notify quality "<未落实的部分>"              可交付但质量不足，须先如实申报`,
    `  capitalist notify progress "<当前进度>"                 只是让监工知道进度，不需要回复`,
    "  监工会据此决定：继续、给出简要纠正、重开或转人工。",
    `  需人工裁决：使用 capitalist ask "<问题>" 后停止执行，等待监工回填。`,
    "",
    "【七、完成或失败】",
    `  完成：capitalist report ${dispatchId} done --note "<做了什么>" --evidence "<产出物在哪里 / 核对了什么 / 结果>"`,
    `  无法完成：capitalist report ${dispatchId} failed --note "<受阻原因>"`,
    `  执行期间收到用户追加消息、经判断属于本单的：在报告中附加 --added "<新增/更正了什么>"。`,
    `  这只是回报；要求是否成立由判定层确认，报告不改变本单要求。`,
  ];
}

/** “交付生效”约束：交付以派单要求的产出物为准；产出物是否需在某个运行环境生效、由谁重启或重载，均由派单指定。工作进程不自行重启或重载任何承载进程，也不因未重启判为未完成。 */
export function buildApplyBlock(): string[] {
  return [
    "【五、交付生效】交付以派单要求的产出物为准；产出物是否需在某个运行环境生效、由谁重启或重载，均由派单明确指定：",
    "  1. 派单指定重启或重载时，按其指定的对象与方式执行，并在收尾报告写明结果。",
    "  2. 派单未指定时，不自行重启或重载任何承载进程；收尾报告如实说明产出物已落盘、尚未重载。",
    "  3. 不预设任务根是代码项目；未重启或重载不作为未完成处理。",
  ];
}

/**
 * 派单在提示词里的抬头，例如 `派单 4-1（标题 盘点下所有含中文的文件）：`。
 *
 * 不写任务树坐标：工作进程只做这一单，它在树里的位置对它没有可执行含义。
 * 写进去的后果是它被复述回来。申报里出现“第一层第二个节点：…”，用户还得回头数树。
 * 分片则只在确有分片时写，它对应会话归属，是可执行信息。
 */
export function dispatchHead(d: Dispatch, title: string): string {
  const bits = [d.shard ? `分片 ${d.shard}` : "", title ? `标题 ${title}` : ""].filter(Boolean);
  return bits.length ? `派单 ${d.id}（${bits.join("，")}）：` : `派单 ${d.id}：`;
}

/**
 * 续跑提示词必须自包含：宿主换会话、上下文压缩或进程重启后仍可独立执行。
 * 本单要求原样重发，补上上一轮卡点与本次验收；只有“已改动文件无需重做”这类续跑语义依赖会话。
 */
export function buildResumePrompt(opts: { root: string; target: string; id: string; dispatch: Dispatch }): string {
  const d = opts.dispatch;
  const raw = String(d.action ?? "");
  /* 正文与追加段分开：追加段各自带标题，混在一起会使引导语与“不是新要求，无需重做”自相矛盾。 */
  const tailText = actionTail(raw);
  const fullTail = tailText.trim();
  const baseAction = (tailText ? raw.slice(0, raw.length - tailText.length) : raw).trim();
  const bAt = fullTail.indexOf(BLOCKER_MARKER);
  const tail = bAt >= 0 ? fullTail.slice(0, bAt).trim() : fullTail;
  /* 续跑与重派共用 `buildSkipBlocker`：优先取 `retry_context`，老台账沿用 action 尾部的卡点段，两者都无则从台账找上一张失败单。 */
  const blocker =
    bAt >= 0
      ? fullTail.slice(bAt).trim()
      : retryContextOf(d) ||
        buildSkipBlocker(
          findPreviousBlocker(opts.root, {
            id: d.id,
            shard: String(d.shard ?? ""),
            lineage: d.lineage,
          }),
        );
  const title = String((d as unknown as Record<string, unknown>).title ?? "").trim();
  const accept = buildAcceptBlock(d);
  /* 与首次派单同一套七块结构（见 buildPrompt 的说明），块内编号各自从 1 起。 */
  return [
    "继续上一次被中断的执行，无需从头重启。",
    "本提示词自包含：会话上下文丢失或压缩后，仍可凭以下正文与约束继续执行。",
    `任务根：${opts.root}`,
    `任务目标：${opts.target}`,
    `本单说明：.capitalist/workers/${opts.id}/brief.md（只有这一份属于你；不要读其他单的说明与台账）`,
    "",
    "【一、这一单要做什么】",
    "  （下面正文里若再出现【用户插话】【上一轮卡点】【上一轮已完成的部分】【本次验收】，都是这一块的子项，不是新的一节。）",
    `${dispatchHead(d, title)}这一单的要求原文如下，原样重发，不重写。`,
    baseAction || "（这一单没有留下正文，按下面的验收清单与卡点确定任务；无法判断时使用 capitalist ask。）",
    "继续完成剩余部分；已完成的产出物不重做，开始前先核对当前状态。",
    ...(tail
      ? [
          "",
          "本次启动前用户追加了要求或未完成的验收项，原文如下，优先执行：",
          tail,
        ]
      : []),
    ...(blocker ? ["", blocker] : []),
    ...(accept.length ? ["", ...accept.slice(1)] : []),
    "",
    /* 续跑同样要核对现状：中断期间文件可能已被改动，按本单 `at` 给工作进程一个比较 mtime 的时刻。 */
    ...(hasPreflight(raw) ? [] : [...buildGroundingBlock(d), ""]),
    ...buildBoundaryBlock(opts.id),
    "",
    ...buildDispatchAcceptBlock(d),
    ...buildCloseOutRules(),
    "",
    ...buildApplyBlock(),
    "",
    ...buildHelpBlock(d.id),
  ].join("\n");
}

/**
 * 诊断 / 修复进程的派单说明，与业务单分两套提示词：两者职责几乎不重叠，混写会使模型无法兼顾两者。
 */
function buildRepairPrompt(opts: { root: string; target: string; id: string; dispatch: Dispatch }, role: string): string {
  const d = opts.dispatch;
  const readonly = role === "diagnose";
  /* 卡点只取正文：`action` 尾部可能附有业务单的追加段，原样并入【一、卡点】会把卡点变成一整段需求，故尾部单独列出并标明身份。 */
  const rawAction = String(d.action ?? "");
  const tailText = actionTail(rawAction);
  const baseAction = (tailText ? rawAction.slice(0, rawAction.length - tailText.length) : rawAction).trim();
  const extra = tailText.trim();
  /* 块序随角色变化：诊断进程只读，没有“核对现状”一步，后续序号整体前移一位，由变量计算。 */
  const CN = ["一", "二", "三", "四", "五", "六", "七", "八"];
  /** “怎么查”的序号：诊断=3、修复=4。 */
  const n = readonly ? 3 : 4;
  /* 与业务单同一套块序：卡点 -> 只做一件事 -> 核对现状 -> 怎么查 -> 边界 -> 算做完 -> 收尾。 */
  return [
    `你是${readonly ? "诊断进程" : "修复进程"}，不是业务执行进程。`,
    `任务根：${opts.root}`,
    ``,
    `【一、卡点】`,
    baseAction || "（这一单没有留下卡点描述；按下面“只做一件事”的范围自行定位。）",
    ...(extra
      ? [
          "",
          "  以下内容为业务单后来的追加要求，一并作为卡点的上下文（不是新任务）：",
          /* 缩进两格：追加段自带的【用户插话】【上一轮卡点】标题与顶层区块同级，不缩进会被读成新的一节。 */
          ...extra.split("\n").map((l) => (l.trim() ? `  ${l}` : l)),
        ]
      : []),
    ``,
    `【二、这一单只做一件事】`,
    readonly
      ? "查明卡点：停滞的步骤、原因与对应证据。给出结论与修复建议。不修改任何对象。"
      : "查明卡点并修复：先定位根因，再修改对应对象，再验证。",
    ``,
    /* 修复单也要先核对现状：卡点描述可能已过时，根因或许已被其他修改一并修复。 */
    ...(readonly ? [] : [...buildGroundingBlock(d, "【三、动手前先核对现状】"), ``]),
    `【${readonly ? "三" : "四"}、怎么查】`,
    /* 修复单只读本单的说明与日志，全局文件按本单 id 取相关行，避免读到其他单的内容而带偏结论。 */
    `  1. 先看事实，不推断。派单说明：.capitalist/workers/${opts.id}/brief.md；工作进程日志：.capitalist/workers/${opts.id}/output.log。`,
    `     全局文件（.capitalist/runtime/state.json、.capitalist/runtime/supervisor.json、.capitalist/ledger/events.jsonl）只按本单 id（${d.id}）取相关行；`,
    `     不要读 .capitalist/ledger/tasks.jsonl、.capitalist/inbox/*.jsonl 里其他单的记录，也不要读其他工作进程的日志与会话。`,
    `  2. 再看实际执行路径：代码项目沿运行时生效的那条链路，不依据注释中的设计（注释可能已过期）。其他项目按实际执行路劲复现。`,
    `  3. 可复现的问题应复现一次（执行对应命令、脚本或流程），并保留真实输出；复现前须评估其可能影响，存在负面影响时先申报。`,
    `  4. 根因须能解释问题的必然性；只描述现象不算根因。`,
    ``,
    `【${CN[n]}、边界】`,
    `  1. 不执行 capitalist adopt / capitalist supervise，也不手动修改 .capitalist/ 下的台账；`,
    `     台账只按本单 id 取本单的行，其他单不读。`,
    `  2. 不擅自重启服务、重跑既有流程；需要时申报，或按派单指令执行。`,
    readonly
      ? "  3. 只读：文件、配置、台账均不修改。"
      : "  3. 可以修改，但仅限与本卡点直接相关的部分；不连带重构，不处理其他单的任务。",
    ``,
    /* 修复单同样按业务单的结束口径验收：证据是修改点，以及与卡点直接相关的复现或核对结果。 */
    ...buildDispatchAcceptBlock(d),
    ...buildCloseOutRules(`【${CN[n + 1]}、怎么算做完】`),
    ``,
    `【${CN[n + 2]}、收尾】`,
    `  ${readonly ? "查清后" : "修完并验证后"}：capitalist report ${d.id} done --note "<${readonly ? "根因" : "修改了什么"}>" --evidence "<${readonly ? "支持这个根因的证据" : "核对了什么、结果如何"}>"`,
    `排查受阻：capitalist report ${d.id} failed --note "<已排除的项、尚缺的项>"`,
    `  需人工裁决：capitalist ask "<问题>" 后停手。`,
  ].join("\n");
}

/* 技能清单的扫描见 `./skills`：看板下拉与工作进程共用同一份，避免两处口径不一致。 */

/**
 * 派单正文是否点名该技能。
 *
 * 按整词匹配，避免正文里的常见短词与目录名冲突；名字过短的一律排除，防止短词误命中。
 */
function mentionsSkill(text: string, name: string): boolean {
  if (name.length < 4) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_-])${esc}(?![A-Za-z0-9_-])`).test(text);
}

/**
 * 技能块：只附派单正文点名的技能（用户指定）的完整路径，供工作进程需要时自取。
 *
 * 监工已把本单涉及的技能重点整理进派单描述；正文未点名的技能一律不出现，更不列全量清单。
 * 这里只给路径：重点在描述里，工作进程需要更多细节时按路径读完整 SKILL.md。
 */
function buildSkillsBlock(root: string, actionText: string): string[] {
  const skills = listSkills(root);
  if (skills.length === 0) return [];
  const named = skills.filter((s) => mentionsSkill(actionText, s.name));
  if (named.length === 0) return [];
  const lines = [
    "【本单技能】",
    "  所需完整内容按以下路径获取（要点已在派单描述中）：",
  ];
  for (const s of named) {
    lines.push(`  · ${s.name} — ${s.path}`);
  }
  lines.push("");
  return lines;
}

export function buildPrompt(opts: {
  root: string;
  target: string;
  id: string;
  dispatch: Dispatch;
}): string {
  const d = opts.dispatch;
  const role = (d as unknown as { role?: string }).role;
  if (role === "fix" || role === "diagnose") return buildRepairPrompt(opts, role);
  const title = typeof (d as unknown as Record<string, unknown>).title === "string"
    ? String((d as unknown as Record<string, unknown>).title)
    : "";
  /*
   * 附件按本单 `atts` 字段重建，不按张数裁剪。判据只有 `atts` 字段：
   *   · 为数组（含空数组）-> 移除正文里的附件行，只按字段补回；空数组表示本单明确不带图；
   *   · 缺失（老单）-> 原样保留正文，不清除老单的图。
   * 发车时 `loop.ts` 已重建一次，这里再处理旧台账 action 里残留的正文路径。
   */
  const actionText = String(d.action ?? "");
  const ownAtts = Array.isArray(d.atts) ? d.atts.map((p) => String(p ?? "").trim()).filter(Boolean) : null;
  /*
   * 按本单 `atts` 重建附件行时保留其在正文中的位置：`（现状）`“（参照）”等角色标注随行保留，`bindAttachments` 只移除不属于本单的行。
   * 老单没有 `atts` 字段时不重建，否则按空数组处理会删掉正文里的图。
   */
  const attPayload = {
    text: ownAtts === null ? actionText : bindAttachments(actionText, ownAtts).text,
  };
  /* 卡点段只在发车时拼进提示词，不写入 action（见 `retry_context` 字段说明）；放在正文之后、执行要求之前。 */
  const retryCtx = retryContextOf(d);
  /*
   * 提示词分七块，顺序即工作进程的执行顺序：一、做什么；二、动手前核对；三、边界；四、怎么算做完；五、改完要生效；六、受阻申报；七、完成/失败。
   * 每块只出现一次，块内编号从 1 起，块外用中文序号标识阅读路径。
   */
  const accept = buildAcceptBlock(d);
  /*
   * 新会话缺少上一轮上下文。同一事项此前已结束的，将结论随提示词传递；
   * 缺少这一段，新进程只能照正文重做，重复修改上一轮已改动的部分并再次申报。
   */
  const carry = handoffLines(lastSettledOf(opts.root, d));
  return [
    "你是独立的工作进程，不是监工。",
    `任务根：${opts.root}`,
    `任务目标：${opts.target}`,
    `本单说明：.capitalist/workers/${opts.id}/brief.md（仅本份属于你；内容与下方正文一致，需要复查时读取该文件）`,
    ``,
    "【一、这一单要做什么】",
    "  （下面正文里若再出现【用户插话】【上一轮卡点】【上一轮已完成的部分】【本次验收】，都是这一块的子项，不是新的一节。）",
    dispatchHead(d, title),
    attPayload.text,
    /* 上一轮结论先于卡点：先了解已完成内容，再查看未完成内容。 */
    ...(carry.length ? ["", "【上一轮已完成的部分】", ...carry] : []),
    /* 卡点段只在发车时拼进提示词，不写入 action；放在正文之后、其余约束之前。 */
    ...(retryCtx ? ["", retryCtx] : []),
    /* 本次验收（重派时才有）：属于“这一单要做什么”的一部分，不另起一块。 */
    ...(accept.length ? ["", ...accept.slice(1)] : []),
    ``,
    /* 执行前核对现状：老单正文里可能已内联这一段，此时不重复拼接。 */
    ...(hasPreflight(attPayload.text) ? [] : [...buildGroundingBlock(d), ""]),
    ...buildBoundaryBlock(opts.id),
    ``,
    ...buildSkillsBlock(opts.root, attPayload.text),
    ...buildDispatchAcceptBlock(d),
    ...buildCloseOutRules(),
    ``,
    ...buildApplyBlock(),
    ``,
    ...buildHelpBlock(d.id),
  ].join("\n");
}

/** 把参数整理成 shell 可安全传递的形式。cmd.exe 以引号加倍转义，不用反斜杠；含换行的参数在命令行层面无法表达，调用方须优先判断能否改走 stdin。 */
export function quoteShellArg(a: string): string {
  if (a === "") return '""';
  if (!/[\s"&|<>^()%!]/.test(a)) return a;
  return `"${a.replace(/"/g, '""')}"`;
}

/**
 * 把本单说明写成独立文件 `.capitalist/workers/<workerId>/brief.md`，按工作进程分份、互不覆盖；工作进程复查要求只读自己这份，不查共用流水。
 */
function writeWorkerBrief(root: string, workerId: string, text: string): void {
  try {
    const p = workersLoc.brief(root, workerId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text, "utf8");
  } catch {
    /* 写入失败不影响启动：正文已经内联在提示词里 */
  }
}

/**
 * 启动一个工作进程，输出直接落到 `workers/<id>.log`。
 * 监工不解析工作进程的自然语言输出，只接受写回 `.capitalist/` 的结构化结果（report / ask / block）；解析 stdout 会把判定绑到措辞上。
 */
export function launchWorker(opts: LaunchOptions): Launched {
  const id = opts.id ?? newWorkerId(opts.root, opts.dispatch.id);
  const log = workerLogPath(opts.root, id);
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "a");
  closeSync(fd);

  // 同一分片重派时续接上一次会话，要求变过则新开。
  const session = resolveSession(opts.root, opts.dispatch);
  const prompt = session.resume
    ? buildResumePrompt({ root: opts.root, target: opts.target, id, dispatch: opts.dispatch })
    : buildPrompt({
        root: opts.root,
        target: opts.target,
        id,
        dispatch: opts.dispatch,
      });

  /*
   * 每单一份说明，落成 `.capitalist/workers/<workerId>/brief.md`；提示词指向它，工作进程复查只读这一份，不查共用流水。
   * 写入失败不影响启动，正文已内联在 prompt 里。
   */
  writeWorkerBrief(opts.root, id, prompt);

  const custom = opts.cmd ? parseWorkerCmd(opts.cmd, prompt) : null;
  const located = custom?.bin || opts.bin || findBin(opts.host);
  if (!located) throw new Error(`找不到 ${opts.host} 可执行文件：该宿主不能作为工作进程启动，改用 --worker-cmd`);

  // 宿主可以把 shim 换成直接可 spawn 的入口（Windows 的 .cmd 包装脚本在受限环境里会短路）；`--worker-cmd` 由调用方显式指定，不改写。
  const program = custom
    ? null
    : workerImpl(opts.host)?.worker?.program?.({
        bin: located,
        dir: dirname(located),
        platform: process.platform,
      }) ?? null;
  let bin = program?.bin ?? located;
  let preArgs = program?.args ?? [];

  // 脚本入口（测试替身、自建包装）交给当前 node 执行。Windows 上带 shebang 的 .js
  // 不是可执行格式，直接 spawn 会 EFTYPE。
  if (/\.(?:js|cjs|mjs)$/i.test(bin)) {
    preArgs = [bin, ...preArgs];
    bin = process.execPath;
  }

  // Windows 上 .cmd 必须经 shell。prompt 统一经 stdin 传递：写入 argv 会让 CLI 在多参数组合下静默无响应，而 stdin 是其明确支持的管道写法。
  const shell = needsShell(bin, opts.host);
  const stdinArgs = custom ? null : buildArgsStdin(opts.host, opts.model, session, opts.effort);
  const viaStdin = stdinArgs !== null;
  const rawArgs = custom
    ? custom.args
    : [...preArgs, ...(stdinArgs ?? buildArgs(opts.host, prompt, opts.model, session, opts.effort))];
  const args = shell ? rawArgs.map(quoteShellArg) : rawArgs;

  const extraEnv: Record<string, string> = {
    CAPITALIST_WORKER_ID: id,
    CAPITALIST_DISPATCH_ID: opts.dispatch.id,
    CAPITALIST_SESSION_ID: id,
    // 任务根：hook 靠它定位 .capitalist/workers/<id>/record.json 续写心跳。
    CAPITALIST_ROOT: opts.root,
    // 监工 pid：父进程被强杀后 hook 靠它自查是否已成孤儿（见 host/orphanGuard.ts）；注入的是监工进程号。
    CAPITALIST_SUPERVISOR_PID: String(process.pid),
  };

  /*
   * 令牌只进子进程环境，变量名由 impl 声明。宿主 CLI 见到该变量即用它认证，不再去读
   * 客户端保存的登录态文件；未声明的宿主不注入，行为与之前一致。
   */
  if (opts.token) {
    const authVar = byId(opts.host)?.worker?.authEnvVar;
    if (authVar) extraEnv[authVar] = opts.token;
  }

  const banner = [
    `[launch] ${new Date().toISOString()} host=${opts.host} dispatch=${opts.dispatch.id} shard=${opts.dispatch.shard ?? ""}`,
    `[launch] bin=${bin}${shell ? "（经 shell）" : ""}${viaStdin ? " prompt=stdin" : " prompt=argv"}`,
    /* 模型与会话写入日志一行：`.cmd` shim 下 argv 会被包装，命令行不足以核对实际使用的模型与续接的会话。 */
    `[launch] model=${opts.model ?? "（宿主默认）"} session=${session.id}${session.resume ? " resume" : " new"} lane=${session.resume ? "续" : "新"}`,
    `[launch] dropped-env=${droppedHostEnv().length} 个宿主变量（${envDropPrefixes().join(" / ")}）`,
    "",
  ].join("\n");
  try {
    appendFileSync(log, banner);
  } catch {
    /* 日志写失败不影响工作进程 */
  }

  let bytesAtLaunch = 0;
  try {
    bytesAtLaunch = statSync(log).size;
  } catch {
    /* 读取失败时按 0 计，自检会把整份 banner 视为正文，结果偏保守 */
  }

  // 工作进程的 stdout/stderr 经管道回到父进程再写入日志：宿主持有日志 fd 时不写输出，故不能把 fd 直接交给它。
  // 管道随父进程退出而断开，工作进程再写 stdout 会 EPIPE；由 orphanGuard 注入 CAPITALIST_SUPERVISOR_PID 自查父进程存活，父进程不在即退出。
  const spawnEnv = workerEnv(extraEnv);
  const child = spawn(bin, args, {
    cwd: opts.root,
    env: spawnEnv,
    shell,
    // Windows 上不带这一项会弹出控制台窗口，工作进程是后台进程，不需要窗口。
    windowsHide: true,
    // stdin 必须是管道：部分宿主首次进入目录会交互式询问是否信任文件，非交互模式没有 TTY 时会持续等待、零输出。
    stdio: ["pipe", "pipe", "pipe"],
    // 不另起进程组：Windows 上 detached 会分配新控制台并弹窗。孤儿回收走 orphanGuard 的自查，不依赖进程组关系。
    detached: false,
  });

  // prompt 经 stdin 传递时，这里写入的是完整派单；否则仅写入一个回车，用于确认目录信任。
  if (child.stdin) {
    try {
      if (viaStdin) {
        child.stdin.write(prompt.endsWith("\n") ? prompt : `${prompt}\n`);
      } else if (workerImpl(opts.host)?.workspace) {
        // 声明了 workspace 的宿主会先问“是否信任这些文件”，非交互模式没有 TTY，
        // 一次回车即默认确认；否则进程会持续等待。
        child.stdin.write("\n");
      }
      child.stdin.end();
    } catch {
      /* 工作进程可能已退出，写 stdin 失败交给 exit 事件判定 */
    }
  }

  // 输出转发：两个流分开落盘。stdout 是协议通道（`--output-format stream-json` 时一行一个事件），stderr 是诊断通道。
  // 宿主的运维噪声与异常栈走 stderr，归入 `<worker>.log.err` 供排查，主日志只留协议内容。
  const appendToLog = (chunk: Buffer | string): void => {
    try {
      appendFileSync(log, chunk);
    } catch {
      /* 日志写失败不影响工作进程 */
    }
  };
  const errLog = `${log}.err`;
  const appendToErr = (chunk: Buffer | string): void => {
    try {
      appendFileSync(errLog, chunk);
    } catch {
      /* 诊断通道写失败同样不影响工作进程 */
    }
  };
  /*
   * 每段输出后补一次心跳，不依赖宿主 hook（配置丢失或宿主升级时 hook 可能整段不触发，而输出正常）。
   * 落盘间隔取 2 秒：每块输出都改写工作进程记录会拖慢调度轮次，并与 hook 的写入互相覆盖；判活阈值是分钟级。首次输出把状态从 starting 置为 running。
   */
  let lastBeat = 0;
  const beatFromOutput = (): void => {
    const now = Date.now();
    if (now - lastBeat < 2_000) return;
    lastBeat = now;
    const rec = loadWorker(opts.root, id);
    if (!rec || (rec.status !== "starting" && rec.status !== "running")) return;
    try {
      touchWorker(opts.root, id, rec.status === "starting" ? { status: "running" } : {});
    } catch {
      /* 心跳写失败不影响工作进程与输出转发 */
    }
  };
  child.stdout?.on("data", (chunk: Buffer | string) => {
    appendToLog(chunk);
    beatFromOutput();
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    appendToErr(chunk);
    beatFromOutput();
  });

  // 启动失败是异步事件（ENOENT 之类），不捕获会以未捕获异常结束监工进程。
  child.on("error", (err) => {
    const rec = loadWorker(opts.root, id);
    if (rec) saveWorker(opts.root, { ...rec, status: "failed", exit_code: -1 });
    try {
      appendFileSync(log, `[launch error] ${err.message}\n`);
    } catch {
      /* 日志写失败不影响判定 */
    }
  });

  const now = new Date().toISOString();
  const record: WorkerRecord = {
    id,
    host: opts.host,
    pid: child.pid ?? 0,
    session: id,
    ai_session: session.id,
    dispatch: opts.dispatch.id,
    shard: opts.dispatch.shard ?? "",
    started_at: now,
    heartbeat_at: now,
    heartbeat_ts: Date.now() / 1000,
    status: "starting",
    log,
    mode: "background",
    supervisor_pid: process.pid,
  };
  registerWorker(opts.root, record);
  watchSilentStart(log, bytesAtLaunch, child, args, spawnEnv);

  return { record, child };
}

/** 自检等待时长；测试可用环境变量压缩。 */
function silentStartProbeMs(): number {
  const raw = Number(process.env.CAPITALIST_SILENT_PROBE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 25_000;
}

/** 日志相对启动时的增量字节；读不到按 0 处理。 */
function logGrowth(log: string, baseline: number): number {
  try {
    return Math.max(0, statSync(log).size - baseline);
  } catch {
    return 0;
  }
}

/**
 * 启动后的静默自检：非交互模式下的失败常无输出或仅以退出码 0 结束，监工只能看到心跳超时，无法区分端口冲突、认证失效与单例锁冲突。
 * 固定时长后日志正文仍为空时，补记一条诊断，写入进程存活、日志增量、argv 规模与是否含换行、令牌是否注入等事实。
 */
function watchSilentStart(
  log: string,
  baseline: number,
  child: ChildProcess,
  args: string[],
  env: NodeJS.ProcessEnv,
): void {
  const delayMs = silentStartProbeMs();
  const timer = setTimeout(() => {
    if (logGrowth(log, baseline) > 0) return; // 已有正文，CLI 已进入会话

    const pid = child.pid ?? 0;
    const argvChars = args.reduce((n, a) => n + a.length, 0);
    const multiline = args.some((a) => a.includes("\n") || a.includes("\r"));
    const hasToken = Object.keys(env).some((k) => k.endsWith("_TOKEN") && !!env[k]);

    const lines = [
      `[silent] 启动后 ${Math.round(delayMs / 1000)} 秒，日志仍无正文，工作进程未进入会话`,
      /* `child.pid` 缺失时 pid 为 0，判活按“已退出”处理：未取得 pid 即表示未启动。 */
      `[silent] 进程${pid}${pidAlive(pid) ? "仍存活" : "已退出"}，日志增量 0 字节`,
      `[silent] 参数 ${args.length} 项，共 ${argvChars} 字符，${multiline ? "含换行" : "不含换行"}`,
      `[silent] 令牌变量${hasToken ? "已注入" : "未注入"}`,
      "",
    ];
    try {
      appendFileSync(log, lines.join("\n"));
    } catch {
      /* 日志写不进去时不影响工作进程 */
    }
  }, delayMs);
  // 自检不阻塞监工退出。
  if (typeof timer.unref === "function") timer.unref();
}

/**
 * 以独立控制台窗口启动工作进程（可见模式）；窗口内是交互式会话，目录信任询问、工具权限审批、登录异常等卡点直接显现。
 * 环境变量随 spawn 的 env 传入并被新控制台继承，令牌不出现在命令行、不落盘。
 * 派单说明写入 `<id>.prompt.md`，窗口内首条消息只引用该路径；正文含引号与换行，直接拼进命令行会被 cmd.exe 截断。
 * 进程 detach 且 unref：监工退出后窗口仍保留，由使用者自行关闭。
 */
export function openVisibleWorker(opts: LaunchOptions): Launched {
  // 整个函数依赖 cmd.exe、.cmd 脚本、chcp 与 pause，没有跨平台实现。
  // 调用方（loop.ts）已按平台回落，这里直接 throw，比 spawn 出 ENOENT、只留一条 error 事件更好定位。
  if (process.platform !== "win32") {
    throw new Error("可见窗口模式依赖 cmd.exe，仅 Windows 可用；其他平台用后台模式。");
  }
  const id = opts.id ?? newWorkerId(opts.root, opts.dispatch.id);
  const log = workerLogPath(opts.root, id);
  mkdirSync(dirname(log), { recursive: true });

  const bin = opts.bin || (opts.cmd ? parseWorkerCmd(opts.cmd, "").bin : findBin(opts.host));
  if (!bin) throw new Error(`找不到 ${opts.host} 可执行文件：该宿主不能作为工作进程启动，改用 --worker-cmd`);

  // 同一分片重派时续接上一次会话，要求变过则新开。
  const session = resolveSession(opts.root, opts.dispatch);
  const prompt = session.resume
    ? buildResumePrompt({ root: opts.root, target: opts.target, id, dispatch: opts.dispatch })
    : buildPrompt({
        root: opts.root,
        target: opts.target,
        id,
        dispatch: opts.dispatch,
      });
  const promptFile = join(dirname(log), `${id}.prompt.md`);
  try {
    appendFileSync(promptFile, prompt);
  } catch (err) {
    throw new Error(`派单说明写入失败：${String((err as Error).message ?? err)}`);
  }
  /* 提示词指向 `.capitalist/workers/<id>/brief.md`，此入口也要写入，否则该路径无内容。 */
  writeWorkerBrief(opts.root, id, prompt);

  const extraEnv: Record<string, string> = {
    CAPITALIST_WORKER_ID: id,
    CAPITALIST_DISPATCH_ID: opts.dispatch.id,
    CAPITALIST_SESSION_ID: id,
    // 任务根：hook 靠它定位 .capitalist/workers/<id>/record.json 续写心跳。
    CAPITALIST_ROOT: opts.root,
    // 监工 pid：窗口模式下工作进程同样是独立进程，父进程被强杀后的自保走同一套。
    CAPITALIST_SUPERVISOR_PID: String(process.pid),
  };

  /* 与后台模式同口径：令牌只进子进程环境，不写进上面那个 .cmd 脚本。 */
  if (opts.token) {
    const authVar = byId(opts.host)?.worker?.authEnvVar;
    if (authVar) extraEnv[authVar] = opts.token;
  }

  // 首条消息保持单行，只指向派单文件；模型随后自行读取全文。
  const firstMessage = `读取 ${promptFile} 并严格按其中内容执行，这是该派单的说明。`;

  // 启动过程写成脚本文件，不把整串命令直接拼进 cmd /k：命令串里有中文、引号与 &&，
  // 直接拼接会受 cmd 代码页与引号剥离规则影响，出错时窗口随即关闭。脚本加 pause 让报错留在窗口内可读。
  const scriptPath = join(dirname(log), `${id}.launch.cmd`);
  const script = [
    "@echo off",
    "chcp 65001 >nul",
    `title capitalist ${id}`,
    `cd /d "${opts.root}"`,
    `echo [capitalist] worker ${id}`,
    `echo [capitalist] dispatch ${opts.dispatch.id} / shard ${opts.dispatch.shard ?? "-"}`,
    `echo [capitalist] closing this window does NOT report failure.`,
    `echo [capitalist] if aborted, run: capitalist report ${opts.dispatch.id} failed --note "aborted"`,
    "echo.",
    `"${bin}" "${firstMessage}"`,
    "echo.",
    `echo [capitalist] worker exited, code %ERRORLEVEL%`,
    "pause",
    "",
  ].join("\r\n");
  try {
    writeFileSync(scriptPath, script, "utf8");
  } catch (err) {
    throw new Error(`启动脚本写入失败：${String((err as Error).message ?? err)}`);
  }

  // 以 detached 方式启动新控制台执行启动脚本：
  // - detached + stdio ignore 让工作进程脱离父控制台，Windows 为其分配独立控制台（即新窗口）；
  // - 不用 `start`：其标题参数必须带引号，argv 转义会破坏它，且无控制台的父进程里 start 会持续等待；
  // 不开 /MAX：工作进程窗口只用于查看卡点，不占满屏幕。
  const child = spawn("cmd.exe", ["/k", `${id}.launch.cmd`], {
    cwd: dirname(log),
    env: workerEnv(extraEnv),
    detached: true,
    stdio: "ignore",
    // 例外：可见窗口模式需要显示窗口（spawn-allow-visible）；除此之外仓库里所有 spawn/spawnSync 都必须 windowsHide: true。
    windowsHide: false,
  });
  child.unref();

  // 启动失败是异步事件：不捕获会以未捕获异常结束监工进程。窗口模式的 pid 属于
  // cmd.exe，开窗后即退出，所以这里只把记录标 failed，存活判断仍交给 report。
  child.on("error", (err) => {
    const rec = loadWorker(opts.root, id);
    if (rec) saveWorker(opts.root, { ...rec, status: "failed", exit_code: -1 });
    try {
      appendFileSync(log, `[launch error] ${err.message}\n`);
    } catch {
      /* 日志写失败不影响判定 */
    }
  });

  try {
    appendFileSync(
      log,
      [
        `[launch] ${new Date().toISOString()} host=${opts.host} dispatch=${opts.dispatch.id} shard=${opts.dispatch.shard ?? "-"}`,
        `[launch] bin=${bin} 模式=可见窗口（cmd start）`,
        `[launch] prompt=${promptFile}`,
        `[launch] command=cmd /k ${id}.launch.cmd（cwd=${dirname(log)}）`,
        "",
      ].join("\n"),
    );
  } catch {
    /* 日志写失败不影响工作进程 */
  }

  const now = new Date().toISOString();
  const record: WorkerRecord = {
    id,
    host: opts.host,
    pid: child.pid ?? 0,
    session: id,
    ai_session: session.id,
    dispatch: opts.dispatch.id,
    shard: opts.dispatch.shard ?? "",
    started_at: now,
    heartbeat_at: now,
    heartbeat_ts: Date.now() / 1000,
    status: "starting",
    log,
    mode: "visible",
    supervisor_pid: process.pid,
  };
  registerWorker(opts.root, record);

  return { record, child: null };
}
