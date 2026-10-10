import type { UiMessage } from "@pi-desktop/shared";
import type { SubagentDirectoryEntry } from "./subagent-persistence.js";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 从普通会话结果中读取轻量任务目录；不重建模型上下文，也不重放工具。 */
export function subagentResultsFromHistory(messages: readonly UiMessage[]): Map<string, SubagentDirectoryEntry> {
  const entries = new Map<string, SubagentDirectoryEntry>();
  const rank = { running: 0, interrupted: 1, completed: 2, failed: 3, revoked: 4 };
  for (const message of messages) {
    if (message.role !== "tool" || !["Task", "TaskExecution"].includes(message.toolName ?? "")) continue;
    let details: unknown = object(message.toolResult) ? message.toolResult.details : undefined;
    if (!object(details)) {
      try { details = JSON.parse(message.content ?? ""); } catch { continue; }
    }
    if (!object(details) || typeof details.delegationId !== "string" || !Number.isSafeInteger(details.execution)) continue;
    const execution = Number(details.execution);
    if (execution < 1) continue;
    const status = details.status === "stopped" || details.status === "revoked" ? "revoked"
      : details.status === "completed" ? "completed" : details.status === "failed" ? "failed" : "interrupted";
    const previous = entries.get(details.delegationId);
    if (previous && (previous.execution > execution || (previous.execution === execution && rank[previous.status] > rank[status]))) continue;
    const report = typeof details.report === "string" && details.report.length > 0 ? details.report
      : previous?.execution === execution ? previous.lastReportSummary ?? "" : "";
    const task = typeof details.task === "string" ? details.task
      : object(message.toolArgs) && typeof message.toolArgs.task === "string" ? message.toolArgs.task : previous?.taskInstruction;
    const persistenceState = status === "completed" ? "pending-validation" : status;
    entries.set(details.delegationId, {
      sessionId: typeof details.sessionId === "string" ? details.sessionId : "",
      delegationId: details.delegationId, execution, executionId: typeof details.executionId === "string" ? details.executionId : "",
      revision: 0, snapshotGeneration: 0, status, canResume: false, source: "disk",
      persistenceState, durableState: persistenceState, taskInstruction: task,
      agentName: typeof details.agent === "string" ? details.agent : message.agentName ?? previous?.agentName,
      modelId: typeof details.modelId === "string" ? details.modelId : previous?.modelId,
      parentToolCallId: typeof details.parentToolCallId === "string" ? details.parentToolCallId : message.parentToolCallId ?? message.toolCallId,
      updatedAt: typeof details.completedAt === "number" ? details.completedAt : Date.parse(message.createdAt) || 0,
      lastReportSummary: report,
      lastResult: { status, report, turns: Number(details.turns) || 0, toolCalls: Number(details.toolCalls) || 0 },
    });
  }
  return entries;
}
