import { Command } from "commander";
import { ensureServer } from "../client.js";
import { resolveSession } from "../resolve.js";
import { streamEvents } from "../sse.js";
import type { Event } from "@opencode-ai/sdk";

export function sessionWatchCommand(): Command {
  return new Command("watch")
    .description("Watch a session for real-time updates")
    .argument("[session-id]", "Session ID (defaults to most recent)")
    .option("-j, --json", "Output events as JSON")
    .option(
      "-e, --events <types>",
      "Comma-separated event types to filter (e.g. message.updated,session.idle)"
    )
    .option("-t, --text-only", "Only show text content as it streams")
    .action(async (sessionId: string | undefined, opts) => {
      const client = await ensureServer();
      const resolved = await resolveSession(client, sessionId);

      const filterTypes = opts.events
        ? opts.events.split(",").map((s: string) => s.trim())
        : null;

      console.error(`Watching session ${resolved}...`);
      console.error("Press Ctrl+C to stop.\n");

      const result = await streamEvents(resolved, (event) => {
        if (filterTypes && !filterTypes.includes(event.type)) return;

        if (opts.json) {
          console.log(JSON.stringify(event));
          return;
        }

        if (opts.textOnly) {
          handleTextOnly(event);
          return;
        }

        handleEvent(event);
      });

      if (result === "disconnected") {
        console.error("\nConnection lost.");
        process.exit(1);
      }
    });
}

function handleTextOnly(event: Event): void {
  if (event.type === "message.part.updated") {
    const props = event.properties as { part: { type: string; text?: string }; delta?: string };
    if (props.part.type === "text" && props.delta) {
      process.stdout.write(props.delta);
    }
  }
}

function handleEvent(event: Event): void {
  const time = new Date().toLocaleTimeString();
  switch (event.type) {
    case "message.updated": {
      const props = event.properties as { info: { role: string; id: string } };
      console.log(`[${time}] message.updated: ${props.info.role} ${props.info.id}`);
      break;
    }
    case "message.part.updated": {
      const props = event.properties as {
        part: { type: string; tool?: string; state?: { status: string } };
        delta?: string;
      };
      if (props.part.type === "text" && props.delta) {
        process.stdout.write(props.delta);
      } else if (props.part.type === "tool") {
        console.log(
          `[${time}] tool: ${props.part.tool} [${props.part.state?.status}]`
        );
      }
      break;
    }
    case "session.status": {
      const props = event.properties as { status: { type: string } };
      console.log(`[${time}] session.status: ${props.status.type}`);
      break;
    }
    case "session.idle": {
      console.log(`\n[${time}] session.idle`);
      break;
    }
    case "permission.updated": {
      const props = event.properties as { id: string; title: string; type: string };
      console.log(
        `\n[${time}] PERMISSION REQUEST: ${props.title} (id: ${props.id}, type: ${props.type})`
      );
      break;
    }
    case "todo.updated": {
      const props = event.properties as { todos: Array<{ content: string; status: string }> };
      console.log(`[${time}] todo.updated:`);
      for (const todo of props.todos) {
        const icon =
          todo.status === "completed"
            ? "[x]"
            : todo.status === "in_progress"
            ? "[>]"
            : "[ ]";
        console.log(`  ${icon} ${todo.content}`);
      }
      break;
    }
    case "session.error": {
      const props = event.properties as { error?: { name: string } };
      console.log(`[${time}] ERROR: ${props.error?.name || "unknown"}`);
      break;
    }
    default: {
      console.log(`[${time}] ${event.type}`);
    }
  }
}
