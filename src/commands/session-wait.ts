import { Command } from "commander";
import { ensureServer } from "../client.js";
import { resolveSession } from "../resolve.js";
import { waitForIdle, waitForAnyIdle, waitForAllIdle } from "../wait-util.js";
import { formatJSON } from "../format.js";
import { getDerivedSessionStatus } from "../status-util.js";

// ─── wait-for-idle ─────────────────────────────────────

export function sessionWaitForIdleCommand(): Command {
  return new Command("wait-for-idle")
    .description(
      "Block until a session and its child agents go idle. Exits 0 when idle, 1 on timeout."
    )
    .argument("[session-id]", "Session ID (defaults to most recent)")
    .option(
      "-t, --timeout <seconds>",
      "Timeout in seconds (exit 1 if not idle in time)",
      parseInt
    )
    .option(
      "--require-busy",
      "Wait for an actual busy→idle transition; do not settle for sessions that are already (or have never left) idle"
    )
    .option(
      "--main-agent",
      "Only wait for the main agent to go idle, ignoring child sessions"
    )
    .action(async (sessionId: string | undefined, opts) => {
      const client = await ensureServer();
      const resolved = await resolveSession(client, sessionId);

      const timeoutMs = opts.timeout ? opts.timeout * 1000 : undefined;
      const result = await waitForIdle(client, resolved, timeoutMs, {
        requireBusy: !!opts.requireBusy,
        mainAgentOnly: !!opts.mainAgent,
      });

      if (result.idle) {
        process.exit(0);
      }

      if (result.reason === "timeout") {
        console.error("Timeout: session did not go idle in time.");
      } else if (result.reason === "disconnected") {
        console.error("Error: lost connection to OpenCode server.");
      }
      process.exit(1);
    });
}

// ─── wait-any ──────────────────────────────────────────

export function sessionWaitAnyCommand(): Command {
  return new Command("wait-any")
    .description(
      "Wait for the first of multiple sessions to go idle. Outputs the session ID that finished."
    )
    .argument(
      "<session-ids...>",
      "Two or more session IDs to watch"
    )
    .option(
      "-t, --timeout <seconds>",
      "Timeout in seconds (exit 1 if none finish)",
      parseInt
    )
    .option("-j, --json", "Output as JSON")
    .action(async (sessionIds: string[], opts) => {
      const client = await ensureServer();

      // Resolve all session IDs
      const resolved: string[] = [];
      for (const sid of sessionIds) {
        resolved.push(await resolveSession(client, sid));
      }

      const timeoutMs = opts.timeout ? opts.timeout * 1000 : undefined;
      const result = await waitForAnyIdle(client, resolved, timeoutMs);

      if (result.sessionID) {
        if (opts.json) {
          console.log(formatJSON({ sessionID: result.sessionID, reason: result.reason }));
        } else {
          console.log(result.sessionID);
        }
        process.exit(0);
      }

      if (result.reason === "timeout") {
        console.error("Timeout: no session went idle in time.");
      } else if (result.reason === "disconnected") {
        console.error("Error: lost connection to OpenCode server.");
      }
      process.exit(1);
    });
}

// ─── wait-all ──────────────────────────────────────────

export function sessionWaitAllCommand(): Command {
  return new Command("wait-all")
    .description(
      "Wait for all of multiple sessions to go idle. Outputs each session ID when all are idle."
    )
    .argument(
      "<session-ids...>",
      "Two or more session IDs to watch"
    )
    .option(
      "-t, --timeout <seconds>",
      "Timeout in seconds (exit 1 if any session does not finish)",
      parseInt
    )
    .option("-j, --json", "Output as JSON")
    .option(
      "--require-busy",
      "Wait for actual session.idle events; do not count sessions already idle at startup"
    )
    .action(async (sessionIds: string[], opts) => {
      const client = await ensureServer();

      const resolved: string[] = [];
      for (const sid of sessionIds) {
        resolved.push(await resolveSession(client, sid));
      }

      const timeoutMs = opts.timeout ? opts.timeout * 1000 : undefined;
      const result = await waitForAllIdle(client, resolved, timeoutMs, {
        requireBusy: !!opts.requireBusy,
      });

      if (result.pending.length === 0) {
        if (opts.json) {
          console.log(formatJSON({ sessionIDs: result.sessionIDs, reason: result.reason }));
        } else {
          console.log(result.sessionIDs.join("\n"));
        }
        process.exit(0);
      }

      if (opts.json) {
        console.log(formatJSON(result));
      }
      if (result.reason === "timeout") {
        console.error(`Timeout: ${result.pending.length} session(s) did not go idle in time.`);
      } else if (result.reason === "disconnected") {
        console.error("Error: lost connection to OpenCode server.");
      }
      process.exit(1);
    });
}

// ─── is-idle ───────────────────────────────────────────

export function sessionIsIdleCommand(): Command {
  return new Command("is-idle")
    .description(
      "Check if a session and its child agents are idle (non-blocking). Exit 0 = idle, exit 1 = busy."
    )
    .argument("[session-id]", "Session ID (defaults to most recent)")
    .option("-j, --json", "Output status as JSON")
    .option(
      "--require-busy",
      "Treat 'no status entry yet' as not-idle. Use in polling loops after `send --async` so brand-new sessions don't report idle before the prompt has started."
    )
    .option(
      "--main-agent",
      "Only check the main agent status, ignoring child sessions"
    )
    .action(async (sessionId: string | undefined, opts) => {
      const client = await ensureServer();
      const resolved = await resolveSession(client, sessionId);

      const derivedStatus = await getDerivedSessionStatus(client, resolved);
      const isIdle = opts.mainAgent
        ? opts.requireBusy
          ? derivedStatus.mainKnown && derivedStatus.main === "idle"
          : derivedStatus.mainIdle
        : opts.requireBusy
          ? derivedStatus.mainKnown && derivedStatus.allIdle
          : derivedStatus.allIdle;

      if (opts.json) {
        console.log(
          formatJSON({
            sessionID: resolved,
            idle: isIdle,
            status: opts.mainAgent ? derivedStatus.main : derivedStatus.type,
            mainStatus: derivedStatus.main,
            allIdle: derivedStatus.allIdle,
            activeChildren: derivedStatus.activeChildren,
          })
        );
      }

      process.exit(isIdle ? 0 : 1);
    });
}
