---
name: occtl
description: Manage OpenCode sessions from the CLI using occtl. Use when the user wants to list sessions, read session messages, get the last message, watch a session for updates, send messages to sessions, respond to permission requests, check session status, view todos, abort sessions, view diffs, or automate session management. Triggers include "check session", "read messages", "last message", "watch session", "send prompt", "approve permissions", "session status", "session todo", "abort session", or any programmatic OpenCode session interaction.
---

# occtl - Extended CLI for OpenCode Sessions

`occtl` extends the `opencode` CLI with session management commands that are missing from the official tool: reading messages, watching sessions in real-time, responding to permission requests, and more.

## Prerequisites

- OpenCode must be running (the server is auto-detected from running processes)
- If auto-detection fails, set `OPENCODE_SERVER_HOST` and `OPENCODE_SERVER_PORT`

## Quick Reference

```bash
occtl create -q                   # create a new session, print its ID
occtl list                        # list all sessions
occtl last                        # last message from most recent session
occtl messages <id>               # all messages in a session
occtl watch <id> --text-only      # stream text in real-time
occtl send "fix the bug"          # send a message
occtl respond --auto-approve -w   # auto-approve permissions
occtl todo                        # view session todo list
occtl status                      # check if sessions are busy/idle
occtl share                       # share session, get public URL
```

## Commands

### List Sessions

```bash
occtl list                    # sessions for current directory only (default)
occtl list --all              # sessions for ALL directories
occtl list /path/to/project   # sessions for a specific directory
occtl list --children         # include child sessions (sub-agents)
occtl list --json             # JSON output for scripting
occtl list --detailed         # show full details per session
occtl list --limit 5          # limit results
occtl list --active           # only non-idle sessions (busy or retry)
occtl list --sort created     # sort by: updated (default), created, title
occtl list --sort title --asc # sort ascending
```

### Create a Session

```bash
occtl create                          # create a new session in the current directory
occtl create -t "my feature work"     # with a title
occtl create -d /path/to/project      # create in a specific project directory
occtl create -q                       # quiet mode: only output the session ID
occtl create --json                   # full JSON output
occtl create -p <parent-id>           # create a child session
```

The `-q` flag is useful in scripts: `SID=$(occtl create -q)`

The `-d` flag enables cross-project orchestration: `SID=$(occtl create -q -d /path/to/other/project)`

### Get Session Details

```bash
occtl get <session-id>        # detailed info about a session
occtl get <session-id> --json
```

### Read Messages

```bash
occtl messages                          # all messages from most recent session
occtl messages <session-id>             # all messages from specific session
occtl messages <id> --role user         # only user messages
occtl messages <id> --role assistant    # only assistant messages
occtl messages <id> --limit 5           # last 5 messages
occtl messages <id> --text-only         # text content only
occtl messages <id> --verbose           # include tool call details
occtl messages <id> --json              # full JSON output
```

### Get Last Message

```bash
occtl last                              # last message (text-only by default)
occtl last <session-id>                 # from specific session
occtl last --role user                  # last user message
occtl last --role assistant             # last assistant message
occtl last --verbose                    # include tool calls and metadata
occtl last --json                       # full JSON output
```

### Watch Session (Real-Time)

Connects to the SSE event stream and displays events for a session:

```bash
occtl watch                             # watch most recent session
occtl watch <session-id>                # watch specific session
occtl watch --text-only                 # stream only text content as it arrives
occtl watch --json                      # output each event as JSON line
occtl watch --events message.updated,session.idle  # filter event types
```

Event types shown: `message.updated`, `message.part.updated` (text deltas, tool calls), `session.status`, `session.idle`, `permission.updated`, `todo.updated`, `session.error`.

Press Ctrl+C to stop watching.

### Send Messages

```bash
occtl send "your message here"                    # send to most recent session
occtl send -s <session-id> "your message"         # send to specific session
occtl send --async "do this in background"        # send and return immediately
occtl send -w "fix the tests"                     # send, block until idle, show result
occtl send --model anthropic/claude-opus-4-6 "hi" # specify model
occtl send --agent plan "analyze this code"       # specify agent
occtl send --no-reply "context info"              # inject context without AI response
occtl send --stdin < prompt.txt                   # read message from stdin
occtl send "message" --json                       # JSON response output
```

The three send modes:
- **(default)** — synchronous: blocks on the HTTP request until the agent responds, returns the response.
- **`--async`** — fire-and-forget: sends and exits immediately. Use with `watch` or `wait-for-text` separately.
- **`--wait` / `-w`** — hybrid: sends async, blocks until `session.idle` via SSE, then fetches and displays the last assistant message. Best for scripts that need the result but want event-driven waiting.

### Respond to Permission Requests

```bash
# Respond to a specific permission
occtl respond <session-id> -p <permission-id> -r once

# Wait for and respond to the next permission request
occtl respond <session-id> --wait -r always

# Auto-approve all permissions continuously (for automation)
occtl respond <session-id> --auto-approve --wait

# Response options: once, always, reject
occtl respond -r reject -p <permission-id>
```

### View Todos

```bash
occtl todo                              # todos from most recent session
occtl todo <session-id>                 # todos from specific session
occtl todo --json                       # JSON output
```

Output format:
```
[x]! Completed high-priority task
[>]  In-progress task
[ ]  Pending task
[-]  Cancelled task
```

### Check Session Status

```bash
occtl status                            # all session statuses
occtl status <session-id>               # specific session status
occtl status --json                     # JSON output
```

Status types: `idle`, `busy`, `retry`.

### Abort a Session

```bash
occtl abort                             # abort most recent session
occtl abort <session-id>                # abort specific session
```

### View Diffs

```bash
occtl diff                              # file changes from most recent session
occtl diff <session-id>                 # file changes from specific session
occtl diff --json                       # JSON output
```

### Wait for Text

```bash
occtl wait-for-text "SOME_TEXT"                    # wait on most recent session
occtl wait-for-text "SOME_TEXT" <session-id>       # wait on specific session
occtl wait-for-text "DONE" --timeout 300           # timeout after 5 minutes (exit 1)
occtl wait-for-text "DONE" --no-check-existing     # skip checking existing messages
```

Checks existing messages first (by default), then watches the SSE stream for new ones. Outputs everything after the matched text and exits 0. Exits 1 on timeout.

The default check-existing behavior prevents a race condition where the text appears between `send --async` and `wait-for-text` starting. Use `--no-check-existing` only if you specifically want to wait for a *new* occurrence.

### Wait for Idle

```bash
occtl wait-for-idle                     # block until most recent session is idle
occtl wait-for-idle <session-id>        # block until specific session is idle
occtl wait-for-idle --timeout 300       # timeout after 5 minutes (exit 1)
```

Blocks until the session goes idle. Does a quick status check first — if already idle, exits immediately. Otherwise watches the SSE stream. Exit 0 = idle, exit 1 = timeout.

### Wait Any (Multiple Sessions)

```bash
occtl wait-any <id1> <id2> <id3>        # wait for FIRST to go idle, output its ID
occtl wait-any <id1> <id2> --timeout 600
occtl wait-any <id1> <id2> --json       # {"sessionID": "...", "reason": "idle"}
```

Watches multiple sessions simultaneously. Outputs the session ID of the first one to go idle and exits. Essential for orchestrating parallel workloads.

### Is Idle (Non-Blocking Check)

```bash
occtl is-idle                           # exit 0 if idle, exit 1 if busy
occtl is-idle <session-id>
occtl is-idle --json                    # {"sessionID": "...", "idle": true, "status": "idle"}
```

Non-blocking check. Useful for conditional logic in agent orchestration.

### Session Summary

```bash
occtl summary                           # compact summary of most recent session
occtl summary <session-id>
occtl summary --json                    # machine-readable summary
occtl summary -n 500                    # longer last-message snippet (default: 200 chars)
```

Shows status, todo progress, total cost, file changes, and a snippet of the last assistant message — all in one call. Designed for orchestration agents that need a quick overview without reading full message history.

### Share / Unshare

```bash
occtl share                             # share most recent session, print URL
occtl share <session-id>                # share a specific session
occtl share --json                      # full JSON output
occtl unshare <session-id>              # remove sharing
```

### List Child Sessions

```bash
occtl children                          # children of most recent session
occtl children <session-id>             # children of specific session
occtl children --json                   # JSON output
```

## Session ID Resolution

All commands that accept a session ID support:

1. **No ID** - defaults to most recent session
2. **Full ID** - exact match (e.g., `ses_2e1451cf8ffe7cBLbjmQS8Ogsc`)
3. **Partial ID** - prefix or substring match (e.g., `ses_2e14` or just `2e14`)
4. **Title search** - case-insensitive match against session title

## Worktrees

`occtl worktree` (alias `occtl wt`) manages git worktrees for running parallel, isolated sessions. Each worktree gets its own branch and working directory under `.occtl/worktrees/`, so multiple agents can work on different features simultaneously without file conflicts.

### List Worktrees

```bash
occtl wt list                             # list all git worktrees
occtl wt list --json                      # JSON output
```

### Create a Worktree

```bash
occtl wt create auth-feature              # creates worktree + branch + session
occtl wt create auth-feature -b my-branch # custom branch name
occtl wt create auth-feature --base main  # branch from a specific ref
occtl wt create auth-feature --no-session # just create the worktree, no session
occtl wt create auth-feature -q           # only output the worktree path
occtl wt create auth-feature --json       # JSON output with path, branch, sessionID
```

By default, `create` also creates an OpenCode session scoped to the worktree directory.

Worktrees are created under `.occtl/worktrees/<name>` with branch `worktree-<name>`.

### Remove a Worktree

```bash
occtl wt rm auth-feature                  # remove by name
occtl wt rm auth-feature --force          # force remove even if dirty
```

### Run a Prompt in a New Worktree

The `run` command is a one-liner that creates a worktree, starts a session, and sends a prompt:

```bash
# Fire-and-forget: create worktree + session, send prompt, exit immediately
occtl wt run auth-feature "implement JWT authentication"

# Wait for completion: block until the session goes idle, show result
occtl wt run auth-feature -w "implement JWT authentication"

# With auto-approve and a specific model
occtl wt run auth-feature -w --auto-approve \
  --model anthropic/claude-sonnet-4-6 \
  "implement JWT authentication"

# Read prompt from a file
occtl wt run auth-feature -w --stdin < prompts/auth.md
```

### Parallel Features

Launch multiple features in parallel, each in its own worktree:

```bash
# Start 3 features simultaneously
occtl wt run auth "implement JWT auth" &
occtl wt run payments "add Stripe checkout" &
occtl wt run dashboard "build analytics dashboard" &
wait

# Check status of each
occtl ls /path/to/repo/.occtl/worktrees/auth
occtl ls /path/to/repo/.occtl/worktrees/payments
occtl ls /path/to/repo/.occtl/worktrees/dashboard

# When done, review diffs and merge
for wt in auth payments dashboard; do
  echo "=== $wt ==="
  cd .occtl/worktrees/$wt && git log --oneline main..HEAD && cd -
done
```

### Parallel Ralph Loop

Combine worktrees with the Ralph Loop to run multiple autonomous task lists in parallel:

```bash
#!/usr/bin/env bash
set -e

# Each feature gets its own worktree and Ralph loop
FEATURES=("auth" "payments" "dashboard")

for feature in "${FEATURES[@]}"; do
  (
    # Create worktree
    WT_PATH=$(occtl wt create "$feature" -q)

    for i in $(seq 1 10); do
      SID=$(occtl create -q -t "ralph-${feature}-$i")

      PROMPT="$(cat "prompts/${feature}.md")

## Progress
$(cat "${WT_PATH}/progress.txt" 2>/dev/null || echo 'Starting fresh.')

When done, output RALPH_DONE. If ALL tasks are complete, output ALL_TASKS_COMPLETE."

      occtl send --async "$PROMPT" -s "$SID"
      occtl respond "$SID" --auto-approve --wait &
      APID=$!

      occtl wait-for-text "RALPH_DONE" "$SID" --timeout 600 || true
      kill $APID 2>/dev/null || true

      occtl last "$SID" >> "${WT_PATH}/progress.txt"

      if occtl wait-for-text "ALL_TASKS_COMPLETE" "$SID" \
           --check-existing --timeout 1; then
        echo "=== $feature complete ==="
        break
      fi
    done
  ) &
done

wait
echo "All features complete. Review worktrees and merge."
```

## Automation Patterns

### Continuous permission approval

```bash
# Run in background to auto-approve all permission requests
occtl respond --auto-approve --wait &
```

### Poll session until idle

```bash
while [ "$(occtl status <id> --json | jq -r '.type')" = "busy" ]; do
  sleep 2
done
echo "Session is idle"
```

### Send message and capture response

```bash
response=$(occtl send "what files were changed?" --json)
echo "$response" | jq -r '.parts[] | select(.type == "text") | .text'
```

### Watch for text output and pipe it

```bash
occtl watch <id> --text-only | tee session-output.txt
```

### Chain send + watch for async workflows

```bash
occtl send --async "refactor the auth module"
occtl watch --text-only
```

## JSON Output

All commands support `--json` for machine-readable output. The JSON structure matches the OpenCode SDK types directly (`Session`, `Message`, `Part`, `Todo`, etc.).

## Ralph Mode

Ralph Mode turns YOU (the agent reading this skill) into an autonomous project
orchestrator. Instead of a bash script driving the loop, you ARE the loop. You
create sessions, send prompts, monitor progress, handle failures, and keep
iterating until the project is done — all by running `occtl` commands.

The user kicks it off with something like:
> "Use the occtl skill to complete project X using Ralph Mode."

And you take it from there.

### How It Works

The Ralph pattern: break work into atomic tasks, execute each in a fresh session
(fresh context window), persist progress in the filesystem, repeat until done.

You are smarter than a bash loop because you can:
- Read the worker session's output and decide what to do next
- Adjust the prompt based on what actually happened
- Run multiple sessions in parallel on independent tasks
- Use worktrees to isolate parallel work that would conflict
- Handle errors, retries, and stuck sessions intelligently
- Make strategic decisions about task ordering and dependencies

### Step-by-Step Procedure

When asked to use Ralph Mode, follow this procedure:

**1. Assess the project.** Read the codebase, requirements, and any existing
task files. Understand what needs to be done.

**2. Create a task list.** Write a `tasks.md` file (or similar) in the project
root. Each task should be:
- Atomic: completable in a single session/context window
- Verifiable: has clear done criteria (tests pass, file exists, etc.)
- Independent: minimizes dependencies on other tasks

**3. Create a `PROMPT.md` file.** This is the base prompt sent to each worker
session. It should tell the worker to:
- Read `tasks.md` and `progress.txt` to understand current state
- Pick one incomplete task and implement it
- Run tests/verification before marking done
- Update `tasks.md` (mark task done) and `progress.txt` (append summary)
- Commit changes

**4. Execute the loop.** For each iteration:

```bash
# Create a fresh session
occtl create -q -t "ralph-iteration-N"
# Returns: ses_xxxxx

# Send the prompt (async so you don't block)
occtl send --async "$(cat PROMPT.md)" -s ses_xxxxx

# Auto-approve permissions for this session
occtl respond ses_xxxxx --auto-approve --wait
# (this runs in background via the shell — use & in bash)

# Wait for the session to finish
occtl wait-for-idle ses_xxxxx --timeout 600

# Check what happened
occtl summary ses_xxxxx
occtl last ses_xxxxx
occtl todo ses_xxxxx
```

**5. Evaluate and decide.** After each iteration:
- Read the worker's output with `occtl last ses_xxxxx`
- Check `tasks.md` to see what was marked done
- Check `progress.txt` for the worker's notes
- If the task failed or was only partially done, adjust the next prompt
- If the worker got stuck, break the task into smaller pieces
- If all tasks are done, stop

**6. Repeat** until `tasks.md` shows all tasks complete.

### Cross-Project Orchestration

You can coordinate work across completely separate codebases. Use `--dir`
when creating sessions to target different project directories:

```bash
# Create sessions in different projects
API_SID=$(occtl create -q -d /path/to/backend -t "implement API endpoints")
CLIENT_SID=$(occtl create -q -d /path/to/frontend -t "implement API client")

# Send prompts to both
occtl send --async "Add the /users REST endpoints per the spec in docs/api.md" -s $API_SID
occtl send --async "Add API client methods for the /users endpoints" -s $CLIENT_SID

# Wait for both, checking whichever finishes first
DONE=$(occtl wait-any $API_SID $CLIENT_SID)
occtl summary $DONE
# ... continue coordinating
```

This works because one OpenCode server can manage sessions across different
directories. Each session operates in its own project context.

Use cases:
- **API + client**: Implement a backend API and its frontend client simultaneously
- **Library + consumers**: Make a library change and update all downstream repos
- **Monorepo coordination**: Work across packages that have separate contexts
- **Migration**: Change a shared schema in one project and update all dependents

### Key Commands for Orchestration

| What you need to do | Command |
|---|---|
| Create a fresh session | `occtl create -q -t "ralph-N"` |
| Create session in another project | `occtl create -q -d /path/to/project` |
| Send prompt to a session | `occtl send --async "prompt text" -s <id>` |
| Auto-approve permissions | `occtl respond <id> --auto-approve --wait` |
| Wait for session to finish | `occtl wait-for-idle <id> --timeout 600` |
| Quick status check | `occtl is-idle <id>` (exit 0=idle, 1=busy) |
| Get session overview | `occtl summary <id>` |
| Read last assistant message | `occtl last <id>` |
| Read full message history | `occtl messages <id> --text-only` |
| Check todo progress | `occtl todo <id>` |
| Check file changes | `occtl diff <id>` |
| Wait for first of N to finish | `occtl wait-any <id1> <id2> <id3>` |
| Abort a stuck session | `occtl abort <id>` |

### Parallel Execution

For independent tasks, run multiple sessions simultaneously:

```bash
# Create sessions for independent tasks
SID1=$(occtl create -q -t "task-auth")
SID2=$(occtl create -q -t "task-payments")
SID3=$(occtl create -q -t "task-dashboard")

# Send prompts to all three
occtl send --async "implement JWT auth. Read tasks.md..." -s $SID1
occtl send --async "add Stripe checkout. Read tasks.md..." -s $SID2
occtl send --async "build analytics dashboard. Read tasks.md..." -s $SID3

# Wait for the first one to finish
FINISHED=$(occtl wait-any $SID1 $SID2 $SID3 --timeout 600)
# $FINISHED contains the session ID that went idle first

# Check its result
occtl summary $FINISHED
```

When tasks would modify the same files, use worktrees for isolation:

```bash
# Create isolated worktrees for conflicting work
WT1=$(occtl wt create auth -q)
WT2=$(occtl wt create payments -q)

# Sessions are auto-created in worktree directories
# Send prompts, wait, then merge branches when done
```

### Handling Failures

When a worker session fails or produces bad output:

1. **Read the output**: `occtl last <id>` — understand what went wrong
2. **Check for errors**: `occtl summary <id> --json` — look at the error field
3. **Decide**:
   - If the task is too big, break it into subtasks in `tasks.md`
   - If the worker misunderstood, refine the prompt and retry
   - If there's a dependency, reorder tasks
   - If it's a transient error, simply retry with a new session
4. **Create a new session and try again** — never reuse a failed session

### Example: Full Ralph Mode Session

Here is how you (the agent) would orchestrate a project. You are talking to
yourself — these are the bash commands you would execute:

```
# 1. Read the project
cat tasks.md     # understand what needs doing
cat progress.txt # see what's done so far

# 2. Iteration 1: first task
SID=$(occtl create -q -t "ralph-1-add-user-model")
occtl send --async "You are working on a project. Read tasks.md and progress.txt.
Pick the first incomplete task and implement it. Run tests. Update tasks.md and
progress.txt when done. Commit your changes." -s $SID
occtl respond $SID --auto-approve --wait &
occtl wait-for-idle $SID --timeout 600
occtl summary $SID
# Read output to see what happened
occtl last $SID

# 3. Check progress
cat tasks.md     # was the task marked done?
cat progress.txt # what did the worker report?

# 4. Iteration 2: next task
SID=$(occtl create -q -t "ralph-2-add-api-endpoints")
occtl send --async "..." -s $SID
# ... repeat

# 5. When tasks.md shows all tasks done: stop and report to the user.
```

### Guidelines

- **One task per session.** This is the core principle. Fresh context = better quality.
- **You are the brains, workers are the hands.** Workers implement. You plan,
  evaluate, and adapt. Don't expect workers to make strategic decisions.
- **Read worker output between iterations.** Use `occtl last` and
  `occtl summary` to understand what actually happened before deciding
  what to do next.
- **Adjust prompts based on results.** If a worker misunderstood, clarify.
  If a task was too big, break it down. This is where you add intelligence
  that a bash loop cannot.
- **Use parallel sessions for independent work.** Use `wait-any` to react
  to whichever finishes first, then dispatch the next task.
- **Use worktrees when parallel tasks touch the same files.** Merge after.
- **Keep `progress.txt` lean.** Workers append to it, you may edit it to
  keep it useful. Trim old entries if it gets too long.
- **Commit early, commit often.** Tell workers to commit after each task.
  Git history is the real memory.
- **Report progress to the user.** Periodically summarize what's been done
  and what remains. The user should be able to check in and see status.

### Handling Timeouts

When a `wait-for-idle` or `wait-for-text` times out, do NOT blindly
start a new session. That wastes the work the current session may still
be doing. Instead:

1. **Check if the session is still working:** `occtl is-idle <id>`
2. **If still busy:** the task is taking longer than expected. Either:
   - Increase the timeout and wait again: `occtl wait-for-idle <id> --timeout 1200`
   - Check what it's doing: `occtl summary <id>` — it may be stuck in a loop
   - Abort and retry with a clearer prompt: `occtl abort <id>`, then create a new session
3. **If idle:** the timeout was a false alarm (the session finished between the
   timeout firing and your check). Read the output: `occtl last <id>`
4. **Never re-send the same prompt to the same session** — that adds to its
   context window. Always create a fresh session for retries.

### Model Recommendations

As the orchestrator, you don't write code — you run `occtl` commands and make
decisions. This is lightweight work that doesn't require a frontier model.

- **Orchestrator (you):** Use a fast, cheap model like **Sonnet**, **Flash**,
  or **GPT-4o-mini**. You're just reading summaries, comparing outputs, and
  running shell commands. Speed and cost matter more than raw capability.
- **Worker sessions:** Use a capable model like **Opus**, **Pro**, or **o3**
  for the actual implementation work. Workers need deep reasoning to write
  code, debug tests, and handle complexity.

You can specify the worker model when sending prompts:
```bash
occtl send --async --model anthropic/claude-opus-4-6 "implement feature X" -s $SID
```

This keeps orchestration cheap while letting workers use the best model for
the job. A typical Ralph Mode run might cost $0.50 in orchestration and
$15 in worker tokens.
