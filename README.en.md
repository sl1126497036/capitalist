<div align="center">

# Capitalist

[![Node 18.17+](https://img.shields.io/badge/node-18.17%2B-blue.svg)](https://nodejs.org/)

[中文](README.md)

</div>

An AI-driven multi-task scheduling plugin: each task has its own context, and a resident supervisor process schedules them all.
Designed and tested by humans, implemented by Deepseek-V4.1-Flash.

## What it does

`capitalist` is a cross-agent AI plugin that automates AI process scheduling and helps the user complete task acceptance.

| Agent pain point | What this plugin does |
|---|---|
| Long tasks getting interrupted | The supervisor takes the user's role, adjudicates long tasks on its own, and performs release, interception, reporting and acceptance |
| Long contexts getting polluted | Each worker holds its own pid, session and context, with no sharing between them; `capitalist reload` writes a progress snapshot, compacts heartbeats and completed details, switches session and produces a resume plan |
| Parallel work colliding | Parallel file operations are locked; for tasks that carry a contract, each `parallel` shard maps to one worker process and the files it touches are isolated per shard |
| Instructions having to be repeated | The host hook injects the current stage, unmet gate items and the next action at prompt submission. No user intervention is needed |

## Install

npm commands:

```bash
npm i -g capitalist
capitalist install          # pick the agents to wire up, write hook entries, place the skill
```

Requirements: Node.js ≥ 18.17; macOS / Linux / Windows; the worker host needs a non-interactive entry point (`claude -p`, `codebuddy -p`).

### Combined installation of WorkBuddy and CodeBuddy

Session processes depend on CodeBuddy's `-p` mode, so WorkBuddy and CodeBuddy are currently installed together. The plugin remains usable in the WorkBuddy desktop app, but the account credentials ultimately come from CodeBuddy.

## Quick use in a host

With the skill installed, say this directly in the host:

- Start a supervisor process and finish the billing service migration.
- Add a login-page integration task to the supervisor.
- Start a supervisor for this project and create a contract following the "xxx" skill flow.

The host runs `capitalist supervise`, which creates a task root in the current directory and starts the resident supervisor. "Add a task" requests go through `capitalist say`: folded into a dispatch that has not started, or delivered by the hook before the next tool call for one already running. The trigger list is in `skill/SKILL.md`.

The supervisor board works as well: the startup log prints a board address, in the form `http://127.0.0.1:7788/`, and the same address appears as `board_url` in `capitalist status`. The board resumes dispatching, shows stages and in-flight workers, accepts new instructions and adjudicates questions. The access key is not checked by default; with `--secure` the printed address carries a `?key=`, which changes on every start.

## Scenarios

Tasks can be issued directly in the host or through the supervisor board.

### 1. Coding tasks: frontend and backend in parallel

In a coding task, the supervisor can let the frontend and backend proceed independently according to the project requirements, then create integration and automated test processes once both sides finish coding.

You can: create a custom contract that writes the frontend and backend as two `parallel` shards, one dispatch and one worker process per shard; put integration and automated tests in a later stage, and create those dispatches once the preceding stage's `done` gate is met. The bundled `minimal` contract has only three stages (requirements, execution, pre-delivery review) and carries no domain split, so this layout needs a separate contract.

### 2. Security tasks: batch dispatch and per-domain splits

In a security task, a skill can be combined to dispatch vulnerability research across multiple sites in one request, with the supervisor enforcing redlines and accepting results as the skill requires; a single site can also be split per subdomain and dispatched to multiple processes once asset collection finishes.

You can: split multiple sites into per-site shards, and split one site into subdomain shards in a later stage. Destructive commands are intercepted by the `BLOCK` rules in the contract's `redlines`, matched against command text; hits go to `violations.jsonl`, and already-allowed out-of-boundary actions can be reviewed later with `capitalist review`. Acceptance is based on evidence written by `capitalist record` and `capitalist ledger`. Contract fields and gate types are in section 8 of `skill/SKILL.md`.

## Details

### Process model

| Role | Started by | Responsibility |
|---|---|---|
| Supervisor process | `capitalist supervise`, resident | Create the task root, select a contract, dispatch, verify, recycle and requeue |
| Worker process | Independent host process (`claude -p` / `codebuddy -p`) | Execute the current dispatch; each holds its own pid, session and context |
| Host hook | Called by the host at session lifecycle points | Inject state and judge commands against contract redlines and the filesystem boundary |

`capitalist` provides three executables: the main command `capitalist`, the short name `cap`, and the hook entry `capitalist-hook`. `capitalist board` serves a local board on `127.0.0.1:7788` (moving to the next free port when taken, local machine only).

### One task, end to end

1. Run `capitalist supervise "<goal>" --contract minimal` in the project directory. The command creates `.capitalist/`, writes `state.json` and `inbox/`, and starts the resident supervisor and the local board.
2. Click "Resume dispatching" on the board, run `capitalist resume`, or start with `--auto-start`. The supervisor writes dispatches from the current stage's `next` / `parallel` definitions and spawns one independent worker process per dispatch.
3. Inside a worker session, the host calls the hook at prompt submission to inject the current stage, unmet gate items and the next action. Before each tool call, the hook matches the command against contract redlines and the filesystem boundary; a `BLOCK` hit denies execution.
4. The worker writes evidence with `capitalist record` and closes its dispatch with `capitalist report`. The supervisor verifies against the stage's `done` checks; a stage advances when its gate is met and the dispatch is requeued otherwise.
5. State remains on disk after a session ends or a process exits. Running `capitalist supervise` again reuses the same task root; `capitalist reload` produces a snapshot and a resume plan, and the next tick adds re-verification dispatches.

### Contracts

A contract is a JSON file defining stages, gates, redlines and the filesystem boundary. `packages/supervisor/contracts/minimal.contract.json` ships with the repository and provides a three-stage flow with no domain assumptions.

```json
{
  "name": "my-domain",
  "domain": "domain name",
  "stages": [
    { "id": "S0", "name": "stage name", "goal": "why", "next": "next action",
      "done": { "type": "file_exists", "path": "docs/plan.md" } }
  ],
  "redlines": [
    { "id": "R1", "level": "BLOCK", "label": "prohibited action",
      "pattern": "regex", "skip_if": "^(?:grep|rg)\\b", "fix": "correct approach" }
  ],
  "local_guard": {
    "sensitive_paths": ["~/.ssh", "/etc"],
    "sensitive_names": [".env", "id_rsa"]
  }
}
```

A stage declaring `parallel` runs one dispatch and one worker process per shard. A stage without `parallel` has a fixed parallelism of 1; `--workers > 1` does not increase it. `--contract` takes a bundled name or a path to a contract JSON. When a new task root is created without `--contract`, `supervise` generates a contract from the goal and falls back to the bundled contract if generation fails.

### Task root and data

`capitalist supervise` creates `.capitalist/` in the task directory. Main files:

| File | Contents |
|---|---|
| `state.json` | Goal, contract, current stage, next action |
| `inbox/dispatch.jsonl` / `inbox/qa.jsonl` | Dispatch queue / open questions |
| `events.jsonl` / `tasks.jsonl` / `review.jsonl` | Event ledger / task pool / items awaiting review |
| `violations.jsonl` / `justify.jsonl` | Redline hits / registered exceptions |
| `supervisor.json` / `workers/` | Supervisor heartbeat and board URL / worker records and logs |
| `sessions.json` / `reload/` | Session registry / snapshots, compacted context, resume plans |

The repository `.gitignore` excludes this directory, so task data does not enter version control.

### Common commands

| Purpose | Commands |
|---|---|
| Start and stop | `capitalist supervise "<goal>" --contract minimal`, `capitalist supervise-stop` |
| Pause and resume | `capitalist pause`, `capitalist resume` |
| Wake old dispatches | `capitalist wake [<dispatch id\|shard>]` (add `--user` in a non-interactive terminal) |
| Inspect state | `capitalist status`, `capitalist workers`, `capitalist board` |
| Advance and adjudicate | `capitalist advance`, `capitalist ask "<question>"`, `capitalist answer <id> "<guidance>"` |
| Intervene in running work | `capitalist say "<text>"`, `capitalist takeover [shard]`, `capitalist promote <target>` |
| Evidence and pre-checks | `capitalist record <name> <json>`, `capitalist ledger <add\|list\|assert>`, `capitalist gate --text '<cmd>'` |
| Context reload | `capitalist reload` |
| Install and uninstall | `capitalist install`, `capitalist uninstall`, `capitalist hosts` |

`capitalist --help` lists every subcommand and its arguments; the division between supervisor-side and worker-side commands is section 4 of `skill/SKILL.md`.

### Terms

| Term | Meaning |
|---|---|
| Host / hook | Agent CLI providing model calls and sign-in; the hook is its judgement entry point at session lifecycle points |
| Task root | Project directory containing `.capitalist/state.json`; commands search upward for the nearest one |
| Contract | JSON file defining stages, gates, redlines and the filesystem boundary |
| Stage / gate | Ordered steps in the contract and their `done` checks; `capitalist advance` is refused while a gate is unmet |
| Dispatch / shard | Work unit written to `inbox/dispatch.jsonl`; each `parallel` shard maps to one worker process |
| Redline / filesystem boundary | Regular expressions over command text and path ranges defined in the contract; levels are `BLOCK` / `NEED_USER` / `WARN` |
| Permission mode | `plan` / `default` / `accept_edits` / `bypass`; adjusts how strictly rules are applied |
| Evidence ledger | JSONL files under `.capitalist/` recording requirements, changes, verdicts and violations |
| Board | Local HTTP page showing stages, dispatches, worker processes and report feed |

### Supported hosts

| Host | Config location | Notes |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | Applies immediately |
| CodeBuddy | `~/.codebuddy/settings.json` | Unavailable as a worker host in restricted environments |
| WorkBuddy | `~/.workbuddy/settings.json` | Same `hooks` schema as Claude Code; commands run through a POSIX shell |
| generic | — | POSIX exit-code path when no host is detected |

### Scope and limitations

Applies to: coding tasks spanning several sessions; tasks with stages and acceptance criteria; tasks whose changes and verdicts need to be retained; tasks that modify different files in parallel shards; agent sessions that need a common interception rule for destructive commands.

Does not apply to: single-turn questions and one-off scripts; commands run directly in a terminal; assessment of work content. Hooks cover only agent sessions where they are installed, and redlines judge command text.

### Project structure

```
packages/supervisor/    npm package: engine, host impls, CLI, installer
  src/core/             contracts, redlines, filesystem boundary, modes, gates, ledgers
  src/host/             interface + registry + dispatch; impl/<id>/ per agent
  src/cli/              `capitalist` command line
  src/supervisor/       resident supervisor process: dispatch loop, workers, board
  contracts/            bundled contract: minimal
skill/                  agent skill (installed into each host's skills directory)
```

### License

Apache License 2.0. Copyright 2026 sl1126497036 (https://github.com/sl1126497036). See [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party notices are in [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).
