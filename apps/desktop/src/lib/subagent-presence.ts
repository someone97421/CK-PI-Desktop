import type { UiMessage } from "@pi-desktop/shared";
import type { AssistantActivityItem } from "./assistant-turns";
import { delegationIdForMessage } from "./subagent-panel";
import { collectDelegationStatuses, collectDelegationTimings, delegationIsCreating, isDelegationActivityItem, subagentOutcome, type SubagentOutcome } from "./subagent-topology";
import { delegateTaskDescription } from "./subagent-transcript";
import { getToolSummary } from "./tool-display";
import { toolResultPayload } from "./tool-presentation";

export type PresenceStatus = SubagentOutcome | "queued";
export type SubagentPresenceItem = {
  id: string;
  call: UiMessage;
  agent: string;
  status: PresenceStatus;
  task: string;
  detail: string;
  model: string;
  startedAt: number | null;
  completedAt: number | null;
  toolCalls: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

function isDelegateToolCall(row: UiMessage): boolean {
  return row.role === "tool" && row.toolName !== "TaskExecution" && row.toolName !== "TaskGuidance";
}

export function isActiveDelegate(item: SubagentPresenceItem): boolean {
  return item.status === "running" || item.status === "queued";
}

/** Include the current root turn and any earlier versioned executions still running. */
export function projectSubagentPresence(messages: readonly UiMessage[], turnLive: boolean): SubagentPresenceItem[] {
  const roots: UiMessage[] = [];
  const children = new Map<string, UiMessage[]>();
  const rootTurnIds = new Set<string>();
  for (const message of messages) {
    if (message.parentToolCallId) {
      const rows = children.get(message.parentToolCallId) ?? [];
      rows.push(message);
      children.set(message.parentToolCallId, rows);
      continue;
    }
    if (message.role === "user" && !message.steering) rootTurnIds.clear();
    if (message.role !== "tool") continue;
    roots.push(message);
    rootTurnIds.add(message.id);
  }
  const tools: AssistantActivityItem[] = roots.map((message) => ({
    kind: "tool", message,
    delegate: { items: (children.get(message.toolCallId ?? message.id) ?? [])
      .filter((row) => row.role === "tool" && row.toolName === "TaskExecution")
      .map((message) => ({ kind: "tool", message })) },
  }));
  const statuses = collectDelegationStatuses(tools, { turnLive });
  const timings = collectDelegationTimings(tools);
  const calls = tools.filter(isDelegationActivityItem);
  const latestExecution = new Map<string, string>();
  for (const { message } of calls) {
    const payload = record(toolResultPayload(message));
    const rawId = text(payload.delegationId);
    if (rawId) latestExecution.set(rawId, delegationIdForMessage(message));
  }
  const items = new Map<string, SubagentPresenceItem>();
  for (const { message } of calls) {
    const id = delegationIdForMessage(message);
    const payload = record(toolResultPayload(message));
    const collaboration = record(payload.collaboration);
    const outcome = subagentOutcome(message, statuses);
    const current = rootTurnIds.has(message.id);
    const execution = count(collaboration.execution ?? payload.execution) ?? 0;
    const rawId = text(payload.delegationId);
    const superseded = Boolean(rawId && latestExecution.get(rawId) !== id);
    const creating = delegationIsCreating(message);
    const mayBeLive = (!creating && execution > 0) || (turnLive && current);
    if (outcome === "running" && (superseded || !mayBeLive)) continue;
    if (outcome !== "running" && !current) continue;
    const rows = children.get(message.toolCallId ?? message.id) ?? [];
    const assistants = rows.filter((row) => row.role === "assistant");
    const latestAssistant = assistants.at(-1);
    const realTools = rows.filter(isDelegateToolCall);
    const observedTools = new Set(realTools.map((row) => row.toolCallId || row.id)).size;
    const reportedTools = execution <= 1 ? count(payload.toolCalls) ?? count(collaboration.completedSteps) : null;
    const latest = rows.findLast((row) => row.role === "assistant" || isDelegateToolCall(row));
    const usage = record(payload.executionUsage ?? (execution <= 1 ? payload.usage : undefined));
    const usageRows = assistants.flatMap((row) => row.usage ? [row.usage] : []);
    items.set(id, {
      id, call: message,
      agent: text(payload.agent) || text(latestAssistant?.agentName) || text(record(message.toolArgs).agent),
      status: outcome === "running" && creating ? "queued" : outcome,
      task: delegateTaskDescription(message) || getToolSummary(message.toolName, message.toolArgs),
      detail: text(record(payload.error).message) || text(payload.report) ||
        (latest?.role === "tool"
          ? [latest.toolName, getToolSummary(latest.toolName, latest.toolArgs)].filter(Boolean).join(" · ")
          : text(latest?.content)),
      model: text(latestAssistant?.responseModelId) || text(payload.modelId) || text(latestAssistant?.modelId),
      startedAt: timings.get(id)?.startedAt ?? count(Date.parse(message.createdAt)),
      completedAt: timings.get(id)?.completedAt ?? null,
      toolCalls: observedTools || reportedTools !== null ? Math.max(observedTools, reportedTools ?? 0) : null,
      inputTokens: count(usage.inputTokens) ?? (usageRows.length ? usageRows.reduce((sum, row) => sum + row.inputTokens, 0) : null),
      outputTokens: count(usage.outputTokens) ?? (usageRows.length ? usageRows.reduce((sum, row) => sum + row.outputTokens, 0) : null),
    });
  }
  return [...items.values()].sort((a, b) => Number(isActiveDelegate(b)) - Number(isActiveDelegate(a)));
}

export function presenceMetrics(item: SubagentPresenceItem, now: number) {
  const end = isActiveDelegate(item) ? now : item.completedAt;
  const elapsed = item.startedAt !== null && end !== null ? Math.max(0, end - item.startedAt) : null;
  return { elapsed, speed: elapsed && item.outputTokens !== null ? item.outputTokens * 1000 / elapsed : null };
}
