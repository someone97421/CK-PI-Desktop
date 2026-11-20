import type { MessageUsage, UiMessage } from "@pi-desktop/shared";
import type { AssistantActivityItem, AssistantTurnEntry, AssistantTurnPart } from "./assistant-turns";
import { assistantTurnResponseDuration } from "./assistant-turns";
import { projectAssistantCommentary } from "./assistant-commentary";

const contentFacts = new WeakMap<UiMessage, { trimmedContent: string; hasContent: boolean }>();

/** Renderer snapshots are immutable; a same-id replacement is a new cache key. */
export function messageContentFacts(message: UiMessage) {
  let facts = contentFacts.get(message);
  if (!facts) {
    const trimmedContent = (message.content || "").trim();
    facts = { trimmedContent, hasContent: Boolean(trimmedContent) };
    contentFacts.set(message, facts);
  }
  return facts;
}

export type AssistantTurnSummary = {
  messages: UiMessage[];
  tools: UiMessage[];
  activityItems: AssistantActivityItem[];
  toolItems: Extract<AssistantActivityItem, { kind: "tool" }>[];
  generatedImages: UiMessage[];
  actionMessage?: UiMessage;
  metaMessage?: UiMessage;
  latestUsageMessage?: UiMessage;
  usage?: MessageUsage;
  responseDurationMs?: number;
  responseOutputTokens?: number;
  responseOutputEstimated: boolean;
  hasError: boolean;
  streaming: boolean;
  hasContent: boolean;
  process: AssistantTurnPart[];
  responses: Extract<AssistantTurnPart, { kind: "message" }>[];
  lastActivityPart?: AssistantTurnPart;
};

const summaries = new WeakMap<AssistantTurnEntry, AssistantTurnSummary>();

function taskResponseParts(entry: AssistantTurnEntry): Set<AssistantTurnPart> {
  const responses = new Set<AssistantTurnPart>();
  if (entry.task?.status !== "completed" || !entry.finalMessageId) return responses;
  const finalIndex = entry.parts.findIndex((part) => part.kind === "message" && part.message.id === entry.finalMessageId);
  for (let index = finalIndex; index >= 0; index -= 1) {
    const part = entry.parts[index];
    if (part.kind === "activity" && part.items.some((item) => item.kind === "tool")) break;
    if (part.kind !== "message") continue;
    const { role, status, error } = part.message;
    if (role !== "assistant" || status !== "complete" || error) break;
    if (messageContentFacts(part.message).hasContent) responses.add(part);
  }
  return responses;
}

/**
 * Share content facts between the transcript and composer without joining the
 * reply on a stream tick. A changed turn still scans references/metadata, not
 * old text. Key by the immutable entry so task metadata and compaction parts
 * remain consistent in deferred and retained panes.
 */
export function getAssistantTurnSummary(entry: AssistantTurnEntry): AssistantTurnSummary {
  const cached = summaries.get(entry);
  if (cached) return cached;
  const result: AssistantTurnSummary = {
    messages: [], tools: [], activityItems: [], toolItems: [], generatedImages: [],
    responseOutputEstimated: false, hasError: false, streaming: false,
    hasContent: false, process: [], responses: [],
  };
  const finalTaskParts = entry.task ? taskResponseParts(entry) : undefined;
  const last = entry.parts.at(-1);
  const answer = last?.kind === "message" && last.message.role === "assistant" && messageContentFacts(last.message).hasContent
    ? last : undefined;
  for (const part of entry.parts) {
    if (part.kind === "compaction") {
      result.process.push(part);
      continue;
    }
    if (part.kind === "activity") {
      result.process.push(part);
      result.lastActivityPart = part;
      for (const item of part.items) {
        result.activityItems.push(item);
        if (item.kind !== "tool") continue;
        result.toolItems.push(item);
        result.tools.push(item.message);
        if (item.message.toolName === "GenerateImages") result.generatedImages.push(item.message);
      }
      continue;
    }
    const message = part.message;
    result.messages.push(message);
    const projection = projectAssistantCommentary(message);
    if (projection) result.process.push(...projection.progress);
    const reply = projection?.reply ?? part;
    const hasReply = messageContentFacts(reply.message).hasContent;
    const isResponse = finalTaskParts ? finalTaskParts.has(part) && hasReply : part === answer || message.error;
    if (!projection || hasReply || message.error || message.outputTruncated) {
      if (isResponse) result.responses.push(reply);
      else result.process.push(reply);
    }
    if (message.role === "assistant" && hasReply && (!finalTaskParts || isResponse)) {
      result.actionMessage = reply.message;
      result.hasContent = true;
    }
    if (message.modelId || message.usage || message.responseDurationMs || message.responseOutputTokens) {
      result.metaMessage = message;
    }
    result.hasError ||= Boolean(message.error);
    result.streaming ||= message.status === "streaming";
    const duration = message.responseDurationMs;
    if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
      result.responseDurationMs = (result.responseDurationMs ?? 0) + duration;
    }
    const output = message.usage?.outputTokens ?? message.responseOutputTokens;
    if (typeof output === "number" && Number.isFinite(output) && output > 0) {
      result.responseOutputTokens = (result.responseOutputTokens ?? 0) + output;
    }
    result.responseOutputEstimated ||= (!message.usage || message.usage.outputTokens <= 0) &&
      typeof message.responseOutputTokens === "number" && message.responseOutputTokens > 0;
    if (message.usage) {
      result.latestUsageMessage = message;
      const usage = result.usage ??= { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      usage.inputTokens += message.usage.inputTokens ?? 0;
      usage.outputTokens += message.usage.outputTokens ?? 0;
      usage.totalTokens += message.usage.totalTokens ?? 0;
      for (const key of ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
        if (message.usage[key] !== undefined) usage[key] = (usage[key] ?? 0) + (message.usage[key] ?? 0);
      }
    }
  }
  if (entry.task) {
    result.usage = entry.task.usage;
    result.responseDurationMs = assistantTurnResponseDuration(entry);
  }
  summaries.set(entry, result);
  return result;
}

/** Do not retain duplicated reply text in the session-wide projection cache. */
export function getAssistantTurnContent(entry: AssistantTurnEntry): string {
  const summary = getAssistantTurnSummary(entry);
  if (entry.task) return summary.responses.map((part) => part.message.content).join("\n\n");
  return summary.messages
    .map((message) => messageContentFacts(projectAssistantCommentary(message)?.reply.message ?? message).trimmedContent)
    .filter(Boolean)
    .join("\n\n");
}

/** Preserve a derived input when only unrelated text/thinking items changed. */
export function reuseReferences<T>(previous: readonly T[] | undefined, next: T[]): T[] {
  if (previous === next) return next;
  return previous && previous.length === next.length && previous.every((item, index) => item === next[index])
    ? previous as T[] : next;
}
