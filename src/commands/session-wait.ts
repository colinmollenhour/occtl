import { Command } from "commander";
import { ensureServer } from "../client.js";
import { resolveSession } from "../resolve.js";
import { waitForIdle, waitForAnyIdle } from "../wait-util.js";
import { formatJSON } from "../format.js";

// ─── wait-for-idle ─────────────────────────────────────

export function sessionWaitForIdleCommand(): Command {
  return new Command("wait-for-idle")
    .description(
      "Block until a session goes idle. Exits 0 when idle, 1 on timeout."
    )
    .argument("[session-id]", "Session ID (defaults to most recent)")
    .option(
      "-t, --timeout <seconds>",
      "Timeout in seconds (exit 1 if not idle in time)",
      parseInt
    )
    .action(async (sessionId: string | undefined, opts) => {
      const client = await ensureServer();
      const resolved = await resolveSession(client, sessionId);

      const timeoutMs = opts.timeout ? opts.timeout * 1000 : undefined;
      const result = await waitForIdle(client, resolved, timeoutMs);

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

// ─── is-idle ───────────────────────────────────────────

export function sessionIsIdleCommand(): Command {
  return new Command("is-idle")
    .description(
      "Check if a session is idle (non-blocking). Exit 0 = idle, exit 1 = busy."
    )
    .argument("[session-id]", "Session ID (defaults to most recent)")
    .option("-j, --json", "Output status as JSON")
    .action(async (sessionId: string | undefined, opts) => {
      const client = await ensureServer();
      const resolved = await resolveSession(client, sessionId);

      const statusResult = await client.session.status();
      const statuses = statusResult.data ?? {};
      const current = statuses[resolved];
      const isIdle = !current || current.type === "idle";

      if (opts.json) {
        console.log(
          formatJSON({
            sessionID: resolved,
            idle: isIdle,
            status: current?.type ?? "idle",
          })
        );
      }

      process.exit(isIdle ? 0 : 1);
    });
}
