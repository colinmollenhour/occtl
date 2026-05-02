#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { pingCommand } from "./commands/ping.js";
import { sessionListCommand } from "./commands/session-list.js";
import { sessionGetCommand } from "./commands/session-get.js";
import { sessionMessagesCommand } from "./commands/session-messages.js";
import { sessionLastCommand } from "./commands/session-last.js";
import { sessionStatusCommand } from "./commands/session-status.js";
import { sessionWatchCommand } from "./commands/session-watch.js";
import { sessionSendCommand } from "./commands/session-send.js";
import { sessionStreamCommand } from "./commands/session-stream.js";
import { sessionRunCommand } from "./commands/session-run.js";
import { sessionRespondCommand } from "./commands/session-respond.js";
import { modelsCommand } from "./commands/models.js";
import { sessionTodoCommand } from "./commands/session-todo.js";
import { sessionAbortCommand } from "./commands/session-abort.js";
import { sessionDiffCommand } from "./commands/session-diff.js";
import { sessionChildrenCommand } from "./commands/session-children.js";
import { sessionCreateCommand } from "./commands/session-create.js";
import { sessionDeleteCommand } from "./commands/session-delete.js";
import { sessionShareCommand, sessionUnshareCommand } from "./commands/session-share.js";
import { sessionWaitForTextCommand } from "./commands/session-wait-for-text.js";
import {
  sessionWaitForIdleCommand,
  sessionWaitAnyCommand,
  sessionIsIdleCommand,
} from "./commands/session-wait.js";
import { sessionSummaryCommand } from "./commands/session-summary.js";
import {
  worktreeListCommand,
  worktreeCreateCommand,
  worktreeRemoveCommand,
  worktreeRunCommand,
} from "./commands/worktree.js";
import { installSkillCommand, viewSkillCommand } from "./commands/skill.js";

const pkg = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf8"
  )
);

const program = new Command();

program
  .name("occtl")
  .description(
    "Extended CLI for managing OpenCode sessions.\n\n" +
    "Auto-detects running OpenCode server, or set:\n" +
    "  OPENCODE_SERVER_HOST  (default: 127.0.0.1)\n" +
    "  OPENCODE_SERVER_PORT  (default: 4096)"
  )
  .version(pkg.version);

// Session commands (top-level)
program.addCommand(pingCommand());
program.addCommand(sessionListCommand());
program.addCommand(sessionCreateCommand());
program.addCommand(sessionDeleteCommand());
program.addCommand(sessionGetCommand());
program.addCommand(sessionMessagesCommand());
program.addCommand(sessionLastCommand());
program.addCommand(sessionStatusCommand());
program.addCommand(sessionWatchCommand());
program.addCommand(sessionSendCommand());
program.addCommand(sessionStreamCommand());
program.addCommand(sessionRunCommand());
program.addCommand(sessionRespondCommand());
program.addCommand(modelsCommand());
program.addCommand(sessionTodoCommand());
program.addCommand(sessionAbortCommand());
program.addCommand(sessionDiffCommand());
program.addCommand(sessionChildrenCommand());
program.addCommand(sessionShareCommand());
program.addCommand(sessionUnshareCommand());
program.addCommand(sessionWaitForTextCommand());
program.addCommand(sessionWaitForIdleCommand());
program.addCommand(sessionWaitAnyCommand());
program.addCommand(sessionIsIdleCommand());
program.addCommand(sessionSummaryCommand());

// Worktree subcommand group
const worktree = program
  .command("worktree")
  .alias("wt")
  .description("Manage git worktrees for parallel session isolation");

worktree.addCommand(worktreeListCommand());
worktree.addCommand(worktreeCreateCommand());
worktree.addCommand(worktreeRemoveCommand());
worktree.addCommand(worktreeRunCommand());

// Skill management (top-level)
program.addCommand(installSkillCommand());
program.addCommand(viewSkillCommand());

program.parse();
