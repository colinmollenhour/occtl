import { Command } from "commander";
import { ensureServer } from "../client.js";
import { formatJSON } from "../format.js";
import { resolveSession } from "../resolve.js";
import { deriveSessionStatus, getRawSessionStatus } from "../status-util.js";

export function sessionStatusCommand(): Command {
  return new Command("status")
    .description("Get the status of sessions (idle, busy, retry, waiting)")
    .argument("[session-id]", "Session ID (defaults to showing all statuses)")
    .option("-j, --json", "Output as JSON")
    .option(
      "--main-agent",
      "Only report the main agent status, ignoring child sessions"
    )
    .action(async (sessionId: string | undefined, opts) => {
      const client = await ensureServer();

      const [statusResult, sessionsResult] = await Promise.all([
        client.session.status(),
        client.session.list({}),
      ]);
      const statuses = statusResult.data ?? {};
      const sessions = sessionsResult.data ?? [];

      if (opts.json) {
        if (sessionId) {
          const resolved = await resolveSession(client, sessionId);
          if (opts.mainAgent) {
            console.log(formatJSON(statuses[resolved] ?? { type: "idle" }));
          } else {
            console.log(formatJSON(deriveSessionStatus(resolved, statuses, sessions)));
          }
        } else {
          if (opts.mainAgent) {
            console.log(formatJSON(statuses));
          } else {
            console.log(
              formatJSON(
                Object.fromEntries(
                  sessions.map((session) => [
                    session.id,
                    deriveSessionStatus(session.id, statuses, sessions),
                  ])
                )
              )
            );
          }
        }
        return;
      }

      if (sessionId) {
        const resolved = await resolveSession(client, sessionId);
        const status = opts.mainAgent
          ? getRawSessionStatus(statuses, resolved)
          : deriveSessionStatus(resolved, statuses, sessions).type;
        console.log(`${resolved}: ${status}`);
        return;
      }

      const entries = opts.mainAgent
        ? Object.entries(statuses).map(([id, status]) => [id, status?.type ?? "idle"])
        : sessions.map((session) => [
            session.id,
            deriveSessionStatus(session.id, statuses, sessions).type,
          ]);
      if (entries.length === 0) {
        console.log("No active session statuses.");
        return;
      }

      console.log("SESSION\tSTATUS");
      for (const [id, status] of entries) {
        console.log(`${id}\t${status}`);
      }
    });
}
