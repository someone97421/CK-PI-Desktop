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
const ALIGN_WINDOW_MS = 1500;
const MISSING_GRACE_MS = 300;
const transcriptMessages = (value: unknown): readonly UiMessage[] =>
  Array.isArray(value) ? value as readonly UiMessage[] : NO_MESSAGES;

/** A bounded initial alignment, cancelled by real input/navigation/new turns. */
export function useTranscriptReadingPosition({
  sessionId, scrollRef, contentRef, pinnedRef, visible, windowSize,
  contentVersion, historical = false, onPosition, onRestore, onMissing, onStale,
}: {
  sessionId: string | undefined;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  pinnedRef: RefObject<boolean>;
  visible: boolean;
  windowSize: number;
  contentVersion: unknown;
  /** The transcript shows a historical window, whose tail is not the session tail. */
  historical?: boolean;
  onPosition: (top: number) => void;
  onRestore?: RestoreTranscriptReading;
  onMissing: () => void;
  /** A newer transcript tail was observed before the bookmark could be restored. */
  onStale?: () => void;
}) {
  const [initialPosition] = useState(() => {
    const position = getTranscriptReadingPosition(sessionId);
    return transcriptReadingPositionIsStale(position, transcriptMessages(contentVersion), historical)
      ? undefined
      : position;
  });
  const pendingRef = useRef(initialPosition?.pinned === false ? initialPosition : undefined);
  const requestRef = useRef<AbortController | null>(null);
  const completedRestoreRef = useRef<TranscriptReadingPosition | null>(null);
  const alignedRef = useRef<TranscriptReadingPosition | null>(null);
  const restoreReadyRef = useRef(!onRestore);
  const [restoreRevision, setRestoreRevision] = useState(0);
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
      historical,
    );
    if (position) sessionReadingState(sessionId).position = position;
  }, [contentRef, contentVersion, historical, pinnedRef, scrollRef, sessionId, visible, windowSize]);
  const isRestoring = useCallback(
    () => Boolean(pendingRef.current) && alignedRef.current !== pendingRef.current,
    [],
  );
  const callbacks = useRef({ remember, onMissing, onStale });
  callbacks.current = { remember, onMissing, onStale };

  // 仅在打开会话或恢复旧阅读位置时检查新输出；当前阅读由用户控制。
  useLayoutEffect(() => {
    const reopening = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (!visible) return;
    if (reopening) {
      const bookmark = getTranscriptReadingPosition(sessionId);
      if (bookmark?.pinned === false) {
        pendingRef.current = bookmark;
        pinnedRef.current = false;
      } else if (!pinnedRef.current) {
        pendingRef.current = bookmark;
      }
      alignmentUntilRef.current = 0;
      alignedRef.current = null;
    }
    if (pinnedRef.current) return;
    const position = pendingRef.current;
    if (!transcriptReadingPositionIsStale(position, transcriptMessages(contentVersion), historical)) return;
    clearTranscriptReadingPosition(sessionId);
    cancel();
    alignmentUntilRef.current = 0;
    pinnedRef.current = true;
    callbacks.current.onStale?.();
    callbacks.current.onMissing();
  }, [cancel, contentVersion, historical, onMissing, pinnedRef, sessionId, visible]);

  // Fetch only if the row is outside the current range. Abort also invalidates
  // completion when a pane hides/unmounts, or the reader takes over during IO.
  useLayoutEffect(() => {
    const position = pendingRef.current;
    if (!visible || !position || !onRestore || completedRestoreRef.current === position) return;
    // Do not start the bounded alignment window while the target may still be
    // loading. A slow history read must not be aborted by the fallback timer.
    restoreReadyRef.current = false;
    const controller = new AbortController();
    requestRef.current = controller;
    void onRestore(position, controller.signal).then((found) => {
      if (controller.signal.aborted) return;
      if (found) {
        completedRestoreRef.current = position;
        restoreReadyRef.current = true;
        setRestoreRevision((revision) => revision + 1);
        return;
      }
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
    if (!restoreReadyRef.current) return;
    let timer = 0;
    const finish = () => {
      const position = pendingRef.current;
      if (!position) return;
      const aligned = alignedRef.current === position;
      cancel();
      if (!aligned) callbacks.current.onMissing();
      callbacks.current.remember();
    };
    const align = () => {
      const position = pendingRef.current;
      if (!position || !restoreReadyRef.current) return;
      const now = performance.now();
      if (alignmentUntilRef.current && now >= alignmentUntilRef.current) {
        finish();
        return;
      }
      const result = restoreTranscriptReadingPosition(scroller, content, position);
      if (result === "unavailable") return;
      if (result === "aligned") {
        if (alignedRef.current !== position) alignmentUntilRef.current = now + ALIGN_WINDOW_MS;
        alignedRef.current = position;
        onPosition(scroller.scrollTop);
      } else if (!alignmentUntilRef.current) {
        // 锚点行可能还差一次提交才挂载；宽限期内仍未出现则视为缺失并回到底部。
        alignmentUntilRef.current = now + MISSING_GRACE_MS;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(finish, Math.max(0, alignmentUntilRef.current - performance.now()));
    };
    align();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(align);
    observer?.observe(content);
    return () => {
      window.clearTimeout(timer);
      observer?.disconnect();
    };
  }, [cancel, contentRef, contentVersion, onPosition, onRestore, restoreRevision, scrollRef, visible]);

  // Save laid-out geometry as well as native scrolls (e.g. disclosure changes).
  useLayoutEffect(() => {
    if (!visible) return;
    const content = contentRef.current;
    const observer = content && typeof ResizeObserver !== "undefined" ? new ResizeObserver(remember) : null;
    if (content) observer?.observe(content);
    remember();
    return () => observer?.disconnect();
  }, [contentRef, remember, visible]);

  return { initialPosition, pendingRef, remember, cancel, isRestoring };
}
