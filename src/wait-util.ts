import type { OpencodeClient } from "@opencode-ai/sdk";
import { startStream, startAllStream, getEventSessionId } from "./sse.js";
import type { StreamResult } from "./sse.js";
import { getDerivedSessionStatus } from "./status-util.js";

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
  timeoutMs?: number,
  options?: { requireBusy?: boolean; mainAgentOnly?: boolean }
): Promise<WaitResult> {
  const requireBusy = options?.requireBusy ?? false;
  const mainAgentOnly = options?.mainAgentOnly ?? false;
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

    const checkAllAgentsIdle = async (
      reason: WaitResult["reason"],
      eventSessionId?: string
    ) => {
      if (settled) return;
      try {
        const status = await getDerivedSessionStatus(client, sessionId);
        if (
          eventSessionId &&
          eventSessionId !== sessionId &&
          !status.children.includes(eventSessionId)
        ) {
          return;
        }
        if (requireBusy && !status.mainKnown) return;
        if (status.allIdle) settle({ idle: true, reason });
      } catch {
        // API check failed; rely on later SSE events or timeout.
      }
    };

    // Start SSE stream. When child sessions matter, listen to all session.idle
    // events because the parent can be idle while a sub-agent is still running.
    const handle = mainAgentOnly ? startStream(sessionId, (event) => {
      if (event.type === "session.idle") {
        settle({ idle: true, reason: "sse" });
        return "stop";
      }
    }) : startAllStream((event) => {
      if (event.type !== "session.idle") return;
      const sid = getEventSessionId(event);
      if (sid) void checkAllAgentsIdle("sse", sid);
    });

    // When stream ends unexpectedly
    handle.result.then((streamResult: StreamResult) => {
      if (!settled && streamResult === "disconnected") {
        settle({ idle: false, reason: "disconnected" });
      }
    });

    // After SSE is connected, check current status via API.
    // With requireBusy, skip this shortcut — only a real session.idle
    // event from SSE counts, so we won't return prematurely for sessions
    // that have never been busy or whose busy→idle transition we missed.
    if (!requireBusy) {
      handle.connected.then(async () => {
        if (settled) return;
        try {
          if (mainAgentOnly) {
            const statusResult = await client.session.status();
            const statuses = statusResult.data ?? {};
            const current = statuses[sessionId];
            if (!current || current.type === "idle") {
              settle({ idle: true, reason: "api" });
            }
          } else {
            await checkAllAgentsIdle("api");
          }
        } catch {
          // API check failed; rely on SSE stream
        }
      });
    }
  });
}

export interface WaitAnyResult {
  /** The session ID that went idle first (empty string if timeout/disconnect). */
  sessionID: string;
  /** How it was determined. */
  reason: "api" | "sse" | "disconnected" | "timeout";
}

export interface WaitAllResult {
  /** Session IDs confirmed idle before timeout/disconnect. */
  sessionIDs: string[];
  /** Session IDs still pending if timeout/disconnect occurred. */
  pending: string[];
  /** How the wait ended. */
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

/**
 * Race-safe wait for all of multiple sessions to go idle.
 */
export async function waitForAllIdle(
  client: OpencodeClient,
  sessionIds: string[],
  timeoutMs?: number,
  options?: { requireBusy?: boolean }
): Promise<WaitAllResult> {
  const uniqueSessionIds = [...new Set(sessionIds)];
  const pending = new Set(uniqueSessionIds);
  const completed = new Set<string>();
  const requireBusy = options?.requireBusy ?? false;

  return new Promise<WaitAllResult>((resolve) => {
    let settled = false;
    const settle = (reason: WaitAllResult["reason"]) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      handle.cancel();
      resolve({
        sessionIDs: uniqueSessionIds.filter((sid) => completed.has(sid)),
        pending: uniqueSessionIds.filter((sid) => pending.has(sid)),
        reason,
      });
    };
    const markIdle = (sid: string, reason: WaitAllResult["reason"]) => {
      if (!pending.has(sid)) return;
      pending.delete(sid);
      completed.add(sid);
      if (pending.size === 0) settle(reason);
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => settle("timeout"), timeoutMs);
    }

    const handle = startAllStream((event) => {
      if (event.type !== "session.idle") return;
      const sid = getEventSessionId(event);
      if (!sid || !pending.has(sid)) return;
      markIdle(sid, "sse");
    });

    handle.result.then((streamResult: StreamResult) => {
      if (!settled && streamResult === "disconnected") settle("disconnected");
    });

    if (!requireBusy) {
      handle.connected.then(async () => {
        if (settled) return;
        try {
          const statusResult = await client.session.status();
          const statuses = statusResult.data ?? {};
          for (const sid of uniqueSessionIds) {
            if (settled) return;
            const current = statuses[sid];
            if (!current || current.type === "idle") markIdle(sid, "api");
          }
        } catch {
          // API check failed; rely on SSE stream
        }
      });
    }
  });
}
