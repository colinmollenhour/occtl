import { Command } from "commander";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { ensureServer, getClientV2 } from "../client.js";
import { resolveSession } from "../resolve.js";
import { readDefaults } from "../session-defaults.js";
import { startStream, type StreamHandle } from "../sse.js";
import { getDerivedSessionStatus } from "../status-util.js";
import { makeIdleTracker, snapshotAssistantIds, waitForTurnComplete } from "../turn-util.js";
import { handleEvent } from "./session-watch.js";

type StreamExitReason = "completed" | "timeout" | "disconnected";

// Steady-state cadence of the message-completion poll (the SSE stream pokes it
// to re-check sooner when the server does emit events).
const POLL_INTERVAL_MS = 1500;
// How often to re-check the session tree while waiting for sub-agents.
const CHILD_POLL_INTERVAL_MS = 1500;

export function sessionStreamCommand(): Command {
  return new Command("stream")
    .description(
      "Send a message and stream events live (text deltas + tool calls) until the session is idle"
    )
    .argument("[message...]", "Message text to send (omit when --stdin is used)")
    .option("-s, --session <id>", "Session ID (defaults to most recent)")
    .option("-j, --json", "Emit each event as a JSON line (NDJSON) instead of formatted output")
    .option("--no-reply", "Send as context injection (no AI response)")
    .option("--agent <agent>", "Agent to use")
    .option("--model <model>", "Model to use (format: provider/model)")
    .option("--variant <variant>", "Model variant to use (e.g. high)")
    .option("--stdin", "Read message from stdin instead of arguments")
    .option(
      "-t, --timeout <seconds>",
      "Exit 124 if the session is still busy after this many seconds. " +
        "Bound long runs and fall back to `occtl last` for the result."
    )
    .option(
      "--wait-children",
      "Stay until sub-agent (child) sessions are also idle, not just the main " +
        "agent. Matches the tree-aware idle semantics of `wait-for-idle`/`is-idle`."
    )
    .action(async (messageParts: string[] | undefined, opts) => {
      // Validate CLI args before contacting the server (fail fast). Parse the
      // raw string with Number() so partial/invalid input ("10abc", "abc") is
      // rejected rather than silently coerced by parseInt.
      let timeoutMs = 0;
      if (opts.timeout !== undefined) {
        const timeoutSeconds = Number(opts.timeout);
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
          console.error("--timeout must be a non-negative number of seconds.");
          process.exit(2);
        }
        timeoutMs = timeoutSeconds * 1000;
      }

      const client = await ensureServer();
      const clientV2 = getClientV2();
      const resolved = await resolveSession(client, opts.session);

      let messageText: string;
      if (opts.stdin) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        messageText = Buffer.concat(chunks).toString("utf-8").trim();
      } else {
        messageText = (messageParts ?? []).join(" ");
      }

      if (!messageText) {
        console.error("No message provided.");
        process.exit(1);
      }

      const stored = readDefaults(resolved) ?? {};
      const modelStr: string | undefined = opts.model ?? stored.model;
      const agent: string | undefined = opts.agent ?? stored.agent;
      const variant: string | undefined = opts.variant ?? stored.variant;

      let model: { providerID: string; modelID: string } | undefined;
      if (modelStr) {
        const parts = modelStr.split("/");
        if (parts.length === 2 && parts[0] && parts[1]) {
          model = { providerID: parts[0], modelID: parts[1] };
        }
      }

      const noReply = opts.reply === false;

      let reason: StreamExitReason;
      try {
        reason = await runStream({
          client,
          clientV2,
          sessionId: resolved,
          messageText,
          model,
          agent,
          variant,
          noReply,
          json: !!opts.json,
          timeoutMs,
          waitChildren: !!opts.waitChildren,
        });
      } catch (err) {
        // Startup failure (server unreachable during snapshot / promptAsync
        // auth/4xx). Surface it cleanly with exit 1 — parity with `run` — rather
        // than as a raw unhandled rejection.
        console.error(
          `\nocctl stream: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
      }

      if (reason === "timeout") {
        // Diagnostics go to stderr so --json stdout stays valid NDJSON.
        console.error(
          `\nocctl stream: timed out after ${opts.timeout} second(s). ` +
            `The session may still be running — read the result with \`occtl last ${resolved}\`.`
        );
        process.exit(124);
      }
      if (reason === "disconnected") {
        console.error("\nLost connection to OpenCode server.");
        process.exit(1);
      }
    });
}

interface RunStreamArgs {
  client: OpencodeClient;
  clientV2: ReturnType<typeof getClientV2>;
  sessionId: string;
  messageText: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
  noReply: boolean;
  json: boolean;
  timeoutMs: number;
  waitChildren: boolean;
}

/**
 * Send a message, stream events live for display, and return once the submitted
 * turn has actually completed.
 *
 * Completion is detected by polling `session.messages` for a NEW assistant
 * message that the server has finalized (`time.completed`/`error`) — see
 * `waitForTurnComplete`. This is the only signal that is reliable across
 * opencode server versions: some never deliver `session.idle`/`session.status`
 * SSE events for a session, and `session.status()` can report a busy session as
 * absent. The SSE stream here is therefore best-effort: it renders live output,
 * *pokes* the poller to re-check sooner, and feeds the idle tracker that lets
 * the poller rescue turns the server abandons without finalizing them — but a
 * dead stream never blocks a normal completion.
 *
 * This fixes two regressions:
 *  - the premature empty exit (a pre-send snapshot means a fresh/idle session
 *    can never look "already complete"), and
 *  - the original hang (message state is polled, so a missed terminal SSE event
 *    cannot wedge the command).
 *
 * `--wait-children` waits for the main turn to finish, then polls the session
 * tree until every sub-agent is idle too. `--timeout` bounds the whole wait and
 * exits 124 without aborting (so the caller can recover via `occtl last`).
 */
async function runStream(args: RunStreamArgs): Promise<StreamExitReason> {
  const {
    client,
    clientV2,
    sessionId,
    messageText,
    model,
    agent,
    variant,
    noReply,
    json,
    timeoutMs,
    waitChildren,
  } = args;

  const abort = new AbortController();
  let poke: (() => void) | undefined;
  let handle: StreamHandle | undefined;

  // `--timeout` arms a single deadline that bounds the ENTIRE operation —
  // SSE connect, the pre-send snapshot, `promptAsync`, and the completion wait —
  // so a stalled connection or hung request can never outlive the requested
  // budget. Firing it aborts every in-flight step; `timedOut` distinguishes a
  // deadline abort (exit 124) from a SIGINT/disconnect abort.
  let timedOut = false;
  const hardTimer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          abort.abort();
        }, timeoutMs)
      : undefined;

  const onSignal = (sig: NodeJS.Signals): void => {
    abort.abort();
    handle?.cancel();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const finish = (reason: StreamExitReason): StreamExitReason => {
    if (hardTimer) clearTimeout(hardTimer);
    handle?.cancel();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    return reason;
  };

  // Resolves (never rejects) the instant the deadline/signal aborts, so we can
  // race it against connect/snapshot/send without risking an unhandled
  // rejection if the abort lands after a step already settled.
  const ABORTED = Symbol("aborted");
  const abortedP: Promise<typeof ABORTED> = new Promise((resolve) => {
    if (abort.signal.aborted) resolve(ABORTED);
    else abort.signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
  });
  const abortReason = (): StreamExitReason => (timedOut ? "timeout" : "disconnected");

  // Open the SSE stream first (best-effort live display + poll accelerator +
  // idle tracking for the abandoned-turn fallback). Reconnect on silent drops
  // so a multi-hour turn cannot permanently lose the display or idle signal.
  const idleTracker = makeIdleTracker();
  handle = startStream(
    sessionId,
    (event) => {
      idleTracker.observe(event);
      if (json) {
        process.stdout.write(JSON.stringify(event) + "\n");
      } else {
        handleEvent(event);
      }
      // Only genuine terminal/transition hints nudge the poller — NOT per-delta
      // message events. Poking on per-token events would collapse the steady
      // 1.5s cadence into a back-to-back full-history `session.messages()`
      // loop for the whole turn, hammering the server and risking false
      // `disconnected` exits under load on servers that stream.
      if (
        event.type === "session.idle" ||
        event.type === "session.status" ||
        event.type === "message.updated"
      ) {
        poke?.();
      }
    },
    { reconnect: true }
  );

  // Wait for the SSE connection so live display catches early events, but bound
  // it by the deadline (connected resolves even on connect failure, so the only
  // thing this guards against is a server that accepts the socket then stalls).
  await Promise.race([handle.connected, abortedP]);
  if (abort.signal.aborted) return finish(abortReason());

  // Snapshot existing assistant message IDs BEFORE sending so a brand-new
  // finalized assistant message unambiguously marks our turn's completion.
  const snap = await Promise.race([
    snapshotAssistantIds(client, sessionId).then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e })
    ),
    abortedP,
  ]);
  if (snap === ABORTED) return finish(abortReason());
  if (!snap.ok) {
    finish("disconnected");
    throw snap.e;
  }
  const priorAssistantIds = snap.v;

  const sent = await Promise.race([
    clientV2.session
      .promptAsync({
        sessionID: sessionId,
        parts: [{ type: "text", text: messageText }],
        ...(model && { model }),
        ...(agent && { agent }),
        ...(variant && { variant }),
        ...(noReply && { noReply: true }),
      })
      .then(
        () => ({ ok: true as const }),
        (e) => ({ ok: false as const, e })
      ),
    abortedP,
  ]);
  if (sent === ABORTED) return finish(abortReason());
  if (!sent.ok) {
    // promptAsync failed (auth / network / 400) — surface the real error.
    finish("disconnected");
    throw sent.e;
  }

  // Context injection produces no assistant turn: nothing to wait for.
  if (noReply) return finish("completed");

  // The deadline is owned by the hard timer (via the abort signal), so the
  // wait is signal-driven; a deadline abort surfaces as `timedOut`.
  const turn = await waitForTurnComplete(client, sessionId, {
    priorAssistantIds,
    pollIntervalMs: POLL_INTERVAL_MS,
    onPoke: (p) => {
      poke = p;
    },
    idleSince: idleTracker.idleSince,
    signal: abort.signal,
  });
  if (turn.status !== "completed") return finish(abortReason());

  // Main turn finished. With --wait-children, also wait for sub-agents to idle.
  if (waitChildren) {
    const childReason = await waitForChildrenIdle(client, sessionId, abort.signal);
    if (childReason !== "completed") return finish(abortReason());
    return finish("completed");
  }

  return finish("completed");
}

/**
 * Poll the session tree until every sub-agent (descendant) is idle, stopping if
 * the shared abort signal fires (deadline or interrupt). Best-effort: on servers
 * whose `session.status()` omits busy children this returns as soon as no active
 * child is observed (matching `wait-for-idle`/`is-idle` semantics).
 */
async function waitForChildrenIdle(
  client: OpencodeClient,
  sessionId: string,
  signal: AbortSignal
): Promise<StreamExitReason> {
  // Single abort listener (registered once) ends the current sleep early.
  let endSleep: (() => void) | undefined;
  const onAbort = (): void => endSleep?.();
  signal.addEventListener("abort", onAbort);
  try {
    while (true) {
      if (signal.aborted) return "disconnected";
      try {
        const derived = await getDerivedSessionStatus(client, sessionId);
        if (derived.allIdle) return "completed";
      } catch {
        // Tree status unavailable; retry until the signal aborts.
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          endSleep = undefined;
          resolve();
        }, CHILD_POLL_INTERVAL_MS);
        endSleep = () => {
          clearTimeout(timer);
          endSleep = undefined;
          resolve();
        };
      });
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
