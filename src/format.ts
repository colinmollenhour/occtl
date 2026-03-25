import type { Session, Message, Part, AssistantMessage, UserMessage } from "@opencode-ai/sdk";

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function formatTimeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}

export function formatSession(session: Session): string {
  const parts = [
    session.id,
    truncate(session.title || "(untitled)", 50),
    formatTimeAgo(session.time.updated),
  ];
  return parts.join("\t");
}

export function formatSessionDetailed(session: Session): string {
  const lines: string[] = [];
  lines.push(`ID:        ${session.id}`);
  lines.push(`Title:     ${session.title || "(untitled)"}`);
  lines.push(`Directory: ${session.directory}`);
  lines.push(`Created:   ${formatTime(session.time.created)}`);
  lines.push(`Updated:   ${formatTime(session.time.updated)}`);
  if (session.parentID) {
    lines.push(`Parent:    ${session.parentID}`);
  }
  if (session.share?.url) {
    lines.push(`Share URL: ${session.share.url}`);
  }
  if (session.summary) {
    lines.push(
      `Changes:   +${session.summary.additions} -${session.summary.deletions} (${session.summary.files} files)`
    );
  }
  return lines.join("\n");
}

export function isUserMessage(msg: Message): msg is UserMessage {
  return msg.role === "user";
}

export function isAssistantMessage(msg: Message): msg is AssistantMessage {
  return msg.role === "assistant";
}

export function extractText(parts: Part[]): string {
  const textParts = parts.filter((p) => p.type === "text");
  return textParts.map((p) => (p as { text: string }).text).join("\n");
}

export function extractToolCalls(parts: Part[]): Array<{
  tool: string;
  status: string;
  title?: string;
}> {
  return parts
    .filter((p) => p.type === "tool")
    .map((p) => {
      const toolPart = p as { tool: string; state?: { status: string; title?: string } };
      return {
        tool: toolPart.tool,
        status: toolPart.state?.status ?? "unknown",
        title: toolPart.state?.title,
      };
    });
}

export function formatMessage(
  msg: Message,
  parts: Part[],
  opts: { verbose?: boolean; textOnly?: boolean } = {}
): string {
  const lines: string[] = [];
  const role = msg.role.toUpperCase();
  const time = formatTime(msg.time.created);

  if (opts.textOnly) {
    const text = extractText(parts);
    if (text) lines.push(text);
    return lines.join("\n");
  }

  lines.push(`--- ${role} [${time}] ---`);

  if (isAssistantMessage(msg)) {
    lines.push(`Model: ${msg.providerID}/${msg.modelID}`);
    if (msg.cost > 0) {
      lines.push(`Cost: $${msg.cost.toFixed(6)}`);
    }
    if (msg.tokens) {
      lines.push(
        `Tokens: in=${msg.tokens.input} out=${msg.tokens.output}` +
          (msg.tokens.reasoning ? ` reasoning=${msg.tokens.reasoning}` : "") +
          (msg.tokens.cache.read ? ` cache_read=${msg.tokens.cache.read}` : "")
      );
    }
    if (msg.error) {
      lines.push(`Error: ${msg.error.name}`);
    }
  }

  const text = extractText(parts);
  if (text) {
    lines.push("");
    lines.push(text);
  }

  if (opts.verbose) {
    const tools = extractToolCalls(parts);
    if (tools.length > 0) {
      lines.push("");
      lines.push("Tool calls:");
      for (const t of tools) {
        lines.push(
          `  - ${t.tool} [${t.status}]${t.title ? ` ${t.title}` : ""}`
        );
      }
    }
  }

  return lines.join("\n");
}

export function formatJSON(data: unknown): string {
  return JSON.stringify(data, null, 2);
}
