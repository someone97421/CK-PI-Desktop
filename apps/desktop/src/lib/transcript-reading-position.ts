import type { UiMessage } from "@pi-desktop/shared";
import { transcriptHasLayout } from "./transcript-scroll";

export type TranscriptReadingPosition = {
  pinned: boolean;
  messageId?: string;
  offset: number;
  /** Outermost entry row, which stays mounted while its process drawer is folded. */
  anchorId?: string;
  anchorOffset?: number;
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

export type TranscriptRevealOwnership = "reading-position" | "pinned" | "retained";

/**
 * Which effect owns a pane reveal. A recorded unpinned bookmark wins over a
 * stale follow flag: follow mode can still read `true` when a send or retry hid
 * the pane, and bottoming there would undo the position the reader is meant to
 * return to (issue #1771).
 */
export function transcriptRevealOwnership(
  bookmark: TranscriptReadingPosition | undefined,
  pending: boolean,
  pinned: boolean,
): TranscriptRevealOwnership {
  if (bookmark?.pinned === false || pending) return "reading-position";
  return pinned ? "pinned" : "retained";
}
export function forgetTranscriptReadingState(sessionId: string) {
  readingStates.delete(sessionId);
}

/** Tail marker of real activity; paging and window reshaping must not change it. */
export function transcriptReadingRevision(messages: readonly UiMessage[]): string | undefined {
  const tail = messages.at(-1);
  if (!tail) return undefined;
  return [
    tail.id,
    tail.createdAt,
    tail.status ?? "",
    tail.toolStatus ?? "",
    tail.content.length,
    tail.thinking?.length ?? 0,
    tail.toolCompletedAt ?? "",
  ].join(":");
}

/** Empty transcripts and historical windows cannot disprove a bookmark; a changed live tail can. */
export function transcriptReadingPositionIsStale(
  position: TranscriptReadingPosition | undefined,
  messages: readonly UiMessage[],
  historical = false,
): boolean {
  if (historical) return false;
  const revision = transcriptReadingRevision(messages);
  return Boolean(
    position?.transcriptRevision && revision && position.transcriptRevision !== revision,
  );
}

const READING_ANCHOR_SELECTOR = "[data-reading-anchor]";

/** 折叠的 details 后代仍可能有布局尺寸，不能仅凭 rect 判断可读性。 */
export function isTranscriptElementShown(element: HTMLElement): boolean {
  if (element.closest?.('[hidden], [inert], [aria-hidden="true"]')) return false;
  let details = element.parentElement?.closest<HTMLDetailsElement>("details:not([open])");
  while (details) {
    if (!details.querySelector(":scope > summary")?.contains(element)) return false;
    details = details.parentElement?.closest<HTMLDetailsElement>("details:not([open])");
  }
  return true;
}

function firstVisibleRow(content: HTMLElement, selector: string, viewport: DOMRect) {
  for (const row of content.querySelectorAll<HTMLElement>(selector)) {
    if (!isTranscriptElementShown(row)) continue;
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= viewport.top || rect.top >= viewport.bottom || rect.height === 0) continue;
    return { row, offset: rect.top - viewport.top };
  }
}

/** Sample only a visible layout; hidden panes must never replace a bookmark. */
export function captureTranscriptReadingPosition(
  scroller: HTMLElement,
  content: HTMLElement,
  pinned: boolean,
  windowSize: number,
  messages: readonly UiMessage[] = [],
  historical = false,
): TranscriptReadingPosition | undefined {
  if (!transcriptHasLayout(scroller)) return;
  const transcriptRevision = historical ? undefined : transcriptReadingRevision(messages);
  if (pinned) return { pinned, offset: 0, scrollTop: scroller.scrollTop, windowSize, transcriptRevision };
  const viewport = scroller.getBoundingClientRect();
  // 优先锚定可见消息本身：翻页前插时回答组的首条消息会变，消息自身的身份与偏移不变。
  // 同时记录条目最外层行：过程抽屉折叠后内层行会卸载，书签恢复回退到外层行。
  const outer = firstVisibleRow(content, READING_ANCHOR_SELECTOR, viewport);
  const anchorId = outer?.row.dataset.readingAnchor;
  const anchor = outer && anchorId ? { anchorId, anchorOffset: outer.offset } : {};
  for (const selector of ["[data-message-id]", "[data-minimap-id]"]) {
    const visible = firstVisibleRow(content, selector, viewport);
    const messageId = visible?.row.dataset.messageId ?? visible?.row.dataset.minimapId;
    if (visible && messageId) return { pinned, messageId, offset: visible.offset, ...anchor,
      scrollTop: scroller.scrollTop, windowSize, transcriptRevision };
  }
  if (outer && anchorId) return { pinned, messageId: anchorId, offset: outer.offset, ...anchor,
    scrollTop: scroller.scrollTop, windowSize, transcriptRevision };
}

function readingPositionCandidates(position: TranscriptReadingPosition): Array<[string, number]> {
  if (!position.messageId) return [];
  const id = CSS.escape(position.messageId);
  const anchorId = CSS.escape(position.anchorId ?? position.messageId);
  return [
    [`[data-message-id="${id}"]`, position.offset],
    [`[data-minimap-id="${id}"]`, position.offset],
    [`[data-reading-anchor="${anchorId}"]`, position.anchorOffset ?? position.offset],
  ];
}

export function isTranscriptReadingAnchorVisible(
  scroller: HTMLElement,
  content: HTMLElement,
  position: TranscriptReadingPosition,
): boolean {
  if (!transcriptHasLayout(scroller)) return false;
  for (const [selector, offset] of readingPositionCandidates(position)) {
    const row = content.querySelector<HTMLElement>(selector);
    const height = row && isTranscriptElementShown(row) ? row.getBoundingClientRect().height : 0;
    if (height > 0) return offset < scroller.clientHeight && offset + height > 0;
  }
  return false;
}

export type TranscriptReadingRestore = "aligned" | "missing" | "unavailable";

/** `unavailable` means no layout yet; `missing` means no anchored row is mounted. */
export function restoreTranscriptReadingPosition(
  scroller: HTMLElement,
  content: HTMLElement,
  position: TranscriptReadingPosition,
): TranscriptReadingRestore {
  if (!transcriptHasLayout(scroller)) return "unavailable";
  if (!position.messageId) {
    if (!Number.isFinite(position.scrollTop) || position.scrollTop < 0) return "missing";
    if (Math.abs(scroller.scrollTop - position.scrollTop) > 0.5) scroller.scrollTop = position.scrollTop;
    return "aligned";
  }
  const candidates = readingPositionCandidates(position);
  let waiting = false;
  for (const [selector, offset] of candidates) {
    const row = content.querySelector<HTMLElement>(selector);
    if (!row || !isTranscriptElementShown(row)) continue;
    const rect = row.getBoundingClientRect();
    if (rect.height === 0) { waiting = true; continue; }
    const delta = rect.top - scroller.getBoundingClientRect().top - offset;
    if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
    return "aligned";
  }
  return waiting ? "unavailable" : "missing";
}
