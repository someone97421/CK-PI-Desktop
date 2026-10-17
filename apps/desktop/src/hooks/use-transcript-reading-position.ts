import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { UiMessage } from "@pi-desktop/shared";
import {
  captureTranscriptReadingPosition,
  clearTranscriptReadingPosition,
  getTranscriptReadingPosition,
  restoreTranscriptReadingPosition,
  sessionReadingState,
  transcriptReadingPositionIsStale,
  type TranscriptReadingPosition,
} from "../lib/transcript-reading-position";

export type RestoreTranscriptReading = (
  position: TranscriptReadingPosition,
  signal: AbortSignal,
) => Promise<boolean>;

const NO_MESSAGES: readonly UiMessage[] = [];
const transcriptMessages = (value: unknown): readonly UiMessage[] =>
  Array.isArray(value) ? value as readonly UiMessage[] : NO_MESSAGES;

/** A bounded initial alignment, cancelled by real input/navigation/new turns. */
export function useTranscriptReadingPosition({
  sessionId, scrollRef, contentRef, pinnedRef, visible, windowSize,
  contentVersion, onPosition, onRestore, onMissing, onStale,
}: {
  sessionId: string | undefined;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  pinnedRef: RefObject<boolean>;
  visible: boolean;
  windowSize: number;
  contentVersion: unknown;
  onPosition: (top: number) => void;
  onRestore?: RestoreTranscriptReading;
  onMissing: () => void;
  /** A newer transcript tail was observed before the bookmark could be restored. */
  onStale?: () => void;
}) {
  const [initialPosition] = useState(() => {
    const position = getTranscriptReadingPosition(sessionId);
    return transcriptReadingPositionIsStale(position, transcriptMessages(contentVersion))
      ? undefined
      : position;
  });
  const pendingRef = useRef(initialPosition?.pinned === false ? initialPosition : undefined);
  const requestRef = useRef<AbortController | null>(null);
  const alignmentUntilRef = useRef(0);
  const wasVisibleRef = useRef(false);
  const cancel = useCallback(() => {
    pendingRef.current = undefined;
    requestRef.current?.abort();
  }, []);
  const remember = useCallback(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!sessionId || !visible || !scroller || !content || pendingRef.current) return;
    const position = captureTranscriptReadingPosition(
      scroller,
      content,
      pinnedRef.current,
      windowSize,
      transcriptMessages(contentVersion),
    );
    if (position) sessionReadingState(sessionId).position = position;
  }, [contentRef, contentVersion, pinnedRef, scrollRef, sessionId, visible, windowSize]);
  const callbacks = useRef({ remember, onMissing, onStale });
  callbacks.current = { remember, onMissing, onStale };

  // 仅在打开会话或恢复旧阅读位置时检查新输出；当前阅读由用户控制。
  useLayoutEffect(() => {
    const reopening = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (!visible || pinnedRef.current) return;
    if (reopening) {
      pendingRef.current = getTranscriptReadingPosition(sessionId);
      alignmentUntilRef.current = 0;
    }
    const position = pendingRef.current;
    if (!transcriptReadingPositionIsStale(position, transcriptMessages(contentVersion))) return;
    clearTranscriptReadingPosition(sessionId);
    cancel();
    alignmentUntilRef.current = 0;
    pinnedRef.current = true;
    callbacks.current.onStale?.();
    callbacks.current.onMissing();
  }, [cancel, contentVersion, onMissing, pinnedRef, sessionId, visible]);

  // Fetch only if the row is outside the current range. Abort also invalidates
  // completion when a pane hides/unmounts, or the reader takes over during IO.
  useLayoutEffect(() => {
    const position = pendingRef.current;
    if (!visible || !position || !onRestore) return;
    const controller = new AbortController();
    requestRef.current = controller;
    void onRestore(position, controller.signal).then((found) => {
      if (controller.signal.aborted || found) return;
      cancel();
      callbacks.current.onMissing();
      callbacks.current.remember();
    });
    return () => controller.abort();
  }, [cancel, onRestore, visible]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!visible) {
      alignmentUntilRef.current = 0;
      return;
    }
    if (!pendingRef.current || !scroller || !content) return;
    let timer = 0;
    const align = () => {
      const position = pendingRef.current;
      if (!position) return;
      if (alignmentUntilRef.current && performance.now() >= alignmentUntilRef.current) {
        cancel();
        callbacks.current.remember();
        return;
      }
      if (!restoreTranscriptReadingPosition(scroller, content, position)) return;
      onPosition(scroller.scrollTop);
      if (!alignmentUntilRef.current) {
        alignmentUntilRef.current = performance.now() + 1500;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        cancel();
        callbacks.current.remember();
      }, Math.max(0, alignmentUntilRef.current - performance.now()));
    };
    align();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(align);
    observer?.observe(content);
    return () => {
      window.clearTimeout(timer);
      observer?.disconnect();
    };
  }, [cancel, contentRef, contentVersion, onPosition, scrollRef, visible]);

  // Save laid-out geometry as well as native scrolls (e.g. disclosure changes).
  useLayoutEffect(() => {
    if (!visible) return;
    const content = contentRef.current;
    const observer = content && typeof ResizeObserver !== "undefined" ? new ResizeObserver(remember) : null;
    if (content) observer?.observe(content);
    remember();
    return () => observer?.disconnect();
  }, [contentRef, remember, visible]);

  return { initialPosition, pendingRef, remember, cancel };
}
