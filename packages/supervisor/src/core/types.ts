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

/** 守卫里写的红线级别。旧名保留以兼容既有守卫。 */
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
  /** 敏感文件名通配。与 `sensitive_names` 共用同一份 glob 匹配，`*` 匹配任意串。 */
  sensitive_globs?: string[];
  never_delete_outside_task_root?: boolean;
  justify_ttl_sec?: number;
  deny_message?: string;
  /**
   * 只读放行目录：各宿主技能目录（项目级、用户级、插件缓存）内的读取不按越界处理。
   *
   * 派单时已把技能文件的完整路径写进派单内容，工作进程按该路径读取属于执行派单本身，
   * 不应再等一次授权。缺省开启；置 `false` 关闭，回到逐次申请。
   * 只对读生效：写入与删除仍按原规则申请或拒绝。
   */
  allow_read_skills?: boolean;
  /** 只读白名单：额外放行的路径，前缀匹配。只对读生效，用于技能目录之外的固定资料。 */
  allow_read_paths?: string[];
}

/**
 * 守卫文件内容。只声明任务边界：禁止什么、本机哪些位置可以动、判据来源与权限档位。
 * 流程不在此声明，编排由任务树承担。未知键原样透传，守卫可扩展而不必改代码。
 */
export interface PolicyData {
  name: string;
  domain?: string;
  version?: number;
  description?: string;
  permission?: { mode?: string; default_mode?: string };
  redlines?: Redline[];
  redlines_note?: string;
  local_guard?: LocalGuardConfig;
  /** 判据上下文：写清本领域的完成口径与禁止事项来源，判据排障与交接时引用。 */
  context?: string | Record<string, number>;
  env_notes?: { summary?: string; mistakes?: Mistake[] };
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
 * `policy_fallback` 标记该任务未指定领域守卫，跑的是通用守卫。该字段出现在每份简报里，
 * 使“当前无领域判据”这一状态显式可见，避免被当作已有判据。
 */
export interface TaskState {
  version: number;
  target: string;
  /** 守卫名。 */
  policy: string;
  policy_path: string;
  policy_fallback?: boolean;
  permission_mode?: Mode;
  /**
   * 写入代数。读改写用它做冲突检测：写回时磁盘上的值已变，说明有其他进程修改过 state；应重读后再改，避免覆盖对方的字段。
   */
  rev?: number;
  /**
   * 监工或用户指定的下一步动作。任务树里已有可执行节点时以节点为准。
   */
  next_action: string;
  blockers?: unknown[];
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
 * 由 `agent/contract.ts` 定义，新增宿主不触及判定层。
 */
export type LifecyclePoint = "on_start" | "on_idle" | "on_action" | "on_compact" | "on_stop";
