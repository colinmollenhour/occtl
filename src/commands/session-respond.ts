import { Command } from "commander";
import { ensureServer, getClient } from "../client.js";
import { resolveSession } from "../resolve.js";
import { formatJSON } from "../format.js";
import { streamEvents } from "../sse.js";
import type { StreamResult } from "../sse.js";

export function sessionRespondCommand(): Command {
  return new Command("respond")
    .description("Respond to a permission request in a session")
    .argument("[session-id]", "Session ID (defaults to most recent)")
    .option(
      "-r, --response <response>",
      "Response: once, always, or reject",
      "once"
    )
    .option("-j, --json", "Output as JSON")
    .option(
      "-p, --permission-id <id>",
      "Permission ID to respond to (auto-detects if omitted)"
    )
    .option("-w, --wait", "Wait for a permission request if none pending")
    .option(
      "--auto-approve",
      "Automatically approve all permission requests (implies --wait)"
    )
    .action(async (sessionId: string | undefined, opts) => {
      const client = await ensureServer();
      const resolved = await resolveSession(client, sessionId);

      const validResponses = ["once", "always", "reject"];
      if (!validResponses.includes(opts.response)) {
        console.error(
          `Invalid response: ${opts.response}. Must be one of: ${validResponses.join(", ")}`
        );
        process.exit(1);
      }

      if (opts.permissionId) {
        await respondToPermission(resolved, opts.permissionId, opts.response);
        if (opts.json) {
          console.log(formatJSON({ success: true, permissionId: opts.permissionId }));
        } else {
          console.log(
            `Responded to permission ${opts.permissionId} with: ${opts.response}`
          );
        }
        return;
      }

      if (opts.wait || opts.autoApprove) {
        await waitAndRespond(resolved, opts);
        return;
      }

      console.error(
        "No --permission-id specified. Use --wait to wait for permission requests."
      );
      process.exit(1);
    });
}

async function respondToPermission(
  sessionId: string,
  permissionId: string,
  response: "once" | "always" | "reject"
): Promise<void> {
  const client = getClient();
  await client.postSessionIdPermissionsPermissionId({
    path: { id: sessionId, permissionID: permissionId },
    body: { response },
  });
}

async function waitAndRespond(
  sessionId: string,
  opts: { response: string; json?: boolean; autoApprove?: boolean }
): Promise<void> {
  console.error(`Waiting for permission requests on session ${sessionId}...`);
  console.error("Press Ctrl+C to stop.\n");

  const result: StreamResult = await streamEvents(sessionId, async (event) => {
    if (event.type !== "permission.updated") return;

    const props = event.properties as {
      id: string;
      title: string;
      type: string;
      status?: string;
      sessionID?: string;
    };

    // Skip permissions that are not pending (already resolved)
    if (props.status && props.status !== "pending") return;

    console.error(
      `Permission request: ${props.title} (type: ${props.type}, id: ${props.id})`
    );

    try {
      if (opts.autoApprove) {
        await respondToPermission(sessionId, props.id, "once");
        console.error(`Auto-approved: ${props.id}`);
      } else {
        await respondToPermission(
          sessionId,
          props.id,
          opts.response as "once" | "always" | "reject"
        );
        console.error(`Responded with "${opts.response}": ${props.id}`);
        return "stop";
      }
    } catch (err) {
      console.error(
        `Failed to respond to ${props.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });

  if (result === "disconnected") {
    console.error("Error: lost connection to OpenCode server.");
    process.exit(1);
  }
}
