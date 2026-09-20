import type { AppSettings, UiMessage } from "@pi-desktop/shared";
import type { AssistantTurnEntry, AssistantTurnPart } from "./assistant-turns";

type ThinkingDisplayMode = NonNullable<AppSettings["thinkingDisplayMode"]>;

export function resolveThinkingDisplayMode(value: unknown): ThinkingDisplayMode {
  return value === "compact" ? "compact" : "detailed";
}

export function isThinkingActive(message: UiMessage, active: boolean): boolean {
  return active && message.status === "streaming" && !message.content.trim();
}

export function isTurnThinking(
  parts: readonly AssistantTurnPart[],
  active: boolean,
): boolean {
  const latestPart = parts.at(-1);
  const latestActivity =
    latestPart?.kind === "activity" ? latestPart.items.at(-1) : undefined;
  return (
    latestActivity?.kind === "thinking" &&
    isThinkingActive(latestActivity.message, active)
  );
}

export function processContainsMessage(
  parts: readonly AssistantTurnPart[],
  messageId: string,
): boolean {
  return parts.some((part) => {
    if (part.kind === "compaction") return false;
    if (part.kind === "message") return part.message.id === messageId;
    return part.items.some((item) => {
      if (item.message.id === messageId) return true;
      return (
        item.kind === "tool" &&
        Boolean(item.delegate?.items.some((row) => row.message.id === messageId))
      );
    });
  });
}

export function hasFailedProcessTool(parts: readonly AssistantTurnPart[]): boolean {
  return parts.some(
    (part) =>
      part.kind === "activity" &&
      part.items.some(
        (item) =>
          item.kind === "tool" &&
          (item.message.toolStatus === "error" ||
            item.message.toolStatus === "denied" ||
            item.message.isError),
      ),
  );
}

/** Compact groups a turn into one process disclosure; detailed does not. */
export function shouldGroupTurnProcess(mode: ThinkingDisplayMode): boolean {
  return mode === "compact";
}

/** The last activity chunk of a turn owns detailed-mode's default-open tool. */
export function isLastActivityPart(
  parts: readonly AssistantTurnPart[],
  part: AssistantTurnPart,
): boolean {
  if (part.kind !== "activity") return false;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index].kind === "activity") return parts[index] === part;
  }
  return false;
}

/** Compact process stays collapsed unless an active tool failed. */
export function shouldAutoOpenTurnProcess(
  mode: ThinkingDisplayMode,
  isActive: boolean,
  hasToolFailure: boolean,
): boolean {
  return mode === "compact" && isActive && hasToolFailure;
}

/**
 * 工具前的文字属于过程。任务完成后，保留以最终回复结尾的连续正文，
 * 避免子任务报告触发的补充回复把完整总结收进抽屉；思考不截断正文，
 * 工具执行和用户输入则构成边界。旧记录继续使用末尾回复与错误展示。
 */
export function projectTurnProcess(entry: AssistantTurnEntry) {
  if (entry.task) {
    const finalIndex = entry.task.status === "completed" && entry.finalMessageId
      ? entry.parts.findIndex((part) => part.kind === "message"
        && part.message.id === entry.finalMessageId)
      : -1;
    const responses: Extract<AssistantTurnPart, { kind: "message" }>[] = [];
    for (let index = finalIndex; index >= 0; index -= 1) {
      const part = entry.parts[index];
      if (part.kind === "activity") {
        if (part.items.some((item) => item.kind === "tool")) break;
      } else if (part.kind === "message") {
        if (part.message.role !== "assistant" || part.message.status !== "complete"
          || part.message.error) break;
        if (part.message.content.trim()) responses.push(part);
      }
    }
    responses.reverse();
    const responseParts = new Set<AssistantTurnPart>(responses);
    return { process: entry.parts.filter((part) => !responseParts.has(part)), responses };
  }
  const last = entry.parts.at(-1);
  const answer =
    last?.kind === "message" &&
    last.message.role === "assistant" &&
    last.message.content.trim()
      ? last
      : undefined;
  const process: AssistantTurnPart[] = [];
  const responses: Extract<AssistantTurnPart, { kind: "message" }>[] = [];
  for (const part of entry.parts) {
    if (part.kind === "message" && (part === answer || part.message.error)) {
      responses.push(part);
    } else {
      process.push(part);
    }
  }
  return { process, responses };
}

export function visibleProcessSteps(
  parts: readonly AssistantTurnPart[],
  mode: ThinkingDisplayMode,
  active: boolean,
): number {
  let count = 0;
  for (const part of parts) {
    if (part.kind === "compaction") continue;
    if (part.kind === "message") {
      if (part.message.content.trim()) count += 1;
      continue;
    }
    for (const item of part.items) {
      // Between provider streams the turn is still active but the last
      // reasoning row is complete; keep its process shell through that wait.
      if (
        item.kind === "tool" ||
        mode === "detailed" ||
        (active && item.kind === "thinking" && !item.message.content.trim())
      ) {
        count += 1;
      }
    }
  }
  return count;
}

/** Use recorded message/tool timing for history; elapsed live time is UI-only. */
export function turnProcessTiming(parts: readonly AssistantTurnPart[]) {
  const messages = parts.flatMap((part) => {
    if (part.kind === "compaction") return [];
    return part.kind === "message" ? [part.message] : part.items.map((item) => item.message);
  });
  const starts = messages
    .map((message) => Date.parse(message.createdAt))
    .filter(Number.isFinite);
  if (starts.length === 0) return { startedAt: undefined, endedAt: undefined };
  const startedAt = Math.min(...starts);
  const endedAt = Math.max(
    startedAt,
    ...messages.map((message) => {
      const createdAt = Date.parse(message.createdAt);
      if (!Number.isFinite(createdAt)) return startedAt;
      const duration =
        message.role === "tool" ? message.toolDurationMs : message.responseDurationMs;
      const recordedEnd = Date.parse(message.toolCompletedAt ?? "");
      return Number.isFinite(recordedEnd)
        ? recordedEnd
        : createdAt +
            (typeof duration === "number" && Number.isFinite(duration)
              ? Math.max(0, duration)
              : 0);
    }),
  );
  return { startedAt, endedAt };
}
