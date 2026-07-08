import { Command } from "commander";
import { ensureServer } from "../client.js";
import { resolveSession } from "../resolve.js";
import { formatJSON } from "../format.js";
import { startStream } from "../sse.js";
import type { StreamResult } from "../sse.js";
import {
  getPermissionFromEvent,
  listPendingPermissions,
  respondToPermission,
  type PendingPermission,
  type PermissionResponse,
} from "../permission-util.js";

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

async function waitAndRespond(
  sessionId: string,
  opts: { response: string; json?: boolean; autoApprove?: boolean }
): Promise<void> {
  console.error(`Waiting for permission requests on session ${sessionId}...`);
  console.error("Press Ctrl+C to stop.\n");

  const handled = new Set<string>();
  const processPermission = async (
    permission: PendingPermission
  ): Promise<"stop" | undefined> => {
    if (handled.has(permission.id)) return undefined;
    handled.add(permission.id);

    console.error(
      `Permission request: ${permission.title} (type: ${permission.type}, id: ${permission.id})`
    );

    try {
      if (opts.autoApprove) {
        await respondToPermission(sessionId, permission.id, "once");
        console.error(`Auto-approved: ${permission.id}`);
      } else {
        await respondToPermission(
          sessionId,
          permission.id,
          opts.response as PermissionResponse
        );
        console.error(`Responded with "${opts.response}": ${permission.id}`);
        return "stop";
      }
    } catch (err) {
      handled.delete(permission.id);
      console.error(
        `Failed to respond to ${permission.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return undefined;
  };

  const handle = startStream(sessionId, async (event) => {
    const permission = getPermissionFromEvent(event, sessionId);
    if (!permission) return;

    return processPermission(permission);
  });
  await handle.connected;

  try {
    for (const permission of await listPendingPermissions(sessionId)) {
      const outcome = await processPermission(permission);
      if (outcome === "stop") {
        handle.cancel();
        return;
      }
    }
  } catch (err) {
    console.error(
      `Warning: failed to list pending permissions; waiting for new permission events instead: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const result: StreamResult = await handle.result;

  if (result === "disconnected") {
    console.error("Error: lost connection to OpenCode server.");
    process.exit(1);
  }
}
