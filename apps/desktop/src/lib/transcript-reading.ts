import type { SessionDetail, UiMessage } from "@pi-desktop/shared";
import { dedupeSessionMessages } from "./session-transcript";

export type TranscriptSearchTarget = {
  sessionId: string;
  messageId: string;
  query: string;
  requestId: number;
};

/** One renderer reading range, shared by ordinary history and search navigation. */
export type TranscriptView = {
  messages: UiMessage[];
  messageStart: number;
  messageEnd?: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  parentMessage?: UiMessage;
  focus: TranscriptSearchTarget | null;
  loading: "target" | "before" | "after" | null;
};

export const EMPTY_TRANSCRIPT: UiMessage[] = [];
export const TRANSCRIPT_PAGE_SIZE = 100;
export const TRANSCRIPT_SEARCH_PAGE_SIZE = 60;
export const TRANSCRIPT_CONTENT_LIMIT = 64 * 1024;

export function transcriptViewFromSession(
  session: SessionDetail,
  focus: TranscriptSearchTarget | null = null,
): TranscriptView {
  return {
    messages: session.messages,
    messageStart: session.messageStart ?? 0,
    messageEnd: session.messageEnd,
    hasMoreBefore: session.hasMoreBefore === true,
    hasMoreAfter: session.hasMoreAfter === true,
    parentMessage: session.navigationParent,
    focus,
    loading: null,
  };
}

/**
 * 阅读窗口可能同时保留旧提问和最新页，中间并不连续。以共同消息为边界
 * 合并各段，只在段内交织缺失消息；不按时间全局排序，以免打乱工具记录
 * 的原始顺序。相同时间优先保留 first 的位置，同 ID 的字段由 second 更新。
 */
function mergeReadingMessages(first: UiMessage[], second: UiMessage[]): UiMessage[] {
  const left = dedupeSessionMessages(first);
  const right = dedupeSessionMessages(second);
  const values = new Map(dedupeSessionMessages([...left, ...right]).map((message) =>
    [message.id, message]));
  const rightPositions = new Map(right.map((message, index) => [message.id, index]));
  const merged: UiMessage[] = [];
  const used = new Set<string>();
  const push = (message: UiMessage) => {
    if (used.has(message.id)) return;
    used.add(message.id);
    merged.push(values.get(message.id)!);
  };
  let leftStart = 0;
  let rightStart = 0;
  const mergeUntil = (leftEnd: number, rightEnd: number) => {
    while (leftStart < leftEnd && rightStart < rightEnd) {
      if (Date.parse(right[rightStart].createdAt) < Date.parse(left[leftStart].createdAt)) {
        push(right[rightStart++]);
      } else {
        push(left[leftStart++]);
      }
    }
    while (leftStart < leftEnd) push(left[leftStart++]);
    while (rightStart < rightEnd) push(right[rightStart++]);
  };
  for (let index = 0; index < left.length; index++) {
    const anchor = rightPositions.get(left[index].id);
    if (anchor === undefined || anchor < rightStart) continue;
    mergeUntil(index, anchor);
    push(left[index]);
    leftStart = index + 1;
    rightStart = anchor + 1;
  }
  mergeUntil(left.length, right.length);
  return merged;
}

/** Live output remains authoritative outside an explicit historical search. */
export function transcriptViewMessages(live: UiMessage[], view?: TranscriptView): UiMessage[] {
  if (!view) return live;
  const messages = view.focus
    ? view.messages
    : mergeReadingMessages(view.messages, live);
  const parent = view.parentMessage;
  if (!parent) return messages;
  const index = messages.findIndex((message) => message.id === parent.id);
  if (index < 0) return [parent, ...messages];
  if (messages[index] === parent) return messages;
  // A neighboring page may contain an earlier physical copy of the Task.
  return messages.map((message) => (message.id === parent.id ? parent : message));
}

export function extendTranscriptView(
  view: TranscriptView,
  session: SessionDetail,
  direction: "before" | "after",
): TranscriptView {
  const messages = direction === "before"
    ? mergeReadingMessages(session.messages, view.messages)
    : mergeReadingMessages(view.messages, session.messages);
  const focused = view.messages.find((message) => message.id === view.focus?.messageId);
  if (focused) messages[messages.findIndex((message) => message.id === focused.id)] = focused;
  return {
    ...view,
    messages,
    messageStart: Math.min(view.messageStart, session.messageStart ?? 0),
    messageEnd: Math.max(view.messageEnd ?? 0, session.messageEnd ?? 0),
    hasMoreBefore: direction === "before" ? session.hasMoreBefore === true : view.hasMoreBefore,
    hasMoreAfter: direction === "after" ? session.hasMoreAfter === true : view.hasMoreAfter,
    loading: null,
  };
}

/** Hydrating or appending is safe; a canonical rewrite invalidates older snapshots. */
export function transcriptWasRewritten(previous: UiMessage[], next: UiMessage[]): boolean {
  const current = new Map(next.map((message) => [message.id, message]));
  return previous.some((message) => {
    const replacement = current.get(message.id);
    return (
      !replacement ||
      replacement.content !== message.content ||
      replacement.activeRevision !== message.activeRevision
    );
  });
}
