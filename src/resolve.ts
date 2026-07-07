import type { OpencodeClient, Session } from "@opencode-ai/sdk";
import { listAllSessions } from "./client.js";

/**
 * Resolve a session ID. If none is provided, returns the most recently updated session
 * for the current directory. Also supports partial ID matching.
 */
export async function resolveSession(
  client: OpencodeClient,
  sessionId?: string
): Promise<string> {
  if (!sessionId) {
    // Get most recent session for the current directory
    const dir = process.cwd();
    let sessions = (await listAllSessions(client, { directory: dir })).filter(
      (s: Session) => !s.parentID && s.directory === dir
    );
    if (sessions.length === 0) {
      console.error(`No sessions found for ${dir}.`);
      process.exit(1);
    }
    // Sessions are sorted by most recently updated
    return sessions[0].id;
  }

  // Try exact match first
  try {
    const result = await client.session.get({
      path: { id: sessionId },
    });
    if (result.data) {
      return result.data.id;
    }
  } catch {
    // Fall through to partial match
  }

  // Try partial match (global search so partial IDs work across all sessions)
  const sessions = await listAllSessions(client);
  const matches = sessions.filter(
    (s: Session) =>
      s.id.startsWith(sessionId) ||
      s.id.includes(sessionId) ||
      (s.title && s.title.toLowerCase().includes(sessionId.toLowerCase()))
  );

  if (matches.length === 0) {
    console.error(`No session found matching: ${sessionId}`);
    process.exit(1);
  }

  if (matches.length > 1) {
    // Prefer sessions in the current directory to resolve ambiguity
    const dir = process.cwd();
    const cwdMatches = matches.filter((s: Session) => s.directory === dir);
    if (cwdMatches.length === 1) {
      return cwdMatches[0].id;
    }

    console.error(`Ambiguous session ID "${sessionId}", matches:`);
    for (const m of matches.slice(0, 5)) {
      console.error(`  ${m.id}  ${m.title || "(untitled)"}  (${m.directory})`);
    }
    process.exit(1);
  }

  return matches[0].id;
}
