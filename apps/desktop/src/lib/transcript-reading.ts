import type { SessionDetail, UiMessage } from "@pi-desktop/shared";
import { dedupeSessionMessages, upsertLiveSessionMessage } from "./session-transcript";
import {
  getSessionMessageSnapshot,
  registerSessionMessageReplacement,
  registerSessionMessageReplacements,
  type SessionMessageSnapshot,
} from "./session-transcript-updates";

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

type ReadingProjection = {
  source: SessionMessageSnapshot;
  messages: UiMessage[];
};

// One current projection per reading view/live owner, not a linked generation
// history. Replacing/evicting a view releases its cache. A new live owner or
// structural edit takes the full merge path; skipped renders compare blocks.
const readingProjections = new WeakMap<TranscriptView, WeakMap<object, ReadingProjection>>();

function withNavigationParent(messages: UiMessage[], parent?: UiMessage): UiMessage[] {
  if (!parent) return messages;
  const snapshot = getSessionMessageSnapshot(messages);
  const index = snapshot.positions.get(parent.id);
  if (index === undefined) return [parent, ...messages];
  if (messages[index] === parent) return messages;
  // A neighboring page may contain an earlier physical copy of the Task.
  if (!snapshot.unique) return messages.map((message) => message.id === parent.id ? parent : message);
  const next = messages.slice();
  next[index] = parent;
  return registerSessionMessageReplacement(messages, next, index);
}

function replaceReadingOverlap(
  cached: ReadingProjection,
  source: SessionMessageSnapshot,
  parent?: UiMessage,
): UiMessage[] | undefined {
  if (!source.unique || source.positions !== cached.source.positions) return undefined;
  if (source === cached.source) return cached.messages;
  const output = getSessionMessageSnapshot(cached.messages);
  let next: UiMessage[] | undefined;
  const changed: number[] = [];
  for (let blockIndex = 0; blockIndex < source.blocks.length; blockIndex++) {
    const block = source.blocks[blockIndex];
    const previous = cached.source.blocks[blockIndex];
    if (block === previous) continue;
    for (let index = 0; index < block.length; index++) {
      const message = block[index];
      if (message === previous[index]) continue;
      // Timestamp corrections can move live-only rows across the durable
      // window. Content/status/role updates cannot change that merge ordering.
      if (message.createdAt !== previous[index].createdAt) return undefined;
      if (parent && message.id === parent.id) continue;
      const position = output.positions.get(message.id);
      if (position === undefined) return undefined;
      if (cached.messages[position] === message) continue;
      next ??= cached.messages.slice();
      next[position] = message;
      changed.push(position);
    }
  }
  return next ? registerSessionMessageReplacements(cached.messages, next, changed) : cached.messages;
}

/** Live output remains authoritative outside an explicit historical search. */
export function transcriptViewMessages(live: UiMessage[], view?: TranscriptView): UiMessage[] {
  if (!view) return live;
  // Search deliberately holds its historical snapshot. Do not index or merge
  // the live transcript when it cannot contribute anything to this view.
  if (view.focus) return withNavigationParent(view.messages, view.parentMessage);

  const normalized = dedupeSessionMessages(live);
  const source = getSessionMessageSnapshot(normalized);
  let projections = readingProjections.get(view);
  if (!projections) {
    projections = new WeakMap();
    readingProjections.set(view, projections);
  }
  const cached = projections.get(source.owner);
  let messages = cached && replaceReadingOverlap(cached, source, view.parentMessage);
  if (!messages) {
    messages = withNavigationParent(
      mergeReadingMessages(view.messages, normalized),
      view.parentMessage,
    );
    getSessionMessageSnapshot(messages);
  }
  projections.set(source.owner, { source, messages });
  return messages;
}

export function extendTranscriptView(
  view: TranscriptView,
  session: SessionDetail,
  direction: "before" | "after",
): TranscriptView {
  const merged = direction === "before"
    ? mergeReadingMessages(session.messages, view.messages)
    : mergeReadingMessages(view.messages, session.messages);
  const focused = view.messages.find((message) => message.id === view.focus?.messageId);
  const messages = focused ? upsertLiveSessionMessage(merged, focused) : merged;
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
