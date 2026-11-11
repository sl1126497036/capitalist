/**
 * 宿主契约：一个 agent 提供哪些能力，才可被本引擎监督。
 *
 * 本文件是 impl 唯一允许依赖的类型来源，因此只写中性词：宿主、impl、facet、能力。
 * 产品名、配置目录名、CLI 参数只出现在 `host/impl/` 下的实现里，
 * 分层与目录约定见 docs/architecture/impl-layer.md。
 *
 * 五个生命周期点固定。原生事件映射不上时返回 null，表示该宿主缺这项能力。
 */

/** 注册表键。稳定、唯一，写进用户配置、`.capitalist/` 与工作进程记录，属外部兼容面。 */
export type HostId = string;

/** 供应商中立的生命周期点。 */
export type LifecyclePoint = "on_start" | "on_idle" | "on_action" | "on_compact" | "on_stop";

/** 宿主原生 payload。各家字段名不同，因此按 unknown 收进来由 impl 自行解释。 */
export type NativePayload = Record<string, unknown>;

/** 统一事件：impl 的产出，dispatch 的输入。 */
export interface UnifiedEvent {
  point: LifecyclePoint;
  /** 原生事件名，仅用于日志与排查，不参与判定 */
  native: string;
  sessionId: string;
  cwd: string;
  tool: string;
  toolInput: Record<string, unknown>;
  transcript: string;
  prompt: string;
}

/** 决策出口。返回进程退出码，由 hook 入口统一 `process.exit`。 */
export interface HookDecision {
  code: number;
  stdout?: string;
}

/**
 * 事件到判定的适配面。每个 impl 必有。
 *
 * 失败语义对每个 impl 一致：
 * - `pointFor` 与 `parse` 不抛；字段缺失给空值。
 * - `passthrough` / `deny` / `inject` 不抛，也不读 stdin。
 * - `dispatch` 整体 fail-open：hook 位于用户必经路径上，自身故障不阻断工作。
 */
export interface HookFacet {
  /** 原生事件名 -> 生命周期点。无法映射返回 null（该事件不处理）。 */
  pointFor(native: string): LifecyclePoint | null;
  /** 解析原生 payload。字段缺失一律给空值，不抛。 */
  parse(payload: NativePayload, native: string): UnifiedEvent;
  passthrough(): HookDecision;
  deny(reason: string, point: LifecyclePoint, sessionId: string): HookDecision;
  inject(context: string, point: LifecyclePoint, sessionId: string): HookDecision;
  /**
   * 手工配置（`--agent` 缺失）时被猜中的优先级，越大越先。
   *
   * 这张表决定“用户当前在哪个宿主里”。`WorkerFacet.detectPriority` 决定“哪些 impl 可作为
   * 工作进程”，两者互不影响：桌面端能跑 hook，但不能当工作进程。猜错时判定会挂到另一个
   * impl 的事件映射上。
   */
  readonly guessPriority?: number;
  /** 注入是否真的到达模型上下文。false 表示只有 stderr / 日志，能力矩阵会显示缺失。 */
  readonly injects: boolean;
  /** 拒绝是否带结构化输出。false 表示退化为退出码 + stderr。 */
  readonly structuredDeny: boolean;
}

/** 安装上下文：由顶层安装器准备，impl 只读。 */
export interface InstallContext {
  /** hook 入口绝对路径（dist/agent/main.js） */
  entry: string;
  /** 当前 node 绝对路径 */
  node: string;
  /** 幂等标记，同时用于卸载识别 */
  marker: string;
  /** 运行平台，命令串的平台差异归 impl */
  platform: NodeJS.Platform;
}

/** 写入宿主配置的一条 hook 条目。形状与各家的 `hooks` 值一致。 */
export interface InstallEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number; statusMessage?: string }>;
}

/**
 * 让 hook 跑起来。缺失表示该宿主只能手工配置。
 *
 * 幂等合并、只动 `hooks` 键、保留用户条目、卸载识别由安装器负责。写哪些事件、命令串
 * 长什么样、装完还差哪一步由 impl 给出。
 */
export interface InstallFacet {
  /**
   * 原生事件名到配置条目的映射。
   *
   * 返回的键必须用宿主原生事件名，安装器按原样写入配置文件。
   */
  plan(ctx: InstallContext): Record<string, InstallEntry[]>;
  /**
   * 安装后需呈现给用户的条目，例如宿主信任确认。
   *
   * 返回 null 表示没有后置条件。
   */
  notice?(): string | null;
  /**
   * 不满足则视为“装了但没生效”的前置条件，由安装器强制提示。
   *
   * 返回空数组表示没有前置条件。
   */
  preconditions?(ctx: InstallContext): string[];
  /** 支持整包分发的宿主可走这条路（优先于写 settings.json）。 */
  packageDir?: string;
}

/**
 * 续载信息。
 *
 * worker 是一次性进程，但宿主会话可以续：同一分片重派时接上上一次的会话，模型不必重新
 * 通读项目、不必重新理解这一单要做的事。反复“从头开始”是 token 的主要浪费点，一个
 * 三十分钟的活被中断三次，就等于把项目读了三遍。
 */
export interface WorkerSession {
  /** 稳定会话 id，按 阶段/分片 派生，重派之间不变。 */
  id: string;
  /** true = 续接已有会话；false = 新开。要求变过时必须新开：续上会带着旧要求。 */
  resume: boolean;
}

/** 工作进程的启动参数。 */
export interface WorkerLaunchInput {
  prompt: string;
  model?: string;
  session?: WorkerSession;
  /** 推理强度（`minimal` / `low` / `medium` / `high` / `xhigh` / `max`）。 */
  effort?: string;
}

/**
 * 拉起独立进程。缺失表示该宿主不能作为工作进程，顶层据此明确报错。
 *
 * `key` 是工作进程宿主的取值，写进 `.capitalist/workers/*.json`，属外部兼容面：
 * 只增不改；与注册表 id 可以不同（历史取值要保留）。
 */
export interface WorkerFacet {
  readonly key: string;
  /** PATH 里的可执行文件名，按平台给出候选。 */
  binNames(platform: NodeJS.Platform): string[];
  /** prompt 走 argv 时的参数。 */
  argv(input: WorkerLaunchInput): string[];
  /** prompt 走 stdin 时的参数；null 表示该宿主不支持管道。 */
  argvStdin?(input: { model?: string; session?: WorkerSession; effort?: string }): string[] | null;
  /**
   * 把推理强度翻译成该宿主的启动参数。
   *
   * 不声明的宿主表示没有这个能力：顶层不会为它写入任何推测参数。宿主之间的
   * 写法不一样（`--effort` / 环境变量 / 根本不存在），把这个差异留在 impl 里，
   * 顶层只负责把“想要多深的思考”这个意图传下来。
   *
   * @returns 需要追加的参数；返回空数组表示该档位这个宿主不支持。
   */
  effortArgs?(level: string): string[];
  /**
   * 是否优先用 stdin 传 prompt。默认 false，即声明了 `argvStdin` 也只走 argv。
   *
   * 有的宿主的 `-p` 会把 stdin 留给首次进入目录的信任确认。prompt 与确认共用一条管道时，
   * prompt 会被当作确认读掉，进程随后读到 EOF 空转：内存监控照常输出、CPU 接近零、
   * 没有会话内容。这类宿主只声明 `argvStdin`，不设本开关。
   */
  preferStdin?: boolean;
  /** 该可执行文件是否必须经 shell 才能 spawn（例如 Windows 批处理 shim）。 */
  needsShell?(bin: string, platform: NodeJS.Platform): boolean;
  /**
   * 把 PATH 里的 shim 换成可以直接 spawn 的等价入口，返回 null 表示按原样启动。
   *
   * Windows 上经 npm 安装的 CLI 是 .cmd 包装脚本，脚本主体形如
   * `goto #_undefined_# 2>NUL || title %COMSPEC% & node <entry> %*`。受限环境里这条
   * 重定向会被拒，整行短路，CLI 无法启动，日志里只有“拒绝访问”。改走 node 加真实
   * 入口可以绕开这层脚本。
   */
  program?(ctx: { bin: string; dir: string; platform: NodeJS.Platform }): { bin: string; args: string[] } | null;
  /**
   * 宿主自己会注入、不能传给工作进程的环境变量前缀。
   *
   * 前缀内容属于宿主协议，由 impl 声明。顶层只执行“声明过的前缀一律不继承”。
   */
  envDropPrefixes?: readonly string[];
  /**
   * 承载访问令牌的环境变量名。
   *
   * 声明后，顶层把宿主登录态中的令牌写进这个变量交给子进程，宿主 CLI 据此认证，不再依赖
   * 客户端自身的登录态文件。不声明表示该宿主没有这条通道，顶层不注入任何令牌。
   * 变量名由 impl 给出：不同宿主的认证变量不同，写错等于没注入。
   */
  authEnvVar?: string;
  /**
   * 需要按完整变量名剔除的条目，全大写。
   *
   * 前缀剔除适用于整个命名空间都属于宿主会话的情况。同一个前缀里也会混着工作进程
   * 启动必需的配置：CLI 的 node 路径、配置文件位置、服务地址。按前缀一并剔除会让进程
   * 起来但走缺少配置的分支，表现为没有会话输出，最终被心跳超时判死。这类变量按名剔除。
   */
  envDropNames?: readonly string[];
  /** 参与自动探测的优先级，越大越先；未声明表示不参与。 */
  detectPriority?: number;
}

/** 开工前把目录变成可写（首次进入要人工确认的那类前置条件）。 */
export interface WorkspaceFacet {
  /** 幂等、只追加不覆盖用户配置；失败不阻断启动但要说清原因。 */
  prepare(root: string): { ok: boolean; added: boolean; message: string };
}

/**
 * 一条宿主环境特征：变量存在即命中，`contains` 进一步要求取值里出现该关键字。
 *
 * 只读变量，不改环境；值比较忽略大小写与首尾空白。
 */
export interface HostEnvHint {
  readonly name: string;
  /** 取值必须包含的关键字。省略表示“变量非空即命中”。 */
  readonly contains?: string;
}

/** 一个宿主的完整实现。除 `hook` 外的 facet 缺失即能力缺失。 */
export interface HostImpl {
  readonly id: HostId;
  readonly label: string;
  /**
   * 归一用的额外写法：短名 / 公司名 / 拼写变体。主 id 由清单键直接命中，不必重复列在这里。
   */
  readonly aliases: readonly string[];
  /** 家目录下的配置目录名 */
  readonly configDir: string;
  /** hook 配置文件名 */
  readonly settingsFile: string;

  /**
   * 是否支持项目级 `settings.local.json`（四段式配置）。
   *
   * 装 hook 只写项目级：写用户级会让整台机器的每次工具调用都 spawn 一次钩子。
   * 没有项目级落点的宿主显式缺省，安装器据此跳过，不猜。
   */
  readonly projectLocal?: boolean;

  /**
   * hook 写到用户级配置（`~/<configDir>/<settingsFile>`），项目内不建配置目录。
   *
   * 用于“项目里出现该目录会改变宿主自身行为”的宿主：WorkBuddy 在项目里看到 `.codebuddy`
   * 就转受限模式，连 bash 都不再执行，届时插件装上了也跑不动。这类宿主的 hook 只能写用户级。
   */
  readonly userLevelHook?: boolean;

  /**
   * 已知支持的模型 ID（宿主 CLI 帮助文本解析不出来时的回退清单，按界面展示顺序）。
   * 只是回退，首选来源仍是 CLI 帮助里的 `--model` 全量清单。
   */
  readonly knownModels?: readonly string[];

  readonly modelPolicy?: {
    /** 没有显式指定、或指定了禁用模型时，用这一档。 */
    readonly default: string;
    /** 禁止使用的模型（含宿主内部别名）。命中即回落到 {@link default}。 */
    readonly deny: readonly string[];
  };

  /** 在 PATH 上查找宿主 CLI 的可执行文件名；缺省表示没有可调用的 CLI。 */
  readonly cliBins?: readonly string[];

  /**
   * 产品族。同一族的宿主共用登录态与配置目录，可互相承担工作进程。
   *
   * 监工运行于宿主进程内，工作进程仅从当前宿主所属的产品族中选取：跨族选用会让工作进程
   * 借用另一个产品线的登录态。未声明产品族的实现单独成族，不与其他实现互换。
   */
  readonly family?: string;

  /**
   * 宿主注入的进程环境变量，用于判定监工当前所在的宿主。
   *
   * 环境变量比配置目录更可靠：同一台机器可能安装多个宿主，但只有发起本次进程的宿主会注入
   * 该变量。变量名与取值关键字均由 impl 声明，注册表按声明匹配。
   *
   * 同族宿主可能共用同一个变量（以一处配置区分产品形态），因此 `contains` 比“存在即命中”
   * 更具体，判定时优先采信。
   */
  readonly hostEnv?: readonly HostEnvHint[];

  /**
   * 回退项：没有任何 impl 能猜中时用它。整个注册表必须恰好有一个。
   */
  readonly fallback?: boolean;

  readonly hook: HookFacet;
  readonly install?: InstallFacet;
  readonly worker?: WorkerFacet;
  readonly workspace?: WorkspaceFacet;
}

/**
 * 能力矩阵。由 facet 推导，不单独维护。
 */
export interface Capabilities {
  hookBlock: true;
  hookInject: boolean;
  structuredDeny: boolean;
  install: boolean;
  installNeedsConfirm: boolean;
  workerLaunch: boolean;
  workerAutoDetect: boolean;
  workspacePrepare: boolean;
}

/** 能力探测用的空上下文：只关心“有没有前置条件”，不关心具体路径。 */
const PROBE_CTX: InstallContext = { entry: "", node: "", marker: "", platform: process.platform };

/**
 * 推导一个 impl 的能力矩阵。
 *
 * `ctx` 缺省时用空上下文探测，只反映 facet 是否存在，不反映具体路径上的前置条件。
 */
export function deriveCapabilities(impl: HostImpl, ctx: InstallContext = PROBE_CTX): Capabilities {
  return {
    hookBlock: true,
    hookInject: impl.hook.injects,
    structuredDeny: impl.hook.structuredDeny,
    install: impl.install !== undefined,
    installNeedsConfirm: (impl.install?.preconditions?.(ctx) ?? []).length > 0,
    workerLaunch: impl.worker !== undefined,
    workerAutoDetect: impl.worker?.detectPriority !== undefined,
    workspacePrepare: impl.workspace !== undefined,
  };
}

/**
 * 宽松地把外部字段读成字符串。
 *
 * 字符串原样返回，数字与布尔转成字符串，其余类型返回 `fallback`。
 */
export function str(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

/**
 * 宽松地把外部字段读成对象。
 *
 * 数组与 null 返回空对象，其余非对象类型同样返回空对象。
 */
export function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * 生命周期点的事件名别名表，允许调用方直接传生命周期点，省去在配置里查宿主事件名。
 *
 * 安装器写配置时用原生名，手工配置时用统一名，两者都要认。
 */
export const POINT_ALIASES: Record<string, LifecyclePoint> = {
  on_start: "on_start",
  start: "on_start",
  on_idle: "on_idle",
  idle: "on_idle",
  on_action: "on_action",
  action: "on_action",
  on_compact: "on_compact",
  compact: "on_compact",
  on_stop: "on_stop",
  stop: "on_stop",
};
