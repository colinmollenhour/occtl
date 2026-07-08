import { Command } from "commander";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import {
  ensureServer,
  getClientV2,
  setServer,
  setPassword,
  getBaseUrl,
} from "../client.js";
import { extractText } from "../format.js";
import { spawnOpencodeServer, type SpawnedServer } from "../spawn.js";
import { startStream } from "../sse.js";
import { makeIdleTracker, snapshotAssistantIds, waitForTurnComplete } from "../turn-util.js";

interface RunOpts {
  model?: string;
  variant?: string;
  agent?: string;
  title?: string;
  file: string[];
  message?: string;
  dir?: string;
  out?: string;
  stderr?: string;
  raw?: string;
  timeout?: string;
  thinking?: boolean;
  spawn?: boolean;
  spawnPort?: string;
  password?: string;
  ephemeral?: boolean;
}

export function sessionRunCommand(): Command {
  return new Command("run")
    .description(
      "One-shot prompt: create a session, send, wait for completion, write the response. " +
        "Use --spawn to run against an ephemeral `opencode serve`."
    )
    // Model behavior
    .option("-m, --model <provider/model>", "Model (required, e.g. anthropic/claude-opus-4-7)")
    .option("--variant <name>", "Model variant (e.g. high, xhigh, max)")
    .option("--agent <name>", "Agent name")
    .option("--thinking", "Forward thinking flag to the model")
    // Session
    .option("-t, --title <title>", "Session title")
    .option("-d, --dir <path>", "Project directory for the session (default: cwd)")
    // Prompt
    .option(
      "-f, --file <path>",
      "Prompt file (repeatable; concatenated into a single text part)",
      collect,
      [] as string[]
    )
    .option("--message <text>", "Short text appended to the prompt after files")
    // Output sinks
    .option("-o, --out <path>", "Write assistant text to this file (default: stdout)")
    .option("--raw <path>", "Write the full last assistant message JSON to this file")
    .option("--stderr <path>", "Capture run-level diagnostics to this file")
    // Run control
    .option("--timeout <ms>", "Abort if not idle within this many ms (exits 124)")
    .option("--ephemeral", "Delete the session after the run completes successfully")
    // Server
    .option("--spawn", "Spawn an ephemeral `opencode serve` instead of using a running server")
    .option("--spawn-port <port>", "Bind --spawn to this port instead of a random free one")
    .option("--password <pw>", "Server password (also reads OPENCODE_SERVER_PASSWORD)")
    .argument("[message...]", "Trailing message text (alternative to --message)")
    .action(async (positionalParts: string[], opts: RunOpts) => {
      await runAction(positionalParts, opts);
    });
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function dieDiag(
  diagPath: string | undefined,
  exitCode: number,
  body: string
): never {
  if (diagPath) {
    try {
      mkdirSync(dirname(pathResolve(diagPath)), { recursive: true });
      writeFileSync(diagPath, body);
    } catch {
      process.stderr.write(body);
    }
  } else {
    process.stderr.write(body);
  }
  process.exit(exitCode);
}

function writeOut(path: string, body: string): void {
  mkdirSync(dirname(pathResolve(path)), { recursive: true });
  writeFileSync(path, body);
}

async function runAction(positionalParts: string[], opts: RunOpts): Promise<void> {
  // ─── Validate ───────────────────────────────────────────────────────────
  if (!opts.model) {
    process.stderr.write("occtl run: --model is required (e.g. anthropic/claude-opus-4-7)\n");
    process.exit(2);
  }
  const modelParts = opts.model.split("/");
  const providerID = modelParts[0];
  const modelID = modelParts.slice(1).join("/");
  if (!providerID || !modelID) {
    process.stderr.write(`occtl run: --model must be provider/model (got ${JSON.stringify(opts.model)})\n`);
    process.exit(2);
  }

  let timeoutMs = 0;
  if (opts.timeout) {
    timeoutMs = Number(opts.timeout);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      process.stderr.write(`occtl run: --timeout must be a non-negative number (got ${JSON.stringify(opts.timeout)})\n`);
      process.exit(2);
    }
  }

  let spawnPort: number | undefined;
  if (opts.spawnPort) {
    spawnPort = Number(opts.spawnPort);
    if (!Number.isFinite(spawnPort) || spawnPort < 0 || spawnPort > 65535) {
      process.stderr.write(`occtl run: --spawn-port must be a valid TCP port (got ${JSON.stringify(opts.spawnPort)})\n`);
      process.exit(2);
    }
  }

  // ─── Build prompt ───────────────────────────────────────────────────────
  const promptChunks: string[] = [];
  for (const f of opts.file) {
    try {
      promptChunks.push(readFileSync(f, "utf-8"));
    } catch (err) {
      process.stderr.write(`occtl run: failed to read --file ${JSON.stringify(f)}: ${(err as Error).message}\n`);
      process.exit(2);
    }
  }
  const trailing =
    opts.message?.trim() ||
    (positionalParts.length > 0 ? positionalParts.join(" ") : "");
  if (trailing) promptChunks.push(trailing);
  const prompt = promptChunks.join("\n").trim();
  if (!prompt) {
    process.stderr.write("occtl run: no prompt content (provide --file, --message, or a positional message)\n");
    process.exit(2);
  }

  // ─── Optional spawn ─────────────────────────────────────────────────────
  let server: SpawnedServer | null = null;
  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (server) {
      try {
        await server.shutdown();
      } catch {
        /* swallow shutdown errors */
      }
    }
  };

  // Best-effort cleanup on signals. We don't await here because Node won't.
  const onSignal = (signal: NodeJS.Signals): void => {
    cleanup().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  try {
    if (opts.spawn) {
      server = await spawnOpencodeServer({
        port: spawnPort,
        password: opts.password ?? null,
      });
      setServer(server.baseUrl);
      // Override env-derived password so we don't try to auth against an
      // unsecured spawned server. setPassword(null) wins over env.
      setPassword(server.password);
    } else if (opts.password) {
      setPassword(opts.password);
    }

    // ─── Connect & create session ─────────────────────────────────────────
    const client = await ensureServer();
    const clientV2 = getClientV2();
    const directory = opts.dir ? pathResolve(opts.dir) : process.cwd();

    const created = await client.session.create({
      body: { ...(opts.title && { title: opts.title }) },
      query: { directory },
    });
    if (!created.data) {
      await cleanup();
      dieDiag(opts.stderr, 1, "occtl run: session create failed\n");
    }
    const sessionId = created.data.id;

    // Write the session sidecar early so a later timeout/disconnect is still
    // recoverable via `occtl last <session>` even if we capture nothing.
    if (opts.out) writeOut(`${opts.out}.session`, `${sessionId}\n`);

    // Snapshot existing assistant message IDs before sending so a brand-new
    // finalized assistant message unambiguously marks our turn's completion.
    // (Empty on a freshly created session; the helper guards against a
    // transient-failure empty set on existing sessions.)
    let priorAssistantIds: Set<string> = new Set();
    try {
      priorAssistantIds = await snapshotAssistantIds(client, sessionId);
    } catch (err) {
      await cleanup();
      dieDiag(
        opts.stderr,
        1,
        `occtl run: cannot reach OpenCode server: ${(err as Error).message}\nsession_id: ${sessionId}\n`
      );
    }

    // ─── Send prompt ──────────────────────────────────────────────────────
    type PromptParams = Parameters<typeof clientV2.session.promptAsync>[0];
    const params = {
      sessionID: sessionId,
      parts: [{ type: "text" as const, text: prompt }],
      model: { providerID, modelID },
      ...(opts.agent && { agent: opts.agent }),
      ...(opts.variant && { variant: opts.variant }),
      ...(opts.thinking && { thinking: true }),
    } as unknown as PromptParams;

    // Best-effort SSE idle tracker (started before the send so the idle
    // transition cannot be missed). Completion is still decided by polling
    // message state; the tracker only lets the poller rescue turns the server
    // abandons without finalizing the assistant message. If the event stream
    // is unavailable the run behaves exactly as before.
    const idleTracker = makeIdleTracker();
    const events = startStream(sessionId, (event) => idleTracker.observe(event), {
      reconnect: true,
    });
    await events.connected;

    let turn;
    try {
      await clientV2.session.promptAsync(params);

      // ─── Wait for the submitted turn to finish ──────────────────────────
      // Poll message state (a new assistant message with `time.completed`/
      // `error`) rather than trusting SSE — a dead event stream must never
      // block completion. Polling holds no long-lived connection, so it is
      // safe for long agentic turns.
      turn = await waitForTurnComplete(client, sessionId, {
        priorAssistantIds,
        timeoutMs,
        idleSince: idleTracker.idleSince,
      });
    } finally {
      events.cancel();
    }

    if (turn.status !== "completed") {
      try {
        await client.session.abort({ path: { id: sessionId } });
      } catch {
        /* ignore */
      }
      const code = turn.status === "timeout" ? 124 : 1;
      const baseUrl = getBaseUrl();
      const diag =
        turn.status === "timeout"
          ? `occtl run: timed out after ${timeoutMs}ms.\nmodel: ${opts.model}\nsession_id: ${sessionId}\nbase_url: ${baseUrl}\n`
          : `occtl run: lost connection to OpenCode server while waiting for the turn.\nmodel: ${opts.model}\nsession_id: ${sessionId}\nbase_url: ${baseUrl}\n`;
      await cleanup();
      dieDiag(opts.stderr, code, diag);
    }

    // ─── Use the completed assistant message ──────────────────────────────
    // `turn` is narrowed to the "completed" variant here (the block above exits
    // for every other status), so `message`/`parts` are guaranteed present.
    const message = turn.message;
    const parts = turn.parts;
    const text = extractText(parts);

    // ─── Write outputs ────────────────────────────────────────────────────
    if (opts.out) {
      writeOut(opts.out, text);
    } else {
      process.stdout.write(text);
      if (text && !text.endsWith("\n")) process.stdout.write("\n");
    }

    if (opts.raw) {
      writeOut(opts.raw, JSON.stringify({ info: message, parts }, null, 2));
    }

    // ─── Empty-response detection ─────────────────────────────────────────
    if (!text.trim()) {
      const diag = `occtl run: provider returned no text — there could be an availability issue or account spending limits may have been reached.\nmodel: ${opts.model}\nsession_id: ${sessionId}\nparts: ${parts.length}\n`;
      await cleanup();
      dieDiag(opts.stderr, 1, diag);
    }

    // ─── Ephemeral cleanup ────────────────────────────────────────────────
    if (opts.ephemeral) {
      try {
        await client.session.delete({ path: { id: sessionId } });
      } catch {
        /* ignore */
      }
    }
  } finally {
    await cleanup();
  }
}
