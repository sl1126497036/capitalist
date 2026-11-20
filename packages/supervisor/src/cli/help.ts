/**
 * 帮助文本。
 *
 * `HELP` 覆盖全部子命令；`COMMAND_HELP` 覆盖 say / direct / takeover / release /
 * stop-worker / close / reload，说明这些命令的生效时机。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { modeNames } from "../core/guard/permission";

/**
 * 版本号唯一来源：包根的 `package.json`。
 *
 * 发布号由 `package.json` 决定；CLI 的 `--version`、帮助文本抬头、看板“关于”都从这里
 * 派生，不再各自维护一份字面量。读不到时返回空串，只影响展示，不阻断命令执行。
 */
function readVersion(): string {
  try {
    const raw = readFileSync(join(__dirname, "..", "..", "package.json"), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

/** `capitalist --version` 打印的版本号。 */
export const VERSION = readVersion();

/** 全角字符按 2 列计的终端显示宽度，说明列对齐以此为据。 */
function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
  return w;
}

interface HelpOpt {
  /** 参数写法，如 `--port 7788`。 */
  f: string;
  /** 该参数的解释；每条一行，首行放得下就跟在参数后并补齐到说明列。 */
  d: string[];
}

interface HelpItem {
  /** 命令写法（含位置参数，不含选项）。 */
  cmd: string;
  /** 命令整体说明；首行放得下就跟在命令后并补齐到说明列。 */
  brief: string[];
  /** 选项表：每个选项一行，右侧带各自的解释。 */
  opts?: HelpOpt[];
}

interface HelpGroup {
  title: string;
  items: HelpItem[];
}

const HELP_GROUPS: HelpGroup[] = [
  {
    title: "流程",
    items: [
      {
        cmd: "start <目标>",
        brief: ["创建或续用任务根。省略契约时缺省为 minimal"],
        opts: [
          { f: "--contract <名|路径>", d: ["契约名或路径"] },
          { f: "--root <目录>", d: ["任务根目录"] },
        ],
      },
      {
        cmd: "init <目标>",
        brief: ["新建任务根，已存在时报错"],
        opts: [
          { f: "--contract <名|路径>", d: ["契约名或路径"] },
          { f: "--root <目录>", d: ["任务根目录"] },
        ],
      },
      {
        cmd: "restart <目标>",
        brief: ["更换目标重开：旧 .capitalist 归档为 .capitalist.closed.<时间>，再就地重建"],
        opts: [
          { f: "--contract <名>", d: ["新契约"] },
          { f: "--root <目录>", d: ["任务根目录"] },
        ],
      },
      {
        cmd: "adopt",
        brief: ["为已有任务根更换契约，此后按正式契约执行"],
        opts: [
          { f: "--contract <名|路径>", d: ["新契约"] },
          { f: "--keep-stage", d: ["保留当前阶段"] },
        ],
      },
      {
        cmd: "advance",
        brief: ["门槛达标时推进到下一阶段"],
        opts: [{ f: "--force", d: ["未达标也推进，写入 FORCED 记录"] }],
      },
      { cmd: 'set-next "<下一步>"', brief: ["更新下一步动作，不改阶段"] },
      { cmd: "scope <k=v ...>", brief: ["就绪标记，写入 .capitalist/scope.json（如 scope assets=1 rules=1）"] },
    ],
  },
  {
    title: "记录",
    items: [
      { cmd: "record <名> <json>", brief: ["追加一条业务数据到 .capitalist/<名>.jsonl"] },
      {
        cmd: "update <名> <id> <字段> <值>",
        brief: ["修改 jsonl 中指定记录的字段"],
        opts: [{ f: "--key id", d: ["查找记录用的键名，缺省 id"] }],
      },
      {
        cmd: "ledger <add|list|assert>",
        brief: ["证据台账；confirmed 且证据不全时自动降级"],
        opts: [
          { f: "--claim ...", d: ["主张"] },
          { f: "--verdict confirmed", d: ["结论"] },
          { f: "--baseline ...", d: ["基线"] },
          { f: "--probe ...", d: ["探针"] },
          { f: "--diff ...", d: ["差异"] },
          { f: "--repro ...", d: ["复现"] },
        ],
      },
      {
        cmd: "justify <路径> <理由>",
        brief: ["登记越界理由；有效期内该路径放行，放行时记入待复核"],
        opts: [{ f: "--ttl 秒", d: ["有效期，缺省 300 秒"] }],
      },
    ],
  },
  {
    title: "问答",
    items: [
      {
        cmd: 'ask "<问题>"',
        brief: ["登记待裁决问题，登记后收工闸放行"],
        opts: [{ f: "--id X", d: ["问题编号"] }],
      },
      { cmd: "inbox [id]", brief: ["查看待裁决问题"] },
      { cmd: 'answer <id> "<指导>"', brief: ["关闭问题，并把指导写入下一步"] },
      { cmd: 'block <类型> "<卡在哪>"', brief: ["登记阻塞（验证码 / 账号 / 授权），收工闸放行"] },
      {
        cmd: "unblock",
        brief: ["清除阻塞，继续执行"],
        opts: [
          { f: "--type <类型>", d: ["清除指定类型"] },
          { f: "--all", d: ["清除全部"] },
        ],
      },
    ],
  },
  {
    title: "任务池",
    items: [
      {
        cmd: "tasks",
        brief: ["任务池汇总与清单；未完成 = 总数 - 已验收 - 已关闭"],
        opts: [
          { f: "--json", d: ["输出 JSON"] },
          {
            f: "--backfill",
            d: [
              "把历史派单投影成任务项，可重复执行；",
              "每张派单登记一项，同一分片的重派归并到同一项。状态：",
              "待派 -> 进行中 -> 待确认 -> 已验收 / 失败 / 已关闭",
            ],
          },
        ],
      },
    ],
  },
  {
    title: "派单树",
    items: [
      { cmd: "tree", brief: ["输出树结构与节点状态"] },
      { cmd: "tree next", brief: ["下一轮将派出的派单，按调度顺序排列"] },
      {
        cmd: "tree rebuild",
        brief: ["存量重建：同一事项的多条记录归并，按已有 after/parent 连边"],
        opts: [{ f: "--apply", d: ["写入结果；缺省只输出计划"] }],
      },
      {
        cmd: "tree group [ls]",
        brief: ["查看分组：成员、完成数、是否断链"],
      },
      {
        cmd: "tree group new <标题> <派单...>",
        brief: ["将多条并行派单归入一组：组内并行，整组完成才放行挂在组上的派单"],
      },
      {
        cmd: "tree group add|rm <#G> <派单...>",
        brief: ["增补或移出成员；成员必须共享同一个父节点"],
      },
      {
        cmd: "tree group attach <#G> <父|none>",
        brief: ["整组改挂：批量改成员父节点"],
        opts: [{ f: "--reason X", d: ["改挂理由"] }],
      },
      {
        cmd: "tree group close <#G>",
        brief: ["解散：挂在组上的派单按已收尾放行"],
      },
      {
        cmd: "tree move <派单...> --under <父|#G>",
        brief: ["单点改挂父节点：适用于已有树的结构调整，不影响整组"],
        opts: [{ f: "--reason X", d: ["改挂理由"] }],
      },
      {
        cmd: "tree detach <派单...>",
        brief: ["摘成根节点：不再等待任何前置"],
      },
    ],
  },
  {
    title: "复核",
    items: [
      { cmd: "review [list]", brief: ["待复核项（越界但放行的动作）"] },
      { cmd: "review resolve <序号|片段>", brief: ["消解待复核项"] },
      {
        cmd: "correct",
        brief: ["标记违规已改正；存在未消解项时，收工按第 3 次拦截处理"],
        opts: [
          { f: "--rule X", d: ["违反的规则"] },
          { f: "--note Y", d: ["改正说明"] },
        ],
      },
    ],
  },
  {
    title: "会话",
    items: [
      { cmd: "sessions", brief: ["列出该任务根上的会话"] },
      {
        cmd: "retire [<id>]",
        brief: ["退役会话"],
        opts: [{ f: "--note 说明", d: ["退役原因"] }],
      },
    ],
  },
  {
    title: "监工进程",
    items: [
      {
        cmd: "supervise <目标>",
        brief: [
          "创建任务根并常驻：派单、验收、回收重派。队列无待办时转入待命。",
          "在终端前台运行，随终端存活；关闭终端后监工下线。",
          "WorkBuddy 会话运行在沙箱里，不能在会话内启动；其他宿主可直接启动。",
          "启动后不执行上次未完成的派单：这些单逐张标为暂停，队列原样保留；",
          "新派入的单不受暂停影响，可立即执行。唤醒暂停单用 capitalist wake --user，",
          "或在看板按“已暂停”筛选后逐单唤醒。",
          "监工不自行生成派单：阶段门槛通过只推进状态，不建单。",
          "派单入口：看板、capitalist dispatch、capitalist say（追加要求）。",
          "看板默认随监工启动（127.0.0.1:7788，端口占用时顺延），启动时输出地址。",
          "令牌缺省不下发，工作进程与对话通道使用宿主 CLI 登录态；",
          "置 CAPITALIST_TOKEN_INJECT=1 时读取一次宿主登录态并注入子进程，",
          "宿主对该次访问弹一次确认，选择“本次会话内始终允许”后覆盖监工与全部",
          "工作进程；未授权时启动日志输出“未下发宿主令牌”。",
        ],
        opts: [
          { f: "--workers N", d: ["并行度上限，缺省 3"] },
          {
            f: "--agent <id>",
            d: ["监工所在宿主（workbuddy / codebuddy / claude-code）；", "未声明时按 claude-code 判定，工作进程宿主跟随监工宿主"],
          },
          { f: "--worker-model <模型>", d: ["工作进程使用的模型"] },
          {
            f: "--effort <档位>",
            d: ["推理强度，缺省 high；只改思考深度，不改模型；", "非法值按 high 处理，并在启动时输出说明"],
          },
          {
            f: "--capitalist-model <模型>",
            d: ["监工对话层模型（看板对话 / 申报判定 / 派单前检查），", "缺省为宿主默认；选择结果写入监工状态，看板指标条可见"],
          },
          {
            f: "--capitalist-context <上限>",
            d: ["监工对话上下文上限，缺省 1m；", "面板显示与超限重载按配置与模型实际上限取小"],
          },
          { f: '--worker-cmd "<模板含 {prompt}>"', d: ["自定义工作进程启动命令模板"] },
          { f: "--worker-timeout <秒>", d: ["工作进程超时"] },
          { f: "--worker-visible", d: ["为每个工作进程打开独立控制台窗口"] },
          {
            f: "--stuck-sec <秒>",
            d: ["卡点观察窗口，缺省 300（环境变量 CAPITALIST_STUCK_SEC）；", "心跳与日志均超过该窗口未更新时判为卡点，任一在窗口内更新即视为存活"],
          },
          { f: "--no-spawn", d: ["只写派单，由另一个会话执行 capitalist next 领取"] },
          { f: "--no-board", d: ["不启动看板"] },
          { f: "--secure", d: ["校验访问 key；缺省不校验，地址不带 key"] },
          { f: "--board-quiet-ms N", d: ["看板合并窗口，缺省 8000ms（CAPITALIST_BOARD_RELOAD_QUIET_MS）"] },
          { f: "--board-min-gap-ms N", d: ["看板最小间隔，缺省 60000ms（CAPITALIST_BOARD_RELOAD_MIN_GAP_MS）"] },
          { f: "--force", d: ["接管并清除熔断"] },
          {
            f: "--verbose",
            d: ["打印启动参数、守护进程、任务列表热加载等运行细节（环境变量 CAPITALIST_VERBOSE=1）；", "缺省只输出看板地址、运行状态与错误"],
          },
        ],
      },
      { cmd: "supervise-stop", brief: ["请求监工退出（下一轮调度生效）"] },
      { cmd: "auth", brief: ["已移除；认证使用宿主自身登录态"] },
      {
        cmd: "auth-check",
        brief: ["检查宿主能否正常调用模型；可用时退出码 0，其余 1"],
        opts: [
          { f: "--agent <id>", d: ["指定宿主；缺省取该任务的工作进程宿主"] },
          { f: "--no-probe", d: ["跳过探测，只报告令牌来源"] },
          { f: "--json", d: ["输出 JSON"] },
        ],
      },
      { cmd: 'pause ["<原因>"]', brief: ["写 .capitalist/pause.json：下一轮调度起不派新单，", "运行中的进程被停止，对应派单退回排队"] },
      {
        cmd: "resume",
        brief: ["删除 .capitalist/pause.json：下一轮调度起恢复派单。", "暂停的旧派单由 capitalist wake --user 唤醒"],
        opts: [
          {
            f: "--user",
            d: ["表示用户已明确要求；非交互终端（宿主会话代执行）默认拒绝。", "看板“恢复调度”按钮不经过本命令"],
          },
        ],
      },
      {
        cmd: "next",
        brief: ["领取一张派单（外部会话作为工作进程时使用）"],
        opts: [{ f: "--session <名>", d: ["会话名"] }],
      },
      {
        cmd: "wake [<派单id|分片>]",
        brief: ["唤醒暂停的派单；省略目标时唤醒本任务根全部暂停单。", "暂停由监工启动时写入（上次退出时未完成），不阻塞新派单"],
        opts: [{ f: "--user", d: ["唤醒属用户动作：非交互终端默认拒绝，须加 --user"] }],
      },
      {
        cmd: "workers",
        brief: ["各工作进程的 pid / 宿主 / 派单 / 状态"],
        opts: [{ f: "--json", d: ["输出 JSON"] }],
      },
      {
        cmd: "reload",
        brief: [
          "上下文重载：写入进度快照 -> 压缩心跳、调度轮次与已完成明细 ->",
          "切换对话会话 -> 写出恢复计划。已做但未验证的条目由监工下一轮调度",
          "派复验单；已完成且证据齐全的条目不重派。",
        ],
        opts: [
          { f: "--status", d: ["输出状态"] },
          { f: "--hold <秒>", d: ["延长看板“监工重载中”的显示时间"] },
          { f: "--json", d: ["输出 JSON"] },
        ],
      },
      {
        cmd: "report <派单id>",
        brief: ["工作进程上报，由工作进程内部调用"],
        opts: [
          { f: "--status done|failed", d: ["结束状态"] },
          { f: '--note "..."', d: ["结束说明"] },
          {
            f: '--outcome "<编号>=<结论>;…"',
            d: [
              "为派单正文中的每条用户插话给出结论，编号取正文里的",
              "[方括号]；结论取 done / not_mine / blocked，not_mine 注明",
              "归属派单，blocked 注明阻塞原因，可在结论后用冒号补充说明。",
              "未给出结论的条目阻止结束，并输出可复制的命令行。",
            ],
          },
        ],
      },
    ],
  },
  {
    title: "指令与中断",
    items: [
      {
        cmd: 'say "<文本>"',
        brief: ["给派单追加一条消息，写入 .capitalist/ledger/direct.jsonl。", "未开工的派单在启动时并入原派单；执行中的派单由 hook 在", "下一次工具调用前送达，不中断进程，送达后标记已用"],
        opts: [
          { f: "--shard <分片>", d: ["只对目标分片的派单生效"] },
          { f: "--thread <线程>", d: ["用于界面回显归属，不改变生效范围"] },
        ],
      },
      {
        cmd: 'direct "<文本>"',
        brief: ["与 say 等价（同一实现、同一生效时机）"],
        opts: [
          { f: "--shard <分片>", d: ["同 say"] },
          { f: "--thread <线程>", d: ["同 say"] },
        ],
      },
      {
        cmd: "takeover [<分片>]",
        brief: ["接管指定分片（省略分片时为整个任务根）：监工暂停该分片的", "自动重派与自动验收，直到 release"],
        opts: [{ f: '--reason "<原因>"', d: ["接管原因，写入 .capitalist/takeover.json"] }],
      },
      { cmd: "release [<分片>]", brief: ["交还被接管的分片，恢复监工自动重派与自动验收"] },
      {
        cmd: "stop-worker <id>",
        brief: ["中断指定工作进程：结束其进程，并把它的派单按失败结束", "（下一轮调度重派，分片被接管或登记阻塞时除外）"],
      },
      {
        cmd: "close <派单id|worker-id|分片>",
        brief: ["手动结束：运行中与排队中的派单均可关闭，状态置为终态 closed", "并写记录；监工不再为它补派单"],
        opts: [{ f: '--reason "<原因>"', d: ["结束原因"] }],
      },
      {
        cmd: "promote <派单id|worker-id|分片>",
        brief: ["手动插队：将排队中的派单提到队首，下一轮填槽时最先拉起", "（有空槽时立即拉起；不越过并行度与暂停状态，不新建派单）"],
      },
    ],
  },
  {
    title: "文件锁",
    items: [
      { cmd: "lock status [<路径>]", brief: ["输出锁的持有者、持有时长与排队项；省略路径时列出全部"] },
      {
        cmd: "lock release <路径>",
        brief: ["释放指定锁"],
        opts: [{ f: "--force", d: ["不校验持有者"] }],
      },
      { cmd: "lock reap", brief: ["回收持有者进程已退出且心跳超时的锁；监工每轮调度自动执行"] },
    ],
  },
  {
    title: "看板",
    items: [
      {
        cmd: "board",
        brief: ["实时看板：工作进程状态、派单与回报流水，页面按间隔轮询状态"],
        opts: [
          { f: "--port 7788", d: ["监听端口，缺省 7788"] },
          { f: "--host <地址>", d: ["监听地址，缺省 127.0.0.1"] },
          { f: "--secure", d: ["校验访问 key；缺省不校验"] },
          { f: "--json", d: ["输出单次快照"] },
        ],
      },
      {
        cmd: "feed",
        brief: ["回报流水（工作进程上报、判定失败、阶段推进）最近 N 条"],
        opts: [
          { f: "--limit N", d: ["条数"] },
          { f: "--json", d: ["输出 JSON"] },
        ],
      },
    ],
  },
  {
    title: "查看",
    items: [
      {
        cmd: "status",
        brief: ["当前阶段 / 门槛 / 档位"],
        opts: [{ f: "--json", d: ["输出 JSON"] }],
      },
      { cmd: "brief", brief: ["极短状态（hook 注入用）"] },
      {
        cmd: "mode [档位]",
        brief: [`查看或切换权限档位：${modeNames().join(" | ")}`],
        opts: [{ f: "--json", d: ["输出 JSON"] }],
      },
    ],
  },
  {
    title: "预检与安装",
    items: [
      {
        cmd: "gate",
        brief: ["红线预检，不执行命令"],
        opts: [
          { f: "--text <命令>", d: ["预检单条命令"] },
          { f: "--req <文件>", d: ["预检请求体文件"] },
          { f: "--json", d: ["输出 JSON"] },
        ],
      },
      {
        cmd: "fire",
        brief: ["请求体判定：BLOCK 拒绝，NEED_USER 需授权原文，按 gap 限速"],
        opts: [
          { f: "--req <文件>", d: ["请求体文件"] },
          { f: '--authorized "<授权原话>"', d: ["用户授权原文"] },
          { f: "--gap 秒", d: ["限速间隔"] },
        ],
      },
      {
        cmd: "local-check",
        brief: ["本机边界预检"],
        opts: [
          { f: "--path <路径>", d: ["目标路径"] },
          { f: "--action read|write|delete", d: ["预检动作"] },
          { f: "--json", d: ["输出 JSON"] },
        ],
      },
      {
        cmd: "hosts",
        brief: ["列出全部宿主的 id / 别名 / 能力"],
        opts: [{ f: "--json", d: ["输出 JSON"] }],
      },
      {
        cmd: "install",
        brief: [
          "安装 hook 与手册。必须指定宿主；交互终端下省略 --agent / --all",
          "时进入选择菜单。hook 写入当前项目 <配置目录>/settings.local.json，",
          "手册写入用户目录；换项目时在该项目目录再执行一次",
        ],
        opts: [
          { f: "--agent <宿主...>", d: ["指定宿主，取值见宿主表"] },
          { f: "--all", d: ["安装到全部已检测宿主"] },
          { f: "--yes", d: ["跳过交互确认"] },
          { f: "--dry-run", d: ["只展示计划，不写入"] },
          { f: "--verbose", d: ["输出细节"] },
        ],
      },
      {
        cmd: "uninstall",
        brief: ["卸载 hook 与手册，保留任务数据；省略 --agent 时进入选择菜单"],
        opts: [
          { f: "--agent <宿主...>", d: ["指定宿主"] },
          { f: "--all", d: ["卸载全部已检测宿主"] },
          { f: "--keep-skill", d: ["保留用户目录手册"] },
          { f: "--verbose", d: ["输出细节"] },
        ],
      },
      {
        cmd: "check-update",
        brief: ["与 npm 上的版本比对；结论缓存 24 小时"],
        opts: [{ f: "--force", d: ["重新联网"] }],
      },
    ],
  },
];

/** 命令与参数所在的左列最大显示宽度；超过则说明整体换行到说明列。 */
const SIG_MAX = 35;

/** 命令行与参数行右侧的说明固定从该显示列起，命令区与说明区泾渭分明。 */
const DESC_COL = 38;
const CONT_PAD = " ".repeat(DESC_COL - 1);

/** 渲染单个命令条目：命令行 + 各参数行，说明统一落在说明列。 */
function renderItem(item: HelpItem): string[] {
  const out: string[] = [];
  const put = (left: string, d: string[]) => {
    out.push(d.length > 0 && dispWidth(left) <= SIG_MAX ? left + " ".repeat(DESC_COL - 1 - dispWidth(left)) + d[0] : left);
    for (const line of d.length > 0 && dispWidth(left) <= SIG_MAX ? d.slice(1) : d) out.push(CONT_PAD + line);
  };
  put(`  ${item.cmd}`, item.brief);
  for (const opt of item.opts ?? []) put(`   ${opt.f}`, opt.d);
  return out.map((l) => l.trimEnd());
}

/** 总帮助文本。`capitalist --help` 与无参数时打印它；末尾带换行，终端不留 partial line。 */
export const HELP =
  [
    `capitalist ${VERSION} 长流程任务监工`,
    "",
    "用法：capitalist <命令> [选项]",
    ...HELP_GROUPS.flatMap((g) => ["", g.title, ...g.items.flatMap(renderItem)]),
    "",
    ...renderItem({ cmd: "--version", brief: ["输出版本号；缓存中有新版本结论时附一行提示"] }),
  ].join("\n") + "\n";

/**
 * 单命令帮助。
 *
 * 条目说明生效时机：未开工的派单并入原派单，执行中的派单由 hook 送达；中断会触发重派。
 */
export const COMMAND_HELP: Record<string, string> = {
  say: `capitalist say "<文本>" [--target <派单id>] [--lineage <派生链>] [--shard <分片>] [--thread <线程>]
给派单追加一条消息。
  - 写入 .capitalist/ledger/direct.jsonl，字段 at / text / target / lineage / shard / thread / consumed
  - 未开工的派单：监工派单时读取未消费消息拼进 action，追加内容并入原派单，消费后标记 consumed
  - 执行中的派单：hook 在工作进程下一次工具调用前把消息随拒绝理由送达模型，不中断进程；
    送达后标记已用（consumed_via=hook），不重复注入
  - 记录 consumed_by / consumed_at / consumed_via，标明接收派单与送达方式，
    台账另有 direct_inject（登记）与 direct_deliver（送达）事件
  - --target 将消息绑定到指定派单或其同派生链重派单；绑定到工作进程时不转发给其他派单
  - 不带定位参数时对下一次任意派单生效；带 --shard 时只对目标分片的派单生效
  - --thread 用于界面回显归属，不改变生效范围`,
  direct: `capitalist direct "<文本>" [--shard <分片>] [--thread <线程>]
与 capitalist say 等价（同一实现、同一文件、同一生效时机）。
  - 写入 .capitalist/ledger/direct.jsonl；未开工的派单并入原派单，执行中的派单由 hook 送达`,
  takeover: `capitalist takeover [<分片>] [--reason "<原因>"]
接管指定分片。省略分片时为整个任务根。
  - 写入 .capitalist/takeover.json，记 root / shard / at / reason / active
  - 生效时机：下一轮调度起监工不自动重派该分片，也不自动验收该分片
  - 不终止运行中的进程；中断进程使用 capitalist stop-worker
  - 交还：capitalist release [<分片>]`,
  release: `capitalist release [<分片>]
交还被接管的分片。省略分片时交还全部接管项。
  - 把 .capitalist/takeover.json 里对应条目的 active 置为 false，并记 released_at
  - 生效时机：下一轮调度起监工恢复该分片的自动重派与自动验收`,
  "stop-worker": `capitalist stop-worker <worker-id>
中断指定工作进程。
  - 结束该进程（SIGTERM），并把它的派单按失败结束
  - 下一轮调度重派该派单；分片被接管（capitalist takeover）或登记阻塞（capitalist block）时除外
  - worker-id 由 capitalist workers 输出`,
  close: `capitalist close <派单id|worker-id|分片> [--reason "原因"]
手动结束：运行中与排队中的派单均可关闭。
  - 派单状态置为终态 closed，写 done_at / closed_at / closed_by / note
  - 存在运行中的进程时，先写 closed 结束再发送 SIGTERM；顺序颠倒会让进程退出回调
    按失败结束，下一轮调度重派
  - 写 dispatch_closed 事件到 .capitalist/ledger/events.jsonl（含原状态、是否发送过 SIGTERM）
  - 监工不再为已关闭分片补单；关闭的分片计入完成数，不阻塞阶段推进
  - stop-worker 中断进程并触发重派；close 关闭派单且不再补单
  - 目标写法：派单 id（D-…）、worker id（W-…）、分片名或 shard:xxx（排队行）`,
  reload: `capitalist reload [--status] [--hold <秒>] [--json]
监工上下文重载：从事件台账提取进度，切换会话后继续执行。
  - 写入 .capitalist/reload/snapshot.json（+ history/ 副本）：当前阶段、已达标的验收项、
    每片的最后状态与未完成条目、用户未处理的插话、未裁决提问、重派计数
  - 压缩成 .capitalist/reload/context.md：移除心跳 / 重复调度轮次 / 已完成条目详情 / 一次性调试输出；
    保留需求原文、未完成项、决策结论、待复验清单
  - 切换监工对话会话，原会话中的工具输出不再读取
  - 写 .capitalist/reload/resume.json：done_verified 不重派；done_unverified（已做但未验证）
    由监工下一轮调度派 source=reverify 的复验单，不按完成处理
  - 重载期间看板监工面板显示“监工重载中”，结束后隐藏（.capitalist/reload/active.json）
  - 生效时机：复验单在下一轮调度由监工补出；阶段推进与门槛判定不受影响`,
};
