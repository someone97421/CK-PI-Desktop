import type { UiMessage } from "@pi-desktop/shared";

export type SessionTimingMessage = Pick<
  UiMessage,
  "role" | "responseDurationMs" | "parentToolCallId" | "nestedParentToolCallId" | "status" | "createdAt"
>;

export type SessionTimingPage = {
  messages?: SessionTimingMessage[];
  messageStart?: number;
  hasMoreBefore?: boolean;
};

export type SessionTiming = {
  elapsedMs: number;
  modelResponseMs: number;
  modelResponsePercent?: number;
};

const SESSION_TIMING_PAGE_SIZE = 1_000;
const SESSION_TIMING_CONTENT_LIMIT = 256;

/** Sum completed top-level model responses. Delegate calls can overlap. */
export function sumModelResponseDuration(
  messages: readonly SessionTimingMessage[],
): number {
  return messages.reduce((total, message) => {
    if (
      message.role !== "assistant" ||
      message.parentToolCallId ||
      message.nestedParentToolCallId
    ) {
      return total;
    }
    const duration = message.responseDurationMs;
    return typeof duration === "number" && Number.isFinite(duration) && duration > 0
      ? total + duration
      : total;
  }, 0);
}

/**
 * Read earlier transcript pages for the response durations omitted from the
 * renderer's bounded transcript window. The callback keeps this helper
 * independent of the IPC transport and easy to test.
 */
export async function loadEarlierModelResponseDuration(
  messageBefore: number,
  readPage: (options: {
    messageBefore: number;
    messageLimit: number;
    contentLimit: number;
  }) => Promise<SessionTimingPage | null>,
  signal?: AbortSignal,
): Promise<number> {
  let before = messageBefore;
  let total = 0;

  while (before > 0) {
    if (signal?.aborted) return total;
    const page = await readPage({
      messageBefore: before,
      messageLimit: SESSION_TIMING_PAGE_SIZE,
      contentLimit: SESSION_TIMING_CONTENT_LIMIT,
    });
    if (signal?.aborted) return total;
    if (!page) throw new Error("Session timing history is unavailable");

    total += sumModelResponseDuration(page.messages ?? []);
    if (page.hasMoreBefore !== true) return total;

    const nextBefore = page.messageStart;
    if (
      typeof nextBefore !== "number" ||
      !Number.isInteger(nextBefore) ||
      nextBefore < 0 ||
      nextBefore >= before
    ) {
      throw new Error("Session timing history did not advance");
    }
    before = nextBefore;
  }

  return total;
}

export function calculateSessionTiming({
  createdAt,
  updatedAt,
  isRunning,
  messages,
  now,
  earlierModelResponseMs = 0,
  activeModelRequestStartedAt,
}: {
  createdAt: string;
  updatedAt: string;
  isRunning: boolean;
  messages: readonly SessionTimingMessage[];
  now: number;
  earlierModelResponseMs?: number;
  activeModelRequestStartedAt?: number;
}): SessionTiming | undefined {
  const startedAt = Date.parse(createdAt);
  if (!Number.isFinite(startedAt)) return undefined;

  const updatedAtMs = Date.parse(updatedAt);
  const endedAt = isRunning || !Number.isFinite(updatedAtMs) ? now : updatedAtMs;
  const elapsedMs = Math.max(0, endedAt - startedAt);
  const streamingMessageStartedAt = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        !message.parentToolCallId &&
        !message.nestedParentToolCallId &&
        message.status === "streaming",
    )?.createdAt;
  const streamingStartedAt = streamingMessageStartedAt
    ? Date.parse(streamingMessageStartedAt)
    : Number.NaN;
  const activeStartedAt = Number.isFinite(activeModelRequestStartedAt)
    ? activeModelRequestStartedAt
    : streamingStartedAt;
  const activeModelResponseMs =
    isRunning &&
    typeof activeStartedAt === "number" &&
    Number.isFinite(activeStartedAt)
      ? Math.max(0, now - activeStartedAt)
      : 0;
  const modelResponseMs =
    Math.max(0, earlierModelResponseMs) +
    sumModelResponseDuration(messages) +
    activeModelResponseMs;

  return {
    elapsedMs,
    modelResponseMs,
    modelResponsePercent:
      elapsedMs > 0 ? Math.round((modelResponseMs / elapsedMs) * 100) : undefined,
  };
}
