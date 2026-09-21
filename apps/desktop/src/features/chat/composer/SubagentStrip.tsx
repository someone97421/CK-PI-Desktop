import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { api } from "../../../lib/api";
import { buildTranscriptEntries } from "../../../lib/assistant-turns";
import { delegationIdForMessage } from "../../../lib/subagent-panel";
import { collectDelegationStatuses, isDelegationActivityItem, subagentOutcome } from "../../../lib/subagent-topology";
import { getToolAction, getToolSummary } from "../../../lib/tool-display";
import { useAppStore } from "../../../stores/app-store";
import { EMPTY_TRANSCRIPT, transcriptWasRewritten } from "../../../lib/transcript-reading";
import { delegateAgentName } from "../transcript/model";
import { useSubagentExecution } from "../transcript/SubagentSupervision";
import { IconCheck, IconCircleAlert, IconStop } from "../../../components/icons";

// 只保留主任务、生命周期回执及执行快照；详情仍通过现有历史接口按需读取。
function rosterMessage(message: UiMessage) {
  return (!message.parentToolCallId && getToolAction(message.toolName) === "delegate") || message.toolName === "TaskExecution";
}

export function SubagentStrip({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const live = useAppStore((state) => state.activeSessionId === sessionId ? state.messages : EMPTY_TRANSCRIPT);
  const running = useAppStore((state) => Boolean(state.runningSessions[sessionId]));
  const [history, setHistory] = useState<UiMessage[]>([]);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousNewest = useRef<string | undefined>(undefined);

  const previousTranscript = useRef({ live, running });

  useEffect(() => {
    const previous = previousTranscript.current;
    previousTranscript.current = { live, running };
    if (!running && !previous.running && live !== previous.live && transcriptWasRewritten(previous.live, live)) {
      setHistory([]);
      setRetry((value) => value + 1);
    }
  }, [live, running]);
  useEffect(() => {
    let cancelled = false;
    setError(false);
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
        pages.unshift(session.messages.filter(rosterMessage));
        if (!session.hasMoreBefore) break;
        const next = session.messageStart;
        if (next === undefined || (before !== undefined && next >= before)) throw new Error("History page did not advance");
        before = next;
      } while (before > 0);
      if (!cancelled) setHistory(pages.flat());
    })().catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [sessionId, running, retry]);

  const tasks = useMemo(() => {
    const merged = new Map(history.map((message) => [message.id, message]));
    for (const message of live) if (rosterMessage(message)) merged.set(message.id, message);
    const messages = [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const items = buildTranscriptEntries(messages).entries.flatMap((entry) =>
      entry.kind === "assistant-turn" ? entry.parts.flatMap((part) => part.kind === "activity" ? part.items : []) : [],
    );
    const statuses = collectDelegationStatuses(items);
    return items.filter(isDelegationActivityItem).map((item) => ({
      message: item.message,
      name: getToolSummary(item.message.toolName, item.message.toolArgs) || delegateAgentName(item.message, item.delegate),
      outcome: subagentOutcome(item.message, statuses),
    })).reverse();
  }, [history, live]);

  const newest = tasks[0]?.message.id;
  useLayoutEffect(() => {
    if (newest && newest !== previousNewest.current && scrollRef.current) scrollRef.current.scrollLeft = 0;
    previousNewest.current = newest;
  }, [newest]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || element.scrollWidth <= element.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      element.scrollLeft += delta * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? element.clientWidth : 1);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [tasks.length, error]);

  function open(message: UiMessage) {
    const state = useAppStore.getState();
    if (state.activeSessionId === sessionId) state.toggleSubagentPanel(delegationIdForMessage(message));
  }

  if (!tasks.length && !error) return null;
  return <div className="subagent-strip" role="region" aria-label={t("chat.subagentStrip")}>
    <div ref={scrollRef} className="subagent-strip-scroll" role="list" aria-label={t("chat.subagentStripOrder")}>
      {tasks.map((task) => <SubagentCapsule key={task.message.id} {...task} onOpen={() => void open(task.message)} />)}
      {error ? <button className="subagent-strip-retry" onClick={() => setRetry((value) => value + 1)}>{t("chat.subagentStripRetry")}</button> : null}
    </div>
  </div>;
}

function SubagentCapsule({ message, name, outcome, onOpen }: {
  message: UiMessage;
  name: string;
  outcome: ReturnType<typeof subagentOutcome>;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const execution = useSubagentExecution(message);
  const selection = useAppStore((state) => state.subagentPanel);
  const id = delegationIdForMessage(message);
  const selected = selection?.sessionId === execution.sessionId && selection.delegationId === id;
  const historical = outcome === "running" && !execution.live;
  const tone = historical ? "stopped" : outcome;
  const label = historical ? t("chat.subagentHistorical")
    : outcome === "running" && execution.phase === "stopping" ? t("chat.subagentStoppingNow")
    : outcome === "running" && execution.phase === "guiding" ? t("chat.subagentGuidingNow")
    : t(`chat.subagentStatus.${outcome}`);
  const title = name || t("chat.subagentUnnamed");
  return <div role="listitem" className="subagent-capsule-item">
    <button type="button" className={`subagent-capsule is-${tone}${selected ? " is-selected" : ""}`}
      title={`${title} · ${label}`} aria-label={`${title} · ${label}`} aria-expanded={selected}
      aria-controls={selected ? "subagent-panel" : undefined} data-subagent-trigger={id} onClick={onOpen}>
      <span className="subagent-capsule-status" aria-hidden="true">
        {tone === "running" ? <span className="subagent-capsule-dot" /> : tone === "completed" ? <IconCheck size={12} />
          : tone === "stopped" || tone === "aborted" ? <IconStop size={12} /> : <IconCircleAlert size={12} />}
      </span>
      <span className="subagent-capsule-name">{title}</span>
    </button>
  </div>;
}
