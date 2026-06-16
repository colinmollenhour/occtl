import type { OpencodeClient, AssistantMessage, Part } from "@opencode-ai/sdk";

/**
 * Outcome of waiting for a submitted prompt's turn to finish.
 *  - "completed":    the turn's assistant message exists and is finalized
 *                    (`time.completed` set, or a terminal `error`). `message`
 *                    and `parts` are populated.
 *  - "timeout":      the deadline elapsed first.
 *  - "disconnected": the server became unreachable / the wait was aborted.
 */
export interface TurnResult {
  status: "completed" | "timeout" | "disconnected";
  message?: AssistantMessage;
  parts?: Part[];
}

export interface WaitTurnOptions {
  /**
   * Assistant message IDs that existed *before* this prompt was sent. The turn
   * is only considered finished once a *different* assistant message is
   * finalized — this is what distinguishes a genuine completion from the
   * pre-turn idle snapshot of an already-finished prior message (the premature
   * empty-exit bug). Capture with {@link snapshotAssistantIds} before sending.
   */
  priorAssistantIds?: Set<string>;
  /** Hard deadline in ms (0/undefined = wait indefinitely). */
  timeoutMs?: number;
  /** Steady-state poll cadence in ms (default 1500). */
  pollIntervalMs?: number;
  /** First poll delay after arming, in ms (default 600 — catch fast turns sooner). */
  firstPollDelayMs?: number;
  /**
   * Register a "poke" callback. Wire an SSE `session.idle`/`message.updated`
   * listener to it so the poller re-checks immediately instead of waiting for
   * the next tick. SSE is only ever an accelerator here — never authoritative.
   */
  onPoke?: (poke: () => void) => void;
  /** Abort the wait (e.g. on SIGINT) — resolves "disconnected". */
  signal?: AbortSignal;
}

interface MessageEnvelope {
  info: {
    role: string;
    id: string;
    time?: { completed?: number };
    error?: unknown;
  };
  parts: Part[];
}

function lastAssistant(envelopes: MessageEnvelope[]): MessageEnvelope | undefined {
  for (let i = envelopes.length - 1; i >= 0; i--) {
    if (envelopes[i].info.role === "assistant") return envelopes[i];
  }
  return undefined;
}

/**
 * Is this assistant envelope the finished product of a turn we submitted?
 * It must be a *new* message (id not in the pre-send snapshot) that the server
 * has finalized — either `time.completed` is set or a terminal `error` is
 * attached (provider error / output-length / aborted / api). Transient retries
 * surface as a session "retry" status, not as `info.error`, so keying on error
 * cannot trip mid-turn.
 */
function isFinishedTurn(
  env: MessageEnvelope | undefined,
  priorAssistantIds: Set<string>
): boolean {
  if (!env) return false;
  if (priorAssistantIds.has(env.info.id)) return false;
  return Boolean(env.info.time?.completed) || env.info.error != null;
}

/**
 * Poll `session.messages` until the assistant message produced by the just-sent
 * prompt is finalized. This is the single reliable "turn complete" signal: it
 * does not depend on SSE `session.idle`/`session.status` events (some opencode
 * server versions deliver none for a session) nor on a time-based grace (which
 * races the worker picking up the message and exits pre-turn).
 *
 * Robustness:
 *  - A *new* finalized assistant message can only appear after our turn ran, so
 *    it can never false-positive on a fresh or idle session (fixes the premature
 *    empty-exit).
 *  - Reading completion from message state means a missed / never-emitted
 *    terminal SSE event can never hang the wait (fixes the original hang).
 *  - Polling holds no long-lived connection, so it is safe for multi-minute
 *    agentic turns regardless of HTTP body timeouts.
 *
 * Contract: assumes a single active writer per session. Without a server-side
 * turn id, a new finalized assistant proves "some new turn finished", which is
 * exact only when this command is the sole sender.
 */
export async function waitForTurnComplete(
  client: OpencodeClient,
  sessionId: string,
  options: WaitTurnOptions = {}
): Promise<TurnResult> {
  const {
    priorAssistantIds = new Set<string>(),
    timeoutMs = 0,
    pollIntervalMs = 1500,
    firstPollDelayMs = 600,
    onPoke,
    signal,
  } = options;

  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;

  // A single `wake` indirection lets an SSE poke or an abort end the current
  // sleep early. Registered ONCE (not per-iteration) so listeners cannot
  // accumulate on the AbortSignal across a long poll loop.
  let endSleep: (() => void) | undefined;
  const wake = (): void => endSleep?.();
  if (onPoke) onPoke(wake);
  if (signal) signal.addEventListener("abort", wake);

  try {
    let consecutiveErrors = 0;
    let first = true;
    while (true) {
      if (signal?.aborted) return { status: "disconnected" };

      try {
        const res = await client.session.messages({ path: { id: sessionId } });
        const envelopes = (res.data ?? []) as unknown as MessageEnvelope[];
        consecutiveErrors = 0;
        const candidate = lastAssistant(envelopes);
        if (isFinishedTurn(candidate, priorAssistantIds)) {
          return {
            status: "completed",
            message: candidate!.info as unknown as AssistantMessage,
            parts: candidate!.parts,
          };
        }
      } catch {
        // Tolerate transient API failures; report disconnected after a few so
        // the caller surfaces a clear error rather than spinning forever.
        consecutiveErrors += 1;
        if (consecutiveErrors >= 5) return { status: "disconnected" };
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: "timeout" };

      const interval = first ? firstPollDelayMs : pollIntervalMs;
      first = false;
      const sleepMs = Math.min(interval, remaining);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          endSleep = undefined;
          resolve();
        }, sleepMs);
        endSleep = () => {
          clearTimeout(timer);
          endSleep = undefined;
          resolve();
        };
      });
    }
  } finally {
    if (signal) signal.removeEventListener("abort", wake);
  }
}

/**
 * Snapshot the IDs of assistant messages currently in the session, to pass as
 * `priorAssistantIds` before sending a new prompt. Retries briefly so a
 * transient failure cannot silently return an empty set (which on an existing
 * session would let an already-completed prior message look "new"). Returns an
 * empty set for a session with no assistant messages yet (correct for `run`).
 */
export async function snapshotAssistantIds(
  client: OpencodeClient,
  sessionId: string
): Promise<Set<string>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await client.session.messages({ path: { id: sessionId } });
      const envelopes = (res.data ?? []) as unknown as MessageEnvelope[];
      const ids = new Set<string>();
      for (const env of envelopes) {
        if (env.info.role === "assistant") ids.add(env.info.id);
      }
      return ids;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  // All attempts failed — the server is likely unreachable; surface it so the
  // caller can fail loudly instead of risking a pre-turn false positive.
  throw lastErr instanceof Error ? lastErr : new Error("snapshotAssistantIds failed");
}
