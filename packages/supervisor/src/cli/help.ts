/**
 * 帮助文本。
 *
 * `HELP` 覆盖全部子命令；`COMMAND_HELP` 覆盖 say / direct / takeover / release /
 * stop-worker，说明这五个命令的生效时机。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { modeNames } from "../core/permission";

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

/** 总帮助文本。`capitalist --help` 与无参数时打印它。 */
export const HELP = `capitalist ${VERSION} 长流程任务监工

用法：capitalist <命令> [选项]

流程
  start <目标> [--contract <名|路径>] [--root <目录>]
                        创建或续用任务根。省略契约时回落到 minimal
  init <目标> --contract <名|路径> [--root <目录>]
                        新建任务根，已存在时报错
  restart <目标> [--contract <名>] [--root <目录>]
                        更换目标重开：旧 .capitalist 归档为 .capitalist.closed.<时间>，再就地重建
  adopt --contract <名|路径> [--keep-stage]
                        为已有任务根更换契约，回落契约转为正式契约
  advance [--force]     门槛达标时推进到下一阶段；--force 写入 FORCED 记录
  set-next "<下一步>"   更新下一步动作，不改阶段
  scope <k=v ...>       就绪标记，写入 .capitalist/scope.json（如 scope assets=1 rules=1）

记录
  record <名> <json>    追加一条业务数据到 .capitalist/<名>.jsonl
  update <名> <id> <字段> <值> [--key id]
                        修改 jsonl 中指定记录的字段
  ledger <add|list|assert> [--claim ... --verdict confirmed --baseline ... --probe ... --diff ... --repro ...]
                        证据台账；confirmed 且证据不全时自动降级
  justify <路径> <理由> [--ttl 秒]
                        登记越界理由；有效期内该路径放行，放行时记入待复核

问答
  ask "<问题>" [--id X] 登记待裁决问题，登记后收工闸放行
  inbox [id]            查看待裁决问题
  answer <id> "<指导>"  关闭问题，并把指导写入下一步
  block <类型> "<卡在哪>"  登记阻塞（验证码 / 账号 / 授权），收工闸放行
  unblock --type <类型> | --all
                        清除阻塞，继续执行

任务池
  tasks [--json]        任务池汇总与清单；未完成 = 总数 - 已验收 - 已关闭
  tasks --backfill      把历史派单投影成任务项，可重复执行
                        每张派单登记一项，同一分片的重派归并到同一项
                        状态：待派 -> 进行中 -> 待确认 -> 已验收 ／ 失败 ／ 已关闭

派单树
  tree                  输出树结构与节点状态
  tree next             下一轮将派出的派单，按调度顺序排列
  tree rebuild          存量重建：同一事项的多条记录归并，按已有 after/parent 连边
                        默认输出计划；--apply 写入结果

复核
  review [list]         待复核项（越界但放行的动作）
  review resolve <序号|片段>
                        消解待复核项
  correct [--rule X] [--note Y]
                        标记违规已改正；未消解时按第 3 次拦截处理收工

会话
  sessions              列出该任务根上的会话
  retire [<id>] [--note 说明]
                        退役会话

监工进程
  supervise [<目标>] [--contract <名>] [--workers N] [--agent <id>]
            [--worker-model <模型>] [--effort <minimal|low|medium|high|xhigh|max>]
            [--capitalist-model <模型>] [--capitalist-context <300k|1m|token 数>]
            [--worker-visible]
            [--worker-cmd "<模板含 {prompt}>"] [--worker-timeout <秒>]
            [--stuck-sec <秒>]
            [--no-spawn] [--no-board] [--secure] [--board-quiet-ms N] [--board-min-gap-ms N]
            [--force] [--detach]
                        创建任务根并常驻：派单、验收、回收重派。--detach 后台运行；
                        --no-spawn 只写派单，由另一个会话执行 capitalist next 领取；--force 接管并清除熔断。
                        启动后不执行上次未完成的派单：这些单逐张标为暂停，队列原样保留；
                        新派入的单不受暂停影响，可立即执行。队列无待办时转入待命。
                        监工不自行生成派单：阶段门槛通过只推进状态，不建单。
                        派单入口：看板、capitalist dispatch、capitalist say（追加要求）。
                        待命与执行期间均保持在线，不退出进程。唤醒暂停单：capitalist wake --user，
                        或在看板按“已暂停”筛选后逐单唤醒。
                        --agent 显式声明监工运行所在的宿主（workbuddy / codebuddy / claude-code），
                        优先级高于环境特征与配置目录：CodeBuddy CLI 仅注入 CLAUDE_*，不注入
                        CODEBUDDY_HOST，环境变量特征与 Claude Code 相同；未声明时按 claude-code 判定。
                        工作进程宿主按监工所在宿主判定：WorkBuddy 与 CodeBuddy 取 codebuddy，
                        Claude Code 取 claude-code。
                        并行度 = --workers 上限（缺省 3），不按阶段分片数取小。
                        --stuck-sec 是卡点观察窗口（缺省 300 秒，环境变量 CAPITALIST_STUCK_SEC）：
                        心跳与日志都超过该窗口未更新时判为卡点，任一在窗口内更新即视为存活。
                        --effort 设置推理强度，缺省 high。该参数只改变思考深度，不更换模型。
                        派单与监工对话使用同一档位；非法值回落到 high 并在启动时输出说明。
                        --capitalist-model 更换监工对话层的模型（看板对话/申报判定/派单前检查），
                        缺省为宿主默认；选择结果写入监工状态，看板指标条可见。
                        --capitalist-context 是监工对话上下文的配置上限（缺省 1m），面板显示与
                        超限重载都按 min(配置, 模型实际上限) 计算：模型只有 300k 就显示 300k，
                        模型有 2m 也只用到配置的 1m。
                        看板默认随监工启动（127.0.0.1:7788，端口占用时顺延），启动时输出地址；
                        看板产物重建后自动加载，无需重启服务。合并窗口与最小间隔
                        缺省 8000ms / 60000ms，可用 --board-quiet-ms / --board-min-gap-ms
                        或 CAPITALIST_BOARD_RELOAD_QUIET_MS / CAPITALIST_BOARD_RELOAD_MIN_GAP_MS 覆盖。
                        --no-board 不启动看板。
                        --secure 校验访问 key；缺省不校验，地址不带 key。
                        令牌不由本项目保存。令牌下发缺省关闭，工作进程与对话通道使用宿主 CLI
                        自身的登录态；置 CAPITALIST_TOKEN_INJECT=1 时启动命令读取一次宿主登录态
                        并注入子进程，宿主对该次访问弹一次确认，选择“本次会话内始终允许”后
                        覆盖监工与全部工作进程。未授权时启动日志输出“未下发宿主令牌”。
                        --worker-visible 为每个工作进程打开独立控制台窗口
  supervise-stop        请求监工退出（下一 tick 生效）
  serve [--status]      Windows 专用启动器，由 capitalist install 拉起。
                        --detach 依赖启动器，未运行时重跑 capitalist install；--status 查看是否在运行
  auth                 已移除：插件不把令牌写入磁盘，认证只用宿主自身的登录态
  auth-check [--agent <id>] [--no-probe] [--json]
                      检查宿主能否正常调用模型。输出探测结果与令牌来源，
                      登录被拒时给出下一步动作。--agent 缺省取该任务的工作进程宿主；
                      --no-probe 跳过探测，只报告令牌来源。可用时退出码 0，其余 1。
  pause ["<原因>"]      写 .capitalist/pause.json：下一 tick 起不派新单，运行中的进程被停止，对应派单退回排队
  resume [--user]       删除 .capitalist/pause.json：下一 tick 起恢复派单。属用户动作：
                        非交互终端（宿主会话代执行）默认拒绝，须加 --user 表示用户已明确要求；
                        看板“恢复调度”按钮不经过本命令。暂停的旧派单由 capitalist wake --user 唤醒
  next [--session <名>] 领取一张派单（外部会话作为工作进程时使用）
  wake [<派单id|分片>] [--user]
                        唤醒暂停的派单；省略目标时唤醒本任务根全部暂停单。
                        暂停由监工启动时写入（上次退出时未完成），不阻塞新派单；
                        唤醒属用户动作：非交互终端默认拒绝，须加 --user
  workers [--json]      各工作进程的 pid / 宿主 / 派单 / 状态
  reload [--status] [--hold <秒>] [--json]
                        上下文重载：写入进度快照（阶段/已达标验收项/每片状态/未处理插话/
                        未裁决提问/重派计数）-> 压缩心跳、tick 与已完成明细 ->
                        切换对话会话 -> 写出恢复计划。已做但未验证的条目由监工下一 tick
                        派复验单；已完成且证据齐全的条目不重派。
                        --status 输出状态；--hold 延长看板“监工重载中”的显示时间
  report <派单id> --status done|failed --note "..." [--outcome "<编号>=<结论>;…"]
                        工作进程上报，由工作进程内部调用
                        --outcome 为派单正文中的每条用户插话给出结论，编号取正文里的 [方括号]；
                        结论取 done / not_mine（标明归属派单）/ blocked（标明阻塞原因），
                        可在结论后用冒号补充说明。未给出结论的条目阻止结单，并输出可复制的命令行。

指令与中断
  say "<文本>" [--shard <分片>] [--thread <线程>]
                        给派单追加一条消息，写入 .capitalist/direct.jsonl。
                        未开工的派单在启动时并入原派单；执行中的派单由 hook 在
                        下一次工具调用前送达，不中断进程，送达后标记已用
  direct "<文本>" [--shard <分片>] [--thread <线程>]
                        与 say 等价（同一实现）；动作名与看板 action=direct 一致
  takeover [<分片>] [--reason "<原因>"]
                        接管指定分片（省略分片时为整个任务根）：写入 .capitalist/takeover.json，
                        监工暂停该分片的自动重派与自动验收，直到 release
  release [<分片>]      交还被接管的分片，恢复监工自动重派与自动验收
  stop-worker <id>      中断指定工作进程：结束其进程，并把它的派单按失败结单
                        （下一 tick 重派，分片被接管或登记阻塞时除外）
  close <派单id|worker-id|分片> [--reason "<原因>"]
                        手动结项：运行中与排队中的派单均可关闭，状态置为终态 closed 并写记录；
                        监工不再为它补派单
  promote <派单id|worker-id|分片>
                        手动插队：将排队中的派单提到队首，下一轮填槽时最先拉起
                        （有空槽时立即拉起；不越过并行度与暂停状态，不新建派单）

文件锁
  lock status [<路径>]  输出锁的持有者、持有时长与排队项；省略路径时列出全部
  lock release <路径> [--force]
                        释放指定锁；--force 不校验持有者
  lock reap             回收持有者进程已退出且心跳超时的锁；监工每 tick 自动执行

  board [--port 7788] [--host 127.0.0.1] [--secure] [--json]
                        实时看板：工作进程状态、派单与回报流水，页面按间隔轮询状态。
                        --secure 校验访问 key；缺省不校验
                        --json 输出单次快照
  feed [--limit N] [--json]
                        回报流水（工作进程上报、判死、阶段推进）最近 N 条

查看
  status [--json]       当前阶段 / 门槛 / 档位
  brief                 极短状态（hook 注入用）
  mode [档位] [--json]  查看或切换权限档位：${modeNames().join(" | ")}

预检与安装
  gate --text <命令> | --req <文件> [--json]
                        红线预检，不执行命令
  fire --req <文件> [--authorized "<授权原话>"] [--gap 秒]
                        请求体判定：BLOCK 拒绝，NEED_USER 需授权原文，按 gap 限速
  local-check --path <路径> [--action read|write|delete] [--json]
                        本机边界预检
  hosts [--json]        列出所有宿主 impl 的 id / 别名 / 能力
  install [--agent <宿主…>] [--all] [--yes] [--dry-run] [--verbose]
                        安装 hook 与手册。必须指定宿主：--agent 取值见宿主表，--all 安装到
                        全部已检测宿主；交互终端下省略时进入选择菜单。hook 写入当前项目的
                        <配置目录>/settings.local.json，手册写入用户目录；换项目时在该项目
                        目录再执行一次
  uninstall [--agent <宿主…>] [--all] [--keep-skill] [--verbose]
                        卸载 hook 与手册；省略 --agent 时进入选择菜单，保留任务数据
  check-update [--force]
                        与 npm 上的版本比对；结论缓存 24 小时，--force 重新联网

  --version             输出版本号；缓存中有新版本结论时附一行提示
`;

/**
 * 单命令帮助。
 *
 * 条目说明生效时机：未开工的派单并入原派单，执行中的派单由 hook 送达；中断会触发重派。
 */
export const COMMAND_HELP: Record<string, string> = {
  say: `capitalist say "<文本>" [--target <派单id>] [--lineage <血缘>] [--shard <分片>] [--thread <线程>]
给派单追加一条消息。
  - 写入 .capitalist/direct.jsonl，字段 at / text / target / lineage / shard / thread / consumed
  - 未开工的派单：监工派单时读取未消费消息拼进 action，追加内容并入原派单，消费后标记 consumed
  - 执行中的派单：hook 在工作进程下一次工具调用前把消息随拒绝理由送达模型，不中断进程；
    送达后标记已用（consumed_via=hook），不重复注入
  - 记录 consumed_by / consumed_at / consumed_via，标明接收派单与送达方式，
    台账另有 direct_inject（登记）与 direct_deliver（送达）事件
  - --target 将消息绑定到指定派单或其同血缘重派单；绑定到工作进程时不转发给其他派单
  - 不带定位参数时对下一次任意派单生效；带 --shard 时只对目标分片的派单生效
  - --thread 用于界面回显归属，不改变生效范围`,
  direct: `capitalist direct "<文本>" [--shard <分片>] [--thread <线程>]
与 capitalist say 等价（同一实现、同一文件、同一生效时机）。动作名与看板 POST /api/command 的 action=direct 一致。
  - 写入 .capitalist/direct.jsonl；未开工的派单并入原派单，执行中的派单由 hook 送达`,
  takeover: `capitalist takeover [<分片>] [--reason "<原因>"]
接管指定分片。省略分片时为整个任务根。
  - 写入 .capitalist/takeover.json，记 root / shard / at / reason / active
  - 生效时机：下一 tick 起监工不自动重派该分片，也不自动验收该分片
  - 不终止运行中的进程；中断进程使用 capitalist stop-worker
  - 交还：capitalist release [<分片>]`,
  release: `capitalist release [<分片>]
交还被接管的分片。省略分片时交还全部接管项。
  - 把 .capitalist/takeover.json 里对应条目的 active 置为 false，并记 released_at
  - 生效时机：下一 tick 起监工恢复该分片的自动重派与自动验收`,
  "stop-worker": `capitalist stop-worker <worker-id>
中断指定工作进程。
  - 结束该进程（SIGTERM），并把它的派单按失败结单
  - 下一 tick 重派该派单；分片被接管（capitalist takeover）或登记阻塞（capitalist block）时除外
  - worker-id 由 capitalist workers 输出`,
  close: `capitalist close <派单id|worker-id|分片> [--reason "原因"]
手动结项：运行中与排队中的派单均可关闭。
  - 派单状态置为终态 closed，写 done_at / closed_at / closed_by / note
  - 存在运行中的进程时，先结单再发送 SIGTERM。顺序反转会使进程退出回调先按 failed 结单，
    下一 tick 触发重派
  - 写 dispatch_closed 事件到 .capitalist/events.jsonl（含原状态、是否发送过 SIGTERM）
  - planDispatch 不为 closed 分片补单，requiredDone 计入 closed，关闭分片不阻塞阶段推进
  - stop-worker 中断进程并触发重派；close 关闭派单且不再补单
  - 目标写法：派单 id（D-…）、worker id（W-…）、分片名或 shard:xxx（排队行）`,
  reload: `capitalist reload [--status] [--hold <秒>] [--json]
监工上下文重载：从事件台账提取进度，切换会话后继续执行。
  - 写入 .capitalist/reload/snapshot.json（+ history/ 副本）：当前阶段、已达标的验收项、
    每片的最后状态与未完成条目、用户未处理的插话、未裁决提问、重派计数
  - 压缩成 .capitalist/reload/context.md：移除心跳 / 重复 tick / 已完成条目详情 / 一次性调试输出；
    保留需求原文、未完成项、决策结论、待复验清单
  - 切换监工对话会话（capitalist-chat-r<gen>），原会话中的工具输出不再读取
  - 写 .capitalist/reload/resume.json：done_verified 不重派；done_unverified（已做但未验证）
    由监工下一 tick 派 source=reverify 的复验单，不按完成处理
  - 重载期间看板监工面板显示“监工重载中”，结束后隐藏（.capitalist/reload/active.json）
  - 生效时机：复验单在下一 tick 由监工补出；阶段推进与门槛判定不受影响`,
};
