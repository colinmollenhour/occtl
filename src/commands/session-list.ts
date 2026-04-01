import { Command } from "commander";
import path from "path";
import { ensureServer } from "../client.js";
import { formatSession, formatSessionDetailed, formatJSON } from "../format.js";
import type { Session } from "@opencode-ai/sdk";

export function sessionListCommand(): Command {
  return new Command("list")
    .alias("ls")
    .description(
      "List sessions. Default: current directory only. Pass a path to filter by directory, or --all for everything."
    )
    .argument("[directory]", "Only show sessions for this directory")
    .option("-j, --json", "Output as JSON")
    .option("-d, --detailed", "Show detailed info for each session")
    .option("-n, --limit <n>", "Limit number of results", parseInt)
    .option("-a, --all", "Show sessions for all directories")
    .option("-c, --children", "Include child sessions (sub-agents)")
    .option(
      "--sort <field>",
      "Sort by: updated (default), created, title",
      "updated"
    )
    .option("--asc", "Sort ascending instead of descending")
    .option("--active", "Only show non-idle sessions (busy or retry)")
    .action(async (directory: string | undefined, opts) => {
      const client = await ensureServer();

      // Determine which directory to filter by
      let filterDir: string | undefined;
      if (opts.all) {
        filterDir = undefined;
      } else if (directory) {
        filterDir = path.resolve(directory);
      } else {
        filterDir = process.cwd();
      }

      const result = await client.session.list({
        ...(filterDir && { query: { directory: filterDir } }),
      });
      let sessions = result.data ?? [];

      // Client-side directory filtering as fallback
      if (filterDir) {
        sessions = sessions.filter((s) => s.directory === filterDir);
      }

      // Filter out child sessions unless --children
      if (!opts.children) {
        sessions = sessions.filter((s) => !s.parentID);
      }

      // Filter to non-idle sessions if --active
      if (opts.active) {
        const statusResult = await client.session.status();
        const statuses = statusResult.data ?? {};
        sessions = sessions.filter((s) => {
          const status = statuses[s.id];
          return status && status.type !== "idle";
        });
      }

      // Sort
      const sortField = opts.sort as string;
      const ascending = !!opts.asc;
      sessions.sort((a: Session, b: Session) => {
        let cmp = 0;
        switch (sortField) {
          case "created":
            cmp = b.time.created - a.time.created;
            break;
          case "title":
            cmp = (a.title || "").localeCompare(b.title || "");
            break;
          case "updated":
          default:
            cmp = b.time.updated - a.time.updated;
            break;
        }
        return ascending ? -cmp : cmp;
      });

      // Apply limit
      if (opts.limit && opts.limit > 0) {
        sessions = sessions.slice(0, opts.limit);
      }

      if (opts.json) {
        console.log(formatJSON(sessions));
        return;
      }

      if (sessions.length === 0) {
        if (filterDir) {
          console.log(`No sessions found for ${filterDir}.`);
        } else {
          console.log("No sessions found.");
        }
        return;
      }

      if (opts.detailed) {
        for (const s of sessions) {
          console.log(formatSessionDetailed(s));
          console.log("");
        }
      } else {
        console.log("ID\tTITLE\tUPDATED");
        for (const s of sessions) {
          console.log(formatSession(s));
        }
      }
    });
}
