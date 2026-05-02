# occtl

Extended CLI for managing [OpenCode](https://opencode.ai) sessions. Adds the commands missing from the `opencode` CLI: reading messages, watching sessions in real-time, sending prompts, responding to permission requests, managing worktrees, and more.

Built for automating and orchestrating OpenCode sessions externally -- including [Ralph Mode](#ralph-mode), [session handoff](#use-cases), and [parallel worktree](#worktrees) workflows.

## Install

```bash
npm install -g @colinmollenhour/occtl
```

## Quick Start

```bash
# List sessions for the current directory
occtl list

# Get the last assistant message
occtl last

# Watch a session stream in real-time
occtl watch --text-only

# Send a prompt and wait for the response
occtl send "fix the failing tests"

# Auto-approve all permission requests
occtl respond --auto-approve --wait

# One-shot prompt: create + send + wait + write — optionally with its own opencode server
occtl run --spawn --model openai/gpt-5.4 --file ./prompt.md --out ./result.md

# Run a task in an isolated worktree
occtl worktree run auth -w "implement JWT authentication"
```

`worktree` can be shortened to `wt`:

```bash
occtl wt run payments -w "add Stripe checkout"
```

## Server Detection

`occtl` auto-detects a running OpenCode server by inspecting processes. Override with environment variables:

```bash
export OPENCODE_SERVER_HOST=127.0.0.1
export OPENCODE_SERVER_PORT=4096
export OPENCODE_SERVER_PASSWORD=...   # if the server requires HTTP Basic auth
```

## Commands

| Command | Description |
|---------|-------------|
| `list` (`ls`) | List sessions (filters by cwd, supports `--all`, path arg, `--sort`, `--asc`, `--orphans`) |
| `create` | Create a new session (`-q` for ID, `-t` for title, `-d` for directory, `--model`/`--agent`/`--variant` for persisted defaults) |
| `run` | One-shot prompt: create session, send, wait for response, write text. Supports `--spawn` for ephemeral server. |
| `get` (`show`) | Get detailed session info, including locally-persisted defaults |
| `delete` (`rm`) | Delete a session and drop its locally-persisted defaults (`--keep-defaults` to preserve) |
| `messages` | List messages (`--role`, `--limit`, `--text-only`, `--verbose`) |
| `last` | Get the last message (text-only by default) |
| `status` | Check session status (idle/busy/retry) |
| `watch` | Watch session events via SSE (`--text-only`, `--json`, `--events`) |
| `send` | Send a message (`--async`, `--wait`, `--model`, `--agent`, `--variant`, `--stdin`) |
| `stream` | Send a message and stream events live until idle (`--json` for NDJSON) |
| `respond` | Respond to permission requests (`--auto-approve`, `--wait`) |
| `models` | List providers/models/variants from `/config/providers` (`--enabled`, `--json`) |
| `todo` | View the session's todo list |
| `abort` | Abort a running session |
| `diff` | Show file changes in a session |
| `children` | List child sessions (sub-agents) |
| `share` | Share a session and get a public URL |
| `unshare` | Remove sharing from a session |
| `wait-for-text` | Block until a message contains given text, then exit 0 |
| `wait-for-idle` | Block until a session goes idle (`--require-busy` for race-free polling after `send --async`) |
| `wait-any` | Wait for first of N sessions to go idle, output its ID |
| `is-idle` | Non-blocking idle check (`--require-busy` to treat "no status entry yet" as not-idle) |
| `summary` | Compact overview: status, todos, cost, last message snippet |
| `worktree list` | List git worktrees |
| `worktree create` | Create a worktree with branch and optional session |
| `worktree remove` | Remove a worktree |
| `worktree run` | Create worktree + session + send prompt (one-liner) |
| `install-skill` | Install the occtl skill as an OpenCode user-level skill |
| `view-skill` | Display the bundled SKILL.md |

All commands that accept a session ID support partial matching and title search. When no ID is given, the most recent session is used.

All commands support `--json` for machine-readable output.

### One-Shot Runs (`occtl run`)

`occtl run` packages create-session + send + wait + read into a single command. Useful for scripted batch prompts (e.g. running the same review against multiple models in parallel) where you want to keep each call self-contained:

```bash
# Against the running server
occtl run --model anthropic/claude-opus-4-7 --variant high \
  --title "review craft" \
  --file ./prompt.md \
  --out ./result.md \
  --timeout 540000 \
  -- "Perform the review exactly as instructed."

# With its own ephemeral opencode server (random free port, isolated state dir)
occtl run --spawn --model openai/gpt-5.4 \
  --file ./prompt.md \
  --out ./result.md
```

Key flags:

| Flag | Notes |
|---|---|
| `--model <provider/model>` | Required. |
| `--variant`, `--agent`, `--thinking` | Forwarded to the model. |
| `-f, --file <path>` | Repeatable. Files are concatenated into the prompt; trailing positional/`--message` is appended. |
| `-o, --out <path>` | Write assistant text to this file. Sidecar `<out>.session` always gets the session ID. |
| `--raw <path>` | Write the full last assistant message JSON. |
| `--stderr <path>` | Capture run-level diagnostics (timeouts, empty responses) to a file instead of stderr. |
| `--timeout <ms>` | Abort if the session doesn't go idle in time. Exits 124 with diagnostics. |
| `--spawn` | Spawn an ephemeral `opencode serve` on a random port, run the prompt against it, then SIGTERM/SIGKILL on exit. Inherits the user's provider config and credentials. |
| `--spawn-port <port>` | Use a specific port instead of random (with `--spawn`). |
| `--password <pw>` | Server password (Basic auth). Reads `OPENCODE_SERVER_PASSWORD` if unset. With `--spawn`, applied to the spawned server too. |
| `--ephemeral` | Delete the session after a successful run. Default is to keep sessions for token-usage tracking. |

Exit codes: `0` success · `1` empty/no-text response or generic failure · `2` invalid arguments · `124` timeout.

### Send Modes

```bash
# Default: synchronous, blocks until the agent responds
occtl send "fix the bug"

# Async: fire and forget
occtl send --async "fix the bug"

# Wait: send async, block until session idle, show result
occtl send --wait "fix the bug"

# Stream: send async, print live tool calls + text deltas until idle
occtl stream "write 8 template files"
occtl stream --json "..."   # NDJSON of every SSE event
```

`stream` and `send --wait` are race-free send-and-wait primitives. If you build your own polling loop with `is-idle` or `wait-for-idle` after `send --async`, pass `--require-busy` so a session that hasn't yet been marked busy doesn't report idle prematurely.

### Session Defaults

`occtl create --model X --agent Y --variant Z` persists those defaults to `${XDG_CONFIG_HOME:-~/.config}/occtl/sessions/<id>.json`. Subsequent `occtl send` and `occtl stream` calls read and merge them (explicit flags override stored). `occtl delete` clears the file; `occtl ls --orphans` surfaces files whose session no longer exists.

```bash
occtl create -q --model openai/gpt-5.5 --variant high
# now `occtl send "..."` automatically uses gpt-5.5/high

occtl show <id>          # session info + local defaults
occtl ls --orphans       # defaults files with no live session
occtl rm <id>            # delete session and its defaults file
```

### Discovering Providers, Models, and Variants

```bash
occtl models                       # list all providers and models
occtl models --enabled             # only providers with credentials present
occtl models openai                # list openai's models with their variants
occtl models openai/gpt-5.5        # detail view: limits + variants
occtl models --json                # raw output of /config/providers
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

This copies the skill to `~/.config/opencode/skills/occtl/` and any other found user-level skill directories, such as `~/.claude/skills/occtl/` or `~/.agents/skills/occtl/`. Restart OpenCode to pick it up. The skill includes full command reference, Ralph Loop templates, and worktree patterns.

To view the skill without installing:

```bash
occtl view-skill
```

## Ralph Mode

The [Ralph Loop](https://ghuntley.com/ralph/) is an autonomous coding pattern where an AI agent works through tasks in a loop with fresh context each iteration. Traditionally this requires a bash script to drive the loop.

`occtl` eliminates the bash script entirely. With Ralph Mode, **the agent IS the orchestrator**. It creates sessions, sends prompts, monitors progress, handles failures, and keeps iterating — all through `occtl` commands. No bash wrapper needed.

To start: tell your agent "Use the occtl skill to complete project X using Ralph Mode." The skill teaches the agent to:

1. Break work into atomic tasks (`tasks.md`)
2. Create a fresh session per task (`occtl create`)
3. Send the worker a prompt with context (`occtl send --async`)
4. Wait for completion (`occtl wait-for-idle`)
5. Evaluate output (`occtl summary`, `occtl last`)
6. Repeat until all tasks are done

### Parallel Execution

```bash
# Agent creates 3 sessions for independent tasks
SID1=$(occtl create -q -t "task-auth")
SID2=$(occtl create -q -t "task-payments")
SID3=$(occtl create -q -t "task-dashboard")

# Sends prompts to all three
occtl send --async "implement JWT auth..." -s $SID1
occtl send --async "add Stripe checkout..." -s $SID2
occtl send --async "build dashboard..." -s $SID3

# Waits for first to finish, evaluates, dispatches next
DONE=$(occtl wait-any $SID1 $SID2 $SID3)
occtl summary $DONE
```

For conflicting work, use worktrees:

```bash
occtl wt run auth -w "implement JWT auth"
occtl wt run payments -w "add Stripe checkout"
```

See `occtl view-skill` for the full Ralph Mode guide.

### Model Recommendations

The orchestrating agent doesn't write code — it just runs `occtl` commands and makes decisions. Use a cheap, fast model for the orchestrator and a capable model for the workers:

- **Orchestrator:** Sonnet, Flash, GPT-4o-mini (cheap, fast)
- **Workers:** Opus, Pro, o3 (capable, thorough)

```bash
# Specify the worker model when sending prompts
occtl send --async --model anthropic/claude-opus-4-6 "implement feature X" -s $SID
```

## Use Cases

### Handoff: "Watch my session while I sleep"

You're working in a normal OpenCode session — maybe a big refactor that's halfway done. You want to go to bed but keep things moving. Start a second session and tell it to babysit the first:

> "The session ses_abc123 is working on a refactor. When it finishes, use occtl to have it create a pull request, then monitor the CI pipeline. If the pipeline fails, read the failure logs and send the session a prompt to fix the issues. Keep going until the pipeline passes."

The supervisory agent uses:
- `occtl wait-for-idle ses_abc123` — block until the worker finishes
- `occtl send -w "create a PR for this work" -s ses_abc123` — tell it to make a PR
- `occtl last ses_abc123` — read the PR URL from its output
- `occtl send -w "the CI pipeline failed with: ... fix it" -s ses_abc123` — feed it failures
- Loop until the pipeline is green

You come back in the morning to a merged PR.

### PR Review Bot

A session can review another session's work:

> "Use occtl to watch for any session in this project that goes idle. When one does, read its diff and last message. If it made code changes, create a new session to review the changes and post review comments."

- `occtl list --json` — find active sessions
- `occtl wait-any <ids...>` — wait for any to finish
- `occtl diff <id>` — see what files changed
- `occtl create` + `occtl send` — start a review session with the diff as context

### Parallel Test Matrix

Run the same change against different test configurations:

> "Create 3 worktrees. In each one, send a session to run the test suite with a different Node version (18, 20, 22). Wait for all three to finish and report which ones passed."

- `occtl wt create node18` / `node20` / `node22`
- `occtl send --async` to each with the appropriate test command
- `occtl wait-any` repeatedly until all three are idle
- `occtl summary` each to check results

### Continuous Integration Helper

Wire `occtl` into your CI pipeline to have an agent fix failures:

```bash
# In CI, after a failure:
SID=$(occtl create -q -t "ci-fix-$(date +%s)")
occtl send -w "The CI build failed. Here's the log: $(cat ci-output.log)
Fix the issues and commit." -s $SID
```

### Cross-Project Coordination

Orchestrate work across separate codebases from a single agent:

> "Implement the new /users API in the backend, and simultaneously build the API client in the frontend. When both are done, verify they work together."

```bash
# Sessions in different projects
API=$(occtl create -q -d /path/to/backend -t "users API")
CLIENT=$(occtl create -q -d /path/to/frontend -t "users client")

# Work in parallel
occtl send --async "implement /users endpoints" -s $API
occtl send --async "implement users API client" -s $CLIENT

# Wait for both, react to whichever finishes first
DONE=$(occtl wait-any $API $CLIENT)
occtl summary $DONE
```

Works because one OpenCode server manages sessions across directories. Useful for API + client, library + consumers, or monorepo coordination.

### Session Migration

Move context from one session to another when a session gets too large:

> "Read the last 5 messages from ses_old using occtl, create a fresh session, and send it a summary of the prior work so it can continue."

- `occtl messages ses_old --limit 5 --text-only` — extract recent context
- `occtl create -q` — fresh session
- `occtl send --async "Continue the work. Here's what was done: ..."` — seed the new session

## Why Not Just Use opencode CLI?

The `opencode` CLI provides `session list` and `session delete`. Everything else in `occtl` is additive:

- **Read messages** from any session
- **Watch** sessions in real-time via SSE
- **Send prompts** programmatically (sync, async, or wait-for-idle)
- **One-shot runs** with `occtl run`, optionally spawning an ephemeral server (`--spawn`)
- **Respond** to permission requests (including continuous auto-approve)
- **Wait for text** in agent output (event-driven, not polling)
- **Create** sessions for fresh-context workflows
- **Worktrees** for parallel, isolated agent execution
- **Share/unshare** sessions
- **Inspect** todos, diffs, children, and status

## License

MIT

## How to Publish

```sh
npm version patch     # or minor / major
git push && git push --tags
gh release create vX.Y.Z --generate-notes
```

The `Publish to npm` GitHub Action fires on the release and pushes to npm with provenance.
