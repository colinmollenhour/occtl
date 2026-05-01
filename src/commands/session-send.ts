import { Command } from "commander";
import type { Message, Part } from "@opencode-ai/sdk";
import { ensureServer, getClientV2 } from "../client.js";
import { formatMessage, formatJSON } from "../format.js";
import { resolveSession } from "../resolve.js";
import { readDefaults } from "../session-defaults.js";
import { waitForIdle } from "../wait-util.js";

export function sessionSendCommand(): Command {
  return new Command("send")
    .alias("prompt")
    .description("Send a message to a session")
    .argument("[message...]", "Message text to send (omit when --stdin is used)")
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

      // Merge stored session defaults with explicit flags (explicit wins)
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

      const params = {
        sessionID: resolved,
        parts: [{ type: "text" as const, text: messageText }],
        ...(model && { model }),
        ...(agent && { agent }),
        ...(variant && { variant }),
        ...(opts.reply === false && { noReply: true }),
      };

      // --async: fire and forget
      if (opts.async) {
        await clientV2.session.promptAsync(params);
        console.log("Message sent (async).");
        return;
      }

      // --wait: send async, then block until session.idle, then show result
      if (opts.wait) {
        await clientV2.session.promptAsync(params);

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
      const syncResult = await clientV2.session.prompt(params);

      if (!syncResult.data) {
        console.error("No response received.");
        process.exit(1);
      }

      if (opts.json) {
        console.log(formatJSON(syncResult.data));
        return;
      }

      console.log(
        formatMessage(
          syncResult.data.info as unknown as Message,
          syncResult.data.parts as unknown as Part[],
          {
            verbose: opts.verbose,
            textOnly: opts.textOnly ?? true,
          }
        )
      );
    });
}
