import type { Event } from "@opencode-ai/sdk";
import { getBaseUrl } from "./client.js";

/**
 * Extract the session ID from an event, checking all known locations.
 */
export function getEventSessionId(event: Event): string | undefined {
  const props = event.properties as Record<string, unknown>;
  return (
    (props.sessionID as string) ||
    ((props.info as Record<string, unknown>)?.sessionID as string) ||
    ((props.info as Record<string, unknown>)?.id as string) ||
    ((props.part as Record<string, unknown>)?.sessionID as string) ||
    undefined
  );
}

/**
 * Check if an SSE event belongs to a given session.
 */
export function isSessionEvent(event: Event, sessionId: string): boolean {
  return getEventSessionId(event) === sessionId;
}

/**
 * Connect to the OpenCode SSE event stream and invoke a callback for each
 * parsed event that matches the given session.
 */
export async function streamEvents(
  sessionId: string,
  onEvent: (event: Event) => void | "stop" | Promise<void | "stop">
): Promise<void> {
  await streamAllEvents((event) => {
    if (!isSessionEvent(event, sessionId)) return;
    return onEvent(event);
  });
}

/**
 * Connect to the SSE stream and invoke callback for ALL events (unfiltered).
 * Callback can return "stop" to close the stream.
 */
export async function streamAllEvents(
  onEvent: (event: Event) => void | "stop" | Promise<void | "stop">
): Promise<void> {
  const url = `${getBaseUrl()}/event`;
  const response = await fetch(url, {
    headers: { Accept: "text/event-stream" },
  });

  if (!response.ok || !response.body) {
    console.error("Failed to connect to event stream");
    process.exit(1);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;

        try {
          const event = JSON.parse(data) as Event;
          const result = await onEvent(event);
          if (result === "stop") {
            reader.cancel();
            return;
          }
        } catch {
          // Skip unparseable events
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
