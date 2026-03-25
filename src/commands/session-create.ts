import { Command } from "commander";
import { ensureServer } from "../client.js";
import { formatSessionDetailed, formatJSON } from "../format.js";

export function sessionCreateCommand(): Command {
  return new Command("create")
    .alias("new")
    .description("Create a new session")
    .option("-t, --title <title>", "Session title")
    .option(
      "-p, --parent <id>",
      "Parent session ID (creates a child/sub-agent session)"
    )
    .option(
      "-d, --dir <path>",
      "Project directory for the session (defaults to cwd)"
    )
    .option("-j, --json", "Output as JSON")
    .option("-q, --quiet", "Only output the session ID")
    .action(async (opts) => {
      const client = await ensureServer();

      const directory = opts.dir
        ? (await import("path")).resolve(opts.dir)
        : process.cwd();

      const result = await client.session.create({
        body: {
          ...(opts.title && { title: opts.title }),
          ...(opts.parent && { parentID: opts.parent }),
        },
        query: { directory },
      });

      if (!result.data) {
        console.error("Failed to create session.");
        process.exit(1);
      }

      if (opts.quiet) {
        console.log(result.data.id);
        return;
      }

      if (opts.json) {
        console.log(formatJSON(result.data));
        return;
      }

      console.log(formatSessionDetailed(result.data));
    });
}
