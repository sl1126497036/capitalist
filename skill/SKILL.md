---
name: capitalist
version: 0.1.3
agent_created: true
description: capitalist（监工进程）。监工是独立进程（capitalist supervise），工作进程由它拉起，各自独立；本会话只启动监工、读取状态、回报结论，不执行业务代码。适用于多阶段、跨会话、易偏离、有硬性红线、需持续核验进度的任务。触发词：capitalist、监督、盯着做、自动推进、别中断、开新进程、换进程、上下文太长、上下文压缩、会话一长就糊涂、多进程协调、一个进程执行一个监督、不想每一步都给指令、谁来把关、按流程走、照着流程走、监督这个任务、让它自己跑、装 capitalist、开监督、给我盯一下。
---

# capitalist 监工操作手册

本会话执行监工侧命令，不执行业务代码，不代工作进程上报。监工与工作进程在独立进程中运行。表格按现象与处理组织。

## 1. 安装检查

按表中顺序检查，命中即执行对应处理：

| 现象 | 处理 |
|---|---|
| `capitalist --version` 输出版本号 | 已安装，进入第 2 节 |
| 报 `command not found` | 执行 `npm i -g capitalist` |
| 仍找不到 `capitalist` | 执行 `npm prefix -g` 取前缀，用 `<前缀>/capitalist`（Windows 为 `<前缀>/capitalist.cmd`）的绝对路径调用 |
| 需要安装 hook | 执行 `capitalist install --agent <宿主>`，取值见下表 |

安装后验证：发送一条消息，回复中显示 `【capitalist 已生效 …】` 注入行表示 hook 生效。未显示时重启宿主；仍未显示按第 9 节排查。

| 当前宿主       | `--agent` 值   | 配置写入位置                          |
| ------------- | ------------- | --------------------------------- |
| WorkBuddy   | `workbuddy`   | `~/.workbuddy/settings.json`            |
| ClaudeCode | `claude-code` | `~/.claude/settings.json`               |
| CodeBuddy   | `codebuddy`   | `~/.codebuddy/settings.json`            |

## 2. 启动监工

执行一条命令：

```bash
capitalist supervise "<目标>" --contract <契约名> --agent <宿主>
```

`--agent` 取值见第 1 节表格，填当前所在环境对应的值。

监工由常驻任务持有，在后台运行。不使用 `--detach`，不使用前台运行。

- 子进程环境由监工自动处理：拉起工作进程、对话通道与判定通道时，均按前缀剔除 `ACC_PRODUCT_CONFIG*` 与 `SERVER__*`，启动命令不需要额外参数或环境处置。
- 下面这条自检只用于人工诊断：宿主注入的 `ACC_PRODUCT_CONFIG_PATH` 会让直接调用的 CLI 按桌面端身份认证，返回 `Authentication required`。`env -u ACC_PRODUCT_CONFIG -u ACC_PRODUCT_CONFIG_PATH -u ACC_PRODUCT_CONFIG_V2 -u ACC_PRODUCT_CONFIG_V3 -u SERVER__PORT codebuddy -p "reply ok"`，stdout 打出文本才算通；退出码 0 而 stdout 为空按未通过处理。
- 常驻任务由任务管理器持有，命令不占用用户会话，监工持续运行。
- `--detach` 的自检窗口为 30 秒。宿主在约第 37 秒终止整棵进程树（Windows 上为 Job 对象），此时自检已输出「心跳已确认」。`detached` 使进程脱离控制台，不脱离 Job。
- 前台运行占用用户会话，期间无法继续输入。
- 启动后执行 `capitalist status`，输出应为「监工：在线（pid …，心跳 Ns 前更新）」。仅输出「已启动」表示心跳尚未确认。
- 启动后有两种状态，均等待用户动作：
  - 存在未完成事项：上次退出时未完成的派单（`open` / `claimed` / `reported` / `review`）逐张标记暂停，不执行。暂停是派单级标记：宿主侧新派入的单不受影响，可立即执行；被暂停的单继续占住所属分片，不补派、不重派。`--auto-start` 跳过该步，连同旧单一并派发。
  - 不存在上述事项：进入待命。派单全部结单即为该状态，队列中保留已结单记录不影响判定。此状态不派单，等待用户派单。
- 两种状态下进程都保持在线，不自动退出。
- 唤醒暂停单（除非来自用户指令，否则不擅自运行，避免唤醒过时任务）：`capitalist wake [<派单id|分片>] --user`，省略目标时唤醒本任务根全部暂停单；看板在「已暂停」筛选下逐单唤醒。唤醒后按队列顺序参与调度。
- `capitalist resume` 解除的是全局暂停（`capitalist pause` 写入的 `.capitalist/pause.json`），不解除逐单暂停。
- `capitalist start` 只创建任务根，不写入派单，不拉起工作进程，不替代 `capitalist supervise`。

### 宿主说明

按当前宿主指定，不得跨宿主运行。部分宿主要求工作空间读写权限，首次运行时需授予。

- WorkBuddy / CodeBuddy
  - 两者合并安装。`workbuddy` 不是可执行命令，监工只能通过 `codebuddy -p` 调度。
  - 宿主为 WorkBuddy 时凭证仍取自 CodeBuddy。出现登录提示或凭证校验失败时，让用户在 CodeBuddy 中执行 `/login`。
- ClaudeCode
  - 宿主为 ClaudeCode 时，监工通过 `claude -p` 调度。
  
### 看板地址交付

访问 key 缺省不校验，地址不带 key。`--secure` 下校验：每次启动生成新的 key，不带 key 访问返回「需要访问 key」说明页。

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
| 「给这个项目开监督」/「盯着这个项目」 | 执行 `capitalist supervise`，回报 pid 与契约名 |
| 「现在到哪了」/「当前状态」       | `capitalist workers` + `capitalist status`，输出摘要，不贴原文 |
| 「验证码 123456」/「授权了」  | 转交该值，再执行 `capitalist unblock --type <类型>`    |
| 「这个先别动」/「只读」        | `capitalist mode plan`                        |
| 「停」                 | `capitalist supervise-stop`                   |
| 长时间无输入               | 执行 `capitalist workers` 确认工作进程状态          |

## 3. 进程模型

监工为独立常驻进程。工作进程由监工拉起，一张派单对应一个进程。

| 角色   | 进程                                  | 职责               | 启动方       |
| ---- | ------------------------------------ | ----------------- | --------- |
| 监工进程 | `capitalist supervise`，常驻                   | 建根、选定契约、派单、验收、回收重派 | 本会话（一条命令 + 常驻任务持有） |
| 工作进程 | 独立宿主进程（`claude -p` / `codebuddy -p`） | 执行当前派单           | 监工        |
| hook | 宿主在工作进程内调用的判定层                       | 拦截红线、注入状态          | 安装时写入     |

```
监工进程（capitalist supervise）  ← 派单 / 验收 / 回收
    │ 读契约
    ▼
契约 contract.json         ← 阶段门槛与红线
    │ 派单（.capitalist/inbox/dispatch.jsonl）
    ▼
工作进程 A / B / C         ← 各自独立 pid、会话与上下文，上下文互相隔离
    │ 上报（capitalist report）
    ▼
监工进程                   ← 验收、阶段推进、下一轮派单
```

- 无 `parallel` 分片的阶段只有一个工作进程；提高 `--workers` 不增加并行度，监工也拒绝超出分片数的并行度。
- 每个工作进程有独立 pid、会话与上下文，记录与日志各自一份。

## 4. 职责边界

本会话可执行的命令：

```bash
capitalist supervise "<目标>" --contract <契约名> --agent <宿主>   # 启动监工，由常驻任务持有
capitalist supervise-stop                                    # 停止监工
capitalist wake [<派单id|分片>] --user                        # 唤醒上次未完成、启动时被暂停的派单
capitalist workers                                           # 工作进程列表与状态
capitalist status                                            # 阶段与门槛
capitalist inbox / capitalist answer <id> "<指导>"                  # 监工暂停派单时回填裁决
capitalist mode plan                                         # 切换为 plan 档
```

以下命令由监工或工作进程执行：

| 命令                          | 归属                       |
| --------------------------- | ------------------------ |
| `capitalist advance` / `capitalist adopt` | 阶段推进与契约切换由监工在验收后执行 |
| `capitalist report`                | 派单上报由工作进程执行           |
| `capitalist worker <进程号>`        | 只读查询单个工作进程的动作时间线      |
| 直接修改 `.capitalist/`                  | 台账是判定输入，由命令写入         |
| 代工作进程修改代码或文档              | 改动记入工作进程的上下文           |

追加需求时先执行 `capitalist workers` 确认该派单是否有工作进程在执行。无工作进程时，启动新监工或将需求纳入下一张派单。

### 派单内容规范

`capitalist supervise` 目标、契约阶段目标、分片 action 与 `capitalist answer` 回填内容按以下规则编写：

1. 阅读收到的 skill、文档或任务描述。理解不明确时先澄清，不向工作进程转发原始表述。
2. 派单内容包含目标、改动范围与完成判据，表述无歧义，不沿用口语原文。
3. 派单内容只写工作内容。排序、依赖与并行由契约阶段、分片或多次派单安排，不写入工作进程提示词。
4. 派单末尾写入语言要求：工作进程的思考过程、回复与产出文案使用与用户相同的语言，代码与既有标识符除外。
5. 涉及用户可见文案的派单附措辞标准，其余派单不附。
6. 按本单工作内容挑选相关技能，在正文里点明技能名与要用的步骤。被点名的技能正文会自动附进工作进程提示词，未点名的只给路径。整份技能不照抄。

## 5. 监工行为

- 心跳写 `.capitalist/supervisor.json`，hook 据此判断监工是否存活。
- 调度按固定间隔轮询（默认 5 秒，`--tick <秒>` 可改）：每轮刷新心跳与租约、热加载任务列表、消费看板指令；暂停与待命期间不派单。
- 带暂停标记的派单不参与派发与领取（`capitalist next`），也不因同分片缺单而被补派；只有唤醒后重新进入候选。
- 有未裁决问题（`capitalist ask` 登记的 open 项）时暂停派单，等待 `capitalist answer`。
- 工作进程心跳超时或 pid 消失时记 `exited` / `failed`，判死该派单并重派。
- 末阶段门槛达标时记 `supervisor_done`，转入待命，进程不退出；非末阶段达标时推进到下一阶段并派单。
- 监工退出时终止其拉起的工作进程。

## 6. 派单树

派单台账是一组多节点结构：一张派单最多挂一个父节点，父节点完成后子派单才可启动；父节点相同即兄弟；没有父节点的派单自成一棵树。

```bash
capitalist tree                  # 输出树结构与节点状态
capitalist tree next             # 下一轮将派出的单（等待前置的不计）
capitalist tree rebuild          # 输出重建计划，不写台账
capitalist tree rebuild --apply  # 写入重建结果
```

重建规则：

- 按正文归组。正文相同的派单为同一事项的多次尝试，保留一张待办，其余置为 `closed` 并注明「并入代表单 X」。
- 组内存在完工记录时整组不进入树：完工派单保留，失败派单置为 `closed` 并注明「同一件事已完成于 X」。
- 树边只取台账中已有的 `parent` / `after`。父节点已完工的边不重建，子派单按根节点处理，输出中列明。
- 不删除台账行，不改写历史状态。关闭的派单状态为 `closed`，历史记录保留。
- 幂等。第二次 `--apply` 输出「没有需要改的行」。

监工启动后在首个 tick 前检查台账：未完工派单（`open` / `claimed` / `review`）超过一张且均无父节点时执行一次重建，输出「已重建 N 棵树（未完工 M 单）」。存在带父节点的未完工派单时不触发。

监工运行期间不执行 `npm run build`。

`npm run build` 覆盖 `packages/supervisor/dist/`。进程在写入期间加载模块会读到不完整的输出，导出异常在首次请求时才显现。

构建顺序：

```bash
capitalist supervise-stop      # 停止监工
npm run build           # 编译
npm test                # 测试
capitalist supervise "..." --auto-start   # 启动监工，由常驻任务持有
```

运行 `npm test`。`scripts/run-tests.mjs` 设三项限制：

- 单个测试超过 30 秒判为失败；
- 测试结束后强制退出，不等待残留句柄（`supervise --once` 拉起的监工进程不会自动退出）；
- 整体上限 180 秒，超时中止并返回退出码 124。

耗时随改动与机器负载变化，并发进程数增加时耗时上升。退出码 124 表示本轮未在时限内结束：改为运行相关测试文件，或以 `CAPITALIST_TEST_TIMEOUT_MS=600000 npm test` 放宽上限。

运行单个测试文件：

```bash
timeout 120 node --test test/rebuild-tree.test.js
```

## 7. 命令速查

| 目的         | 命令                                                               |
| ---------- | ---------------------------------------------------------------- |
| 启动监工      | `capitalist supervise "<目标>" --contract <契约名> --agent <宿主> [--workers N]`（常驻任务持有） |
| 停止监工      | `capitalist supervise-stop`                                             |
| 唤醒暂停单     | `capitalist wake [<派单id|分片>] --user`                                  |
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
| 写入 hook     | `capitalist install [--agent <宿主>] [--dry-run]`                          |

工作进程侧命令（`capitalist record` / `capitalist ledger` / `capitalist report`）由工作进程执行，本会话不调用。

### 登录态

工作进程沿用宿主自己的登录态，认证与续期由宿主 CLI 完成。插件不读取账号、不保存凭证、不使用令牌。

宿主启动子进程时会把 `ACC_PRODUCT_CONFIG_PATH` 一并传下去。子进程读到它即按桌面端身份认证；桌面端凭证与桌面进程绑定、不能转交，于是报 `Authentication required`。剔除该变量后 CLI 回到自身身份，用独立凭证即可通过。重新登录不解决这个问题。

看板对话通道与工作进程共用同一套环境构造，同样经剔除后调用 CLI。

自检：`env -u ACC_PRODUCT_CONFIG -u ACC_PRODUCT_CONFIG_PATH -u ACC_PRODUCT_CONFIG_V2 -u ACC_PRODUCT_CONFIG_V3 -u SERVER__PORT codebuddy -p "reply ok"`，stdout 打出文本才算通。退出码 0 而 stdout 为空按未通过处理。

宿主沙箱另会拦截凭证目录读取，剔除变量后仍失败时按此排查。本机不同 CLI 版本行为一致，换版本不解决该问题。

不在回复中输出账号、令牌或凭证路径。

## 8. 写契约

契约是纯 JSON 文件，定义阶段、阶段门槛、红线与本机边界。最小结构：

```json
{
  "name": "my-domain",
  "domain": "领域名",
  "stages": [
    { "id": "S0", "name": "阶段名", "goal": "为什么做", "next": "下一步动作",
      "done": { "type": "file_exists", "path": "docs/plan.md" } }
  ],
  "redlines": [
    { "id": "R1", "level": "BLOCK", "label": "禁止项",
      "pattern": "正则", "skip_if": "^(?:grep|rg)\\b", "fix": "正确做法" }
  ],
  "local_guard": {
    "sensitive_paths": ["~/.ssh", "/etc"],
    "sensitive_names": [".env", "id_rsa"]
  }
}
```

### 并行分片（多工作进程）

阶段声明 `parallel` 后按分片并行：每片一张派单、一个独立进程。

```json
{
  "id": "S2",
  "name": "实现",
  "parallel": [
    { "id": "api", "action": "改接口层，完成后 capitalist record changes '{\"shard\":\"api\"}'" },
    { "id": "ui",  "action": "改界面层，完成后 capitalist record changes '{\"shard\":\"ui\"}'" }
  ],
  "done": { "type": "jsonl_min", "file": "changes.jsonl", "min": 2 }
}
```

未声明 `parallel` 的阶段并行度固定为 1，传入 `--workers > 1` 不生效。

### 门槛类型判定表

`done.type` 取值如下，未知类型按未达标处理：

`file_exists`、`glob_min`、`jsonl_min`、`jsonl_all_field`、`jsonl_status_min`、`jsonl_status_none`、`json_keys`、`json_eq`、`file_contains_all`、`glob_all_contains`、`mtime_after_stage`、`evidence_complete`、`all_of`、`any_of`。

### 红线级别判定表

| level       | 行为    |
| ----------- | ----- |
| `BLOCK`     | 阻止执行    |
| `NEED_USER` | 需当次授权 |
| `WARN`      | 放行并记录提示 |

标 `defer: "local_delete"` 将删除命令交由路径判定。

## 9. 故障处理

| 现象                                                  | 处理                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `capitalist supervise` 报找不到工作进程宿主                          | 本机未安装 claude / codebuddy 的 CLI。安装其中一个（`npm i -g @tencent-ai/codebuddy-code`），或更换机器运行监工                                |
| 监工已启动但无工作进程                                           | 读取 `.capitalist/workers/*.log`，确认宿主 CLI 授权状态与非交互入口                                                                              |
| 工作进程启动后立即退出（`capitalist workers` 显示 exited）                     | 读取 `↳ 原因` 行：上游返回 429（账号配额或频率限制）时更换账号                                                                                    |
| `--detach` 启动后监工消失                                    | 不使用 `--detach`。自检窗口为 30 秒，宿主约在第 37 秒回收整棵进程树（Job），自检仍报「心跳已确认」。改用常驻任务持有                            |
| 常驻任务里起的监工被终止，工作进程会一起退出                        | Windows Job 连带终止 `guard`，`.capitalist/guard.log` 无记录。监工终止后所有工作进程退出，重启后重派 |
| 报 `Authentication required` | 先按第 2 节自检：stdout 有文本说明身份变量未剔净，检查 `ACC_PRODUCT_CONFIG*` / `SERVER__*`；stdout 为空则在宿主 CLI 完成登录后重启监工 |
| 窗口停在「是否信任此目录」                                       | 交互式启动会提示信任确认。改用默认后台模式，`-p` 不提示信任；交互式启动按 1 完成授权                                                                               |
| 报 `EADDRINUSE 127.0.0.1:xxxxx`                      | 宿主环境变量被派生进程继承（`SERVER__PORT`）。当前版本继承整份环境并剔除宿主会话变量；出现该错误表明版本过旧 |
| 工作进程一直不结束                                           | `capitalist workers` 读取心跳；超时后监工判死重派，也可执行 `capitalist supervise-stop` 后读取日志                                                                |
| 监工反复派同一单                                            | 门槛未达标而工作进程上报完成：检查 `capitalist status` 的未达项，按需调整契约的 `done`                                                                          |
| 监工不派单且无 open 问题                                     | 存在 claimed 单且工作进程心跳仍在；等待心跳结束，或结束工作进程由监工重派                                                                                      |
| 启动后队列有单但不执行                                       | 这些单带暂停标记（上次中断未完成）：`capitalist status` 显示暂停单数，`capitalist wake --user` 唤醒；新派单不受影响                                    |
| 回复中无 `【capitalist 已生效 …】` 注入行                    | 按第 1 节表格读取该宿主的 `settings.json`，确认 `hooks` 含 capitalist 条目且命令路径存在；缺失或路径失效时执行 `capitalist install --agent <宿主>` 重写                    |

## 10. 不调用的命令

本会话不调用：`setup`、`rotate-worker`、`handoff`、`daemon`、`alerts`、`verdicts`、`ctx status`、`notes`、`scan-reply`、`violations`、`pack`、`role`。

`capitalist worker <进程号>` 已实现，输出该工作进程的身份、统计与最近 15 条动作，只读；本会话不调用，归属见第 4 节。

| 原用途                             | 对应操作                                   |
| ------------------------------- | --------------------------------------- |
| `rotate-worker` / `handoff` 换进程 | 监工判死重派；更换宿主时执行 `capitalist supervise-stop` 后重新启动 |
| `daemon` / `alerts` 实时通道        | 无常驻 IPC；状态在 `.capitalist/`，hook 调用时读           |
| `pack` 派单                       | 写入契约的 `stage.next` 或 `parallel`，由监工派    |
| `capitalist violations` 查看违规            | 读取 `.capitalist/violations.jsonl`               |

## 11. 文本规范

改动注释、界面文案或文档时客观陈述，不留日期与过程记录，不用口语词，术语统一。

提交前按客观陈述、术语统一、无日期与过程记录三项自查。

界面文案改动需同步 `web/src/lib/i18n.js` 的中文条目、全部引用点与英文译文；删除引用后检查字典是否留下无引用条目。
