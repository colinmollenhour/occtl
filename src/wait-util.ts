import type { OpencodeClient } from "@opencode-ai/sdk";
import { startStream, startAllStream, getEventSessionId } from "./sse.js";
import type { StreamResult } from "./sse.js";

export interface WaitResult {
  /** Whether the session is confirmed idle. */
  idle: boolean;
  /** How it was determined: "api" (status check), "sse" (event), "disconnected" (stream lost). */
  reason: "api" | "sse" | "disconnected" | "timeout";
}

/**
 * Race-safe wait for a session to go idle. Starts the SSE stream, waits for
 * the connection to establish, then checks the API. This eliminates the gap
 * where the session could go idle between the check and the stream starting.
 */
export async function waitForIdle(
  client: OpencodeClient,
  sessionId: string,
  timeoutMs?: number
): Promise<WaitResult> {
  return new Promise<WaitResult>((resolve) => {
    let settled = false;
    const settle = (result: WaitResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      handle.cancel();
      resolve(result);
    };

    // Timeout
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        settle({ idle: false, reason: "timeout" });
      }, timeoutMs);
    }

    // Start SSE stream
    const handle = startStream(sessionId, (event) => {
      if (event.type === "session.idle") {
        settle({ idle: true, reason: "sse" });
        return "stop";
      }
    });

    // When stream ends unexpectedly
    handle.result.then((streamResult: StreamResult) => {
      if (!settled && streamResult === "disconnected") {
        settle({ idle: false, reason: "disconnected" });
      }
    });

    // After SSE is connected, check current status via API
    handle.connected.then(async () => {
      if (settled) return;
      try {
        const statusResult = await client.session.status();
        const statuses = statusResult.data ?? {};
        const current = statuses[sessionId];
        if (!current || current.type === "idle") {
          settle({ idle: true, reason: "api" });
        }
      } catch {
        // API check failed; rely on SSE stream
      }
    });
  });
}

export interface WaitAnyResult {
  /** The session ID that went idle first (empty string if timeout/disconnect). */
  sessionID: string;
  /** How it was determined. */
  reason: "api" | "sse" | "disconnected" | "timeout";
}

/**
 * Race-safe wait for any of multiple sessions to go idle.
 */
export async function waitForAnyIdle(
  client: OpencodeClient,
  sessionIds: string[],
  timeoutMs?: number
): Promise<WaitAnyResult> {
  const watchSet = new Set(sessionIds);

  return new Promise<WaitAnyResult>((resolve) => {
    let settled = false;
    const settle = (result: WaitAnyResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      handle.cancel();
      resolve(result);
    };

    // Timeout
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        settle({ sessionID: "", reason: "timeout" });
      }, timeoutMs);
    }

    // Start SSE stream (unfiltered, watching multiple sessions)
    const handle = startAllStream((event) => {
      if (event.type !== "session.idle") return;
      const sid = getEventSessionId(event);
      if (!sid || !watchSet.has(sid)) return;
      settle({ sessionID: sid, reason: "sse" });
      return "stop";
    });

    // When stream ends unexpectedly
    handle.result.then((streamResult: StreamResult) => {
      if (!settled && streamResult === "disconnected") {
        settle({ sessionID: "", reason: "disconnected" });
      }
    });

    // After SSE is connected, check current status via API
    handle.connected.then(async () => {
      if (settled) return;
      try {
        const statusResult = await client.session.status();
        const statuses = statusResult.data ?? {};
        for (const sid of sessionIds) {
          if (settled) return;
          const current = statuses[sid];
          if (!current || current.type === "idle") {
            settle({ sessionID: sid, reason: "api" });
            return;
          }
        }
      } catch {
        // API check failed; rely on SSE stream
      }
    });
  });
}
