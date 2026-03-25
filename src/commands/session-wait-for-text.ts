import { Command } from "commander";
import { ensureServer, getClient } from "../client.js";
import { resolveSession } from "../resolve.js";
import { startStream } from "../sse.js";
import type { StreamResult } from "../sse.js";
import { extractText } from "../format.js";
import type { Part } from "@opencode-ai/sdk";

export function sessionWaitForTextCommand(): Command {
  return new Command("wait-for-text")
    .description(
      "Silently wait until a message contains the given text, then output everything after it and exit 0"
    )
    .argument("<text>", "Text to wait for")
    .argument("[session-id]", "Session ID (defaults to most recent)")
    .option(
      "-t, --timeout <seconds>",
      "Timeout in seconds (exit 1 if not found)",
      parseInt
    )
    .option(
      "--no-check-existing",
      "Skip checking existing messages (only watch for new ones)"
    )
    .action(async (text: string, sessionId: string | undefined, opts) => {
      const client = await ensureServer();
      const resolved = await resolveSession(client, sessionId);

      // Shared found flag to prevent duplicate output from concurrent paths
      let found = false;
      const emitAndExit = (after: string) => {
        if (found) return;
        found = true;
        if (timer) clearTimeout(timer);
        process.stdout.write(after);
        process.exit(0);
      };

      // Set up timeout if requested
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (opts.timeout && opts.timeout > 0) {
        timer = setTimeout(() => {
          if (!found) {
            console.error("Timeout: text not found.");
            process.exit(1);
          }
        }, opts.timeout * 1000);
      }

      // Check existing messages first (default) to avoid race conditions.
      if (opts.checkExisting !== false) {
        const result = await client.session.messages({
          path: { id: resolved },
        });
        const messages = result.data ?? [];
        for (let i = messages.length - 1; i >= 0; i--) {
          const fullText = extractText(messages[i].parts);
          const idx = fullText.indexOf(text);
          if (idx !== -1) {
            emitAndExit(fullText.slice(idx + text.length).trimStart());
            return;
          }
        }
      }

      // Track how many times the session has gone idle without finding the text.
      // After the session goes idle and a full message check finds nothing,
      // exit with failure rather than hanging forever.
      let idleCheckPending = false;

      // Accumulate text per message to detect markers split across deltas
      const messageBuffers = new Map<string, string>();

      const handle = startStream(resolved, (event) => {
        if (found) return "stop";

        if (event.type === "message.part.updated") {
          const props = event.properties as {
            part: Part & { text?: string };
            delta?: string;
          };
          if (props.part.type !== "text" || !props.delta) return;

          const msgId = props.part.messageID;
          const current = (messageBuffers.get(msgId) ?? "") + props.delta;
          messageBuffers.set(msgId, current);

          const idx = current.indexOf(text);
          if (idx !== -1) {
            emitAndExit(current.slice(idx + text.length).trimStart());
            return "stop";
          }
        }

        // When the session goes idle, do a full API check as fallback
        if (event.type === "session.idle" && !idleCheckPending) {
          idleCheckPending = true;
          checkAllMessages(resolved, text).then((after) => {
            idleCheckPending = false;
            if (after !== null) {
              emitAndExit(after);
            }
            // If text not found after idle, the session might restart.
            // If it doesn't, the stream will eventually end or timeout
            // will fire.
          }).catch(() => {
            idleCheckPending = false;
          });
        }
      });

      const streamResult: StreamResult = await handle.result;

      if (!found) {
        // Stream ended without finding the text
        if (streamResult === "disconnected") {
          console.error("Error: lost connection to OpenCode server.");
        } else {
          console.error("Stream ended without finding text.");
        }
        if (timer) clearTimeout(timer);
        process.exit(1);
      }
    });
}

async function checkAllMessages(
  sessionId: string,
  text: string
): Promise<string | null> {
  const client = getClient();
  const result = await client.session.messages({
    path: { id: sessionId },
  });
  const messages = result.data ?? [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const fullText = extractText(messages[i].parts);
    const idx = fullText.indexOf(text);
    if (idx !== -1) {
      return fullText.slice(idx + text.length).trimStart();
    }
  }
  return null;
}
