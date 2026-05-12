#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { setServer } from "./client.js";
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
  sessionWaitAllCommand,
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

function addAttachOption(command: Command): void {
  if (command.options.some((option) => option.long === "--attach")) return;
  command.option(
    "--attach <host:port>",
    "Use a specific OpenCode server instead of auto-detection or OPENCODE_SERVER_HOST/PORT"
  );
}

function parseAttach(value: string): { host: string; port: string } | null {
  const bracketMatch = value.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketMatch) {
    return validateAttach(value, bracketMatch[1], bracketMatch[2]);
  }

  const sep = value.lastIndexOf(":");
  if (sep <= 0 || sep === value.length - 1) return null;
  return validateAttach(value, value.slice(0, sep), value.slice(sep + 1));
}

function validateAttach(
  original: string,
  host: string,
  port: string
): { host: string; port: string } | null {
  const portNumber = Number(port);
  if (
    !host ||
    /\s/.test(host) ||
    !/^\d+$/.test(port) ||
    portNumber < 1 ||
    portNumber > 65535
  ) {
    return null;
  }
  if (original.includes(":") && host.includes(":") && !original.startsWith("[")) {
    return null;
  }
  return { host, port };
}

function findAttachOption(command: Command): string | undefined {
  let current: Command | null = command;
  while (current) {
    const attach = current.opts<{ attach?: string }>().attach;
    if (attach) return attach;
    current = current.parent;
  }
  return undefined;
}

function applyAttachOption(command: Command): void {
  addAttachOption(command);
  for (const child of command.commands) applyAttachOption(child);
}

program
  .name("occtl")
  .description(
    "Extended CLI for managing OpenCode sessions.\n\n" +
    "Auto-detects running OpenCode server. Use --attach host:port, or set:\n" +
    "  OPENCODE_SERVER_HOST  (default: 127.0.0.1)\n" +
    "  OPENCODE_SERVER_PORT  (default: 4096)"
  )
  .version(pkg.version);
program.hook("preAction", (_thisCommand, actionCommand) => {
  const attach = findAttachOption(actionCommand);
  if (!attach) return;

  const parsed = parseAttach(attach);
  if (!parsed) {
    actionCommand.error(
      `error: option '--attach <host:port>' argument must be host:port with port 1-65535 (got ${JSON.stringify(attach)})`,
      { exitCode: 2 }
    );
    return;
  }
  const host = parsed.host.includes(":") ? `[${parsed.host}]` : parsed.host;
  setServer(`http://${host}:${parsed.port}`);
});

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
program.addCommand(sessionWaitAllCommand());
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

applyAttachOption(program);

program.parse();
