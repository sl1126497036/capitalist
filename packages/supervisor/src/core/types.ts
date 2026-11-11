/**
 * 与归档的 Python 实现共用的数据格式。
 *
 * 两套实现读写同一个 `.capitalist/` 目录，字段名保持 snake_case，与
 * `_archive/python-engine/supervisor/scripts/capitalist.py` 序列化的一致。
 * 改字段名属于协议变更：两侧同时改，并保证既有任务根仍可读。
 */

/** 三值动作判定。多条规则同时命中时取更严的一档。 */
export type Verdict = "deny" | "ask" | "allow";

/**
 * 权限档位。
 *
 *   plan          只读：写与删一律拒，读不受影响
 *   default       规则按自身强度生效
 *   accept_edits  文件写入跳过 ask 这一步；命令类不变
 *   bypass        不拦本机改动，但仍全部记账
 *
 * 档位只管本机状态的改动，不会削弱红线。
 */
export type Mode = "plan" | "default" | "accept_edits" | "bypass";

/** 动作类型。决定档位是否介入该动作。 */
export type ActionKind = "command" | "read" | "write" | "delete";

/** 契约里写的红线级别。旧名保留以兼容既有契约。 */
export type RedlineLevel = "BLOCK" | "NEED_USER" | "WARN";

/** 一次红线命中。`defer` 表示最终判定交给更专门的检查。 */
export interface RedlineHit {
  id: string;
  level: string;
  label: string;
  snippet: string;
  defer?: string;
  fix?: string;
}

/**
 * 红线预检结果。
 *
 * `rule_decision` 是规则本身给出的判定，`decision` 是套用当前档位后的最终值。
 * 两者都保留，调用方才能说明一次拒绝来自档位还是来自规则。
 */
export interface GateResult {
  decision: "PASS" | "PASS_WITH_WARN" | "NEED_USER" | "BLOCK";
  rule_decision?: "PASS" | "PASS_WITH_WARN" | "NEED_USER" | "BLOCK";
  mode?: Mode;
  tightened?: boolean;
  reason?: string;
  hits: RedlineHit[];
}

/** 本机边界判定结果。`justify` 表示允许一次，同时要求登记理由。 */
export type LocalDecision = "allow" | "justify" | "deny" | "allow_outside";

/** 一次本机边界命中。 */
export interface LocalHit {
  path: string;
  why: string;
  kind: string;
}

/** 一个阶段。`done` 由声明式检查器解释，不由引擎直接执行。 */
export interface Stage {
  id: string;
  name: string;
  goal?: string;
  next?: string;
  done?: Record<string, unknown>;
}

/** 一条红线。 */
export interface Redline {
  id: string;
  level: RedlineLevel | string;
  label: string;
  pattern: string;
  ignore_case?: boolean;
  fix?: string;
  defer?: string;
  why?: string;
}

/** 本机边界配置。`allow_roots` 为空表示只允许任务根内。 */
export interface LocalGuardConfig {
  allow_roots?: string[];
  sensitive_paths?: string[];
  sensitive_names?: string[];
  sensitive_globs?: string[];
  never_delete_outside_task_root?: boolean;
  justify_ttl_sec?: number;
  deny_message?: string;
}

/** 契约文件内容。未知键原样透传，契约可扩展而不必改代码。 */
export interface ContractData {
  name: string;
  domain?: string;
  version?: number;
  description?: string;
  permission?: { mode?: string; default_mode?: string };
  stages?: Stage[];
  redlines?: Redline[];
  redlines_note?: string;
  local_guard?: LocalGuardConfig;
  context?: string | Record<string, number>;
  env_notes?: { summary?: string; mistakes?: Mistake[] };
  reply_checks?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 一条常见错误。 */
export interface Mistake {
  id: string;
  pattern: string;
  label: string;
  hint: string;
}

/**
 * 任务根状态。
 *
 * `contract_fallback` 标记该任务未指定领域契约，跑的是通用契约。该字段出现在每份简报里，
 * 使“当前无领域判据”这一状态显式可见，而不是被默认成有判据。
 */
export interface TaskState {
  version: number;
  target: string;
  contract: string;
  contract_path: string;
  contract_fallback?: boolean;
  permission_mode?: Mode;
  /**
   * 写入代数。读改写用它做冲突检测：写回时磁盘上的值变了，说明这中间有别的进程
   * 动过 state，应当重读再改，而不是把对方的字段整块覆盖掉。
   */
  rev?: number;
  stage: string;
  /**
   * 进入当前阶段的时间，同时给 ISO 串与 epoch 秒两种形式。
   *
   * `mtime_after_stage` 以它为比对基准。早于该字段出现的任务根（或手写的）两者都没有，
   * 此时检查器回落到 `created_at`，而不是让该门槛永远不达标。
   */
  stage_entered_at?: string;
  stage_entered_at_ts?: number;
  next_action: string;
  blockers?: unknown[];
  counters?: { rounds_in_stage?: number };
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/** 一条台账记录。 */
export interface LedgerRecord {
  at: string;
  at_ts?: number;
  kind?: string;
  [key: string]: unknown;
}

/**
 * 与宿主无关的生命周期点。各 impl 把原生事件映射到这些点上。
 *
 * `HostId` 不在此处定义：`core` 不应知道宿主构成一个封闭集合。注册键是开放字符串，
 * 由 `host/contract.ts` 定义，新增宿主不触及判定层。
 */
export type LifecyclePoint = "on_start" | "on_idle" | "on_action" | "on_compact" | "on_stop";
