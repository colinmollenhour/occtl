---
name: occtl
description: Manage OpenCode sessions from the CLI using occtl. Use when the user wants to list sessions, read messages, watch sessions, send prompts, answer permission requests, inspect todos/status/diffs, abort sessions, create worktrees, or orchestrate autonomous OpenCode work.
---

# occtl

`occtl` controls OpenCode sessions from shell. Use it for health checks, session inspection, live streaming, permission approval, automation, and multi-session orchestration.

## Basics

Prereq: OpenCode server running. If discovery fails, set `OPENCODE_SERVER_HOST` and `OPENCODE_SERVER_PORT`.

Session IDs can be omitted (most recent), full IDs, partial IDs, or title substrings.

Most commands support `--json`. Prefer JSON for scripts.

```bash
occtl ping                        # verify server reachable
occtl list                        # sessions in current dir
occtl list --all --active          # sessions with active main/child agents
occtl list --orphans               # local defaults with no live session
occtl create -q                    # print new session ID
occtl new -q                       # alias for create
occtl create -q -d /repo -t task    # create in another project
occtl get <id>                     # session detail
occtl show <id>                    # alias for get
occtl rm <id>                      # delete session + local defaults
occtl messages <id> --text-only    # full text history
occtl msgs <id>                    # alias for messages
occtl last <id>                    # last assistant message
occtl watch <id> --text-only       # live text stream
occtl summary <id>                 # status + todos + cost + diff summary
occtl todo <id>                    # todo list
occtl diff <id>                    # file changes
occtl status <id>                  # idle/waiting/busy/retry
occtl abort <id>                   # stop work
occtl share <id>                   # public URL
occtl unshare <id>                 # remove public sharing
occtl children <id>                # child sessions
occtl models --grep gpt-5.5        # full matching provider/model IDs
occtl models --enabled --grep opus  # search usable configured providers
occtl install-skill --force         # install bundled skill
occtl view-skill --path             # locate bundled skill
occtl help <command>                # command-specific help
```

Aliases: `ls=list`, `new=create`, `rm=delete`, `show=get`, `msgs=messages`, `prompt=send`, `wt=worktree`, `wt ls=wt list`, `wt rm=wt remove`.

## Send Work

```bash
occtl send "prompt"                         # sync request, returns response
occtl prompt "prompt"                       # alias for send
occtl send -s <id> "prompt"                 # target session
occtl send --async -s <id> "prompt"         # fire and return
occtl send -w -s <id> "prompt"              # send, wait idle, print reply
occtl send --stdin -s <id> < prompt.md       # prompt from stdin
occtl send --no-reply -s <id> "context"     # add context only
occtl stream -s <id> "prompt"               # send + stream until idle
occtl stream --json -s <id> "prompt"        # NDJSON event stream
```

Use `stream` or `send -w` for race-safe single-session automation. Parent sessions with active sub-agents report `waiting`; pass `--main-agent` to `status`, `wait-for-idle`, or `is-idle` only when parent-only status is intended. If using `send --async`, wait with `wait-for-idle --require-busy`, `wait-all --require-busy`, or `wait-for-text`.

Persist worker defaults at create time:

```bash
occtl create -q --model anthropic/claude-opus-4-6 --variant high --agent build
```

Later `send`/`stream` inherit stored model/variant/agent unless explicitly overridden.

One-shot runs create a session, send prompt, wait, then write response. `--model` required:

```bash
occtl run --model anthropic/claude-opus-4-6 "prompt"
occtl run --model openai/gpt-5.5 -f prompt.md --message "extra"
occtl run --model openai/gpt-5.5 --spawn --ephemeral --timeout 600000
occtl run --model openai/gpt-5.5 -o answer.txt --raw answer.json --stderr run.err
```

## Waiting And Permissions

```bash
occtl respond <id> -p <permission-id> -r once
occtl respond <id> --wait -r always
occtl respond <id> --auto-approve --wait

occtl wait-for-idle <id> --timeout 600
occtl wait-for-idle <id> --require-busy --timeout 600
occtl wait-for-idle <id> --main-agent --timeout 600
occtl wait-for-text "DONE" <id> --timeout 600
occtl wait-any <id1> <id2> <id3> --timeout 600
occtl wait-all <id1> <id2> <id3> --require-busy --timeout 600
occtl is-idle <id> --require-busy
occtl is-idle <id> --main-agent
```

Race rule: new sessions may report idle before async prompt starts. After `send --async`, use `--require-busy`, `wait-for-text`, `send -w`, or `stream`.

Use `wait-any` when you want to react to whichever worker finishes first. Use `wait-all` as a barrier before verification, merge, or final report.

Timeout rule: do not blindly retry. Check `occtl is-idle <id>` and `occtl summary <id>`. If still busy, wait longer or abort deliberately. Retry in a fresh session, not same session.

## Worktrees

Use worktrees for parallel or conflicting file changes. They live under `.occtl/worktrees/<name>` and normally create a matching OpenCode session.

```bash
occtl wt list --json
occtl wt ls                         # alias for wt list
occtl wt create auth -q                  # path only
occtl wt create auth -b branch --base main
occtl wt create auth --no-session
occtl wt run auth "implement auth"       # create wt + session + send async
occtl wt run auth -w --auto-approve "implement auth"
occtl wt remove auth                     # remove worktree
occtl wt rm auth                         # remove worktree
occtl wt rm auth --force                 # dirty removal
```

Review and merge branches yourself after workers finish.

## Ralph Mode

Ralph Mode = you orchestrate many fresh OpenCode sessions until project complete. Use when user asks for Ralph Mode or autonomous multi-task work.

Core loop:

1. Inspect repo and requirements.
2. Create/maintain `tasks.md` with atomic, verifiable tasks.
3. Create/maintain `progress.txt` with short worker summaries.
4. For each task, create fresh session.
5. Send prompt telling worker to pick one task, implement, verify, update `tasks.md`/`progress.txt`, and commit if user wants commits.
6. Auto-approve only when appropriate.
7. Wait, then inspect `summary`, `last`, `todo`, and changed files.
8. Adapt: split bad tasks, clarify prompt, retry fresh session, or dispatch next task.
9. Stop when tasks done; report result and verification.

Single-worker skeleton:

```bash
SID=$(occtl create -q -t "ralph-1-task-name")
occtl send --async -s "$SID" "Read tasks.md and progress.txt. Pick one incomplete task. Implement it. Run verification. Update tasks.md and progress.txt. Output RALPH_DONE when finished."
occtl respond "$SID" --auto-approve --wait &
APPROVER=$!
occtl wait-for-text "RALPH_DONE" "$SID" --timeout 600 || occtl summary "$SID"
kill "$APPROVER" 2>/dev/null || true
occtl summary "$SID"
occtl last "$SID"
```

Parallel pattern:

```bash
SID1=$(occtl create -q -t task-a)
SID2=$(occtl create -q -t task-b)
occtl send --async -s "$SID1" "Do task A per tasks.md"
occtl send --async -s "$SID2" "Do task B per tasks.md"
DONE=$(occtl wait-any "$SID1" "$SID2" --timeout 600)
occtl summary "$DONE"
```

Barrier pattern:

```bash
occtl wait-all "$SID1" "$SID2" --require-busy --timeout 600
occtl summary "$SID1"
occtl summary "$SID2"
```

Cross-project pattern:

```bash
API=$(occtl create -q -d /repo/api -t api-work)
WEB=$(occtl create -q -d /repo/web -t web-work)
occtl send --async -s "$API" "Implement endpoints per shared spec"
occtl send --async -s "$WEB" "Implement client per shared spec"
occtl wait-any "$API" "$WEB"
occtl wait-all "$API" "$WEB" --require-busy
```

Ralph rules:

- One meaningful task per worker session.
- You plan/evaluate; workers implement.
- Read worker output before next dispatch.
- Use parallel sessions only for independent work.
- Use worktrees when file conflicts are likely.
- Keep `progress.txt` concise; git history is real memory.
- Never resend same prompt to same failed session; create a fresh one.

## Failure Triage

```bash
occtl summary <id> --json
occtl last <id>
occtl messages <id> --text-only --limit 20
occtl diff <id>
occtl abort <id>
```

If task too big, split `tasks.md`. If worker misunderstood, refine prompt. If dependency missing, reorder. If transient, retry fresh session.
