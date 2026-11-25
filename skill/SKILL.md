---
name: capitalist
version: 0.1.52
agent_created: true
description: capitalist（监工进程）。监工是独立进程（capitalist supervise），工作进程由它拉起，各自独立；本会话只启动监工、读取状态、回报结论，不执行派单内的工作。适用于多节点、跨会话、易偏离、有硬性红线、需持续核验进度的任务。触发词：capitalist、监督、盯着做、自动推进、别中断、开新进程、换进程、上下文太长、上下文压缩、会话一长就糊涂、多进程协调、一个进程执行一个监督、不想每一步都给指令、谁来把关、按流程走、照着流程走、监督这个任务、让它自己跑、装 capitalist、开监督、给我盯一下。
---

# capitalist 监工操作手册

本会话执行监工侧命令，不执行派单内的工作，不代工作进程上报。监工与工作进程在独立进程中运行。表格按现象与处理组织。

## 1. 接入状态

本插件由用户安装并接入宿主。本会话不执行 `npm i -g`，也不执行 `capitalist install`。

| 现象 | 处理 |
|---|---|
| `capitalist --version` 输出版本号 | 已安装 |
| 返回 `command not found` | 执行 `npm prefix -g` 取前缀，用 `<前缀>/capitalist`（Windows 为 `<前缀>/capitalist.cmd`）的绝对路径调用 |
| 回复中无 `【capitalist 已生效 …】` 注入行 | 告知用户尚未接入，由用户处理 |

`capitalist supervise` 的 `--agent` 取值：

| 当前宿主 | `--agent` 值 |
|---|---|
| WorkBuddy | `workbuddy` |
| CodeBuddy | `codebuddy` |
| ClaudeCode | `claude-code` |

## 2. 启动监工

注意：在 WorkBuddy 中，本会话不启动监工。宿主会话的凭证授权仅对单条命令有效，命令结束后即失效，不足以支撑常驻进程。
需要启动时按宿主说明在终端执行（见本节「宿主说明」）。
其他宿主可正常启动，监工与工作进程自动在非交互终端运行：

```bash
capitalist supervise "<目标>" --agent <宿主>
```

`--agent` 取值见第 1 节表格

本会话用 `capitalist status` 确认状态：

| 输出 | 处理 |
|---|---|
| `监工：在线（pid …，心跳 Ns 前更新）` | 已在运行 |
| 无监工记录 | 未启动或启动报错，请用户查看终端输出 |

监工运行期间，本会话仍可操作同一任务根：`capitalist status`、`capitalist workers`、`capitalist tasks`、`capitalist inbox` 查询状态，`capitalist ask` 提问，`capitalist answer` 回填裁决。这些命令只读写 `.capitalist` 下的文件，监工下一轮读取。

- 启动后有两种状态，均等待用户动作：
  - 存在未完成事项：上次退出时未完成的派单（`open` / `claimed` / `reported` / `review`）逐张标记暂停，不执行。暂停是派单级标记：宿主侧新派入的单不受影响，可立即执行；被暂停的派单继续占用所属分片，不补派、不重派。该步骤不能跳过。
  - 不存在上述事项：进入待命。派单全部结单即为该状态，队列中保留已结单记录不影响判定。此状态不派单，等待用户派单。
- 两种状态下进程都保持在线，不自动退出。
- 派单的执行与恢复由用户在监工面板操作。本会话不执行 `capitalist wake`、`capitalist resume`、`capitalist dispatch`，也不代为裁决。
- 队列中的旧派单可能已过时；按过时口径继续执行会改错文件或覆盖已修内容。用户要求唤醒某张派单时，应先说明其可能已过时，由用户在面板确认后操作。
- `capitalist resume` 解除的是全局暂停（`capitalist pause` 写入的 `.capitalist/pause.json`），不解除逐单暂停。
- `capitalist start` 只创建任务根，不写入派单，不拉起工作进程，不替代 `capitalist supervise`。
- 用户未明确要求时严禁派单，保持监工待命，缺省使用 minimal 守卫。
- 确认在线后，汇报面板地址与当前状态；除非用户明确要求，不再做其他工作。

### 宿主说明

按当前宿主指定，不得跨宿主运行。部分宿主要求工作空间读写权限，首次运行时需授予。

- WorkBuddy / CodeBuddy
  - 两者合并安装。`workbuddy` 不是可执行命令，监工只能通过 `codebuddy -p` 调度。

- WorkBuddy 中的注意事项
  - 无终端可用时处于“受限模式”，需先解除。
  - 监工不在 WorkBuddy 的命令通道内启动，由用户在终端执行 `capitalist supervise --agent workbuddy`。

- ClaudeCode
  - 宿主为 ClaudeCode 时，监工通过 `claude -p` 调度。

### 看板地址交付

访问 key 缺省不校验，地址不带 key。`--secure` 下校验：每次启动生成新的 key，不带 key 访问返回“需要访问 key”说明页。

启动后（`capitalist supervise` 或 `capitalist board`）提供完整地址。仅端口号不足以访问。

地址可从以下三处读取，内容一致：

- 启动命令的输出：`[看板] http://127.0.0.1:7788/`（`--secure` 时形如 `http://127.0.0.1:7788/?key=xxxxxxxx`）
- `capitalist status` 输出里的 `board_url`
- `.capitalist/supervisor.json` 的 `board_url`

约束：

1. `--secure` 下 key 每次重启变更，旧链接失效，需重新提供地址。
2. `--secure` 下交付地址保留 `?key=` 原样。首次访问后浏览器以会话 cookie 保存，关闭浏览器后失效。
3. 在别的机器上查看时，把 `127.0.0.1` 换成监工主机的局域网 IP，端口不变（`--secure` 下 key 亦不变）。局域网访问需以 `capitalist board --host 0.0.0.0` 另起看板（`supervise --agent` 指定的是宿主 id），监工自带的看板固定监听回环地址；对外开放时同时传 `--secure`。

地址在每次启动后提供，与用户是否询问无关。

之后按输入内容选动作：

| 输入                   | 动作                                      |
| ------------------- | -------------------------------------- |
| “给这个项目开监督” / “盯着这个项目” | 给出终端启动命令，由用户执行；启动后用 `capitalist status` 确认，回报 pid 与守卫名 |
| “现在到哪了”/“当前状态”       | `capitalist workers` + `capitalist status`，输出摘要，不贴原文 |
| “验证码 123456”/“授权了”  | 转交该值，再执行 `capitalist unblock --type <类型>`    |
| “这个先别动”/“只读”        | `capitalist mode plan`                        |
| “停”                 | `capitalist supervise-stop`                   |
| 长时间无输入               | 执行 `capitalist workers` 确认工作进程状态          |

## 3. 进程模型

监工为独立常驻进程。工作进程由监工拉起，一张派单对应一个进程。

| 角色   | 进程                                  | 职责               | 启动方       |
| ---- | ------------------------------------ | ----------------- | --------- |
| 监工进程 | `capitalist supervise`，前台常驻                   | 建根、选定守卫、派单、验收、回收重派 | 用户终端 |
| 工作进程 | 独立宿主进程（`claude -p` / `codebuddy -p`） | 执行当前派单           | 监工        |
| hook | 宿主在工作进程内调用的判定层                       | 拦截红线、注入状态          | 安装时写入     |

```
监工进程（capitalist supervise）  ← 派单 / 验收 / 回收
    │ 读守卫
    ▼
守卫 policy.json            ← 红线、本机边界、判据来源
    │ 读任务树（台账里的 parent / after）
    │ 派单（.capitalist/inbox/dispatch.jsonl）
    ▼
工作进程 A / B / C         ← 各自独立 pid、会话与上下文，上下文互相隔离
    │ 上报（capitalist report）
    ▼
监工进程                   ← 验收、按任务树派下一张单
```

- 并行度只由 `--workers` 决定；在途派单各占一条并发线，空出的位置留待后续派单。
- 每个工作进程有独立 pid、会话与上下文，记录与日志各自一份。

## 4. 职责边界

启动监工(非WorkBuddy)：
```bash
capitalist supervise "<目标>" --policy <守卫名> --agent <宿主>   # 前台常驻，关闭终端后下线
```

本会话可执行的命令：

```bash
capitalist supervise-stop                                    # 停止监工
capitalist workers                                           # 工作进程列表与状态
capitalist status                                            # 任务树进度与门槛
capitalist inbox / capitalist answer <id> "<指导>"           # 监工暂停派单时回填裁决
capitalist mode plan                                         # 切换为 plan 档
```

以下命令不由本会话执行：

| 命令 | 归属 |
|---|---|
| `capitalist adopt` | 更换守卫由用户执行（`capitalist adopt --policy <名|路径>`） |
| `capitalist wake` / `capitalist resume` / `capitalist dispatch` | 派单的执行与恢复由用户在监工面板确认后操作 |
| `capitalist report` | 派单上报由工作进程执行 |
| `capitalist worker <进程号>` | 只读查询单个工作进程的动作时间线 |
| 直接修改 `.capitalist/` | 台账是判定输入，由命令写入 |
| 代工作进程修改代码或文档 | 改动记入工作进程的上下文 |

追加需求时先执行 `capitalist workers` 确认该派单是否有工作进程在执行。无工作进程时，启动新监工或将需求纳入下一张派单。

### 派单内容规范

`capitalist supervise` 目标、派单 action 与 `capitalist answer` 回填内容按以下规则编写：

1. 阅读收到的 skill、文档或任务描述。理解不明确时先澄清，不向工作进程转发原始表述。
2. 派单内容包含目标、作用对象与完成判据，表述无歧义，不沿用口语原文。
3. 派单内容只写工作内容。排序与依赖用派单的 `PARENT:` / `AFTER:` 行表达，并行由分片与 `--workers` 决定，不写入工作进程提示词。
4. 派单末尾写入语言要求：工作进程的思考过程、回复与产出文案使用与用户相同的语言，代码与既有标识符除外。
5. 涉及用户可见文案的派单附措辞标准，其余派单不附。
6. 按本单工作内容挑选相关技能，在正文里点明技能名与要用的步骤。被点名的技能正文会自动附进工作进程提示词，未点名的只给路径。整份技能不照抄。

## 5. 监工行为

- 心跳写 `.capitalist/supervisor.json`，hook 据此判断监工是否存活。
- 调度按固定间隔轮询（默认 5 秒，`--tick <秒>` 可改）：每轮刷新心跳与租约、热加载守卫、消费看板指令；暂停与待命期间不派单。
- 带暂停标记的派单不参与派发与领取（`capitalist next`），也不因同分片缺单而被补派；只有唤醒后重新进入候选。
- 有未裁决问题（`capitalist ask` 登记的 open 项）时暂停派单，等待 `capitalist answer`。
- 工作进程心跳超时或 pid 消失时记 `exited` / `failed`，将该派单判定为失败并重派。
- 没有在途单、也没有等待退避补派的链时记 `supervisor_done`，转入待命，进程不退出。派单全部结单才进该状态；失败待补派的链仍算未完成。
- 通道不可用时整个任务待命：不派单、不重派。该状态保留五分钟，恢复后自动继续；重新启动监工立即清除。
- 该状态下的可见信号是在看板发消息时返回“对话通道不可用”。
- 监工退出时终止其拉起的工作进程。

## 6. 任务树

派单台账是一组多节点结构：一张派单最多关联一个父节点‘父节点可以是一组任务，同组任务可并行；父节点完成后子派单才可启动；父节点相同即兄弟；没有父节点的派单自成一棵树。

```bash
capitalist tree                  # 输出树结构与节点状态
capitalist tree next             # 下一轮将派出的单（等待前置的不计）
capitalist tree rebuild          # 输出重建计划，不写台账
capitalist tree rebuild --apply  # 写入重建结果
```

重建规则：

- 按正文归组。正文相同的派单为同一事项的多次尝试，保留一张待办，其余置为 `closed` 并注明“并入代表单 X”。
- 组内存在完工记录时整组不进入树：完工派单保留，失败派单置为 `closed` 并注明“同一件事已完成于 X”。
- 树边只取台账中已有的 `parent` / `after`。父节点已完工的边不重建，子派单按根节点处理，输出中列明。
- 不删除台账行，不改写历史状态。关闭的派单状态为 `closed`，历史记录保留。
- 幂等。第二次 `--apply` 输出“没有需要改的行”。

监工启动后在首个 tick 前检查台账：未完工派单（`open` / `claimed` / `review`；`reported` 不计入）超过一张且均无父节点时执行一次重建，输出“已重建 N 棵树（未完工 M 单）”。存在带父节点的未完工派单时不触发。

## 7. 命令速查

| 目的         | 命令                                                               |
| ---------- | ---------------------------------------------------------------- |
| 启动监工      | `capitalist supervise "<目标>" --policy <守卫名> --agent <宿主> [--workers N]`|
| 停止监工      | `capitalist supervise-stop`                                             |
| 唤醒暂停单     | 由用户在监工面板“已暂停”下逐单唤醒（本会话不执行 `capitalist wake`）              |
| 工作进程       | `capitalist workers [--json]`                                           |
| 状态         | `capitalist status [--json]` / `capitalist brief`                              |
| 待裁决        | `capitalist inbox` / `capitalist answer <id> "<指导>"`                           |
| 阻塞         | `capitalist block <类型> "<原因>"` / `capitalist unblock --type <类型>`              |
| 违规消解       | `capitalist correct --rule <规则> --note "…"`                             |
| 待复核        | `capitalist review` / `capitalist review resolve <序号>`                         |
| 派单树        | `capitalist tree` / `capitalist tree next` / `capitalist tree rebuild [--apply]`      |
| 红线预检       | `capitalist gate --text '<命令>'`                                         |
| 本机路径预判     | `capitalist local-check --path <p> --action read\|write\|delete`        |
| 档位         | `capitalist mode [plan\|default\|accept_edits\|bypass]`                 |

工作进程侧命令（`capitalist record` / `capitalist ledger` / `capitalist report`）由工作进程执行，本会话不调用。

## 8. 写守卫

守卫是纯 JSON 文件，放在包的 `policies/<名>.policy.json`。它只声明任务边界与判据来源，不声明流程：没有阶段，也没有工序，步骤顺序由任务树表达。最小结构：

```json
{
  "name": "my-domain",
  "domain": "领域名",
  "description": "这份守卫约束什么",
  "context": "完成口径与判据来源",
  "redlines": [
    { "id": "R1", "level": "BLOCK", "label": "禁止项",
      "pattern": "正则", "skip_if": "^(?:grep|rg)\\b", "fix": "正确做法" }
  ],
  "local_guard": {
    "allow_roots": ["/path/to/work"],
    "sensitive_paths": ["~/.ssh", "/etc"],
    "sensitive_names": [".env", "id_rsa"]
  },
  "env_notes": { "summary": "环境前提，以探测结果为准" }
}
```

| 字段 | 用途 |
|---|---|
| `name` | 守卫名，`--policy` 用它引用 |
| `domain` / `description` | 这份守卫管什么，报错与看板上显示 |
| `context` | 判据来源：完成口径、用户原话与惯例冲突时以谁为准、报告写到什么程度 |
| `redlines` | 命令与操作的正则规则，命中后按 `level` 处理 |
| `local_guard` | 本机路径边界：可以写的范围、敏感路径、敏感文件名与通配 |
| `env_notes` | 环境前提。只写“以探测结果为准”，不写死平台与工具链 |

### 放宽边界

当边界阻止必须执行的操作时，应放宽边界，并在守卫中写明放宽的代价。放宽入口有三处：

1. 改守卫文件：`local_guard.allow_roots` 加目录，或给红线改 `level`、补 `skip_if`。这份守卫下的所有任务根都生效。
2. `capitalist justify <路径> "<理由>" --ttl <秒>`：临时放行一个越界路径，放行记入待复核。
3. `capitalist adopt --policy <名|路径>`：给已有任务根更换守卫。

### 红线级别判定表

| level       | 行为    |
| ----------- | ----- |
| `BLOCK`     | 阻止执行    |
| `NEED_USER` | 需当次授权 |
| `WARN`      | 放行并记录提示 |

标注 `defer: "local_delete"` 后，删除命令交由路径判定。

## 9. 故障处理

| 现象                                                  | 处理                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `capitalist supervise` 报找不到工作进程宿主                          | 本机未安装 claude / codebuddy 的 CLI。告知用户安装其中一个，或更换机器运行监工                                |
| 监工已启动但无工作进程                                           | 读取 `.capitalist/workers/*.log`，确认宿主 CLI 可执行且工作空间可读写                                                                              |
| 工作进程启动后立即退出（`capitalist workers` 显示 exited）                     | 读取 `↳ 原因` 行：上游返回 429（账号配额或频率限制）时更换账号                                                                                    |
| 报“监工不在宿主会话内启动”                                  | 属正常拦截。把终端启动命令交给用户执行                                                                                 |
| 终端启动后 `capitalist status` 无监工记录                     | 启动命令已退出。查看用户终端窗口里的报错输出                                                                           |
| WorkBuddy 启动后对话与派单报“对话通道不可用”                    | 宿主 CLI 登录态不可用。执行 `capitalist auth-check` 确认；不可用时在终端运行 `codebuddy` 并输入 `/login` |
| 监工进程被系统终止，工作进程一起退出                        | Windows Job 连带终止 `guard`，`.capitalist/guard.log` 无记录。重启监工后重派 |
| 窗口停在“是否信任此目录”                                       | 交互式启动会提示信任确认，按 1 完成确认；需要无提示时用 `-p` |
| 报 `EADDRINUSE 127.0.0.1:xxxxx`                      | 宿主环境变量被派生进程继承（`SERVER__PORT`）。当前版本继承整份环境并剔除宿主会话变量；出现该错误表明版本过旧 |
| 工作进程一直不结束                                           | `capitalist workers` 读取心跳；超时后监工判定失败并重派，也可执行 `capitalist supervise-stop` 后读取日志                                                                |
| 监工反复派同一单                                            | 验收未通过而工作进程上报完成：读 `capitalist status` 的未达项与验收判据，补齐判据或补入具体差距后再重派                                                                          |
| 监工不派单且无 open 问题                                     | 存在 claimed 单且工作进程心跳仍在；等待心跳结束，或结束工作进程由监工重派                                                                                      |
| 启动后队列有单但不执行                                       | 这些单带暂停标记（上次中断未完成）：`capitalist status` 显示暂停单数，由用户在面板“已暂停”下逐单唤醒；新派单不受影响                                    |
| 回复中无 `【capitalist 已生效 …】` 注入行                    | 告知用户尚未接入，由用户处理                    |

## 10. 不调用的命令

本会话不调用：`setup`、`rotate-worker`、`handoff`、`daemon`、`alerts`、`verdicts`、`ctx status`、`notes`、`scan-reply`、`violations`、`pack`、`role`。

`capitalist worker <进程号>` 已实现，输出该工作进程的身份、统计与最近 15 条动作，只读；本会话不调用，归属见第 4 节。

| 原用途                             | 对应操作                                   |
| ------------------------------- | --------------------------------------- |
| `rotate-worker` / `handoff` 更换工作进程 | 判定失败后重派；更换宿主时执行 `capitalist supervise-stop` 后重新启动 |
| `daemon` / `alerts` 实时通道        | 无常驻 IPC；状态存放于 `.capitalist/`，在 hook 调用时读取           |
| `pack` 派单                       | 建单时写 `PARENT:` / `AFTER:` 连成任务树，由监工派发    |
| `capitalist violations` 查看违规            | 读取 `.capitalist/violations.jsonl`               |

