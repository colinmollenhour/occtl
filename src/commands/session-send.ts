import { Command } from "commander";
import type { Message, Part } from "@opencode-ai/sdk";
import { ensureServer, getClientV2 } from "../client.js";
import { extractText, formatMessage, formatJSON, formatMessageJSON } from "../format.js";
import { resolveSession } from "../resolve.js";
import { readDefaults } from "../session-defaults.js";
import { startStream } from "../sse.js";
import { makeIdleTracker, snapshotAssistantIds, waitForTurnComplete } from "../turn-util.js";

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
      "Send async, wait for this turn's assistant reply, then print it " +
        "(message-completion poll; same reliability model as stream/run)"
    )
    .option(
      "--timeout <seconds>",
      "With --wait: exit 124 if the turn has not finished after this many " +
        "seconds. Read the result with `occtl last`."
    )
    .option("--agent <agent>", "Agent to use")
    .option("--model <model>", "Model to use (format: provider/model)")
    .option("--variant <variant>", "Model variant to use (e.g. high)")
    .option("--stdin", "Read message from stdin instead of arguments")
    .action(async (messageParts: string[] | undefined, opts) => {
      // Validate --timeout before contacting the server (fail fast). Use Number()
      // so partial/invalid input ("10abc") is rejected rather than coerced.
      let timeoutMs = 0;
      if (opts.timeout !== undefined) {
        if (!opts.wait) {
          console.error("--timeout requires --wait (-w).");
          process.exit(2);
        }
        const timeoutSeconds = Number(opts.timeout);
        // Reject 0: waitForTurnComplete treats timeoutMs <= 0 as Infinity.
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
          console.error("--timeout must be a positive number of seconds.");
          process.exit(2);
        }
        timeoutMs = timeoutSeconds * 1000;
      }

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

      const noReply = opts.reply === false;
      const params = {
        sessionID: resolved,
        parts: [{ type: "text" as const, text: messageText }],
        ...(model && { model }),
        ...(agent && { agent }),
        ...(variant && { variant }),
        ...(noReply && { noReply: true }),
      };

      // --async: fire and forget
      if (opts.async) {
        await clientV2.session.promptAsync(params);
        console.log("Message sent (async).");
        return;
      }

      // --wait: snapshot → promptAsync → wait for THIS turn's finalized reply.
      // Do not use session-idle status alone: async send can still look idle,
      // some servers omit status maps, and "last assistant message" can be a
      // prior turn (empty stdout + exit 0). Same completion model as stream/run.
      if (opts.wait) {
        if (noReply) {
          await clientV2.session.promptAsync(params);
          return;
        }

        let priorAssistantIds: Set<string>;
        try {
          priorAssistantIds = await snapshotAssistantIds(client, resolved);
        } catch (err) {
          console.error(
            `occtl send: cannot snapshot session messages: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          process.exit(1);
        }

        // Best-effort SSE idle tracker (started before the send so the idle
        // transition cannot be missed). Completion is decided by polling
        // message state; the tracker only rescues abandoned unfinalized turns.
        const idleTracker = makeIdleTracker();
        const events = startStream(
          resolved,
          (event) => idleTracker.observe(event),
          { reconnect: true }
        );
        await events.connected;

        let turn: Awaited<ReturnType<typeof waitForTurnComplete>> | undefined;
        let waitError: unknown;
        try {
          await clientV2.session.promptAsync(params);
          turn = await waitForTurnComplete(client, resolved, {
            priorAssistantIds,
            timeoutMs,
            idleSince: idleTracker.idleSince,
          });
        } catch (err) {
          waitError = err;
        } finally {
          events.cancel();
        }

        if (waitError) {
          console.error(
            `occtl send: ${
              waitError instanceof Error ? waitError.message : String(waitError)
            }`
          );
          process.exit(1);
        }
        if (!turn) {
          console.error("occtl send: no turn result.");
          process.exit(1);
        }

        if (turn.status === "timeout") {
          console.error(
            `occtl send: timed out after ${opts.timeout} second(s). ` +
              `The session may still be running — read the result with \`occtl last ${resolved}\`.`
          );
          process.exit(124);
        }
        if (turn.status === "disconnected") {
          console.error("Error: lost connection to OpenCode server.");
          process.exit(1);
        }

        // turn is narrowed to "completed" here.
        const message = turn.message as unknown as Message;
        const parts = turn.parts;

        if (opts.json) {
          console.log(
            formatJSON(
              formatMessageJSON({
                info: message,
                parts,
              })
            )
          );
          return;
        }

        const textOnly = opts.verbose ? false : opts.textOnly !== false;
        const formatted = formatMessage(message, parts, {
          verbose: opts.verbose,
          textOnly,
        });
        if (formatted) {
          console.log(formatted);
        } else if (textOnly && !extractText(parts).trim()) {
          // Text-only + no text parts would previously look like a successful
          // empty reply. Surface a clear error so agents do not treat silence
          // as "got the answer".
          console.error(
            "No text in assistant response (tool-only or empty). " +
              `Use --verbose or \`occtl last ${resolved}\` for full parts.`
          );
          process.exit(1);
        }
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
