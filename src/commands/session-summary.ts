import { Command } from "commander";
import { ensureServer } from "../client.js";
import { resolveSession } from "../resolve.js";
import {
  formatJSON,
  extractText,
  truncate,
  formatTimeAgo,
  getMessageCostAndTokens,
  hasTokenUsage,
} from "../format.js";
import { deriveSessionStatus } from "../status-util.js";

export function sessionSummaryCommand(): Command {
  return new Command("summary")
    .description(
      "Compact summary of a session: status, todo progress, last message snippet, cost"
    )
    .argument("[session-id]", "Session ID (defaults to most recent)")
    .option("-j, --json", "Output as JSON")
    .option(
      "-n, --snippet-length <chars>",
      "Max characters for last message snippet",
      parseInt,
      200
    )
    .action(async (sessionId: string | undefined, opts) => {
      const client = await ensureServer();
      const resolved = await resolveSession(client, sessionId);

      // Fetch session info, status, messages, todos, and child-session info in parallel
      const [sessionResult, statusResult, messagesResult, todoResult, sessionsResult] =
        await Promise.all([
          client.session.get({ path: { id: resolved } }),
          client.session.status(),
          client.session.messages({ path: { id: resolved } }),
          client.session.todo({ path: { id: resolved } }),
          client.session.list({}),
        ]);

      const session = sessionResult.data;
      const statuses = statusResult.data ?? {};
      const messages = messagesResult.data ?? [];
      const todos = todoResult.data ?? [];
      const sessions = sessionsResult.data ?? [];

      // Compute status
      const derivedStatus = deriveSessionStatus(resolved, statuses, sessions);
      const status = derivedStatus.type;

      // Compute todo progress
      const todoTotal = todos.length;
      const todoCompleted = todos.filter(
        (t) => t.status === "completed"
      ).length;
      const todoInProgress = todos.filter(
        (t) => t.status === "in_progress"
      ).length;

      // Get last assistant message snippet
      const assistantMsgs = messages.filter(
        (m) => m.info.role === "assistant"
      );
      const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
      let lastSnippet = "";
      if (lastAssistant) {
        const text = extractText(lastAssistant.parts).trim();
        lastSnippet = truncate(text, opts.snippetLength);
      }

      // Compute total cost and token usage.
      let totalCost = 0;
      const tokens = {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      };
      for (const m of messages) {
        if (m.info.role === "assistant") {
          const usage = getMessageCostAndTokens(m);
          totalCost += usage.cost;
          tokens.input += usage.tokens.input;
          tokens.output += usage.tokens.output;
          tokens.reasoning += usage.tokens.reasoning;
          tokens.cache.read += usage.tokens.cache.read;
          tokens.cache.write += usage.tokens.cache.write;
        }
      }

      // Compute changes
      const changes = session?.summary
        ? `+${session.summary.additions} -${session.summary.deletions} (${session.summary.files} files)`
        : "none";

      const summary = {
        sessionID: resolved,
        title: session?.title || "(untitled)",
        status,
        mainStatus: derivedStatus.main,
        allIdle: derivedStatus.allIdle,
        activeChildren: derivedStatus.activeChildren,
        updated: session?.time.updated
          ? formatTimeAgo(session.time.updated)
          : "unknown",
        todos: {
          total: todoTotal,
          completed: todoCompleted,
          inProgress: todoInProgress,
          pending: todoTotal - todoCompleted - todoInProgress,
        },
        cost: `$${totalCost.toFixed(4)}`,
        totalCost,
        tokens,
        changes,
        lastMessage: lastSnippet,
      };

      if (opts.json) {
        console.log(formatJSON(summary));
        return;
      }

      console.log(`Session:  ${summary.sessionID}`);
      console.log(`Title:    ${summary.title}`);
      console.log(`Status:   ${summary.status}`);
      console.log(`Updated:  ${summary.updated}`);
      if (todoTotal > 0) {
        console.log(
          `Todos:    ${todoCompleted}/${todoTotal} done, ${todoInProgress} in progress`
        );
      }
      console.log(`Cost:     ${summary.cost}`);
      if (hasTokenUsage(tokens)) {
        console.log(
          `Tokens:   in=${tokens.input} out=${tokens.output}` +
            (tokens.reasoning ? ` reasoning=${tokens.reasoning}` : "") +
            (tokens.cache.read ? ` cache_read=${tokens.cache.read}` : "") +
            (tokens.cache.write ? ` cache_write=${tokens.cache.write}` : "")
        );
      }
      console.log(`Changes:  ${summary.changes}`);
      if (lastSnippet) {
        console.log(`Last msg: ${lastSnippet}`);
      }
    });
}
