import { Command } from "commander";
import { ensureServer, listAllSessions } from "../client.js";
import { formatJSON } from "../format.js";
import { resolveSession } from "../resolve.js";
import {
  deriveSessionStatus,
  getRawSessionStatus,
  type DerivedSessionStatus,
} from "../status-util.js";

export function sessionStatusCommand(): Command {
  return new Command("status")
    .description(
      "Get the status of sessions (idle, busy, retry, waiting). Without a session ID, reports every session the server has a status entry for — including sessions outside the server's default 100-row session.list page (occtl pages internally)."
    )
    .argument("[session-id]", "Session ID (defaults to showing all statuses)")
    .option("-j, --json", "Output as JSON")
    .option(
      "--main-agent",
      "Only report the main agent status, ignoring child sessions"
    )
    .action(async (sessionId: string | undefined, opts) => {
      const client = await ensureServer();

      const [statusResult, sessions] = await Promise.all([
        client.session.status(),
        listAllSessions(client),
      ]);
      const statuses = statusResult.data ?? {};

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
            // The server caps session.list at 100 rows, but its status map can
            // reference sessions outside that page — merge both so we never
            // silently drop a busy session that fell off the listing.
            const ids = unionIds(sessions, statuses);
            const derived: Record<string, DerivedSessionStatus> = {};
            for (const id of ids) {
              derived[id] = deriveSessionStatus(id, statuses, sessions);
            }
            console.log(formatJSON(derived));
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

      const entries: [string, string][] = opts.mainAgent
        ? Object.entries(statuses).map(([id, status]) => [id, status?.type ?? "idle"])
        : unionIds(sessions, statuses).map((id) => [
            id,
            deriveSessionStatus(id, statuses, sessions).type,
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

function unionIds(
  sessions: Array<{ id: string }>,
  statuses: Record<string, unknown>
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sessions) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s.id);
  }
  for (const id of Object.keys(statuses)) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
