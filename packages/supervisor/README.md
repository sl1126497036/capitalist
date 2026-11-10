# capitalist

把长任务交给一个外部监工进程：契约定义阶段与验收门槛，红线拦截破坏性命令，证据台账留存改动与结论。

`capitalist` 是跨 agent 的多任务协调工具。负责维持和监管多进程AI调度：派单、验收、拦截、留痕。工作进程仍是各宿主自己的会话（`claude -p` / `codebuddy -p`），各自持有 pid 与上下文，互不共享。

## 安装

```bash
npm i -g capitalist
capitalist install          # 选择要接入的 agent，写入 hook 配置并投放监工手册
```

环境要求：Node.js ≥ 18.17；macOS / Windows；工作进程宿主需提供非交互入口。

### 关于WorkBuddy和CodeBuddy的合并安装

由于会话进程依赖CodeBuddy -p 模式，当前WorkBuddy和CodeBuddy的需要合并安装。所以你可以在WorkBuddy桌面端正常使用当前插件功能，但是最终账号凭证来自CodeBuddy。

## 快速开始

```bash
# 在项目目录启动监工，创建任务根与本地看板
capitalist supervise "把计费服务拆成独立模块" --contract minimal

# 启动时默认暂停派单，确认队列后恢复
capitalist resume

# 查看状态与在看途工作进程
capitalist status
capitalist workers
```

启动日志会输出带访问 key 的看板地址（形如 `http://127.0.0.1:7788/?key=…`），同一地址也出现在 `capitalist status` 的 `board_url` 里。看板可恢复派单、查看阶段与在途进程、写入新指令、进度问询。

## 解决的问题

| Agent存在的问题 | 本插件方案 |
|---|---|
| 长任务中断 | 监工扮演用户角色自主裁决，放行、拦截、报告验收 |
| 长上下文污染 | 每个工作进程独立 pid、会话与上下文；`capitalist reload` 写进度快照并生成恢复计划 |
| 并行冲突 | 并行文件操作加锁；`parallel` 分片各对应一个工作进程，改动范围按分片隔离 |
| 反复输入指令 | 宿主 hook 在提交输入时注入当前阶段、未达标项与下一步动作 |

## 契约

契约是纯 JSON 文件，定义阶段、门槛、红线与本机边界。包内内置 `minimal` 契约，提供不预设行业知识的三阶段流程：需求确认 → 执行 → 交付前复核。
当执行复杂流程时指令时，监工会自动创建契约，也可以明确指定要求创建。
```json
{
  "name": "my-domain",
  "stages": [
    { "id": "S0", "name": "需求确认", "next": "写需求要点",
      "done": { "type": "file_exists", "path": "docs/plan.md" } }
  ],
  "redlines": [
    { "id": "R1", "level": "BLOCK", "label": "禁止删除任务根外内容",
      "pattern": "\\brm\\s+-rf\\s+/", "fix": "只删任务根内的文件" }
  ]
}
```

阶段声明 `parallel` 后按分片并行；未声明的阶段并行度固定为 1。

## 常用命令

| 用途 | 命令 |
|---|---|
| 启动与停止 | `capitalist supervise "<目标>"`、`capitalist supervise-stop` |
| 暂停与恢复 | `capitalist pause`、`capitalist resume` |
| 查看状态 | `capitalist status`、`capitalist workers`、`capitalist board` |
| 推进与裁决 | `capitalist advance`、`capitalist ask`、`capitalist answer` |
| 干预在途任务 | `capitalist say`、`capitalist takeover`、`capitalist promote` |
| 证据与预检 | `capitalist record`、`capitalist ledger`、`capitalist gate` |
| 上下文重载 | `capitalist reload` |
| 安装与卸载 | `capitalist install`、`capitalist uninstall`、`capitalist hosts` |

全部子命令见 `capitalist --help`。

## 宿主支持

| 宿主 | 配置位置 |
|---|---|
| Claude Code | `~/.claude/settings.json` |
| CodeBuddy | `~/.codebuddy/settings.json` |
| WorkBuddy | `~/.workbuddy/settings.json` |
| generic | `~/.capitalist/hooks.json` |

```bash
capitalist hosts                           # 全部宿主实现及其声明的能力
capitalist-hook --selftest --agent <id>    # 该宿主的事件映射
```

四个生命周期点（`UserPromptSubmit`、`PreToolUse`、`Stop`、`PreCompact`）都需要解析到处理器；输出 `unknown` 表示该点不生效。

## 适用范围

适用：跨多个会话的编码任务；有阶段与验收判据的任务；需要留存改动与结论的任务；按分片并行改动不同文件的任务；需要对破坏性命令做统一拦截的 agent 会话。

不适用：单轮问答与一次性脚本；终端里直接执行的动作；工作内容的质量判定。hook 只覆盖装有它的 agent 会话，红线只判定命令文本。

## 数据位置

任务数据在任务目录的 `.capitalist/` 下：`state.json`（目标、契约、阶段）、`inbox/`（派单与提问队列）、`*.jsonl`（事件、任务、复核、违规台账）、`workers/`（工作进程记录与日志）、`reload/`（快照与恢复计划）。该目录不进入版本库。

## 链接

- 仓库与完整文档：<https://github.com/sl1126497036/capitalist>
- 问题反馈：<https://github.com/sl1126497036/capitalist/issues>

## 许可证

Apache License 2.0。Copyright 2026 sl1126497036 (https://github.com/sl1126497036)。全文见 [LICENSE](LICENSE)，归属声明见 [NOTICE](NOTICE)，第三方组件许可见 [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES)。
