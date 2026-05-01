import { Command } from "commander";
import { ensureServer, getClientV2 } from "../client.js";
import { resolveSession } from "../resolve.js";
import { readDefaults } from "../session-defaults.js";
import { startStream } from "../sse.js";
import { handleEvent } from "./session-watch.js";

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

      // Open SSE first so we don't miss early events.
      const handle = startStream(resolved, (event) => {
        if (opts.json) {
          process.stdout.write(JSON.stringify(event) + "\n");
        } else {
          handleEvent(event);
        }
        if (event.type === "session.idle") {
          return "stop";
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

      const result = await handle.result;
      if (result === "disconnected") {
        console.error("\nLost connection to OpenCode server.");
        process.exit(1);
      }
    });
}
