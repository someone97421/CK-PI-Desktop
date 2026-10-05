/** Host-resolved server identity survives the Main -> runtime tool catalog. */
type McpToolIdentity = { name: string; mcpServerId?: string };

export function parseMcpServerIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !id.trim())) {
    throw Object.assign(new Error("Invalid MCP server selection"), { errorCode: "INVALID_ARGUMENT" });
  }
  return [...new Set(value as string[])];
}

export function parseMcpToolNames(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.some(name => typeof name !== "string" || !name.trim())) {
    throw Object.assign(new Error("Invalid MCP tool selection"), { errorCode: "INVALID_ARGUMENT" });
  }
  return [...new Set(value as string[])];
}

/** Resolve exact server IDs; never authorize tools by a name-prefix match. */
export function resolveMcpToolSelection(
  selection: unknown,
  tools: readonly McpToolIdentity[],
  available: (name: string) => boolean,
  toolSelection?: unknown,
): string[] {
  const selected = parseMcpServerIds(selection) ?? [];
  const requested = parseMcpToolNames(toolSelection);
  if (requested?.some(name => !tools.some(tool => tool.name === name && selected.includes(tool.mcpServerId ?? "")))) {
    throw Object.assign(new Error("Selected MCP tool unavailable"), { errorCode: "COMPOSER_MCP_UNAVAILABLE" });
  }
  const names = new Set<string>();
  for (const id of selected) {
    const owned = tools.filter(tool => tool.mcpServerId === id && (!requested || requested.includes(tool.name)));
    if (!owned.length) {
      throw Object.assign(new Error("Selected MCP server unavailable"), { errorCode: "COMPOSER_MCP_UNAVAILABLE" });
    }
    if (requested && owned.some(tool => !available(tool.name))) {
      throw Object.assign(new Error("Selected MCP tool is unavailable in this mode"), { errorCode: "TOOL_DENIED" });
    }
    const allowed = owned.filter(tool => available(tool.name));
    if (!allowed.length) {
      throw Object.assign(new Error("Selected MCP tools are unavailable in this mode"), { errorCode: "TOOL_DENIED" });
    }
    for (const tool of allowed) names.add(tool.name);
  }
  return [...names];
}
