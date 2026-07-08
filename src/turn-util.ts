import type { OpencodeClient, AssistantMessage, Event, Part } from "@opencode-ai/sdk";
import type { SessionMessage, SessionMessageAssistant } from "@opencode-ai/sdk/v2";
import { listAllSessionMessagesV2 } from "./client.js";

/**
 * Some opencode server versions cap `session.messages` at ~100 rows unless an
 * explicit `limit` is given (the v1 SDK type does not advertise the param, but
 * the server honors it — same trick as `listAllSessions`). Without it, a long
 * session could return a page that omits the newest assistant message and the
 * wait would never settle. opencode 1.17.7 returns the full history regardless,
 * so this is defensive insurance across server versions.
 */
const MESSAGES_LIMIT = 100000;
const STABLE_FALLBACK_MS = 5000;
// How long the session must read idle (per SSE) with a frozen transcript
// before an unfinalized turn is declared complete — see waitForTurnComplete.
const IDLE_COMPLETE_MS = 10000;

/**
 * Outcome of waiting for a submitted prompt's turn to finish. Modeled as a
 * discriminated union so `message`/`parts` are guaranteed present exactly when
 * `status === "completed"`.
 *  - "completed":    the turn's assistant message exists and is finalized
 *                    (`time.completed` set, terminal `error`, or a stable
 *                    final text fallback for providers that omit completion).
 *  - "timeout":      the deadline elapsed first.
 *  - "disconnected": the server became unreachable / the wait was aborted.
 */
export type TurnResult =
  | { status: "completed"; message: AssistantMessage; parts: Part[] }
  | { status: "timeout" }
  | { status: "disconnected" };

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
  /**
   * Timestamp (ms) since the session has read idle per SSE `session.idle` /
   * `session.status` events, or undefined while busy/unknown. Wire an
   * {@link makeIdleTracker} to the session's event stream. This rescues turns
   * the server abandons without finalizing the assistant message (no
   * `time.completed`, a tool part stuck "running" forever): once the session
   * is idle and the transcript is frozen, the turn completes with the partial
   * message instead of waiting forever.
   */
  idleSince?: () => number | undefined;
  /** Abort the wait (e.g. on SIGINT) — resolves "disconnected". */
  signal?: AbortSignal;
}

interface MessageEnvelope {
  info: {
    role: string;
    id: string;
    time?: { completed?: number };
    error?: unknown;
    finish?: string;
  };
  parts: Part[];
}

type StableCandidate = {
  id: string;
  signature: string;
  firstSeenAt: number;
};

function v2AssistantToEnvelope(message: SessionMessageAssistant): MessageEnvelope {
  const providerID = message.model.providerID;
  const modelID = message.model.id;
  const parts = message.content.map((content) => {
    if (content.type === "text" || content.type === "reasoning") {
      return { type: content.type, id: content.id, text: content.text } as unknown as Part;
    }
    if (content.type !== "tool") {
      return content as unknown as Part;
    }
    return {
      type: "tool",
      id: content.id,
      tool: content.name,
      state: content.state,
      time: content.time,
    } as unknown as Part;
  });

  return {
    info: {
      id: message.id,
      role: "assistant",
      time: message.time,
      error: message.error,
      finish: (message as { finish?: string }).finish,
      providerID,
      modelID,
      cost: message.cost ?? 0,
      tokens: message.tokens ?? {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    } as unknown as MessageEnvelope["info"],
    parts,
  };
}

function v2MessagesToEnvelopes(messages: SessionMessage[]): MessageEnvelope[] {
  return messages
    .filter((message): message is SessionMessageAssistant => message.type === "assistant")
    .map(v2AssistantToEnvelope);
}

async function loadMessageEnvelopes(
  client: OpencodeClient,
  sessionId: string,
  newestPageOnly = false
): Promise<MessageEnvelope[]> {
  // v1 `session.messages` is the primary source: it returns full
  // `{info, parts}` envelopes on every server version seen so far. The v2
  // projected-messages endpoint (`/api/session/:id/message`) exists on
  // opencode 1.17.x but answers `{"data": []}` for sessions that have
  // messages — silently preferring it wedged `stream`/`run` forever (an empty
  // success never triggered a fallback). v2 is kept as a cross-check for a
  // future server that drops or stubs out the v1 endpoint.
  let v1: MessageEnvelope[] | undefined;
  let v1Error: unknown;
  try {
    const res = await client.session.messages({
      path: { id: sessionId },
      query: { limit: MESSAGES_LIMIT },
    } as Parameters<typeof client.session.messages>[0]);
    const data = (res as { data?: unknown; error?: unknown }).error == null ? res.data : undefined;
    if (Array.isArray(data)) {
      v1 = data as unknown as MessageEnvelope[];
      if (v1.length > 0) return v1;
    }
  } catch (err) {
    v1Error = err;
  }

  // v1 failed or reported no messages: consult the v2 projection before
  // concluding the session is empty.
  let v2: MessageEnvelope[] | undefined;
  try {
    const messages = await listAllSessionMessagesV2(
      sessionId,
      newestPageOnly ? "desc" : "asc",
      newestPageOnly ? 1 : 200
    );
    if (newestPageOnly) messages.reverse();
    v2 = v2MessagesToEnvelopes(messages);
  } catch {
    // v2 unavailable; fall through to whatever v1 produced.
  }

  if (v2 && v2.length > 0) return v2;
  if (v1) return v1;
  if (v2) return v2;
  throw v1Error instanceof Error ? v1Error : new Error("session messages unavailable");
}

function lastAssistant(envelopes: MessageEnvelope[]): MessageEnvelope | undefined {
  for (let i = envelopes.length - 1; i >= 0; i--) {
    if (envelopes[i].info.role === "assistant") return envelopes[i];
  }
  return undefined;
}

function getText(parts: Part[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text?: string }).text ?? "")
    .join("\n");
}

function hasActiveTool(parts: Part[]): boolean {
  return parts.some((part) => {
    if (part.type !== "tool") return false;
    const status = (part as { state?: { status?: string } }).state?.status;
    return status === "pending" || status === "running" || status === "in_progress";
  });
}

function stableSignature(env: MessageEnvelope): string | undefined {
  const text = getText(env.parts).trim();
  if (!text || hasActiveTool(env.parts)) return undefined;
  return JSON.stringify({ text, parts: env.parts });
}

/**
 * Is this assistant envelope the finished product of a turn we submitted?
 * It must be a *new* message (id not in the pre-send snapshot) that the server
 * has finalized — either `time.completed` is set or a terminal `error` is
 * attached (provider error / output-length / aborted / api). Providers that
 * omit completion timestamps are handled by the stable-content fallback in the
 * wait loop. Transient retries surface as a session "retry" status, not as
 * `info.error`, so keying on error cannot trip mid-turn.
 *
 * A completed message whose `finish` is "tool-calls" is an intermediate step
 * of a multi-step agentic turn: the server finalizes it the moment the step's
 * tool calls are issued, milliseconds before the next assistant message row
 * exists. Treating it as the turn's end would end the wait mid-turn if a poll
 * lands in that gap. A turn genuinely abandoned at such a step boundary is
 * covered by the stable-content and idle fallbacks in the wait loop.
 */
function isFinishedTurn(
  env: MessageEnvelope | undefined,
  priorAssistantIds: Set<string>
): boolean {
  if (!env) return false;
  if (priorAssistantIds.has(env.info.id)) return false;
  if (env.info.error != null) return true;
  if (!env.info.time?.completed) return false;
  return env.info.finish !== "tool-calls";
}

function updateStableCandidate(
  env: MessageEnvelope | undefined,
  priorAssistantIds: Set<string>,
  stable: StableCandidate | undefined,
  now: number
): { stable: StableCandidate | undefined; completed: boolean } {
  if (!env || priorAssistantIds.has(env.info.id)) {
    return { stable: undefined, completed: false };
  }

  const signature = stableSignature(env);
  if (!signature) return { stable: undefined, completed: false };

  if (stable?.id !== env.info.id || stable.signature !== signature) {
    return {
      stable: { id: env.info.id, signature, firstSeenAt: now },
      completed: false,
    };
  }

  return {
    stable,
    completed: now - stable.firstSeenAt >= STABLE_FALLBACK_MS,
  };
}

/**
 * Poll `session.messages` until the assistant message produced by the just-sent
 * prompt is finalized. Prefer explicit message completion (`time.completed` or
 * terminal `error`), and fall back to a short stable-content window for
 * providers that persist final text without those terminal fields. SSE events
 * are never required for a normal completion, but when the caller supplies
 * `idleSince` (from an SSE idle tracker), a third tier rescues turns the
 * server abandons without finalizing anything: a *new* assistant message whose
 * content has been frozen while the session has read idle for
 * IDLE_COMPLETE_MS completes with that partial message. This is what bounds
 * the "model abandoned the turn, tool part stuck `running` forever" case that
 * otherwise blocked `stream` indefinitely.
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
    idleSince,
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
    let stable: StableCandidate | undefined;
    // Full-content freeze tracker for the idle tier: unlike `stable`, this
    // signature has no requirements (active tools and missing text allowed) —
    // it only proves the transcript stopped changing.
    let frozen: StableCandidate | undefined;
    while (true) {
      if (signal?.aborted) return { status: "disconnected" };

      try {
        const envelopes = await loadMessageEnvelopes(client, sessionId, true);
        consecutiveErrors = 0;
        const candidate = lastAssistant(envelopes);
        if (isFinishedTurn(candidate, priorAssistantIds)) {
          return {
            status: "completed",
            message: candidate!.info as unknown as AssistantMessage,
            parts: candidate!.parts,
          };
        }
        const stableResult = updateStableCandidate(
          candidate,
          priorAssistantIds,
          stable,
          Date.now()
        );
        stable = stableResult.stable;
        if (stableResult.completed) {
          return {
            status: "completed",
            message: candidate!.info as unknown as AssistantMessage,
            parts: candidate!.parts,
          };
        }

        // Idle tier: the session went idle (per SSE) but the newest assistant
        // message of OUR turn was never finalized (abandoned turn). Requiring
        // a new message means this can never fire before the turn starts, and
        // requiring both the idle reading and the content freeze to persist
        // for IDLE_COMPLETE_MS filters intra-turn status blips.
        if (candidate && !priorAssistantIds.has(candidate.info.id)) {
          const signature = JSON.stringify({
            time: candidate.info.time,
            error: candidate.info.error != null,
            parts: candidate.parts,
          });
          if (frozen?.id !== candidate.info.id || frozen.signature !== signature) {
            frozen = { id: candidate.info.id, signature, firstSeenAt: Date.now() };
          }
          const idleAt = idleSince?.();
          if (
            idleAt !== undefined &&
            Date.now() - Math.max(idleAt, frozen.firstSeenAt) >= IDLE_COMPLETE_MS
          ) {
            return {
              status: "completed",
              message: candidate.info as unknown as AssistantMessage,
              parts: candidate.parts,
            };
          }
        } else {
          frozen = undefined;
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
 * session would let an already-completed prior message look "new"). Reads the
 * newest page first because `waitForTurnComplete` compares against the latest
 * assistant message while waiting for the submitted turn. Returns an empty set
 * for a session with no assistant messages yet (correct for `run`).
 */
export async function snapshotAssistantIds(
  client: OpencodeClient,
  sessionId: string
): Promise<Set<string>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const envelopes = await loadMessageEnvelopes(client, sessionId, true);
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

export interface IdleTracker {
  /** Feed session-scoped SSE events (already filtered to one session). */
  observe: (event: Event) => void;
  /** When the session began reading idle, or undefined while busy/unknown. */
  idleSince: () => number | undefined;
}

/**
 * Track a session's idle state from its SSE events, for use as
 * `waitForTurnComplete`'s `idleSince` option. Poll-based status is not an
 * alternative: on opencode 1.17.x both `/session/status` and
 * `/api/session/active` return empty maps even while a turn is running, so
 * `session.idle` / `session.status` events are the only idle signal there is.
 * Idle is only trusted once observed (`idleSince` stays undefined until an
 * idle event arrives), so a dead event stream degrades to the old behavior
 * rather than a false positive.
 */
export function makeIdleTracker(): IdleTracker {
  let idleAt: number | undefined;
  return {
    observe(event: Event): void {
      const type = event.type as string;
      if (type === "session.idle") {
        idleAt ??= Date.now();
        return;
      }
      if (type === "session.status") {
        const statusType = (event.properties as { status?: { type?: string } } | undefined)
          ?.status?.type;
        if (statusType === "idle") idleAt ??= Date.now();
        else idleAt = undefined;
        return;
      }
      // Assistant-side progress disarms a previously observed idle: some older
      // servers were reported to emit status events between intra-turn steps,
      // and this keeps such a blip from counting as the turn's end. At a real
      // turn end the assistant activity precedes session.idle (only session.*
      // and user-message events trail it), so this cannot disarm a genuine
      // idle transition.
      if (type === "message.part.updated" || type === "message.part.delta") {
        idleAt = undefined;
        return;
      }
      if (type === "message.updated") {
        const role = (event.properties as { info?: { role?: string } } | undefined)?.info?.role;
        if (role === "assistant") idleAt = undefined;
      }
    },
    idleSince: () => idleAt,
  };
}
