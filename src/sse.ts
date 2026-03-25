import type { Event } from "@opencode-ai/sdk";
import { getBaseUrl } from "./client.js";

export type StreamResult = "stopped" | "disconnected";

/**
 * Extract the session ID from an event, checking all known locations.
 */
export function getEventSessionId(event: Event): string | undefined {
  const props = event.properties as Record<string, unknown>;
  const sid =
    (props.sessionID as string | undefined) ??
    ((props.info as Record<string, unknown>)?.sessionID as string | undefined) ??
    ((props.info as Record<string, unknown>)?.id as string | undefined) ??
    ((props.part as Record<string, unknown>)?.sessionID as string | undefined) ??
    undefined;
  return sid || undefined; // treat empty string as undefined
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
 *
 * Returns "stopped" if the callback returned "stop", or "disconnected" if
 * the stream ended unexpectedly.
 */
export async function streamEvents(
  sessionId: string,
  onEvent: (event: Event) => void | "stop" | Promise<void | "stop">
): Promise<StreamResult> {
  return streamAllEvents((event) => {
    if (!isSessionEvent(event, sessionId)) return;
    return onEvent(event);
  });
}

export interface StreamHandle {
  /** Promise that resolves when the stream ends. */
  result: Promise<StreamResult>;
  /** Cancel the stream. */
  cancel: () => void;
  /** Resolves when the SSE connection is established. */
  connected: Promise<void>;
}

/**
 * Connect to the SSE stream and return a handle with cancel + connected signal.
 * This is the low-level version for callers that need to coordinate startup.
 */
export function startStream(
  sessionId: string,
  onEvent: (event: Event) => void | "stop" | Promise<void | "stop">
): StreamHandle {
  return startAllStream((event) => {
    if (!isSessionEvent(event, sessionId)) return;
    return onEvent(event);
  });
}

/**
 * Start an SSE stream (unfiltered) and return a handle with cancel + connected signal.
 */
export function startAllStream(
  onEvent: (event: Event) => void | "stop" | Promise<void | "stop">
): StreamHandle {
  let cancelFn: () => void = () => {};
  let resolveConnected: () => void;
  const connected = new Promise<void>((r) => {
    resolveConnected = r;
  });

  const result = (async (): Promise<StreamResult> => {
    const url = `${getBaseUrl()}/event`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: "text/event-stream" },
      });
    } catch {
      resolveConnected!();
      return "disconnected";
    }

    if (!response.ok || !response.body) {
      resolveConnected!();
      return "disconnected";
    }

    const reader = response.body.getReader();
    cancelFn = () => reader.cancel().catch(() => {});

    // Signal that the connection is established
    resolveConnected!();

    const decoder = new TextDecoder();
    let buffer = "";
    let stoppedCleanly = false;

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

          let event: Event;
          try {
            event = JSON.parse(data) as Event;
          } catch {
            // Skip unparseable SSE data
            continue;
          }

          try {
            const cbResult = await onEvent(event);
            if (cbResult === "stop") {
              stoppedCleanly = true;
              reader.cancel().catch(() => {});
              return "stopped";
            }
          } catch (err) {
            // Log callback errors to stderr instead of swallowing
            console.error(
              `[occtl] SSE callback error: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    return stoppedCleanly ? "stopped" : "disconnected";
  })();

  return { result, cancel: () => cancelFn(), connected };
}

/**
 * Connect to the SSE stream and invoke callback for ALL events (unfiltered).
 * Returns "stopped" or "disconnected".
 */
export async function streamAllEvents(
  onEvent: (event: Event) => void | "stop" | Promise<void | "stop">
): Promise<StreamResult> {
  const handle = startAllStream(onEvent);
  return handle.result;
}
