import { useEffect, useRef, useState } from "react";
import type {
  AgentActivity,
  SessionSummary,
  UiMessage,
} from "@pi-desktop/shared";
import { api } from "../../../lib/api";
import {
  calculateSessionTiming,
  loadEarlierModelResponseDuration,
  type SessionTiming,
} from "../../../lib/session-timing";
import type { SessionHistoryWindow } from "../../../stores/app-state";

type HistoryLoadState = {
  key: string;
  status: "loading" | "ready" | "error";
  durationMs: number;
};

type CachedSessionTiming = {
  key: string;
  durationMs: number;
};

const MAX_CACHED_SESSION_TIMINGS = 16;

export type SessionTimingView = {
  timing?: SessionTiming;
  historyStatus: "loading" | "ready" | "error";
};

export function useSessionTiming({
  enabled,
  session,
  sessionId,
  messages,
  history,
  isRunning,
  modelRequestActivity,
}: {
  enabled: boolean;
  session?: Pick<SessionSummary, "createdAt" | "updatedAt">;
  sessionId?: string;
  messages: UiMessage[];
  history?: SessionHistoryWindow;
  isRunning: boolean;
  modelRequestActivity?: AgentActivity;
}): SessionTimingView {
  const messageStart = history?.messageStart ?? 0;
  const hasMoreBefore = history?.hasMoreBefore === true;
  const historyKey = `${sessionId ?? ""}:${messageStart}:${session?.updatedAt ?? ""}`;
  const historyCache = useRef(new Map<string, CachedSessionTiming>());
  const [retainedRequest, setRetainedRequest] = useState<
    { sessionId: string; startedAt: number } | undefined
  >();
  const [historyLoad, setHistoryLoad] = useState<HistoryLoadState>();
  const [now, setNow] = useState(() => Date.now());

  const streamingMessageStartedAt = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        !message.parentToolCallId &&
        !message.nestedParentToolCallId &&
        message.status === "streaming",
    )?.createdAt;
  const waitingRequestStartedAt =
    modelRequestActivity?.phase === "waiting-model"
      ? modelRequestActivity.since
      : undefined;
  useEffect(() => {
    if (!isRunning || !sessionId) {
      setRetainedRequest(undefined);
    } else if (
      typeof waitingRequestStartedAt === "number" &&
      Number.isFinite(waitingRequestStartedAt)
    ) {
      setRetainedRequest({ sessionId, startedAt: waitingRequestStartedAt });
    }
  }, [isRunning, sessionId, waitingRequestStartedAt]);

  const retainedRequestStartedAt =
    sessionId && retainedRequest?.sessionId === sessionId
      ? retainedRequest.startedAt
      : undefined;
  const currentRequestStartedAt =
    waitingRequestStartedAt ??
    (modelRequestActivity?.phase === "retrying"
      ? retainedRequestStartedAt ?? modelRequestActivity.since
      : undefined) ??
    (streamingMessageStartedAt
      ? retainedRequestStartedAt ?? Date.parse(streamingMessageStartedAt)
      : undefined);

  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !sessionId || !hasMoreBefore || messageStart <= 0) return;

    const cachedTiming = historyCache.current.get(sessionId);
    if (cachedTiming?.key === historyKey) {
      historyCache.current.delete(sessionId);
      historyCache.current.set(sessionId, cachedTiming);
      setHistoryLoad({
        key: historyKey,
        status: "ready",
        durationMs: cachedTiming.durationMs,
      });
      return;
    }

    const controller = new AbortController();
    setHistoryLoad({ key: historyKey, status: "loading", durationMs: 0 });
    void loadEarlierModelResponseDuration(
      messageStart,
      async (options) => {
        const result = await api.getSession(sessionId, options);
        return result.session
          ? {
              messages: result.session.messages,
              messageStart: result.session.messageStart,
              hasMoreBefore: result.session.hasMoreBefore,
            }
          : null;
      },
      controller.signal,
    ).then(
      (durationMs) => {
        if (controller.signal.aborted) return;
        if (
          !historyCache.current.has(sessionId) &&
          historyCache.current.size >= MAX_CACHED_SESSION_TIMINGS
        ) {
          const oldestSessionId = historyCache.current.keys().next().value;
          if (oldestSessionId) historyCache.current.delete(oldestSessionId);
        }
        historyCache.current.set(sessionId, { key: historyKey, durationMs });
        setHistoryLoad({ key: historyKey, status: "ready", durationMs });
      },
      () => {
        if (controller.signal.aborted) return;
        setHistoryLoad({ key: historyKey, status: "error", durationMs: 0 });
      },
    );

    return () => controller.abort();
  }, [enabled, hasMoreBefore, historyKey, messageStart, sessionId]);

  const historyStatus = !hasMoreBefore
    ? "ready"
    : historyLoad?.key === historyKey
      ? historyLoad.status
      : "loading";
  const timing = enabled && session
    ? calculateSessionTiming({
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        isRunning,
        messages,
        now,
        earlierModelResponseMs:
          historyStatus === "ready" && historyLoad?.key === historyKey
            ? historyLoad.durationMs
            : 0,
        activeModelRequestStartedAt: currentRequestStartedAt,
      })
    : undefined;

  return { timing, historyStatus };
}
