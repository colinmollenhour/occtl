# occtl

Extended CLI for managing [OpenCode](https://opencode.ai) sessions. Adds the commands missing from the `opencode` CLI: reading messages, watching sessions in real-time, sending prompts, responding to permission requests, managing worktrees, and more.

Built for automating and orchestrating OpenCode sessions externally -- including [Ralph Loop](#ralph-loop) and [parallel worktree](#worktrees) workflows.

## Install

```bash
npm install -g occtl
```

## Quick Start

```bash
# List sessions for the current directory
occtl session list

# Get the last assistant message
occtl session last

# Watch a session stream in real-time
occtl session watch --text-only

# Send a prompt and wait for the response
occtl session send "fix the failing tests"

# Auto-approve all permission requests
occtl session respond --auto-approve --wait

# Run a task in an isolated worktree
occtl worktree run auth -w "implement JWT authentication"
```

The `session` subcommand can be shortened to `s`, `worktree` to `wt`:

```bash
occtl s ls
occtl s last
occtl s send -w "refactor the auth module"
occtl wt run payments -w "add Stripe checkout"
```

## Server Detection

`occtl` auto-detects a running OpenCode server by inspecting processes. Override with environment variables:

```bash
export OPENCODE_SERVER_HOST=127.0.0.1
export OPENCODE_SERVER_PORT=4096
```

## Commands

### Session Commands

| Command | Description |
|---------|-------------|
| `session list` | List sessions (filters by cwd, supports `--all`, path arg, `--sort`, `--asc`) |
| `session create` | Create a new session (`-q` for just the ID, `-t` for title) |
| `session get` | Get detailed session info |
| `session messages` | List messages (`--role`, `--limit`, `--text-only`, `--verbose`) |
| `session last` | Get the last message (text-only by default) |
| `session status` | Check session status (idle/busy/retry) |
| `session watch` | Watch session events via SSE (`--text-only`, `--json`, `--events`) |
| `session send` | Send a message (`--async`, `--wait`, `--model`, `--agent`, `--stdin`) |
| `session respond` | Respond to permission requests (`--auto-approve`, `--wait`) |
| `session todo` | View the session's todo list |
| `session abort` | Abort a running session |
| `session diff` | Show file changes in a session |
| `session children` | List child sessions (sub-agents) |
| `session share` | Share a session and get a public URL |
| `session unshare` | Remove sharing from a session |
| `session wait-for-text` | Block until a message contains given text, then exit 0 |
| `session wait-for-idle` | Block until a session goes idle |
| `session wait-any` | Wait for first of N sessions to go idle, output its ID |
| `session is-idle` | Non-blocking idle check (exit 0=idle, 1=busy) |
| `session summary` | Compact overview: status, todos, cost, last message snippet |

### Worktree Commands

| Command | Description |
|---------|-------------|
| `worktree list` | List git worktrees |
| `worktree create` | Create a worktree with branch and optional session |
| `worktree remove` | Remove a worktree |
| `worktree run` | Create worktree + session + send prompt (one-liner) |

### Other Commands

| Command | Description |
|---------|-------------|
| `install-skill` | Install the occtl skill as an OpenCode user-level skill |
| `view-skill` | Display the bundled SKILL.md |

All commands that accept a session ID support partial matching and title search. When no ID is given, the most recent session is used.

All commands support `--json` for machine-readable output.

### Send Modes

```bash
# Default: synchronous, blocks until the agent responds
occtl s send "fix the bug"

# Async: fire and forget
occtl s send --async "fix the bug"

# Wait: send async, block until session idle, show result
occtl s send --wait "fix the bug"
```

## Worktrees

`occtl worktree` manages git worktrees for parallel, isolated sessions. Each worktree gets its own branch and directory under `.occtl/worktrees/`, so multiple agents can work on different features without conflicts.

```bash
# Create a worktree with a session
occtl wt create auth-feature

# Run a prompt in a new worktree (one-liner)
occtl wt run auth-feature -w "implement JWT authentication"

# Run 3 features in parallel
occtl wt run auth "implement JWT auth" &
occtl wt run payments "add Stripe checkout" &
occtl wt run dashboard "build analytics dashboard" &
wait

# List worktrees
occtl wt ls

# Clean up
occtl wt rm auth-feature
```

## OpenCode Skill

`occtl` ships with a SKILL.md that teaches OpenCode agents how to use `occtl`. Install it as a user-level skill:

```bash
occtl install-skill
```

This copies the skill to `~/.config/opencode/skills/occtl/`. Restart OpenCode to pick it up. The skill includes full command reference, Ralph Loop templates, and worktree patterns.

To view the skill without installing:

```bash
occtl view-skill
```

## Ralph Mode

The [Ralph Loop](https://ghuntley.com/ralph/) is an autonomous coding pattern where an AI agent works through tasks in a loop with fresh context each iteration. Traditionally this requires a bash script to drive the loop.

`occtl` eliminates the bash script entirely. With Ralph Mode, **the agent IS the orchestrator**. It creates sessions, sends prompts, monitors progress, handles failures, and keeps iterating — all through `occtl` commands. No bash wrapper needed.

To start: tell your agent "Use the occtl skill to complete project X using Ralph Mode." The skill teaches the agent to:

1. Break work into atomic tasks (`tasks.md`)
2. Create a fresh session per task (`occtl s create`)
3. Send the worker a prompt with context (`occtl s send --async`)
4. Wait for completion (`occtl s wait-for-idle`)
5. Evaluate output (`occtl s summary`, `occtl s last`)
6. Repeat until all tasks are done

### Parallel Execution

```bash
# Agent creates 3 sessions for independent tasks
SID1=$(occtl s create -q -t "task-auth")
SID2=$(occtl s create -q -t "task-payments")
SID3=$(occtl s create -q -t "task-dashboard")

# Sends prompts to all three
occtl s send --async "implement JWT auth..." -s $SID1
occtl s send --async "add Stripe checkout..." -s $SID2
occtl s send --async "build dashboard..." -s $SID3

# Waits for first to finish, evaluates, dispatches next
DONE=$(occtl s wait-any $SID1 $SID2 $SID3)
occtl s summary $DONE
```

For conflicting work, use worktrees:

```bash
occtl wt run auth -w "implement JWT auth"
occtl wt run payments -w "add Stripe checkout"
```

See `occtl view-skill` for the full Ralph Mode guide.

## Why Not Just Use opencode CLI?

The `opencode` CLI provides `session list` and `session delete`. Everything else in `occtl` is additive:

- **Read messages** from any session
- **Watch** sessions in real-time via SSE
- **Send prompts** programmatically (sync, async, or wait-for-idle)
- **Respond** to permission requests (including continuous auto-approve)
- **Wait for text** in agent output (event-driven, not polling)
- **Create** sessions for fresh-context workflows
- **Worktrees** for parallel, isolated agent execution
- **Share/unshare** sessions
- **Inspect** todos, diffs, children, and status

## License

MIT
