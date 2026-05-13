# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`occtl` is a Node.js CLI that controls a running OpenCode server over HTTP/SSE. It is published as `@colinmollenhour/occtl` and ships a single binary (`dist/index.js`). It targets Node 20+, is written in TypeScript with ES modules (`"type": "module"`), and depends on `@opencode-ai/sdk` (both v1 and v2 entry points) plus `commander`.

`README.md` is the authoritative user-facing reference for commands, flags, and exit codes — when adding or changing commands, update it alongside `SKILL.md` (the bundled OpenCode skill installed via `occtl install-skill`).

## Commands

```bash
npm install
npm run build          # tsc → dist/
npm run dev -- <args>  # run src/index.ts via tsx, e.g. `npm run dev -- list`
```

There are no unit tests. `npm test` is a placeholder that exits 1. Validate changes by running `npm run dev` against a local `opencode serve`, or by building and invoking `node dist/index.js`.

The `prepublishOnly` hook runs `tsc`, and the `Publish to npm` GitHub Action (`.github/workflows/publish.yml`) publishes on GitHub Release with npm provenance.

## Source layout

- `src/index.ts` — Commander entrypoint. Registers every top-level command plus the `worktree`/`wt` subcommand group. Adds a global `--attach host:port` option to every command via `applyAttachOption` and resolves it in a `preAction` hook.
- `src/commands/*.ts` — One file per command. Each exports a `fooCommand()` factory that returns a `Command`. Adding a command means: write the factory, then `program.addCommand(fooCommand())` in `index.ts`.
- `src/client.ts` — Server detection, SDK client construction, auth, and `listAllSessions` pagination. Holds module-level cached clients; `setServer()` / `setPassword()` reset the cache.
- `src/resolve.ts` — Resolves a session argument (full ID / partial ID / title substring / omitted → most recent for cwd) into a real session ID. Most commands call this first.
- `src/sse.ts` — Low-level SSE consumer for `${baseUrl}/event`. `startStream` / `startAllStream` return a handle with `connected`, `result`, and `cancel`. Used by watch, stream, and the wait utilities.
- `src/wait-util.ts` — Race-safe idle waiters (`waitForIdle`, `waitForAnyIdle`, `waitForAllIdle`). They start the SSE stream **before** the initial API status check to close the window where a session transitions to idle between check and subscription.
- `src/status-util.ts` — Derives the user-visible `idle|waiting|busy|retry` state for a parent session by combining the raw status map with the session tree (a parent with active children reports `waiting`, not `idle`).
- `src/session-defaults.ts` — Per-session model/variant/agent defaults persisted at `${XDG_CONFIG_HOME:-~/.config}/occtl/sessions/<id>.json`. `send` and `stream` merge these with explicit flags (explicit wins).
- `src/spawn.ts` — Spawns an ephemeral `opencode serve` for `run --spawn`. Allocates a free port, redirects `XDG_STATE_HOME` to a fresh tmpdir (works around non-writable user state dirs), waits for the `listening on http` log line, and returns a handle with `shutdown()`.
- `src/format.ts` — Shared formatters for sessions, messages, parts, and JSON output.

## Architecture notes that span multiple files

**Two SDK clients.** v1 (`getClient`) is the default; v2 (`getClientV2`) is used specifically for prompt sending (`session.prompt` and `session.promptAsync`). Both are constructed lazily and share a custom `authFetch` that injects HTTP Basic auth headers when a password is configured. When changing server / password mid-process (e.g. after `--spawn`), call `setServer` / `setPassword` to invalidate the cached clients.

**Server discovery cascade.** `detectServer()` in `client.ts` tries (1) env vars `OPENCODE_SERVER_HOST`/`PORT`, (2) parsing `ps aux | grep 'opencode serve'` for `--port` / `--hostname`, (3) `127.0.0.1:4096`. A global `--attach host:port` (validated against IPv4 `host:port` and bracketed IPv6) overrides everything via `setServer()` in the Commander `preAction` hook.

**Pagination.** The OpenCode v1 list endpoint caps responses at 100 rows and has no cursor. `listAllSessions` requests a generous `limit` (starts at 1000) and quadruples it up to six times whenever the server returns exactly the limit — that's the only signal more rows exist. Any code that needs "all sessions" should call this, not `client.session.list()` directly.

**Parent/child session idle semantics.** Sub-agents are tracked as child sessions with `parentID`. `deriveSessionStatus` walks descendants and reports `waiting` whenever the parent is idle but any descendant is still active. `waitForIdle` defaults to listening on `startAllStream` (all sessions) and only resolves when the whole tree is idle; `--main-agent` switches it to parent-only via `startStream(sessionId, …)`. When in doubt, prefer tree-aware behavior — callers asking for `--main-agent` know they want it.

**`requireBusy` flag.** A fresh session is idle from creation. `send --async` returns before the server marks the session busy, so a naïve `wait-for-idle` poll can return immediately on a session that has never run. `requireBusy: true` skips the initial API shortcut and only honors a real `session.idle` SSE event, ensuring we observe the busy→idle transition.

**ESM + `.js` import suffixes.** `tsconfig.json` uses `module: ESNext`, `moduleResolution: bundler`, and `"type": "module"` in package.json. Local imports in TS source must use the `.js` suffix (e.g. `import { ensureServer } from "../client.js"`) — TypeScript resolves it but the compiled output keeps the suffix so Node's ESM loader can find the file. Match this style in new files.

**Security in shell-outs.** `worktree.ts` and `spawn.ts` use `execFileSync` / `spawn` with argv arrays (no shell). Preserve this when adding new git/process integrations — never compose shell strings from user input.

## Releasing

```bash
npm version patch    # commits + tags
git push && git push --tags
gh release create vX.Y.Z --generate-notes
```

The release event triggers `.github/workflows/publish.yml`, which builds and runs `npm publish --access public --provenance` using `NPM_TOKEN`.
