import { Command } from "commander";
import { ensureServer } from "../client.js";
import { resolveSession } from "../resolve.js";
import { streamEvents, streamAllEvents, getEventSessionId } from "../sse.js";
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

      // First do a quick non-blocking check
      const statusResult = await client.session.status();
      const statuses = statusResult.data ?? {};
      const current = statuses[resolved];
      if (!current || current.type === "idle") {
        // Already idle
        process.exit(0);
      }

      // Set up timeout
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (opts.timeout && opts.timeout > 0) {
        timer = setTimeout(() => process.exit(1), opts.timeout * 1000);
      }

      await streamEvents(resolved, (event) => {
        if (event.type === "session.idle") {
          if (timer) clearTimeout(timer);
          return "stop";
        }
      });

      process.exit(0);
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
      const watchSet = new Set(resolved);

      // Quick check: any already idle?
      const statusResult = await client.session.status();
      const statuses = statusResult.data ?? {};
      for (const sid of resolved) {
        const current = statuses[sid];
        if (!current || current.type === "idle") {
          if (opts.json) {
            console.log(formatJSON({ sessionID: sid, reason: "already_idle" }));
          } else {
            console.log(sid);
          }
          process.exit(0);
        }
      }

      // Set up timeout
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (opts.timeout && opts.timeout > 0) {
        timer = setTimeout(() => process.exit(1), opts.timeout * 1000);
      }

      // Watch the event stream for any of our sessions going idle
      await streamAllEvents((event) => {
        if (event.type !== "session.idle") return;

        const eventSid = getEventSessionId(event);
        if (!eventSid || !watchSet.has(eventSid)) return;

        if (timer) clearTimeout(timer);

        if (opts.json) {
          console.log(formatJSON({ sessionID: eventSid, reason: "idle" }));
        } else {
          console.log(eventSid);
        }

        return "stop";
      });

      process.exit(0);
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
