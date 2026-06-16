import { Command } from "commander";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { ensureServer, getClientV2 } from "../client.js";
import { resolveSession } from "../resolve.js";
import { readDefaults } from "../session-defaults.js";
import { startStream, type StreamHandle } from "../sse.js";
import { getDerivedSessionStatus } from "../status-util.js";
import { handleEvent } from "./session-watch.js";

type StreamIdleReason = "sse" | "api" | "timeout" | "disconnected";

// After promptAsync resolves, wait this long before the API fallback poll may
// declare idle without having observed the session go busy. Covers turns that
// finish faster than a poll can observe busy, and servers that never emit
// session.idle / session.status at all (the original hang bug).
const IDLE_GRACE_MS = 3000;
const POLL_INTERVAL_MS = 2000;

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

      const reason = await runStream({
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
 * Send a message and stream events until the session is idle.
 *
 * Idle is detected via any of:
 *   - `session.idle` SSE event (authoritative: we subscribe before sending, so
 *     it cannot be stale from a prior turn),
 *   - `session.status` SSE event with type "idle", but only after the session
 *     has been observed busy (avoids exiting on a pre-turn idle snapshot),
 *   - periodic `client.session.status()` API poll, gated the same way plus a
 *     short grace period, so a missed/never-emitted terminal SSE event can
 *     never hang the command (the original bug).
 *
 * Detection is main-agent-only by default (matching the original `stream`
 * behavior and avoiding the `listAllSessions` tree walk). With `waitChildren`,
 * idle is instead derived from the whole session tree (`getDerivedSessionStatus`),
 * so it waits for sub-agents too. In that mode the terminal SSE events only
 * *trigger* a tree re-check rather than settling directly, because child
 * sessions are not delivered on this single-session stream — the API poll is
 * the authority for "all sub-agents idle".
 *
 * The detector owns its own settled/reason state. `handle.cancel()` resolves
 * the underlying SSE handle as "disconnected", so we must NOT treat a
 * self-induced cancel as a lost connection — only an unsolicited disconnect
 * (stream ended on its own while not settled) is reported as "disconnected".
 */
async function runStream(args: RunStreamArgs): Promise<StreamIdleReason> {
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

  const state: {
    handle: StreamHandle | undefined;
    settled: boolean;
    sawBusy: boolean;
    polling: boolean;
    promptResolvedAt: number;
    pollTimer: ReturnType<typeof setInterval> | undefined;
    hardTimer: ReturnType<typeof setTimeout> | undefined;
  } = {
    handle: undefined,
    settled: false,
    sawBusy: false,
    polling: false,
    promptResolvedAt: 0,
    pollTimer: undefined,
    hardTimer: undefined,
  };

  let resolveReason!: (r: StreamIdleReason) => void;
  const done = new Promise<StreamIdleReason>((resolve) => {
    resolveReason = resolve;
  });

  // Forward declaration so settle/cleanup can detach the signal handlers.
  let onSignal: (sig: NodeJS.Signals) => void = () => {};

  const idleEligible = (): boolean =>
    state.sawBusy ||
    noReply ||
    (state.promptResolvedAt > 0 &&
      Date.now() - state.promptResolvedAt >= IDLE_GRACE_MS);

  const cleanup = (): void => {
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (state.hardTimer) clearTimeout(state.hardTimer);
    state.handle?.cancel();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };

  const settle = (reason: StreamIdleReason): void => {
    if (state.settled) return;
    state.settled = true;
    cleanup();
    resolveReason(reason);
  };

  // One status check. Sets sawBusy if the turn has started; settles on idle
  // only once idle-eligible. Used both as an immediate post-prompt probe and as
  // the periodic fallback. Guards against overlapping calls on slow APIs.
  //
  // Default: raw `session.status()` for the target session (main-agent-only).
  // With waitChildren: tree-aware `getDerivedSessionStatus`, so "idle" requires
  // the main agent and every sub-agent to be idle.
  const probeStatus = async (): Promise<void> => {
    if (state.settled || state.polling) return;
    state.polling = true;
    try {
      if (waitChildren) {
        const derived = await getDerivedSessionStatus(client, sessionId);
        // sawBusy is the eligibility gate — it must track the MAIN agent's
        // turn starting, NOT descendant activity. A pre-existing background
        // child would otherwise mark sawBusy before this prompt's turn begins,
        // letting a later all-idle snapshot settle pre-turn idle.
        if (!derived.mainIdle) state.sawBusy = true;
        // Exit only when the whole tree (main + sub-agents) is idle.
        if (derived.allIdle && idleEligible()) settle("api");
      } else {
        const statusResult = await client.session.status();
        const statuses = statusResult.data ?? {};
        const type = statuses[sessionId]?.type;
        if (type === "busy" || type === "retry") {
          state.sawBusy = true;
        } else if (idleEligible()) {
          // idle, or no status entry yet — only terminal if eligible.
          settle("api");
        }
      }
    } catch {
      // API check failed; rely on SSE events and later polls.
    } finally {
      state.polling = false;
    }
  };

  // Open SSE first so we don't miss the busy→idle transition.
  state.handle = startStream(sessionId, (event) => {
    if (json) {
      process.stdout.write(JSON.stringify(event) + "\n");
    } else {
      handleEvent(event);
    }
    switch (event.type) {
      case "session.idle":
        // Authoritative terminal signal for the MAIN agent (we subscribed
        // before sending). With --wait-children, sub-agents may still be
        // running and their events are not delivered on this single-session
        // stream, so re-check the whole tree via the API instead of stopping.
        if (waitChildren) {
          void probeStatus();
        } else {
          settle("sse");
          return "stop";
        }
        break;
      case "session.status": {
        const props = event.properties as { status?: { type?: string } };
        const type = props.status?.type;
        if (type === "busy" || type === "retry") {
          state.sawBusy = true;
        } else if (type === "idle") {
          // A status snapshot may reflect pre-turn idle; only act once the
          // turn has actually started (or the grace backstop has elapsed).
          if (waitChildren) {
            void probeStatus();
          } else if (idleEligible()) {
            settle("sse");
            return "stop";
          }
        }
        break;
      }
      case "message.updated":
      case "message.part.updated":
        // The turn is producing output, so a later idle is a genuine finish.
        state.sawBusy = true;
        break;
      default:
        break;
    }
    return;
  });

  // Unsolicited stream end ⇒ lost connection. A self-induced cancel (from
  // settle) resolves as "disconnected" too, but by then state.settled is true.
  state.handle.result.then((streamResult) => {
    if (!state.settled && streamResult === "disconnected") settle("disconnected");
  });

  if (timeoutMs > 0) {
    state.hardTimer = setTimeout(() => settle("timeout"), timeoutMs);
  }

  // Tear down cleanly on interrupt so timers/SSE don't linger.
  onSignal = (sig: NodeJS.Signals): void => {
    settle("disconnected");
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  // Race each await against `done` so a --timeout / signal / unsolicited
  // disconnect (any of which calls settle() and resolves `done`) can
  // short-circuit promptly even if the awaited operation is still in flight.
  await Promise.race([state.handle.connected, done]);
  // If a timeout/signal/disconnect fired while connecting, stop without sending.
  if (state.settled) return done;

  const promptP = clientV2.session.promptAsync({
    sessionID: sessionId,
    parts: [{ type: "text", text: messageText }],
    ...(model && { model }),
    ...(agent && { agent }),
    ...(variant && { variant }),
    ...(noReply && { noReply: true }),
  });
  try {
    await Promise.race([promptP, done]);
  } catch (err) {
    // promptAsync failed (auth/Network/400). Clean up timers/SSE, then surface
    // the real error rather than masking it as "lost connection".
    cleanup();
    throw err;
  }
  if (state.settled) {
    // Settled while promptAsync was still in flight; swallow any late rejection
    // so it doesn't surface as an unhandled promise rejection after we return.
    promptP.catch(() => {});
    return done;
  }
  state.promptResolvedAt = Date.now();

  // Immediate probe fast-paths sawBusy if the server is already busy.
  await Promise.race([probeStatus(), done]);
  if (state.settled) {
    // The probe settled (e.g. --no-reply with the session already idle): do not
    // arm the periodic poller (cleanup() already ran).
    return done;
  }

  // Periodic fallback in case the terminal SSE event is missed or never sent.
  state.pollTimer = setInterval(() => {
    void probeStatus();
  }, POLL_INTERVAL_MS);

  return done;
}
