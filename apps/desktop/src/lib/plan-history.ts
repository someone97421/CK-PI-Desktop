import type { PlanHistoryEntry, PlanProposal, UiMessage } from "@pi-desktop/shared";

/** Only host-owned submission tools carry contract snapshots. */
export function planSubmission(message: UiMessage): PlanProposal | undefined {
  if (message.role !== "tool" || !["SubmitPlan", "SubmitGoal"].includes(message.toolName ?? "")) return;
  if (message.planHistory) return message.planHistory.proposal;
  const result = message.toolResult as { details?: { proposal?: PlanProposal } } | undefined;
  const proposal = result?.details?.proposal;
  return proposal && proposal.toolCallId === message.toolCallId &&
    typeof proposal.id === "string" && typeof proposal.markdown === "string" &&
    typeof proposal.title === "string" ? proposal : undefined;
}

/** Stale reads/terminal tool echoes must not roll back a newer host revision. */
export function preservePlanHistory(message: UiMessage, previous?: UiMessage): UiMessage {
  const old = previous?.planHistory;
  const next = message.planHistory;
  if (!old || message.toolCallId !== previous?.toolCallId || message.toolName !== previous?.toolName) return message;
  if (next && next.proposal.id !== old.proposal.id) return message;
  const proposal = !next || old.proposal.version > next.proposal.version ||
    (old.proposal.version === next.proposal.version && old.proposal.updatedAt > next.proposal.updatedAt)
    ? old.proposal : next.proposal;
  const superseded = old.superseded || !!next?.superseded;
  if (next?.proposal === proposal && next.superseded === superseded) return message;
  return { ...message, planHistory: { proposal, superseded } };
}

export function projectPlanHistory(
  messages: UiMessage[], entries: readonly PlanHistoryEntry[], sessionId: string,
): UiMessage[] {
  if (!entries.length) return messages;
  const byCall = new Map(entries.filter(entry => entry.proposal.sessionId === sessionId)
    .map(entry => [entry.proposal.toolCallId, entry]));
  let changed = false;
  const next = messages.map(message => {
    if (message.role !== "tool" || !["SubmitPlan", "SubmitGoal"].includes(message.toolName ?? "")) return message;
    const entry = byCall.get(message.toolCallId ?? "");
    const current = message.planHistory;
    // A new submission supersedes only the same kind, never a Goal with a Plan.
    const superseded = current && entries.some(({ proposal }) =>
      proposal.sessionId === sessionId && proposal.kind === current.proposal.kind &&
      proposal.id !== current.proposal.id && proposal.createdAt >= current.proposal.createdAt);
    const projected = entry ? preservePlanHistory({ ...message, planHistory: entry }, message)
      : superseded && !current.superseded ? { ...message, planHistory: { ...current, superseded: true } }
      : message;
    if (projected !== message) changed = true;
    return projected;
  });
  return changed ? next : messages;
}
