import { Command } from "commander";
import { ensureServer } from "../client.js";
import { formatMessage, formatJSON } from "../format.js";
import { resolveSession } from "../resolve.js";
import { waitForIdle } from "../wait-util.js";

export function sessionSendCommand(): Command {
  return new Command("send")
    .alias("prompt")
    .description("Send a message to a session")
    .argument("<message...>", "Message text to send")
    .option("-s, --session <id>", "Session ID (defaults to most recent)")
    .option("-j, --json", "Output response as JSON")
    .option("-v, --verbose", "Show tool calls and extra details")
    .option("-t, --text-only", "Show only text content in response")
    .option("--no-reply", "Send as context injection (no AI response)")
    .option("--async", "Send async and return immediately")
    .option(
      "-w, --wait",
      "Send async, block until session is idle, then show the last message"
    )
    .option("--agent <agent>", "Agent to use")
    .option("--model <model>", "Model to use (format: provider/model)")
    .option("--stdin", "Read message from stdin instead of arguments")
    .action(async (messageParts: string[], opts) => {
      const client = await ensureServer();
      const resolved = await resolveSession(client, opts.session);

      let messageText: string;
      if (opts.stdin) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        messageText = Buffer.concat(chunks).toString("utf-8").trim();
      } else {
        messageText = messageParts.join(" ");
      }

      if (!messageText) {
        console.error("No message provided.");
        process.exit(1);
      }

      // Parse model if provided
      let model: { providerID: string; modelID: string } | undefined;
      if (opts.model) {
        const parts = opts.model.split("/");
        if (parts.length === 2 && parts[0] && parts[1]) {
          model = { providerID: parts[0], modelID: parts[1] };
        }
      }

      const body = {
        parts: [{ type: "text" as const, text: messageText }],
        ...(model && { model }),
        ...(opts.agent && { agent: opts.agent }),
        ...(opts.reply === false && { noReply: true }),
      };

      // --async: fire and forget
      if (opts.async) {
        await client.session.promptAsync({
          path: { id: resolved },
          body,
        });
        console.log("Message sent (async).");
        return;
      }

      // --wait: send async, then block until session.idle, then show result
      if (opts.wait) {
        await client.session.promptAsync({
          path: { id: resolved },
          body,
        });

        const result = await waitForIdle(client, resolved);

        if (!result.idle) {
          if (result.reason === "disconnected") {
            console.error("Error: lost connection to OpenCode server.");
          }
          process.exit(1);
        }

        // Fetch and display the last assistant message
        const msgs = await client.session.messages({
          path: { id: resolved },
        });
        const messages = msgs.data ?? [];
        const last = messages.filter((m) => m.info.role === "assistant").pop();
        if (!last) {
          console.error("No assistant response found.");
          process.exit(1);
        }

        if (opts.json) {
          console.log(formatJSON(last));
          return;
        }

        const textOnly = opts.verbose ? false : (opts.textOnly !== false);
        console.log(
          formatMessage(last.info, last.parts, {
            verbose: opts.verbose,
            textOnly,
          })
        );
        return;
      }

      // Default: synchronous send (blocks until response)
      const syncResult = await client.session.prompt({
        path: { id: resolved },
        body,
      });

      if (!syncResult.data) {
        console.error("No response received.");
        process.exit(1);
      }

      if (opts.json) {
        console.log(formatJSON(syncResult.data));
        return;
      }

      console.log(
        formatMessage(syncResult.data.info, syncResult.data.parts, {
          verbose: opts.verbose,
          textOnly: opts.textOnly ?? true,
        })
      );
    });
}
