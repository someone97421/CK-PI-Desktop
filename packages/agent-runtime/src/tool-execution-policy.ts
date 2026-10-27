/** Batch policy only: this does not grant permissions or coordinate other agents. */
import type { AssistantMessage } from "@earendil-works/pi-ai";

export function toolExecutionMode(name: string): "parallel" | "sequential" {
  switch (name) {
    case "Read":
    case "Glob":
    case "Grep":
    case "Task":
      return "parallel";
    default:
      return "sequential";
  }
}

/**
 * Keep Task fan-out and read batches parallel, but preserve the old safety
 * boundary for a batch that mixes a background delegate with file reads.
 * Delegate write/resource coordination belongs to a later Host-owned phase.
 */
export function resolveBatchExecutionMode(
  assistantMessage: AssistantMessage,
): "parallel" | "sequential" | undefined {
  const names = assistantMessage.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "toolCall" }> => block.type === "toolCall")
    .map((block) => block.name);
  const hasTask = names.includes("Task");
  const hasFileRead = names.some((name) => name === "Read" || name === "Glob" || name === "Grep");
  return hasTask && hasFileRead ? "sequential" : undefined;
}

export function resolveTaskExecutionMode(
  lastMessage: unknown,
): "parallel" | "sequential" {
  if (
    typeof lastMessage === "object" &&
    lastMessage !== null &&
    (lastMessage as { role?: unknown }).role === "assistant" &&
    Array.isArray((lastMessage as { content?: unknown }).content) &&
    resolveBatchExecutionMode(lastMessage as AssistantMessage) === "sequential"
  ) {
    return "sequential";
  }
  return "parallel";
}

export function withDynamicTaskExecutionMode<
  T extends { name: string; executionMode?: "parallel" | "sequential" },
>(tool: T, getLastMessage: () => unknown): T {
  if (tool.name !== "Task" || tool.executionMode !== "parallel") {
    return tool;
  }
  return Object.defineProperty(tool, "executionMode", {
    enumerable: true,
    configurable: true,
    get: () => resolveTaskExecutionMode(getLastMessage()),
  });
}
