import type { UiMessage } from "@pi-desktop/shared";
import { transcriptHasLayout } from "./transcript-scroll";

export type TranscriptReadingPosition = {
  pinned: boolean;
  messageId?: string;
  offset: number;
  scrollTop: number;
  windowSize: number;
  /** Tail fingerprint captured with the bookmark; activity after it makes the bookmark stale. */
  transcriptRevision?: string;
};
export type TranscriptDisclosureChoice = { open: boolean; revealRequest?: number };
type ReadingState = {
  position?: TranscriptReadingPosition;
  disclosures: Map<string, TranscriptDisclosureChoice>;
};

// Renderer-lifetime bookmarks, independent of the bounded DOM and message caches.
// No messages, elements, subscriptions, or persisted user data are retained here.
const readingStates = new Map<string, ReadingState>();
export function sessionReadingState(sessionId: string): ReadingState {
  let state = readingStates.get(sessionId);
  if (!state) {
    state = { disclosures: new Map() };
    readingStates.set(sessionId, state);
  }
  return state;
}
export function getTranscriptReadingPosition(sessionId: string | undefined) {
  return sessionId ? readingStates.get(sessionId)?.position : undefined;
}
export function clearTranscriptReadingPosition(sessionId: string | undefined) {
  const state = sessionId ? readingStates.get(sessionId) : undefined;
  if (state) state.position = undefined;
}
export function forgetTranscriptReadingState(sessionId: string) {
  readingStates.delete(sessionId);
}

/** A cheap tail marker: appends, completion and streaming growth all change it. */
export function transcriptReadingRevision(messages: readonly UiMessage[]): string | undefined {
  const tail = messages.at(-1);
  if (!tail) return undefined;
  return [
    messages.length,
    tail.id,
    tail.createdAt,
    tail.status ?? "",
    tail.toolStatus ?? "",
    tail.content.length,
    tail.thinking?.length ?? 0,
    tail.toolCompletedAt ?? "",
  ].join(":");
}

/** Empty/loading transcripts cannot disprove a bookmark; a changed tail can. */
export function transcriptReadingPositionIsStale(
  position: TranscriptReadingPosition | undefined,
  messages: readonly UiMessage[],
): boolean {
  const revision = transcriptReadingRevision(messages);
  return Boolean(
    position?.transcriptRevision && revision && position.transcriptRevision !== revision,
  );
}

/** Sample only a visible layout; hidden panes must never replace a bookmark. */
export function captureTranscriptReadingPosition(
  scroller: HTMLElement,
  content: HTMLElement,
  pinned: boolean,
  windowSize: number,
  messages: readonly UiMessage[] = [],
): TranscriptReadingPosition | undefined {
  if (!transcriptHasLayout(scroller)) return;
  const transcriptRevision = transcriptReadingRevision(messages);
  if (pinned) return { pinned, offset: 0, scrollTop: scroller.scrollTop, windowSize, transcriptRevision };
  const viewport = scroller.getBoundingClientRect();
  // Prefer the outer message/turn: its offset also describes reading inside an
  // expanded tool body, whose explicit disclosure choices survive eviction.
  for (const row of content.querySelectorAll<HTMLElement>("[data-minimap-id], [data-message-id]")) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= viewport.top || rect.top >= viewport.bottom || rect.height === 0) continue;
    const messageId = row.dataset.minimapId ?? row.dataset.messageId;
    if (messageId) return { pinned, messageId, offset: rect.top - viewport.top,
      scrollTop: scroller.scrollTop, windowSize, transcriptRevision };
  }
}

/** Returns false until the bookmarked row is actually mounted. */
export function restoreTranscriptReadingPosition(
  scroller: HTMLElement,
  content: HTMLElement,
  position: TranscriptReadingPosition,
): boolean {
  if (!transcriptHasLayout(scroller) || !position.messageId) return false;
  const id = CSS.escape(position.messageId);
  const row = content.querySelector<HTMLElement>(`[data-minimap-id="${id}"], [data-message-id="${id}"]`);
  if (!row) return false;
  const rect = row.getBoundingClientRect();
  if (rect.height === 0) return false;
  scroller.scrollTop += rect.top - scroller.getBoundingClientRect().top - position.offset;
  return true;
}
