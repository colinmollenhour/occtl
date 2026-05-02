import { Command } from "commander";
import { ensureServer, getBaseUrl } from "../client.js";

export function pingCommand(): Command {
  return new Command("ping")
    .description("Check that an OpenCode server is reachable")
    .action(async () => {
      await ensureServer();
      console.log(`OK ${getBaseUrl()}`);
    });
}
