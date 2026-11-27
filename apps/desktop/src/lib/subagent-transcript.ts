import type { UiMessage } from "@pi-desktop/shared";
import { buildDelegationReply, messageThinking, type SubagentRunItem } from "./assistant-turns";
import { delegationIdForMessage } from "./subagent-panel";
import { isDelegationStartTool } from "./tool-display";
import { toolResultPayload } from "./tool-presentation";

type SubagentTranscriptTurn = {
  call: UiMessage;
  task: string;
  rows: SubagentRunItem[];
  messages: UiMessage[];
};

export function delegateTaskDescription(call: UiMessage): string {
  const args = call.toolArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const input = args as { task?: unknown; instruction?: unknown };
  const task = input.task ?? input.instruction;
  return typeof task === "string" ? task.trim() : "";
}

function resumeTarget(call: UiMessage): string | undefined {
  const args = call.toolArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const input = args as { resume?: unknown; delegationId?: unknown };
  const target = input.resume ?? (call.toolName?.split(".").at(-1) === "TaskResume" ? input.delegationId : undefined);
  return typeof target === "string" ? target.trim() || undefined : undefined;
}

function subagentCalls(messages: readonly UiMessage[], target: string) {
  const groupByAlias = new Map<string, UiMessage[]>();
  let selected: UiMessage | undefined;
  let calls: UiMessage[] = [];
  for (const call of messages) {
    if (call.role !== "tool" || !isDelegationStartTool(call.toolName)) continue;
    const payload = toolResultPayload(call);
    const rawId = payload && typeof payload === "object" && "delegationId" in payload && typeof payload.delegationId === "string"
      ? payload.delegationId : undefined;
    const displayKey = delegationIdForMessage(call);
    const prior = resumeTarget(call);
    const group = (prior && groupByAlias.get(prior)) || (rawId && groupByAlias.get(rawId)) || [];
    group.push(call);
    // 创建中的调用可用调用 ID 定位，待执行结果抵达后仍保持同一选中项。
    if (displayKey === target || call.toolCallId === target || call.id === target) {
      selected = call;
      calls = group;
    }
    for (const alias of [call.id, call.toolCallId, displayKey, rawId]) {
      if (alias) groupByAlias.set(alias, group);
    }
  }
  return { selected, calls };
}

export function hasSubagentHistoryStart(messages: readonly UiMessage[], delegationId: string): boolean {
  const first = subagentCalls(messages, delegationId.trim()).calls[0];
  return Boolean(first && !resumeTarget(first));
}

export function buildSubagentTranscript(messages: readonly UiMessage[], delegationId: string) {
  const { selected, calls } = subagentCalls(messages, delegationId.trim());
  if (!selected) return null;

  const turns: SubagentTranscriptTurn[] = calls.map((call) => ({
    call, task: delegateTaskDescription(call), rows: [], messages: [],
  }));
  const turnsByCallId = new Map(turns.map((turn) => [turn.call.toolCallId || turn.call.id, turn]));
  let agentName: string | undefined;
  for (const message of messages) {
    if (!message.parentToolCallId) continue;
    const turn = turnsByCallId.get(message.parentToolCallId);
    if (!turn) continue;
    agentName ||= message.agentName;
    turn.messages.push(message);
    if (message.role === "tool") {
      turn.rows.push({ kind: "tool", message });
      continue;
    }
    if (messageThinking(message)) turn.rows.push({ kind: "thinking", message });
    if ((message.content || "").trim() || message.error) turn.rows.push({ kind: "answer", message });
  }
  if (!agentName) {
    for (const call of calls) {
      const args = call.toolArgs;
      if (args && typeof args === "object" && "agent" in args && typeof args.agent === "string" && args.agent) {
        agentName = args.agent;
        break;
      }
    }
  }
  const projected = turns.map((turn) => ({ ...turn, reply: buildDelegationReply(turn.call.id, turn.messages) }));
  return { agentName, turns: projected, selectedTurn: projected.find(({ call }) => call === selected) };
}
