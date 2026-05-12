# occtl

With `occtl` you can inspect, automate, and orchestrate OpenCode sessions from your terminal. Unlike the built-in OpenCode CLI, `occtl` can read messages, send prompts, wait on session state, respond to permission requests, run one-shot prompts, and manage isolated git worktrees.

Use it when you want shell scripts, another agent, or your own tooling to control OpenCode sessions without driving the OpenCode UI.

## Install

Requirements:

- Node.js 20 or later
- A configured [OpenCode](https://opencode.ai) installation
- A running OpenCode server, unless you use `occtl run --spawn`

Install the CLI with npm:

```bash
npm install -g @colinmollenhour/occtl
```

Verify the installation:

```bash
occtl --version
occtl --help
```

## Quickstart

Start an OpenCode server in one terminal:

```bash
opencode serve
```

In another terminal, verify that `occtl` can reach it:

```bash
occtl ping
```

Create a session, send a prompt, and read the response:

```bash
SID=$(occtl create -q -t "readme smoke test")
occtl send -s "$SID" "Say hello from this OpenCode session."
occtl last "$SID"
```

Run a self-contained prompt and print the assistant response:

```bash
occtl run --spawn --model openai/gpt-5.4 "Summarize this repository in five bullets."
```

## Common workflows

### Inspect sessions

```bash
occtl list                         # sessions for the current directory
occtl list --all --active           # sessions with active main or child agents
occtl summary                       # compact status for the most recent session
occtl messages --text-only          # readable transcript
occtl last                          # last assistant message
occtl diff                          # file changes made by the session
occtl todo                          # session todo list
```

Commands that take a session ID usually accept a full ID, partial ID, title substring, or no ID. When you omit the ID, `occtl` uses the most recently updated session for the current directory.

### Send work

```bash
occtl send "fix the failing tests"              # send and wait for the response
occtl send --async "run the test suite"         # send and return immediately
occtl send --wait "update the docs"             # send, wait until idle, and print the reply
occtl send --stdin < prompt.md                  # read the prompt from stdin
occtl stream "implement the parser"             # stream tool calls and text until idle
occtl stream --json "run verification"          # newline-delimited JSON events
```

Use `stream` or `send --wait` for single-session automation. `status`, `summary`, `list --active`, `wait-for-idle`, and `is-idle` treat a parent session with active sub-agents as `waiting`, not idle. Pass `--main-agent` when you specifically want the parent agent's own status. If you use `send --async` and then poll, pass `--require-busy` to `wait-for-idle`, `wait-all`, or `is-idle` so a fresh session does not appear idle before the prompt starts.

### Wait for completion

```bash
occtl wait-for-idle "$SID" --timeout 600
occtl wait-for-idle "$SID" --require-busy --timeout 600
occtl wait-for-idle "$SID" --main-agent --timeout 600
occtl wait-for-text "DONE" "$SID" --timeout 600
occtl wait-any "$SID1" "$SID2" "$SID3" --timeout 600
occtl wait-all "$SID1" "$SID2" "$SID3" --require-busy --timeout 600
occtl is-idle "$SID" --require-busy
occtl is-idle "$SID" --main-agent
```

Use `wait-any` to react when the first worker finishes. Use `wait-all` as a barrier before verification, merge work, or a final report.

### Handle permission requests

```bash
occtl respond "$SID" --wait --response once
occtl respond "$SID" --wait --response always
occtl respond "$SID" --auto-approve --wait
```

`--auto-approve` approves each pending permission request with `once`. Keep it scoped to sessions and repositories where that behavior is acceptable.

### Discover models

```bash
occtl models
occtl models --enabled
occtl models --grep gpt
occtl models --enabled --grep opus
occtl models openai
occtl models openai/gpt-5.4
occtl models --json
```

Use `--grep` instead of piping to `grep` when you need ready-to-use model IDs such as `openai/gpt-5.4` or `openrouter/openai/gpt-5.4`.

## One-shot runs

`occtl run` creates a session, sends a prompt, waits for completion, fetches the last assistant message, and writes the result. It is useful for scripts, batch prompts, and review jobs where each invocation needs its own session.

```bash
occtl run --model anthropic/claude-opus-4-7 \
  --title "review api changes" \
  --file ./prompt.md \
  --out ./review.md \
  --timeout 540000 \
  -- "Follow the review instructions exactly."
```

Use `--spawn` when you want `occtl` to start and stop an ephemeral `opencode serve` process for the run:

```bash
occtl run --spawn --model openai/gpt-5.4 \
  --file ./prompt.md \
  --out ./result.md \
  --raw ./result.json \
  --stderr ./result.err
```

Key flags:

| Flag | Description |
| --- | --- |
| `--model <provider/model>` | Required model ID, such as `openai/gpt-5.4`. |
| `--variant <name>` | Model variant, such as `high`, `xhigh`, or `max`. |
| `--agent <name>` | Agent name to pass to OpenCode. |
| `--thinking` | Forward the thinking flag to the model. |
| `-f, --file <path>` | Read prompt content from a file. Repeat the flag to concatenate files. |
| `--message <text>` | Append a short prompt after any files. |
| `-d, --dir <path>` | Create the session for another project directory. |
| `-o, --out <path>` | Write assistant text to a file. `occtl` also writes `<path>.session` with the session ID. |
| `--raw <path>` | Write the full last assistant message as JSON. |
| `--stderr <path>` | Write run diagnostics to a file. |
| `--timeout <ms>` | Abort the session if it does not become idle before the timeout. |
| `--spawn` | Start an ephemeral OpenCode server for the run. |
| `--spawn-port <port>` | Bind the spawned server to a specific port. |
| `--password <pw>` | Use HTTP Basic authentication for the server password. |
| `--ephemeral` | Delete the session after a successful run. |

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Empty response, lost connection, or general failure. |
| `2` | Invalid arguments. |
| `124` | Timeout. |

## Worktrees

`occtl worktree` manages git worktrees under `.occtl/worktrees/<name>`. Use worktrees when parallel sessions may edit overlapping files or when you want each worker on its own branch.

```bash
occtl wt create auth
occtl wt run payments "add Stripe checkout"
occtl wt run docs --wait "rewrite the API docs"
occtl wt list
occtl wt remove auth
```

`worktree` can be shortened to `wt`.

Run independent work in parallel:

```bash
occtl wt run auth "implement JWT auth" &
occtl wt run payments "add Stripe checkout" &
occtl wt run dashboard "build analytics dashboard" &
wait
```

Review and merge the worktree branches yourself after the workers finish.

## Session defaults

You can store default model settings for a session when you create it:

```bash
SID=$(occtl create -q --model openai/gpt-5.5 --variant high --agent build)
occtl send -s "$SID" "implement the feature"
```

`occtl send` and `occtl stream` merge stored defaults with explicit flags. Explicit flags win.

Defaults are stored locally under:

```text
${XDG_CONFIG_HOME:-~/.config}/occtl/sessions/<SESSION_ID>.json
```

Useful cleanup commands:

```bash
occtl show "$SID"          # session details and local defaults
occtl list --orphans       # defaults files with no live session
occtl rm "$SID"            # delete the session and its defaults file
occtl rm "$SID" --keep-defaults
```

## Server configuration

`occtl` tries to detect a running OpenCode server by inspecting local processes. Use `--attach host:port` for a specific server, or set environment variables when auto-detection is not enough:

```bash
occtl --attach seamus:4095 list --all
occtl ping --attach 127.0.0.1:4096
```

```bash
export OPENCODE_SERVER_HOST=127.0.0.1
export OPENCODE_SERVER_PORT=4096
export OPENCODE_SERVER_PASSWORD=YOUR_SERVER_PASSWORD
```

The password is sent with HTTP Basic authentication using the `opencode` username.

## Command reference

| Command | Purpose |
| --- | --- |
| `ping` | Check that an OpenCode server is reachable. |
| `list`, `ls` | List sessions for the current directory, another directory, or all directories. The OpenCode server caps each response at 100 rows; occtl pages transparently so `--all` returns every session the server lists. Use `status` to enumerate every session that has a status entry, including ones the server omits from the listing. |
| `create`, `new` | Create a session and optionally store model defaults. |
| `delete`, `rm` | Delete a session and remove its stored defaults. |
| `get`, `show` | Show session details and stored defaults. |
| `messages`, `msgs` | List session messages. |
| `last` | Print the last message, usually as text. |
| `status` | Show idle, waiting, busy, and retry status. |
| `watch` | Watch real-time session events. |
| `send`, `prompt` | Send a message to a session. |
| `stream` | Send a message and stream events until the session becomes idle. |
| `run` | Run a one-shot prompt in a new session. |
| `respond` | Respond to permission requests. |
| `models` | List providers, models, and variants from OpenCode configuration. |
| `todo` | Show the session todo list. |
| `abort` | Stop a running session. |
| `diff` | Show file changes for a session. |
| `children` | List child sessions. |
| `share` | Share a session and print the public URL. |
| `unshare` | Remove public sharing from a session. |
| `wait-for-text` | Wait until a message contains specific text. |
| `wait-for-idle` | Wait until one session and its child agents become idle. |
| `wait-any` | Wait until the first of multiple sessions becomes idle. |
| `wait-all` | Wait until all listed sessions become idle. |
| `is-idle` | Check aggregate idle state without blocking. |
| `summary` | Print status, todo progress, cost, and the latest output snippet. |
| `worktree`, `wt` | Manage git worktrees for isolated sessions. |
| `install-skill` | Install the bundled `occtl` skill for OpenCode-compatible agents. |
| `view-skill` | Print or locate the bundled `SKILL.md`. |

Run command-specific help for exact flags:

```bash
occtl help send
occtl help run
occtl help wt run
```

Most inspection and automation commands support `--json` for scripts.

## Agent orchestration examples

### Watch a session while you are away

Start a second session and ask it to supervise another session:

```text
Session ses_abc123 is working on a refactor. When it finishes, use occtl to ask it to create a pull request. Then monitor the CI pipeline. If CI fails, read the logs and send the session a prompt to fix the failures. Continue until CI passes.
```

The supervisory agent can use:

```bash
occtl wait-for-idle ses_abc123
occtl send -w -s ses_abc123 "create a pull request for this work"
occtl last ses_abc123
occtl send -w -s ses_abc123 "CI failed with this log. Fix it: ..."
```

### Review another session

```bash
DONE=$(occtl wait-any "$SID1" "$SID2" "$SID3")
occtl diff "$DONE" > /tmp/session.diff
REVIEW=$(occtl create -q -t "review $DONE")
occtl send -s "$REVIEW" --stdin < /tmp/session.diff
```

### Coordinate multiple repositories

```bash
API=$(occtl create -q -d /path/to/backend -t "users api")
WEB=$(occtl create -q -d /path/to/frontend -t "users client")

occtl send --async -s "$API" "Implement the /users endpoints."
occtl send --async -s "$WEB" "Implement the users API client."

occtl wait-all "$API" "$WEB" --require-busy
occtl summary "$API"
occtl summary "$WEB"
```

## OpenCode skill

`occtl` ships with a `SKILL.md` that teaches OpenCode-compatible agents how to use the CLI for session inspection, Ralph Loop workflows, permission handling, and worktree orchestration.

Install it as a user-level skill:

```bash
occtl install-skill
```

View the bundled skill without installing it:

```bash
occtl view-skill
occtl view-skill --path
```

## Support and status

`occtl` is published as [`@colinmollenhour/occtl`](https://www.npmjs.com/package/@colinmollenhour/occtl) and targets Node.js 20 or later.

Report problems in [GitHub issues](https://github.com/colinmollenhour/occtl/issues). Include the `occtl --version` output, the command you ran, and whether you are using a running OpenCode server or `occtl run --spawn`.

## Develop

Install dependencies and build the CLI:

```bash
npm install
npm run build
```

Run the TypeScript source during development:

```bash
npm run dev -- --help
```

Publish flow for maintainers:

```bash
npm version patch
git push
git push --tags
gh release create vX.Y.Z --generate-notes
```

The `Publish to npm` GitHub Action publishes package releases to npm with provenance.

## License

MIT
