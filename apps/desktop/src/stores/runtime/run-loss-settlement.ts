import type { UiMessage } from "@pi-desktop/shared";
import { settleStoppedAssistantMetrics } from "../../lib/context-usage";
import type { AppState } from "../app-state";

/** 本地执行端失联后的展示收尾。助手与工具行记为 error，不伪造取消回执。 */
export type LocalRunLossSettlement = Partial<
  Pick<
    AppState,
    | "isRunning"
    | "runningSessions"
    | "agentStatuses"
    | "pendingPermissions"
    | "pendingAsks"
    | "messages"
    | "retainedTranscripts"
  >
>;

function interruptRows(rows: UiMessage[]): { rows: UiMessage[]; changed: boolean } {
  let changed = false;
  const next = rows.map((message) => {
    if (message.role === "assistant" && message.status === "streaming") {
      changed = true;
      return {
        ...settleStoppedAssistantMetrics(message, Date.now()),
        status: "error" as const,
        isError: true,
      };
    }
    if (message.role === "tool" && message.toolStatus === "running") {
      changed = true;
      return {
        ...message,
        toolStatus: "error" as const,
        status: "error" as const,
        isError: true,
        toolCompletedAt: message.toolCompletedAt ?? new Date().toISOString(),
      };
    }
    return message;
  });
  return { rows: next, changed };
}

function withoutKeys<T>(record: Record<string, T>, keys: Set<string>): Record<string, T> {
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
}

/** 调用方提供受影响的本地会话；没有需要收尾的状态时返回空补丁。 */
export function settleLocalRunLoss(
  state: Pick<
    AppState,
    | "activeSessionId"
    | "isRunning"
    | "runningSessions"
    | "agentStatuses"
    | "pendingPermissions"
    | "pendingAsks"
    | "messages"
    | "retainedTranscripts"
  >,
  sessionIds: string[],
): LocalRunLossSettlement {
  const lost = new Set(
    sessionIds.filter(
      (id) =>
        state.runningSessions[id] === true ||
        state.agentStatuses[id] !== undefined ||
        state.activeSessionId === id,
    ),
  );
  if (lost.size === 0) return {};

  const patch: LocalRunLossSettlement = {};
  if (sessionIds.some((id) => state.runningSessions[id] === true)) {
    patch.runningSessions = { ...state.runningSessions };
    for (const id of sessionIds) {
      if (state.runningSessions[id] === true) patch.runningSessions[id] = false;
    }
  }
  if (sessionIds.some((id) => state.agentStatuses[id] !== undefined)) {
    patch.agentStatuses = withoutKeys(state.agentStatuses, lost);
  }
  const withoutSession = <T>(queues: Record<string, T>) => {
    if (!sessionIds.some((id) => queues[id] !== undefined)) return queues;
    return withoutKeys(queues, new Set(sessionIds));
  };
  const pendingPermissions = withoutSession(state.pendingPermissions);
  if (pendingPermissions !== state.pendingPermissions) patch.pendingPermissions = pendingPermissions;
  const pendingAsks = withoutSession(state.pendingAsks);
  if (pendingAsks !== state.pendingAsks) patch.pendingAsks = pendingAsks;

  if (state.activeSessionId !== undefined && lost.has(state.activeSessionId)) {
    if (state.isRunning) patch.isRunning = false;
    const interrupted = interruptRows(state.messages);
    if (interrupted.changed) patch.messages = interrupted.rows;
  }
  let retainedTranscripts = state.retainedTranscripts;
  for (const id of lost) {
    if (id === state.activeSessionId) continue;
    const rows = retainedTranscripts[id];
    if (!rows) continue;
    const interrupted = interruptRows(rows);
    if (interrupted.changed && retainedTranscripts === state.retainedTranscripts) {
      retainedTranscripts = { ...state.retainedTranscripts };
    }
    if (interrupted.changed) retainedTranscripts[id] = interrupted.rows;
  }
  if (retainedTranscripts !== state.retainedTranscripts) {
    patch.retainedTranscripts = retainedTranscripts;
  }
  return patch;
}
