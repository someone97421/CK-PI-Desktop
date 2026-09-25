import { useEffect, useMemo, useRef, useState } from "react";
import type { UiMessage } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { mergeLiveSessionMessages } from "../lib/session-transcript";
import { EMPTY_TRANSCRIPT, transcriptWasRewritten } from "../lib/transcript-reading";
import { useAppStore } from "../stores/app-store";
import { useTranscriptView } from "./use-transcript-view";

/** 子代理详情独立读取历史，不依赖主聊天当前加载的分页窗口。 */
export function useSubagentTranscriptView(sessionId: string) {
  const transcript = useTranscriptView(sessionId);
  const live = useAppStore((state) => state.activeSessionId === sessionId
    ? state.messages : state.retainedTranscripts[sessionId] ?? EMPTY_TRANSCRIPT);
  const running = useAppStore((state) => Boolean(state.runningSessions[sessionId]));
  const [history, setHistory] = useState<UiMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const previous = useRef({ sessionId, live, running });

  useEffect(() => {
    const prior = previous.current;
    previous.current = { sessionId, live, running };
    if (prior.sessionId === sessionId && !running && !prior.running
      && live !== prior.live && transcriptWasRewritten(prior.live, live)) {
      setHistory([]);
      setRevision((value) => value + 1);
    }
  }, [sessionId, live, running]);

  useEffect(() => {
    let cancelled = false;
    setHistory([]);
    setLoading(true);
    setError(false);
    if (!sessionId) {
      setLoading(false);
      return;
    }
    void (async () => {
      let before: number | undefined;
      const pages: UiMessage[][] = [];
      do {
        const { session } = await api.getSession(sessionId, {
          messageLimit: 200,
          ...(before === undefined ? {} : { messageBefore: before }),
        });
        if (cancelled) return;
        if (!session) throw new Error("Session unavailable");
        pages.unshift(session.messages);
        if (!session.hasMoreBefore) break;
        const next = session.messageStart;
        if (next === undefined || (before !== undefined && next >= before)) {
          throw new Error("History page did not advance");
        }
        before = next;
      } while (before > 0);
      if (!cancelled) setHistory(pages.flat());
    })().catch(() => {
      if (!cancelled) setError(true);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [sessionId, running, revision]);

  const messages = useMemo(() => {
    const durable = mergeLiveSessionMessages(history, transcript.messages);
    return mergeLiveSessionMessages(live, durable);
  }, [history, live, transcript.messages]);

  return {
    ...transcript,
    messages,
    historyLoading: loading,
    historyError: error,
    retryHistory: () => setRevision((value) => value + 1),
  };
}
