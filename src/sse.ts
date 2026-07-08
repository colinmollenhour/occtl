import type { Event } from "@opencode-ai/sdk";
import { getBaseUrl, getAuthHeaders } from "./client.js";

export type StreamResult = "stopped" | "disconnected";

export interface StreamOptions {
  /**
   * Reconnect automatically (1s→5s backoff) when the stream drops without a
   * "stop"/cancel. Use for long-lived best-effort consumers (stream/run live
   * display + idle tracking) where a silent mid-turn disconnect would
   * otherwise permanently lose events. `result` then only settles on cancel.
   */
  reconnect?: boolean;
}

/**
 * Extract the session ID from an event, checking all known locations.
 */
export function getEventSessionId(event: Event): string | undefined {
  const props = (event.properties ?? {}) as Record<string, unknown>;
  const sid =
    (props.sessionID as string | undefined) ??
    ((props.info as Record<string, unknown> | undefined)?.sessionID as string | undefined) ??
    ((props.info as Record<string, unknown> | undefined)?.id as string | undefined) ??
    ((props.part as Record<string, unknown> | undefined)?.sessionID as string | undefined) ??
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
 * Normalize a parsed SSE data object to a plain Event.
 *
 * Newer opencode servers (>= the `/global/event` bus) wrap every event as
 * `{directory, project, payload: {id, type, properties}}`, while the legacy
 * `/event` stream delivers the bare `{id, type, properties}` shape. Detect by
 * shape, not by endpoint, so either endpoint can serve either format.
 */
function unwrapEvent(raw: unknown): Event | undefined {
  const obj = raw as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") return undefined;
  const payload = obj.payload as Record<string, unknown> | undefined;
  const evt =
    payload && typeof payload === "object" && typeof payload.type === "string" ? payload : obj;
  if (typeof evt.type !== "string") return undefined;
  return evt as unknown as Event;
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
  onEvent: (event: Event) => void | "stop" | Promise<void | "stop">,
  options?: StreamOptions
): StreamHandle {
  return startAllStream((event) => {
    if (!isSessionEvent(event, sessionId)) return;
    return onEvent(event);
  }, options);
}

/**
 * Open the server's event stream, preferring the modern `/global/event` bus.
 *
 * On current opencode servers (1.17.x) `/event` still answers but carries only
 * `server.heartbeat` noise — every session event (message deltas,
 * session.status, session.idle) flows on `/global/event`. Older servers only
 * have `/event`. The content-type check matters: these servers answer unknown
 * routes with a 200 SPA HTML page, so a non-SSE 200 must count as "endpoint
 * unavailable", not as a connection.
 */
async function connectEventStream(): Promise<Response | undefined> {
  for (const path of ["/global/event", "/event"]) {
    let response: Response;
    try {
      response = await fetch(`${getBaseUrl()}${path}`, {
        headers: { Accept: "text/event-stream", ...getAuthHeaders() },
      });
    } catch {
      continue;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (response.ok && response.body && contentType.includes("text/event-stream")) {
      return response;
    }
    response.body?.cancel().catch(() => {});
  }
  return undefined;
}

/**
 * Start an SSE stream (unfiltered) and return a handle with cancel + connected signal.
 */
export function startAllStream(
  onEvent: (event: Event) => void | "stop" | Promise<void | "stop">,
  options?: StreamOptions
): StreamHandle {
  let cancelled = false;
  let cancelReader: () => void = () => {};
  let cancelBackoff: () => void = () => {};
  let resolveConnected: () => void;
  const connected = new Promise<void>((r) => {
    resolveConnected = r;
  });

  // Pump one connection until it ends. Returns "stopped" only when the
  // callback asked to stop; everything else (connect failure, EOF, error)
  // is "disconnected".
  const pumpOnce = async (): Promise<StreamResult> => {
    const response = await connectEventStream();
    resolveConnected!();
    if (!response) return "disconnected";

    const reader = response.body!.getReader();
    cancelReader = () => reader.cancel().catch(() => {});
    if (cancelled) {
      cancelReader();
      return "stopped";
    }

    const decoder = new TextDecoder();
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

          let event: Event | undefined;
          try {
            event = unwrapEvent(JSON.parse(data));
          } catch {
            // Skip unparseable SSE data
            continue;
          }
          if (!event) continue;

          try {
            const cbResult = await onEvent(event);
            if (cbResult === "stop") {
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

    return "disconnected";
  };

  const result = (async (): Promise<StreamResult> => {
    let attempt = 0;
    while (true) {
      const outcome = await pumpOnce();
      if (outcome === "stopped" || cancelled) return "stopped";
      if (!options?.reconnect) return "disconnected";
      // Backoff before reconnecting. unref() so a pending retry timer never
      // keeps the process alive after the command has finished.
      attempt += 1;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(1000 * attempt, 5000));
        timer.unref?.();
        cancelBackoff = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      if (cancelled) return "stopped";
    }
  })();

  return {
    result,
    cancel: () => {
      cancelled = true;
      cancelReader();
      cancelBackoff();
    },
    connected,
  };
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
