import type { ComposerCommand } from "@pi-desktop/shared";

/** Expand a server selection only against the send-time project catalog. */
export function expandMcpInvocation(
  content: string,
  commands: ComposerCommand[],
  hasAttachments = false,
) {
  const match = /^\/(mcp:\S+)(?:\s|$)/.exec(content);
  if (!match) return null;
  const command = commands.find((entry) => entry.name === match[1]);
  if (command && command.kind !== "mcp") return null;
  if (!command?.mcpServerId) {
    throw Object.assign(new Error("Selected MCP server unavailable"), {
      errorCode: "COMPOSER_MCP_UNAVAILABLE",
    });
  }
  const body = content.slice(match[0].length).trim();
  if (!body && !hasAttachments) {
    throw Object.assign(new Error("Add a task or attachment after the MCP selection."), {
      errorCode: "COMPOSER_MCP_REQUEST_REQUIRED",
    });
  }
  return {
    command: content,
    mcpServerIds: [command.mcpServerId],
    ...(command.mcpToolName ? { mcpToolNames: [command.mcpToolName] } : {}),
    expanded: [
      command.mcpToolName
        ? `The user selected the MCP tool ${JSON.stringify(command.mcpToolName)} from ${JSON.stringify(command.title)} for this request.`
        : `The user selected the MCP server ${JSON.stringify(command.title)} for this request.`,
      body,
    ].filter(Boolean).join("\n\n"),
  };
}
