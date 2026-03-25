import { Command } from "commander";
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { resolve, basename } from "path";
import { ensureServer } from "../client.js";
import { formatJSON, formatMessage } from "../format.js";
import { startStream } from "../sse.js";
import { waitForIdle } from "../wait-util.js";

interface Worktree {
  path: string;
  branch: string;
  head: string;
  bare?: boolean;
}

function getRepoRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    console.error("Error: Not inside a git repository.");
    process.exit(1);
  }
}

function parseWorktreeList(): Worktree[] {
  try {
    const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
      encoding: "utf-8",
      timeout: 5000,
    });

    const worktrees: Worktree[] = [];
    let current: Partial<Worktree> = {};

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) worktrees.push(current as Worktree);
        current = { path: line.slice(9) };
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice(5);
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice(7).replace("refs/heads/", "");
      } else if (line === "bare") {
        current.bare = true;
      } else if (line === "detached") {
        current.branch = "(detached)";
      }
    }
    if (current.path) worktrees.push(current as Worktree);

    return worktrees;
  } catch {
    console.error("Error: Failed to list git worktrees.");
    process.exit(1);
  }
}

function getWorktreeDir(): string {
  const root = getRepoRoot();
  return resolve(root, ".occtl", "worktrees");
}

/**
 * Create a git worktree. Uses execFileSync (no shell) to prevent injection.
 */
function createWorktree(wtPath: string, branch: string, base: string): void {
  try {
    execFileSync("git", ["worktree", "add", wtPath, "-b", branch, base], {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 30000,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists")) {
      try {
        execFileSync("git", ["worktree", "add", wtPath, branch], {
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 30000,
        });
      } catch (err2: unknown) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        console.error(`Failed to create worktree: ${msg2}`);
        process.exit(1);
      }
    } else {
      console.error(`Failed to create worktree: ${msg}`);
      process.exit(1);
    }
  }
}

// ─── list ──────────────────────────────────────────────

export function worktreeListCommand(): Command {
  return new Command("list")
    .alias("ls")
    .description("List git worktrees and any associated sessions")
    .option("-j, --json", "Output as JSON")
    .action(async (opts) => {
      const worktrees = parseWorktreeList();

      if (opts.json) {
        console.log(formatJSON(worktrees));
        return;
      }

      if (worktrees.length === 0) {
        console.log("No worktrees found.");
        return;
      }

      console.log("PATH\tBRANCH\tHEAD");
      for (const wt of worktrees) {
        console.log(
          `${wt.path}\t${wt.branch || "(bare)"}\t${(wt.head || "").slice(0, 8)}`
        );
      }
    });
}

// ─── create ────────────────────────────────────────────

export function worktreeCreateCommand(): Command {
  return new Command("create")
    .description(
      "Create a git worktree and optionally a session in it"
    )
    .argument("<name>", "Worktree name (used as directory and branch name)")
    .option(
      "-b, --branch <branch>",
      "Branch name (defaults to worktree-<name>)"
    )
    .option(
      "--base <ref>",
      "Base ref to branch from (defaults to HEAD)"
    )
    .option(
      "--no-session",
      "Don't create a session in the worktree"
    )
    .option("-j, --json", "Output as JSON")
    .option("-q, --quiet", "Only output the worktree path")
    .action(async (name: string, opts) => {
      const wtDir = getWorktreeDir();
      const wtPath = resolve(wtDir, name);
      const branch = opts.branch || `worktree-${name}`;
      const base = opts.base || "HEAD";

      if (existsSync(wtPath)) {
        console.error(`Worktree already exists at ${wtPath}`);
        process.exit(1);
      }

      createWorktree(wtPath, branch, base);

      const result: Record<string, unknown> = {
        path: wtPath,
        branch,
        name,
      };

      // Optionally create a session in the worktree directory
      if (opts.session !== false) {
        try {
          const client = await ensureServer();
          const session = await client.session.create({
            body: { title: `worktree: ${name}` },
            query: { directory: wtPath },
          });
          if (session.data) {
            result.sessionID = session.data.id;
          }
        } catch {
          // Server might not be running — that's OK, just skip session
        }
      }

      if (opts.quiet) {
        console.log(wtPath);
        return;
      }

      if (opts.json) {
        console.log(formatJSON(result));
        return;
      }

      console.log(`Created worktree: ${wtPath}`);
      console.log(`Branch: ${branch}`);
      if (result.sessionID) {
        console.log(`Session: ${result.sessionID}`);
      }
    });
}

// ─── remove ────────────────────────────────────────────

export function worktreeRemoveCommand(): Command {
  return new Command("remove")
    .alias("rm")
    .description("Remove a git worktree")
    .argument("<name>", "Worktree name or path")
    .option("-f, --force", "Force removal even if dirty")
    .action(async (name: string, opts) => {
      let wtPath: string;
      const candidate = resolve(getWorktreeDir(), name);
      if (existsSync(candidate)) {
        wtPath = candidate;
      } else if (existsSync(name)) {
        wtPath = resolve(name);
      } else {
        const worktrees = parseWorktreeList();
        const match = worktrees.find(
          (wt) =>
            basename(wt.path) === name || wt.path.endsWith(`/${name}`)
        );
        if (match) {
          wtPath = match.path;
        } else {
          console.error(`Worktree not found: ${name}`);
          process.exit(1);
        }
      }

      const args = ["worktree", "remove", wtPath];
      if (opts.force) args.push("--force");

      try {
        execFileSync("git", args, {
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 30000,
        });
        console.log(`Removed worktree: ${wtPath}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to remove worktree: ${msg}`);
        process.exit(1);
      }
    });
}

// ─── run ───────────────────────────────────────────────

export function worktreeRunCommand(): Command {
  return new Command("run")
    .description(
      "Create a worktree, start a session, send a prompt, and optionally wait"
    )
    .argument("<name>", "Worktree name")
    .argument("<message...>", "Prompt message to send")
    .option(
      "-b, --branch <branch>",
      "Branch name (defaults to worktree-<name>)"
    )
    .option("--base <ref>", "Base ref to branch from (defaults to HEAD)")
    .option(
      "-w, --wait",
      "Block until the session goes idle, then show the result"
    )
    .option("--auto-approve", "Auto-approve all permission requests")
    .option("--model <model>", "Model to use (format: provider/model)")
    .option("--agent <agent>", "Agent to use")
    .option("-j, --json", "Output as JSON")
    .option("-t, --text-only", "Show only text content")
    .option("--stdin", "Read message from stdin")
    .action(async (name: string, messageParts: string[], opts) => {
      const client = await ensureServer();

      // Create the worktree
      const wtDir = getWorktreeDir();
      const wtPath = resolve(wtDir, name);
      const branch = opts.branch || `worktree-${name}`;
      const base = opts.base || "HEAD";

      if (!existsSync(wtPath)) {
        createWorktree(wtPath, branch, base);
        console.error(`Created worktree: ${wtPath} (branch: ${branch})`);
      } else {
        console.error(`Using existing worktree: ${wtPath}`);
      }

      // Create a session in the worktree directory
      const session = await client.session.create({
        body: { title: `worktree: ${name}` },
        query: { directory: wtPath },
      });

      if (!session.data) {
        console.error("Failed to create session.");
        process.exit(1);
      }

      const sid = session.data.id;
      console.error(`Session: ${sid}`);

      // Build the message
      let messageText: string;
      if (opts.stdin) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        messageText = Buffer.concat(chunks).toString("utf-8").trim();
      } else {
        messageText = messageParts.join(" ");
      }

      // Parse model
      let model: { providerID: string; modelID: string } | undefined;
      if (opts.model) {
        const parts = opts.model.split("/");
        if (parts.length === 2 && parts[0] && parts[1]) {
          model = { providerID: parts[0], modelID: parts[1] };
        }
      }

      const body = {
        parts: [{ type: "text" as const, text: messageText }],
        ...(model && { model }),
        ...(opts.agent && { agent: opts.agent }),
      };

      // Start auto-approve in background if requested.
      // Uses startStream which returns a cancel handle.
      let approveHandle: ReturnType<typeof startStream> | undefined;
      if (opts.autoApprove) {
        approveHandle = startStream(sid, async (event) => {
          if (event.type !== "permission.updated") return;
          const props = event.properties as {
            id: string;
            status?: string;
          };
          if (props.status && props.status !== "pending") return;
          try {
            await client.postSessionIdPermissionsPermissionId({
              path: { id: sid, permissionID: props.id },
              body: { response: "once" },
            });
            console.error(`Auto-approved: ${props.id}`);
          } catch (err) {
            console.error(
              `Failed to auto-approve ${props.id}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        });
      }

      // Send the prompt
      await client.session.promptAsync({
        path: { id: sid },
        body,
      });
      console.error("Prompt sent.");

      if (!opts.wait) {
        const output = { sessionID: sid, worktree: wtPath, branch };
        if (opts.json) {
          console.log(formatJSON(output));
        } else {
          console.log(`Session ${sid} started in ${wtPath}`);
          if (approveHandle) {
            console.log("Auto-approve is active. Press Ctrl+C to stop.");
            // Keep running — the auto-approve stream keeps the event loop alive
            return;
          }
        }
        // Clean up auto-approve if not keeping it running
        approveHandle?.cancel();
        return;
      }

      // --wait: use race-safe waitForIdle
      const waitResult = await waitForIdle(client, sid);

      // Clean up auto-approve
      approveHandle?.cancel();

      if (!waitResult.idle) {
        if (waitResult.reason === "disconnected") {
          console.error("Error: lost connection to OpenCode server.");
        }
        process.exit(1);
      }

      // Fetch the last assistant message
      const msgs = await client.session.messages({
        path: { id: sid },
      });
      const messages = msgs.data ?? [];
      const last = messages.filter((m) => m.info.role === "assistant").pop();

      if (!last) {
        console.error("No assistant response.");
        process.exit(1);
      }

      if (opts.json) {
        console.log(
          formatJSON({
            sessionID: sid,
            worktree: wtPath,
            branch,
            response: last,
          })
        );
        return;
      }

      const textOnly = opts.textOnly !== false;
      console.log(formatMessage(last.info, last.parts, { textOnly }));
    });
}
