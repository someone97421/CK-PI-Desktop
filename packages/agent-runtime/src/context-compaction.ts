/**
 * Shared context-compaction primitives (ADR 0049).
 *
 * The main runtime and a delegate spend the same context window under the same
 * provider rules, so the budget numbers, the shape of a checkpoint, the summary
 * request and its failure handling are defined once here instead of twice.
 * Both callers keep their own policy on top of these primitives: the session
 * runtime persists a checkpoint into the transcript (`ContextCompactionRecord`),
 * a delegate holds its checkpoint in memory for the rest of the run.
 */

import {
  BACKGROUND_CONTEXT,
  compact,
  estimateContextTokens,
  estimateTokens,
  withAbortSignal,
  type AgentMessage,
  type AgentTool,
  type CompactionPreparation,
  type FileOperations,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models, UserMessage } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@pi-desktop/shared";
import { assistantContent } from "./agent-messages.js";
import { withCompactionRequestHeaders } from "./compaction-request.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  type RuntimeProviderConfig,
} from "./provider-binding.js";
import { clampThinkingLevel } from "./thinking-level.js";

import {
  COMPACTION_SUMMARY_RETRY_POLICY,
  estimateSummaryPromptTokens,
} from "./compaction-summary-input.js";
/**
 * Tokens held back from the context window for the summary prompt and the
 * model's own output. Compaction thresholds are derived from the active model's
 * window rather than configured, and this floor reproduces the reserve that
 * used to be the default setting, so the hard safety boundary is unchanged.
 */
export const COMPACTION_RESERVE_FLOOR_TOKENS = 16_384;
/**
 * Retained-tail target as a share of the safe budget, bounded so a 32K window
 * still keeps a usable tail and a 1M window does not carry the whole session
 * forward. A single fixed token count cannot serve both.
 */
export const COMPACTION_KEEP_RECENT_RATIO = 0.2;
export const COMPACTION_MIN_KEEP_RECENT_TOKENS = 8_000;
export const COMPACTION_MAX_KEEP_RECENT_TOKENS = 64_000;
/**
 * Cap on the user messages carried across a compaction boundary, matching
 * Codex's `COMPACT_USER_MESSAGE_MAX_TOKENS`. Clamped against the safe budget so
 * a small model window is not filled by retention alone.
 */
export const COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS = 20_000;
export const COMPACTION_FALLBACK_KEEP_RECENT_RATIO = 0.25;
export const COMPACTION_FALLBACK_MAX_SUMMARY_CHARS = 12_000;
export const COMPACTION_SUMMARY_PROMPT_SAFETY_TOKENS = 2_048;
export const COMPACTION_FALLBACK_MARKER =
  "[automatic context recovery: older context was omitted after summary generation failed]";
/** Stored in place of a carried-forward summary when a fallback had none. */
export const COMPACTION_FALLBACK_NO_SUMMARY =
  "No previous context checkpoint is available.";

const CHECKPOINT_TRUNCATION_MARKER =
  "\n\n[checkpoint truncated: this message crossed the retained context budget]\n\n";

/**
 * Context thresholds derived from the active model's window.
 *
 * `hardLimit` is the safety boundary: the next provider request must not be
 * issued while the context is at or above it. Compaction happens inline at that
 * boundary, the way Codex does it — there is no off-critical-path variant.
 */
export type ContextBudget = {
  /** Estimated tokens in the reconstructed model context. */
  tokens: number;
  /** Point where an uncompacted provider request is no longer allowed. */
  hardLimit: number;
  /** Tokens reserved for the request's own prompt and output. */
  requestHeadroom: number;
  /** Approximate recent-context tokens a checkpoint should retain. */
  keepRecentTokens: number;
};

export type CompactionRetentionMode = "active_turn" | "completed_turn";

/**
 * A pi preparation plus the anchor the checkpoint is filed against.
 *
 * pi 0.84 dropped `firstKeptEntryId` from `CompactionPreparation`: the
 * compaction entry it writes *is* the boundary, so nothing needs to name the
 * first kept entry. We still record ours — it becomes
 * `ContextCompactionRecord.firstKeptMessageId`, which is persisted and reported
 * on `compaction_end` — so the Codex-shaped reshape carries it alongside pi's
 * fields. A delegate has no durable entries and leaves it unset.
 */
export type ShapedPreparation = CompactionPreparation & {
  firstKeptEntryId?: string;
};

/**
 * A retained-tail fallback stores any carried-forward summary ahead of the
 * recovery notice, separated by `COMPACTION_FALLBACK_MARKER` (see
 * `createFallbackCheckpointPlan`). Only the notice is synthetic: the text before
 * the marker is the real summary the failed compaction was carrying forward.
 * Strip the notice — and the "no previous summary" placeholder — so the next
 * summarization rebuilds from that real summary instead of updating a notice
 * that never was a summary (#224), without discarding the history it carried.
 */
export function stripCompactionFallbackNotice(
  summary: string | undefined,
): string | undefined {
  if (!summary) return undefined;
  const markerIndex = summary.indexOf(COMPACTION_FALLBACK_MARKER);
  if (markerIndex === -1) return summary;
  const carried = summary.slice(0, markerIndex).trim();
  if (carried.length === 0 || carried === COMPACTION_FALLBACK_NO_SUMMARY) {
    return undefined;
  }
  return carried;
}

function boundedText(value: string, maxChars: number): string {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  const marker = "\n\n[context recovery summary shortened]\n\n";
  const available = Math.max(2, maxChars - marker.length);
  const headChars = Math.ceil(available / 2);
  const tailChars = Math.floor(available / 2);
  return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`;
}

export function truncateTextForCheckpoint(
  text: string,
  maxChars: number,
): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= CHECKPOINT_TRUNCATION_MARKER.length) {
    return CHECKPOINT_TRUNCATION_MARKER.trim().slice(0, maxChars);
  }
  const retainedChars = maxChars - CHECKPOINT_TRUNCATION_MARKER.length;
  const headChars = Math.ceil(retainedChars * 0.75);
  const tailChars = retainedChars - headChars;
  return `${text.slice(0, headChars)}${CHECKPOINT_TRUNCATION_MARKER}${
    tailChars > 0 ? text.slice(-tailChars) : ""
  }`;
}

/**
 * Flatten a user message to plain text so it can be truncated at a token
 * budget. Images and other non-text blocks are named rather than kept: a
 * checkpoint that carried them would spend its whole budget on one of them.
 */
function userMessageTextForCheckpoint(message: UserMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) =>
      block.type === "text"
        ? block.text
        : `[${block.type} content omitted from checkpoint]`,
    )
    .join("\n");
}

function truncateUserMessageForCheckpoint(
  message: UserMessage,
  tokenBudget: number,
): UserMessage {
  return {
    ...message,
    content: truncateTextForCheckpoint(
      userMessageTextForCheckpoint(message),
      Math.max(1, tokenBudget) * 4,
    ),
  };
}

/**
 * Choose the user messages that survive a compaction boundary: newest first up
 * to `maxTokens`, truncating the one that crosses the budget instead of
 * dropping it, then restored to the order the candidates were given in. This is
 * Codex's `build_compacted_history_with_limit` selection, so a caller orders
 * `candidates` by ascending retention priority — the last one is kept first.
 */
export function selectRetainedUserMessages(
  candidates: readonly UserMessage[],
  maxTokens: number,
): UserMessage[] {
  const selected: UserMessage[] = [];
  let remaining = Math.max(0, maxTokens);
  for (let index = candidates.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = candidates[index];
    const tokens = estimateTokens(message);
    if (tokens <= remaining) {
      selected.push(message);
      remaining -= tokens;
      continue;
    }
    selected.push(truncateUserMessageForCheckpoint(message, remaining));
    break;
  }
  return selected.reverse();
}

/**
 * System-prompt and tool-definition tokens the provider charges on top of
 * `messages` for every request.
 *
 * A caller that owns an agent context passes this: nothing in the transcript
 * accounts for the prompt and the tool catalog, and on a small window a wide
 * tool list is a material share of it.
 */
export function estimatePromptOverheadTokens(
  systemPrompt: string,
  tools: readonly AgentTool[],
): number {
  let chars = systemPrompt.length;
  for (const tool of tools) {
    chars += tool.name.length + tool.label.length + (tool.description?.length ?? 0);
    try {
      chars += JSON.stringify(tool.parameters ?? {}).length;
    } catch {
      // A non-serializable schema is a caller bug; the tool's own length still counts.
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * The budget the next request is measured against.
 *
 * `promptOverheadTokens` is counted only while the transcript carries no
 * provider usage: once an assistant message reports usage, the window that
 * measured already includes the prompt and the tools, and counting them again
 * would compact early. A caller that omits it — the session runtime — keeps the
 * previous numbers exactly.
 */
export function computeContextBudget(input: {
  messages: readonly AgentMessage[];
  /** Active model window; falls back to the runtime default. */
  contextWindow?: number;
  /** Active model output cap; clamped to a share of the window. */
  maxTokens?: number;
  promptOverheadTokens?: number;
}): ContextBudget {
  const contextWindow = Math.max(
    1,
    Math.round(input.contextWindow || DEFAULT_CONTEXT_WINDOW),
  );
  const modelOutputBudget = Math.min(
    Math.max(1, Math.round(input.maxTokens || DEFAULT_MAX_TOKENS)),
    Math.max(1, Math.floor(contextWindow * 0.25)),
  );
  const reserveFloor = Math.min(
    COMPACTION_RESERVE_FLOOR_TOKENS,
    Math.max(1, Math.floor(contextWindow * 0.5)),
  );
  const requestHeadroom = Math.min(
    contextWindow - 1,
    Math.max(reserveFloor, modelOutputBudget, Math.ceil(contextWindow * 0.05)),
  );
  const hardLimit = Math.max(1, contextWindow - requestHeadroom);
  const keepRecentTokens = Math.min(
    Math.max(
      COMPACTION_MIN_KEEP_RECENT_TOKENS,
      Math.min(
        COMPACTION_MAX_KEEP_RECENT_TOKENS,
        Math.floor(hardLimit * COMPACTION_KEEP_RECENT_RATIO),
      ),
    ),
    Math.max(1, Math.floor(hardLimit * 0.5)),
  );
  const estimate = estimateContextTokens([...input.messages]);
  const overhead =
    estimate.lastUsageIndex === null
      ? Math.max(0, Math.round(input.promptOverheadTokens ?? 0))
      : 0;
  return {
    tokens: estimate.tokens + overhead,
    hardLimit,
    requestHeadroom,
    keepRecentTokens,
  };
}

/**
 * Cap on the active user message a checkpoint carries forward. Codex uses a
 * flat 20k; the clamp keeps a small model window from being filled by
 * retention alone, which would leave the summary no room.
 */
export function retainedUserMessageBudget(budget: ContextBudget): number {
  return Math.max(
    1,
    Math.min(
      COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS,
      Math.floor(budget.hardLimit * 0.5),
    ),
  );
}

/**
 * Reshape a pi preparation the way Codex compacts:
 *
 * - Everything pi would have split across `messagesToSummarize`,
 *   `turnPrefixMessages` and `retainedTail` is summarized as one range. The
 *   three are contiguous and ordered, so concatenating them loses nothing —
 *   and it is what makes dropping the tail safe: no message leaves the model
 *   context without the summary covering it.
 * - The retained tail is rebuilt from the user messages the caller allows
 *   through, so a completed turn retains none — its summary is authoritative,
 *   and the next prompt becomes the sole new instruction after the checkpoint.
 *   Dropping assistant messages also drops their `toolCall` blocks, and their
 *   results go with them in the same pass, so no orphaned tool call can reach a
 *   provider.
 * - `firstKeptEntryId` points at the anchor the checkpoint is filed against. It
 *   is ours, not pi's (see `ShapedPreparation`).
 */
export function shapeCheckpointPreparation(
  preparation: CompactionPreparation,
  options: {
    /** Durable anchor of the checkpoint, when the caller has session entries. */
    firstKeptEntryId?: string;
    /**
     * User messages eligible to survive the boundary, in ascending retention
     * priority: the last candidate is kept first.
     */
    retentionCandidates?: readonly UserMessage[];
    /** Token cap for those messages. */
    retainedUserTokens: number;
  },
): ShapedPreparation {
  // pi 0.84 replays a previous checkpoint's `retainedTail` as virtual entries
  // at the head of the compactable range, so those messages already arrive in
  // `preparation` — prepending them again (which is what this had to do while
  // pi walked back to `firstKeptEntryId` instead) would duplicate every one.
  const messagesToSummarize = [
    ...preparation.messagesToSummarize,
    ...preparation.turnPrefixMessages,
    ...preparation.retainedTail,
  ];
  return {
    ...preparation,
    ...(options.firstKeptEntryId !== undefined
      ? { firstKeptEntryId: options.firstKeptEntryId }
      : {}),
    messagesToSummarize,
    turnPrefixMessages: [],
    isSplitTurn: false,
    retainedTail: selectRetainedUserMessages(
      options.retentionCandidates ?? [],
      options.retainedUserTokens,
    ),
  };
}

export function userMessagesOf(
  messages: readonly AgentMessage[],
): UserMessage[] {
  return messages.filter((message): message is UserMessage => message.role === "user");
}

/**
 * Retention candidates for a delegate: the newest instruction first, then the
 * delegation brief that defines the whole task, then older instructions.
 *
 * A delegate is always mid-task — there is no next user prompt to re-state the
 * work — so the newest instruction and the original brief have to survive the
 * boundary; everything else can live in the summary. `selectRetainedUserMessages`
 * keeps candidates from the end, so the order here is ascending priority.
 */
export function subagentRetentionCandidates(
  messages: readonly AgentMessage[],
): UserMessage[] {
  const users = userMessagesOf(messages);
  const latest = users.at(-1);
  if (!latest) return [];
  const brief = users[0];
  if (brief === latest) return [latest];
  return [...users.slice(1, -1), brief, latest];
}

/**
 * Files touched by a transcript, in the shape pi's checkpoint metadata uses.
 * A delegate has no session entries for pi to walk, so its summary would carry
 * no file list at all without this.
 */
export function fileOpsFromMessages(
  messages: readonly AgentMessage[],
): FileOperations {
  const fileOps: FileOperations = {
    read: new Set<string>(),
    written: new Set<string>(),
    edited: new Set<string>(),
  };
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const args = block.arguments as { path?: unknown } | undefined;
      const path = typeof args?.path === "string" ? args.path.trim() : "";
      if (!path) continue;
      if (block.name === "Read") fileOps.read.add(path);
      else if (block.name === "Write") fileOps.written.add(path);
      else if (block.name === "Edit") fileOps.edited.add(path);
    }
  }
  return fileOps;
}

/**
 * Prepare a linear transcript for a checkpoint: every message is summarized and
 * the retained tail is re-derived by `shapeCheckpointPreparation`.
 *
 * The session runtime goes through pi's entry-based `prepareCompaction` and
 * lands on the same shape; a delegate owns no durable entries, so the same
 * preparation is built directly here rather than inventing synthetic ones.
 */
export function prepareLinearCheckpointPreparation(input: {
  messages: readonly AgentMessage[];
  previousSummary?: string;
  fileOps: FileOperations;
  budget: ContextBudget;
}): CompactionPreparation {
  return {
    messagesToSummarize: [...input.messages],
    turnPrefixMessages: [],
    retainedTail: [],
    isSplitTurn: false,
    tokensBefore: input.budget.tokens,
    ...(input.previousSummary ? { previousSummary: input.previousSummary } : {}),
    fileOps: input.fileOps,
    settings: {
      enabled: true,
      reserveTokens: input.budget.requestHeadroom,
      keepRecentTokens: input.budget.keepRecentTokens,
    },
  };
}

/**
 * Whether the summary request itself would cross the summary model's window.
 *
 * The summary is issued by the selected summary model, so the request this
 * guard predicts has to be measured against that model's own window and output
 * budget, not the session model's. pi-agent-core caps the summary output at 80%
 * of the preparation's reserve — the session model's request headroom, which
 * stays the ceiling — so the summary model's own `maxTokens` can only lower it.
 * A caller that follows the session model reproduces the previous numbers
 * exactly: a compatible candidate's window is never smaller.
 *
 * When this returns true the caller must not issue the request at all: a
 * delegate with a huge tool output and a small fallback window falls back to a
 * retained-tail checkpoint instead of sending an oversized prompt.
 */
export function compactionSummaryWouldExceedBudget(
  preparation: Pick<
    CompactionPreparation,
    "messagesToSummarize" | "previousSummary"
  > & {
    turnPrefixMessages?: readonly AgentMessage[];
    isSplitTurn?: boolean;
  },
  budget: Pick<ContextBudget, "hardLimit" | "requestHeadroom">,
  summaryModel: Pick<Model<Api>, "contextWindow" | "maxTokens">,
): boolean {
  const contextWindow = Math.max(
    budget.hardLimit + budget.requestHeadroom,
    Math.max(
      1,
      Math.round(summaryModel.contextWindow || DEFAULT_CONTEXT_WINDOW),
    ),
  );
  const modelOutputBudget = Math.min(
    Math.floor(budget.requestHeadroom * 0.8),
    Math.max(1, Math.round(summaryModel.maxTokens || DEFAULT_MAX_TOKENS)),
  );
  const summaryInputLimit = Math.max(
    1,
    contextWindow - modelOutputBudget - COMPACTION_SUMMARY_PROMPT_SAFETY_TOKENS,
  );
  return (
    estimateSummaryPromptTokens({
      messagesToSummarize: preparation.messagesToSummarize as AgentMessage[],
      turnPrefixMessages: (preparation.turnPrefixMessages as AgentMessage[]) ?? [],
      isSplitTurn: Boolean(preparation.isSplitTurn),
      previousSummary: preparation.previousSummary,
    }) >= summaryInputLimit
  );
}

/**
 * The retained-tail recovery: a checkpoint whose summary is the one the failed
 * attempt was carrying forward, plus a notice that the automatic summary did
 * not complete.
 *
 * The recovery path retains less than a normal checkpoint — its summary is a
 * carried-forward one rather than a fresh one, so the retained messages are the
 * only thing that has to fit. It issues no provider request at all, which is
 * what makes it available when the summary request cannot fit the window.
 */
export function createFallbackCheckpointPlan(input: {
  preparation: ShapedPreparation;
  maxSummaryChars: number;
  retentionMode: CompactionRetentionMode;
}): { summary: string; retainedTail: AgentMessage[] } {
  const previousSummary = input.preparation.previousSummary
    ? boundedText(
        input.preparation.previousSummary,
        Math.min(COMPACTION_FALLBACK_MAX_SUMMARY_CHARS, input.maxSummaryChars),
      )
    : COMPACTION_FALLBACK_NO_SUMMARY;
  const continuation =
    input.retentionMode === "active_turn"
      ? "The provider is continuing the active turn. Use the one retained latest user request as the source of truth for that continuation."
      : "The previous turn is complete. Treat this summary as historical context; the next user message is the only new task to execute.";
  const summary = [
    previousSummary,
    COMPACTION_FALLBACK_MARKER,
    "The automatic summary request did not complete. Older messages before this checkpoint are omitted from the next model request.",
    `The complete transcript remains available in the session. ${continuation}`,
  ].join("\n\n");
  // A completed-turn checkpoint normally retains no naked user messages, but an
  // empty tail plus a carried-forward (or absent) summary leaves the next model
  // request with nothing before the boundary: after a runtime rebuild — model
  // switch, restart — the session restores as if it had just started. Fall back
  // to the newest user messages under the same budget so the failure path still
  // restores a bounded, non-empty context (#224).
  const retainedTail =
    input.preparation.retainedTail.length > 0
      ? input.preparation.retainedTail
      : selectRetainedUserMessages(
          userMessagesOf(input.preparation.messagesToSummarize),
          input.preparation.settings.keepRecentTokens,
        );
  return { summary, retainedTail };
}

/**
 * pi's `compact` accepts any summary the provider returned except an
 * `aborted`/`error` one, so a response cut off at the output limit — or an empty
 * one — would be installed as the whole checkpoint and the summarized history
 * would be gone with it. This turns those responses into the error path
 * `compact` already handles, so the caller keeps its original context and takes
 * its own recovery path instead.
 *
 * A caller with no provider-independent fallback (the session runtime, which
 * also has the fallback marker and its own retained-tail checkpoint) leaves this
 * off; a delegate — whose only context is the one in memory — turns it on.
 */
export function requireCompleteSummaryModels(models: Models): Models {
  const completeSimple: Models["completeSimple"] = async (
    model,
    context,
    options,
  ) => {
    const response = await models.completeSimple(model, context, options);
    const content = assistantContent(response.content);
    if (
      response.stopReason === "error" ||
      response.stopReason === "length" ||
      !content.hasText ||
      !content.text.trim()
    ) {
      return {
        ...response,
        stopReason: "error",
        errorMessage:
          response.stopReason === "length"
            ? "summarization request was cut off at the model's output limit"
            : "summarization request produced no summary",
      };
    }
    return response;
  };
  return new Proxy(models, {
    get: (target, property, receiver) =>
      property === "completeSimple"
        ? completeSimple
        : Reflect.get(target, property, receiver),
  });
}

/**
 * Issue the summary request.
 *
 * pi-agent-core builds this request's options itself and never reaches an
 * agent's `streamFn`, so the headers ride on the collection — and they must be
 * the summary provider's, not the caller's.
 */
export async function generateCompactionSummary(input: {
  preparation: CompactionPreparation;
  /** Provider issuing the request. */
  provider: RuntimeProviderConfig;
  /** Registry built for that provider. */
  models: Models;
  model: Model<Api>;
  /** Session id the summary reaches the same gateway backend with. */
  sessionId: string;
  /** Omitted means the request carries no reasoning setting (the omit path). */
  thinkingLevel?: ThinkingLevel;
  signal: AbortSignal;
  /** Reject an empty or output-truncated summary (delegate policy). */
  requireCompleteSummary?: boolean;
}): Promise<Awaited<ReturnType<typeof compact>>> {
  const models = withCompactionRequestHeaders(
    input.models,
    input.provider,
    input.sessionId,
  );
  return compact(
    input.preparation,
    input.requireCompleteSummary
      ? requireCompleteSummaryModels(models)
      : models,
    input.model,
    undefined,
    input.thinkingLevel,
    COMPACTION_SUMMARY_RETRY_POLICY,
    undefined,
    withAbortSignal(input.signal, BACKGROUND_CONTEXT),
  );
}

/**
 * The thinking selection a summary request uses for a provider: the session's
 * own level, clamped to what the provider supports. `undefined` means the
 * request carries no reasoning setting at all.
 */
export function compactionThinkingLevel(
  provider: RuntimeProviderConfig,
  requested: ThinkingLevel | "omit",
): ThinkingLevel | undefined {
  const level = clampThinkingLevel(provider, requested);
  return requested === "omit" || level === "omit" ? undefined : level;
}
