import { Command } from "commander";
import type { Event } from "@opencode-ai/sdk";
import { ensureServer, getClientV2 } from "../client.js";
import { resolveSession } from "../resolve.js";
import { readDefaults } from "../session-defaults.js";
import { startStream } from "../sse.js";
import { getDerivedSessionStatus } from "../status-util.js";
import { handleEvent } from "./session-watch.js";

// How often to poll the API as a fallback idle detector. The `session.idle`
// SSE event is the fast path; this poll only matters when that event is missed
// or never emitted (e.g. `--no-reply`, or a server version that doesn't emit it
// after tool calls), so a relaxed interval keeps server load low while still
// bounding the wait to a few seconds after the session actually goes idle.
const POLL_INTERVAL_MS = 5000;
// Consecutive idle polls — without ever observing the session go busy — after
// which we assume the turn produced no work and exit. Guards the rare case of a
// reply-less injection or an ultra-fast turn whose busy→idle events we missed.
const IDLE_GRACE_POLLS = 3;

function parseSeconds(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    console.error(
      `occtl stream: ${label} must be a non-negative number of seconds (got ${JSON.stringify(value)})`
    );
    process.exit(2);
  }
  return n * 1000;
}

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
      "--timeout <seconds>",
      "Hard deadline: stop and exit 124 if the session is not idle within this many seconds"
    )
    .option(
      "--idle-timeout <seconds>",
      "Stop and exit 124 if no new events arrive for this many seconds"
    )
    .action(async (messageParts: string[] | undefined, opts) => {
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

      const absTimeoutMs = opts.timeout ? parseSeconds(opts.timeout, "--timeout") : 0;
      const idleTimeoutMs = opts.idleTimeout
        ? parseSeconds(opts.idleTimeout, "--idle-timeout")
        : 0;

      // ─── Completion coordination ──────────────────────────────────────────
      // We exit when the session (and any sub-agents) returns to idle. The
      // `session.idle` SSE event is the fast path, but it can be missed or
      // never emitted, so an authoritative API poll backs it up. Without this
      // fallback, a dropped event leaves `stream` blocked on the event source
      // forever (the original bug).
      let settled = false;
      let exitCode = 0;
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => {
        resolveDone = r;
      });

      let handle: ReturnType<typeof startStream>;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let absTimer: ReturnType<typeof setTimeout> | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;

      const settle = (code: number) => {
        if (settled) return;
        settled = true;
        exitCode = code;
        if (pollTimer) clearInterval(pollTimer);
        if (absTimer) clearTimeout(absTimer);
        if (idleTimer) clearTimeout(idleTimer);
        handle.cancel();
        resolveDone();
      };

      // Whether we've observed the session actually working. Receiving a
      // `session.idle` event or a non-idle status both prove a turn ran, which
      // lets us distinguish "done" from "prompt not picked up yet".
      let sawBusy = false;
      let idleStreak = 0;

      const checkIdle = async (viaIdleEvent: boolean): Promise<void> => {
        if (settled) return;
        let status;
        try {
          status = await getDerivedSessionStatus(client, resolved);
        } catch {
          return; // Transient API failure; a later event/poll will retry.
        }
        if (settled) return;
        if (!status.allIdle) {
          sawBusy = true;
          idleStreak = 0;
          return;
        }
        // Whole tree (main + sub-agents) is idle.
        if (sawBusy || viaIdleEvent || opts.reply === false) {
          settle(0);
          return;
        }
        // Idle, but we never saw the session go busy. Could be a turn that
        // finished between polls, or a prompt the server hasn't started yet.
        // Require several consecutive idle polls before giving up.
        if (++idleStreak >= IDLE_GRACE_POLLS) settle(0);
      };

      const armIdleTimer = () => {
        if (!idleTimeoutMs || settled) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          process.stderr.write(
            `\nocctl stream: no events for ${opts.idleTimeout}s; giving up (exit 124). ` +
              "Use `occtl last` to read the result.\n"
          );
          settle(124);
        }, idleTimeoutMs);
      };

      // Open SSE first so we don't miss early events.
      handle = startStream(resolved, (event: Event) => {
        if (opts.json) {
          process.stdout.write(JSON.stringify(event) + "\n");
        } else {
          handleEvent(event);
        }
        armIdleTimer();
        if (event.type === "session.status") {
          const t = (event.properties as { status?: { type?: string } })?.status?.type;
          if (t && t !== "idle") {
            sawBusy = true;
            idleStreak = 0;
          }
        }
        if (event.type === "session.idle") {
          void checkIdle(true);
        }
      });

      // Surface an unexpected stream drop (distinct from a clean idle exit).
      void handle.result.then((streamResult) => {
        if (!settled && streamResult === "disconnected") {
          process.stderr.write("\nLost connection to OpenCode server.\n");
          settle(1);
        }
      });

      await handle.connected;

      await clientV2.session.promptAsync({
        sessionID: resolved,
        parts: [{ type: "text", text: messageText }],
        ...(model && { model }),
        ...(agent && { agent }),
        ...(variant && { variant }),
        ...(opts.reply === false && { noReply: true }),
      });

      // Arm the safety nets and idle poll only once the prompt is in flight.
      armIdleTimer();
      if (absTimeoutMs) {
        absTimer = setTimeout(() => {
          process.stderr.write(
            `\nocctl stream: not idle after ${opts.timeout}s; giving up (exit 124). ` +
              "Use `occtl last` to read the result.\n"
          );
          settle(124);
        }, absTimeoutMs);
      }
      pollTimer = setInterval(() => void checkIdle(false), POLL_INTERVAL_MS);
      // Kick an immediate check so reply-less injections (which never go busy)
      // and already-finished turns don't wait a full poll interval.
      void checkIdle(false);

      await done;
      if (exitCode !== 0) process.exit(exitCode);
    });
}
