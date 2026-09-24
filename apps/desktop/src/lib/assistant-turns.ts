import type {
  ContextCompactionMark,
  HostedSearchRound,
  MessageUsage,
  UiMessage,
} from "@pi-desktop/shared";
import { hostedSearchRounds } from "@pi-desktop/shared";
import { delegationExecutionKey, isDelegationStartTool } from "./tool-display";
import { toolResultPayload } from "./tool-presentation";

export type AssistantActivityItem =
  | { kind: "thinking"; message: UiMessage }
  | {
      kind: "tool";
      message: UiMessage;
      /** Present on a `Task` call: what the delegate it spawned did. */
      delegate?: SubagentRun;
    }
  | {
      kind: "hostedSearch";
      message: UiMessage;
      /** One provider search round of the message; each round is a row. */
      round: HostedSearchRound;
    };

/** One row a delegate produced, in the order the delegate produced it. */
export type SubagentRunItem =
  | { kind: "thinking"; message: UiMessage }
  | { kind: "tool"; message: UiMessage }
  | { kind: "answer"; message: UiMessage };

/**
 * Everything one delegate did inside a single `Task` call (ADR 0062).
 *
 * Delegate rows arrive on the session stream interleaved with the parent's —
 * parallel delegates guarantee it — so they are collected by the `Task` call
 * that spawned them and rendered under it. That mirrors the model's view: the
 * parent only ever sees the report, never these rows.
 */
export type SubagentRun = {
  /** Definition name, when the runtime attributed the rows to one. */
  agentName?: string;
  items: SubagentRunItem[];
};

export type AssistantTurnPart =
  | { kind: "message"; message: UiMessage }
  | { kind: "compaction"; mark: ContextCompactionMark }
  | {
      kind: "activity";
      items: AssistantActivityItem[];
      endedAt?: string;
    };

export type AssistantTurnEntry = {
  kind: "assistant-turn";
  id: string;
  anchorId?: string;
  parts: AssistantTurnPart[];
  task?: UiMessage["task"];
  sourceMessages?: UiMessage[];
  finalMessageId?: string;
};

export type TranscriptEntry =
  | { kind: "message"; message: UiMessage }
  | { kind: "compaction"; mark: ContextCompactionMark }
  | AssistantTurnEntry;

export function messageThinking(message: UiMessage): string {
  if (typeof message.thinking !== "string") return "";
  return message.thinking.trim() ? message.thinking : "";
}

function isVisibleMessage(message: UiMessage): boolean {
  return !(
    message.role === "assistant" &&
    !(message.content || "").trim() &&
    !messageThinking(message) &&
    !message.hostedSearch &&
    !message.error
  );
}

/** A `Task` start call belongs on the delegation card; parent thinking, workspace
 * tools, and lifecycle rows (TaskWait/TaskList/TaskStop) do not (D319). */
function isDelegationStartActivity(item: AssistantActivityItem): boolean {
  return item.kind === "tool" && isDelegationStartTool(item.message.toolName);
}

/** Delegate rows grouped by the call that produced them. */
function collectSubagentRuns(
  messages: readonly UiMessage[],
): Map<string, SubagentRun> {
  const runs = new Map<string, SubagentRun>();
  for (const message of messages) {
    const parent = message.parentToolCallId;
    if (!parent) continue;
    let run = runs.get(parent);
    if (!run) {
      run = { items: [] };
      runs.set(parent, run);
    }
    if (message.agentName && !run.agentName) run.agentName = message.agentName;
    if (message.role === "tool") {
      run.items.push({ kind: "tool", message });
      continue;
    }
    // A delegate turn can carry reasoning and text at once, and both are worth
    // showing: the text is the only place its narration and report exist.
    const thinking = messageThinking(message);
    if (thinking) run.items.push({ kind: "thinking", message });
    if ((message.content || "").trim() || message.error) {
      run.items.push({ kind: "answer", message });
    }
  }
  return runs;
}

/**
 * The delegation-chain structure of one transcript (ADR 0279).
 *
 * `callByDelegationId` maps each Task result's `delegationId` to the call that
 * returned it; `childOf` links a resumed call to the call it resumed. Shared
 * by the delegation card grouping and the subagent transcript tab so both read
 * the same chain semantics from one place.
 */
export function delegationChainMaps(messages: readonly UiMessage[]): {
  callByDelegationId: Map<string, string>;
  childOf: Map<string, string>;
} {
  const callByDelegationId = new Map<string, string>();
  const childOf = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "tool" || !isDelegationStartTool(message.toolName)) {
      continue;
    }
    const toolCallId = message.toolCallId;
    if (!toolCallId) continue;
    const args = message.toolArgs;
    const input = args && typeof args === "object" && !Array.isArray(args)
      ? args as { resume?: unknown; delegationId?: unknown }
      : null;
    const resume = input?.resume ?? (message.toolName?.split(".").at(-1) === "TaskResume" ? input?.delegationId : undefined);
    const prior = typeof resume === "string" && resume.trim()
      ? callByDelegationId.get(resume.trim())
      : undefined;
    if (prior) childOf.set(prior, toolCallId);
    const payload = toolResultPayload(message);
    const executionId = delegationExecutionKey(payload);
    if (executionId) callByDelegationId.set(executionId, toolCallId);
    if (payload && typeof payload === "object" && "delegationId" in payload && typeof payload.delegationId === "string") {
      callByDelegationId.set(payload.delegationId, toolCallId);
    }
  }
  return { callByDelegationId, childOf };
}

/**
 * Group provider-level assistant fragments and tool rows into user-level turns.
 * Providers end an assistant message before each tool call, but that transport
 * boundary is not a separate conversational response.
 *
 * `compactions` (oldest first) each produce a divider row right after the
 * message they cover, mirroring how the runtime splices its checkpoint entry
 * after the same anchor. A mark whose anchor is no longer in the transcript —
 * rewritten, forked away — has nowhere to sit and is dropped.
 */
export function buildTranscriptEntries(
  messages: UiMessage[],
  compactions: readonly ContextCompactionMark[] = [],
): {
  entries: TranscriptEntry[];
  visible: UiMessage[];
} {
  const runs = collectSubagentRuns(messages);
  // Delegate rows are not transcript rows of their own: they hang off their
  // `Task` call, so they stay out of the turn stream and the minimap.
  const visible = messages.filter(
    (message) => !message.parentToolCallId && isVisibleMessage(message),
  );
  const anchored = new Map<string, ContextCompactionMark[]>();
  for (const mark of compactions) {
    const marks = anchored.get(mark.throughMessageId);
    if (marks) marks.push(mark);
    else anchored.set(mark.throughMessageId, [mark]);
  }
  const entries: TranscriptEntry[] = [];
  const taskRoots = new Map<string, UiMessage>();
  for (const message of messages) {
    if (!message.task) continue;
    const previous = taskRoots.get(message.task.id)?.task;
    if (!previous || (previous.status === "running" && message.task.status !== "running")
      || (previous.status === message.task.status && (message.task.revision ?? 0) >= (previous.revision ?? 0))) {
      taskRoots.set(message.task.id, message);
    }
  }
  const taskTurns = new Map<string, AssistantTurnEntry>();
  const taskSources = new Map<string, UiMessage[]>();
  for (const message of messages) {
    const taskId = message.taskId ?? message.task?.id;
    if (!taskId) continue;
    const source = taskSources.get(taskId) ?? [];
    source.push(message);
    taskSources.set(taskId, source);
  }
  let turn: AssistantTurnEntry | undefined;

  const ensureTurn = (message: UiMessage) => {
    const taskId = message.taskId ?? message.task?.id;
    const root = taskId ? taskRoots.get(taskId) : undefined;
    if (root?.task) {
      const existing = taskTurns.get(root.task.id);
      if (existing) return (turn = existing);
      turn = {
        kind: "assistant-turn",
        id: `task:${root.task.id}`,
        task: root.task,
        sourceMessages: taskSources.get(root.task.id) ?? [],
        parts: [],
      };
      taskTurns.set(root.task.id, turn);
      entries.push(turn);
      return turn;
    }
    if (turn?.task) turn = undefined;
    if (turn) return turn;
    turn = {
      kind: "assistant-turn",
      id: message.id,
      parts: [],
    };
    entries.push(turn);
    return turn;
  };

  const pushActivity = (item: AssistantActivityItem) => {
    const current = ensureTurn(item.message);
    const last = current.parts[current.parts.length - 1];
    // A delegation card is only the Task fan-out. Mixing the parent's later
    // Read/Grep/thinking into that group painted them as subagent work (D319).
    if (
      last?.kind === "activity" &&
      last.items.length > 0 &&
      isDelegationStartActivity(last.items[0]) === isDelegationStartActivity(item)
    ) {
      last.items.push(item);
      return;
    }
    current.parts.push({ kind: "activity", items: [item] });
  };

  const appendMessage = (message: UiMessage) => {
    if (message.role === "user" && message.steering && message.taskId && taskRoots.has(message.taskId)) {
      ensureTurn(message).parts.push({ kind: "message", message });
      return;
    }
    if (message.role === "user" || message.role === "system") {
      turn = undefined;
      entries.push({ kind: "message", message });
      if (message.role === "user" && message.task) ensureTurn(message);
      return;
    }

    if (message.role === "tool") {
      const delegate = message.toolCallId
        ? runs.get(message.toolCallId)
        : undefined;
      pushActivity({
        kind: "tool",
        message,
        ...(delegate ? { delegate } : {}),
      });
      return;
    }

    const current = ensureTurn(message);
    const thinking = messageThinking(message);
    if (thinking) pushActivity({ kind: "thinking", message });
    for (const round of hostedSearchRounds(message.hostedSearch)) {
      pushActivity({ kind: "hostedSearch", message, round });
    }
    if ((message.content || "").trim() || !thinking || message.error) {
      current.parts.push({ kind: "message", message });
      if (!current.anchorId && (message.content || "").trim()) {
        current.anchorId = message.id;
      }
    }
  };

  for (const message of visible) {
    appendMessage(message);
    const marks = anchored.get(message.id);
    if (!marks) continue;
    const currentTask = taskTurns.get(message.taskId ?? message.task?.id ?? "");
    if (currentTask) {
      for (const mark of marks) currentTask.parts.push({ kind: "compaction", mark });
      continue;
    }
    // The row is a divider, so whatever turn it lands inside ends there and the
    // next assistant fragment opens a new one.
    turn = undefined;
    for (const mark of marks) entries.push({ kind: "compaction", mark });
  }

  for (const entry of entries) {
    if (entry.kind !== "assistant-turn") continue;
    if (entry.task?.status === "completed") {
      // A terminal status alone does not turn narration preceding a tool into
      // a final delivery. Only the last main-agent output can be that answer.
      const last = entry.task.finalMessageId
        ? entry.sourceMessages?.find((message) => message.id === entry.task?.finalMessageId)
        : entry.sourceMessages?.filter((message) =>
          !message.parentToolCallId && (message.role === "assistant" || message.role === "tool"),
        ).at(-1);
      if (last?.role === "assistant" && last.status === "complete" && !last.error && last.content?.trim()) {
        entry.finalMessageId = last.id;
        entry.anchorId = last.id;
      }
    }
    for (let index = 0; index < entry.parts.length; index += 1) {
      const part = entry.parts[index];
      const next = entry.parts[index + 1];
      if (
        part.kind === "activity" &&
        next?.kind === "message" &&
        !part.items.some((item) => item.message.id === next.message.id)
      ) {
        part.endedAt = next.message.createdAt;
      }
    }
  }

  return { entries, visible };
}

/**
 * Whether two delegate runs render the same rows.
 *
 * `buildTranscriptEntries` rebuilds run objects on every message change, so
 * memoized activity groups cannot compare them by identity; without this a
 * delegate's rows would either never update or re-render on every tick.
 */
export function subagentRunsEqual(
  previous: SubagentRun | undefined,
  next: SubagentRun | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  if (
    previous.agentName !== next.agentName ||
    previous.items.length !== next.items.length
  ) {
    return false;
  }
  return previous.items.every(
    (item, index) =>
      item.kind === next.items[index].kind &&
      item.message === next.items[index].message,
  );
}

export function reuseReadonlyMap<K, V>(
  previous: ReadonlyMap<K, V> | undefined,
  next: ReadonlyMap<K, V>,
  valuesEqual: (left: V, right: V) => boolean = Object.is,
): ReadonlyMap<K, V> {
  if (!previous || previous.size !== next.size) return next;
  for (const [key, value] of next) {
    if (!previous.has(key) || !valuesEqual(previous.get(key) as V, value)) {
      return next;
    }
  }
  return previous;
}

function reuseActivityItem(
  previous: AssistantActivityItem | undefined,
  next: AssistantActivityItem,
): AssistantActivityItem {
  if (!previous || previous.kind !== next.kind || previous.message !== next.message) {
    return next;
  }
  if (previous.kind === "tool" && next.kind === "tool") {
    if (subagentRunsEqual(previous.delegate, next.delegate)) return previous;
    if (!next.delegate || !previous.delegate) return next;
    const items = next.delegate.items.map((item, index) => {
      const prior = previous.delegate?.items[index];
      return prior && prior.kind === item.kind && prior.message === item.message
        ? prior
        : item;
    });
    const delegate =
      previous.delegate.agentName === next.delegate.agentName &&
      previous.delegate.items.length === items.length &&
      items.every((item, index) => item === previous.delegate!.items[index])
        ? previous.delegate
        : { ...next.delegate, items };
    return delegate === previous.delegate ? previous : { ...next, delegate };
  }
  return previous;
}

function reuseTurnPart(
  previous: AssistantTurnPart | undefined,
  next: AssistantTurnPart,
): AssistantTurnPart {
  if (!previous || previous.kind !== next.kind) return next;
  if (previous.kind === "compaction" && next.kind === "compaction") {
    return previous.mark === next.mark ? previous : next;
  }
  if (previous.kind === "message" && next.kind === "message") {
    return previous.message === next.message ? previous : next;
  }
  if (previous.kind === "activity" && next.kind === "activity") {
    if (previous.endedAt !== next.endedAt) {
      const items = next.items.map((item, index) =>
        reuseActivityItem(previous.items[index], item),
      );
      return { ...next, items };
    }
    const items = next.items.map((item, index) =>
      reuseActivityItem(previous.items[index], item),
    );
    if (
      items.length === previous.items.length &&
      items.every((item, index) => item === previous.items[index])
    ) {
      return previous;
    }
    return { ...next, items };
  }
  return next;
}

function reuseTranscriptEntry(
  previous: TranscriptEntry | undefined,
  next: TranscriptEntry,
): TranscriptEntry {
  if (!previous || previous.kind !== next.kind) return next;
  if (previous.kind === "message" && next.kind === "message") {
    return previous.message === next.message ? previous : next;
  }
  if (previous.kind === "compaction" && next.kind === "compaction") {
    return previous.mark === next.mark ||
      (previous.mark.id === next.mark.id &&
        previous.mark.throughMessageId === next.mark.throughMessageId &&
        previous.mark.generation === next.mark.generation &&
        previous.mark.summaryTokens === next.mark.summaryTokens &&
        previous.mark.summarized === next.mark.summarized &&
        previous.mark.fallback === next.mark.fallback)
      ? previous
      : next;
  }
  if (previous.kind === "assistant-turn" && next.kind === "assistant-turn") {
    if (previous.id !== next.id) return next;
    const parts = next.parts.map((part, index) =>
      reuseTurnPart(previous.parts[index], part),
    );
    if (
      previous.anchorId === next.anchorId &&
      previous.task === next.task &&
      previous.finalMessageId === next.finalMessageId &&
      previous.sourceMessages?.length === next.sourceMessages?.length &&
      (next.sourceMessages ?? []).every((message, index) => message === previous.sourceMessages?.[index]) &&
      parts.length === previous.parts.length &&
      parts.every((part, index) => part === previous.parts[index])
    ) {
      return previous;
    }
    return { ...next, parts };
  }
  return next;
}

/**
 * Keep object identity for unchanged transcript rows so memoized activity
 * groups can bail out when only the live tail token changed.
 */
export function reuseTranscriptEntries(
  previous: readonly TranscriptEntry[] | undefined,
  next: TranscriptEntry[],
): TranscriptEntry[] {
  if (!previous || previous.length === 0) return next;
  const shared = next.map((entry, index) =>
    reuseTranscriptEntry(previous[index], entry),
  );
  if (
    shared.length === previous.length &&
    shared.every((entry, index) => entry === previous[index])
  ) {
    return previous as TranscriptEntry[];
  }
  return shared;
}

export function assistantTurnMessages(
  entry: AssistantTurnEntry,
): UiMessage[] {
  return entry.parts.flatMap((part) =>
    part.kind === "message" ? [part.message] : [],
  );
}

/**
 * The rows these entries actually render, in transcript order.
 *
 * The minimap resolves a click by finding the marker's `data-minimap-id` node in
 * the scroller, so it must be built from the mounted entries rather than from
 * every loaded message (D261). Fed the full set while the transcript window
 * withholds older rows, it would draw dashes whose click target does not exist
 * and jump nowhere.
 */
export function transcriptEntryMessages(
  entries: readonly TranscriptEntry[],
): UiMessage[] {
  return entries.flatMap((entry) => {
    if (entry.kind === "message") return [entry.message];
    if (entry.kind === "assistant-turn") return assistantTurnMessages(entry);
    return [];
  });
}

export function assistantTurnTools(entry: AssistantTurnEntry): UiMessage[] {
  return entry.parts.flatMap((part) =>
    part.kind === "activity"
      ? part.items.flatMap((item) =>
          item.kind === "tool" ? [item.message] : [],
        )
      : [],
  );
}

export function assistantTurnResponseDuration(
  entry: AssistantTurnEntry,
): number | undefined {
  if (entry.task) {
    const start = Date.parse(entry.task.startedAt ?? "");
    const end = Date.parse(entry.task.endedAt ?? "");
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
  }
  const durations = assistantTurnMessages(entry).flatMap((message) =>
    typeof message.responseDurationMs === "number" &&
    Number.isFinite(message.responseDurationMs) &&
    message.responseDurationMs > 0
      ? [message.responseDurationMs]
      : [],
  );
  if (durations.length === 0) return undefined;
  return durations.reduce((total, duration) => total + duration, 0);
}

export function assistantTurnResponseOutputTokens(
  entry: AssistantTurnEntry,
): number | undefined {
  const counts = assistantTurnMessages(entry).flatMap((message) => {
    const value = message.usage?.outputTokens ?? message.responseOutputTokens;
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? [value]
      : [];
  });
  if (counts.length === 0) return undefined;
  return counts.reduce((total, count) => total + count, 0);
}

export function assistantTurnResponseOutputIsEstimated(
  entry: AssistantTurnEntry,
): boolean {
  return assistantTurnMessages(entry).some(
    (message) =>
      (!message.usage || message.usage.outputTokens <= 0) &&
      typeof message.responseOutputTokens === "number" &&
      message.responseOutputTokens > 0,
  );
}

export function assistantTurnContent(entry: AssistantTurnEntry): string {
  return assistantTurnMessages(entry)
    .map((message) => (message.content || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

export function assistantTurnUsage(
  entry: AssistantTurnEntry,
): MessageUsage | undefined {
  if (entry.task) return entry.task.usage;
  const usages = assistantTurnMessages(entry).flatMap((message) =>
    message.usage ? [message.usage] : [],
  );
  if (usages.length === 0) return undefined;

  const sum = (field: keyof MessageUsage) =>
    usages.reduce((total, usage) => total + (usage[field] ?? 0), 0);
  const optionalSum = (
    field: "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens",
  ) =>
    usages.some((usage) => usage[field] !== undefined) ? sum(field) : undefined;
  const cacheReadTokens = optionalSum("cacheReadTokens");
  const cacheWriteTokens = optionalSum("cacheWriteTokens");
  const reasoningTokens = optionalSum("reasoningTokens");

  return {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    totalTokens: sum("totalTokens"),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}
