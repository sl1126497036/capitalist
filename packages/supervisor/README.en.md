# capitalist

Hand long tasks to an external supervisor process: a contract defines stages and acceptance gates, redlines block destructive commands, and an evidence ledger keeps changes and conclusions.

`capitalist` is a cross-agent coordination tool for multi-task work. It keeps AI processes running and supervised: dispatch, acceptance, interception and record keeping. Work processes remain each host's own sessions (`claude -p` / `codebuddy -p`), each holding its own pid and context, sharing nothing.

## Install

```bash
npm i -g capitalist
capitalist install          # choose an agent; writes the hook config and installs the supervisor manual
```

Requirements: Node.js ≥ 18.17; macOS / Windows; the work-process host must offer a non-interactive entry point.

### Installing WorkBuddy and CodeBuddy together

Because session processes rely on the CodeBuddy `-p` mode, WorkBuddy and CodeBuddy are installed together. The plugin works in the WorkBuddy desktop app, but the account credentials come from CodeBuddy.

## Quick start

```bash
# Start the supervisor in the project directory; creates the task root and the local board
capitalist supervise "split the billing service into its own module" --contract minimal

# Dispatch is paused at startup; resume once the queue looks right
capitalist resume

# Inspect state and running work processes
capitalist status
capitalist workers
```

The startup log prints the board address with its access key (for example `http://127.0.0.1:7788/?key=…`), and the same address appears in `board_url` from `capitalist status`. From the board you can resume dispatch, inspect stages and running processes, write new instructions and ask about progress.

## Problems it solves

| Agent problem | Approach |
|---|---|
| Long tasks getting interrupted | The supervisor acts as the user and adjudicates on its own: release, interception, reporting and acceptance |
| Long contexts getting polluted | Every work process has its own pid, session and context; `capitalist reload` writes a progress snapshot and produces a resume plan |
| Parallel work colliding | Parallel file operations are locked; each `parallel` shard maps to one work process and changes are isolated per shard |
| Instructions having to be repeated | The host hook injects the current stage, unmet items and the next action at prompt submission |

## Contract

A contract is a plain JSON file defining stages, gates, redlines and local boundaries. The package ships the `minimal` contract: a three-stage flow with no assumed domain knowledge (requirement confirmation → execution → pre-delivery review).
When a request describes a complex flow, the supervisor creates a contract automatically; it can also be asked to create one explicitly.
```json
{
  "name": "my-domain",
  "stages": [
    { "id": "S0", "name": "requirement confirmation", "next": "write the key requirements",
      "done": { "type": "file_exists", "path": "docs/plan.md" } }
  ],
  "redlines": [
    { "id": "R1", "level": "BLOCK", "label": "no deleting outside the task root",
      "pattern": "\\brm\\s+-rf\\s+/", "fix": "only delete files inside the task root" }
  ]
}
```

A stage that declares `parallel` runs by shard; stages without it have a fixed parallelism of 1.

## Common commands

| Purpose | Command |
|---|---|
| Start and stop | `capitalist supervise "<target>"`, `capitalist supervise-stop` |
| Pause and resume | `capitalist pause`, `capitalist resume` |
| Inspect state | `capitalist status`, `capitalist workers`, `capitalist board` |
| Advance and adjudicate | `capitalist advance`, `capitalist ask`, `capitalist answer` |
| Intervene in running work | `capitalist say`, `capitalist takeover`, `capitalist promote` |
| Evidence and pre-checks | `capitalist record`, `capitalist ledger`, `capitalist gate` |
| Context reload | `capitalist reload` |
| Install and remove | `capitalist install`, `capitalist uninstall`, `capitalist hosts` |

All subcommands are listed in `capitalist --help`.

## Supported hosts

| Host | Config location |
|---|---|
| Claude Code | `~/.claude/settings.json` |
| CodeBuddy | `~/.codebuddy/settings.json` |
| WorkBuddy | `~/.workbuddy/settings.json` |
| generic | `~/.capitalist/hooks.json` |

```bash
capitalist hosts                           # every host implementation and its declared capabilities
capitalist-hook --selftest --agent <id>    # the event mapping for that host
```

All four lifecycle points (`UserPromptSubmit`, `PreToolUse`, `Stop`, `PreCompact`) must resolve to a handler; an `unknown` output means that point has no effect.

## Scope

Applicable: coding tasks spanning several sessions; tasks with stages and acceptance criteria; tasks that must retain changes and conclusions; tasks that change different files in parallel shards; agent sessions that need uniform blocking of destructive commands.

Not applicable: single-turn Q&A and one-off scripts; actions run directly in a terminal; judging the quality of the work. The hook only covers agent sessions that have it installed, and redlines only judge command text.

## Where data lives

Task data sits under `.capitalist/` in the task directory: `state.json` (target, contract, stage), `inbox/` (dispatch and question queues), `*.jsonl` (events, tasks, reviews, violations), `workers/` (work process records and logs), `reload/` (snapshots and resume plans). The directory never enters version control.

## Links

- Repository and full documentation: <https://github.com/sl1126497036/capitalist>
- Issue tracker: <https://github.com/sl1126497036/capitalist/issues>

## License

Apache License 2.0. Copyright 2026 sl1126497036 (https://github.com/sl1126497036). See [LICENSE](LICENSE) for the full text, [NOTICE](NOTICE) for attribution, and [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES) for third-party licenses.
