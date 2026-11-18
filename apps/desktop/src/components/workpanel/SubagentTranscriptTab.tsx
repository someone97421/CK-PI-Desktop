import { Fragment, useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { TranscriptDisclosureProvider } from "../../features/chat/transcript/disclosure";
import { delegateAgentName } from "../../features/chat/transcript/model";
import { AssistantErrorMessage, ThinkingRow } from "../../features/chat/transcript/shared";
import { SubagentDetail, SubagentFailureCard } from "../../features/chat/transcript/SubagentDetail";
import { SubagentGuidanceMessage } from "../../features/chat/transcript/SubagentGuidanceMessage";
import { SubagentSupervision, useSubagentExecution } from "../../features/chat/transcript/SubagentSupervision";
import { ToolRow } from "../../features/chat/transcript/ToolRow";
import { useFollowScroll } from "../../hooks/use-follow-scroll";
import { useSubagentTranscriptView } from "../../hooks/use-subagent-transcript-view";
import { useTranscriptSearchFocus } from "../../hooks/use-transcript-search-focus";
import type { AssistantActivityItem, SubagentRunItem } from "../../lib/assistant-turns";
import { DisclosureAnchorContext } from "../../lib/disclosure-anchor-context";
import { subagentGuidance } from "../../lib/subagent-guidance";
import { delegationIdForMessage, type SubagentPanelSelection } from "../../lib/subagent-panel";
import { collectDelegationFailures, collectDelegationStatuses, collectDelegationTimings, subagentOutcome } from "../../lib/subagent-topology";
import { buildSubagentTranscript } from "../../lib/subagent-transcript";
import { TranscriptSearchContext } from "../../lib/transcript-search-context";
import { reviewChangeFromMessage } from "../../lib/workspace-review";
import { SlotSessionProvider } from "../../plugins/renderer-slots/use-slots";
import { useAppStore } from "../../stores/app-store";
import { IconArrowDown } from "../icons";
import { Markdown } from "../Markdown";
import { ReviewChangeCard } from "../ReviewChangeCard";
import { TooltipButton } from "../ui";
import { SubagentGuideComposer } from "./SubagentGuideComposer";

type Props = { delegationId: string; selection?: SubagentPanelSelection };

export function SubagentTranscriptTab({ delegationId, selection }: Props) {
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const sessionId = selection?.sessionId ?? activeSessionId ?? "";
  return (
    <SlotSessionProvider sessionId={sessionId}>
      <TranscriptDisclosureProvider key={JSON.stringify([sessionId, delegationId])}>
        <SubagentTranscriptSurface sessionId={sessionId} delegationId={delegationId} selection={selection} />
      </TranscriptDisclosureProvider>
    </SlotSessionProvider>
  );
}

function SubagentTranscriptSurface({ sessionId, delegationId, selection }: Props & { sessionId: string }) {
  const { t } = useTranslation();
  const transcript = useSubagentTranscriptView(sessionId, delegationId);
  const { messages } = transcript;
  const result = useMemo(() => buildSubagentTranscript(messages, delegationId), [messages, delegationId]);
  const selected = result?.selectedTurn;
  const execution = useSubagentExecution(selected?.call);
  const agentName = selected ? result?.agentName || delegateAgentName(selected.call) : "";
  const { statuses, failures, timings } = useMemo(() => {
    const turns = new Map(result?.turns.map((turn) => [turn.call.id, turn]));
    const items: AssistantActivityItem[] = [];
    for (const message of messages) {
      if (message.role !== "tool" || message.parentToolCallId) continue;
      const turn = turns.get(message.id);
      items.push(turn
        ? { kind: "tool", message, delegate: { items: turn.rows } }
        : { kind: "tool", message });
    }
    return {
      statuses: collectDelegationStatuses(items),
      failures: collectDelegationFailures(items),
      timings: collectDelegationTimings(items),
    };
  }, [messages, result]);
  const outcome = selected ? subagentOutcome(selected.call, statuses) : undefined;
  const running = outcome === "running" && execution.live;
  const { scrollRef, contentRef, showJump, handleScroll, jumpToLatest, scheduleFollowScroll, releaseFollow, disclosureAnchorNotifier } = useFollowScroll();
  const initialPositionSet = useRef(false);
  const selectedPromptRef = useRef<HTMLDivElement>(null);
  const focus = transcript.focus;
  const searchTarget = focus && (!selection || focus.requestId === selection.searchRequestId)
    && result?.turns.some(({ rows }) => rows.some(({ message }) => message.id === focus.messageId))
    ? focus : null;
  useTranscriptSearchFocus({
    target: searchTarget,
    source: searchTarget ? messages.find(({ id }) => id === searchTarget.messageId)?.content ?? "" : "",
    scrollRef,
    contentRef,
    contentVersion: messages,
    onNavigate: releaseFollow,
  });

  const locateExecution = Boolean(selected && (selected !== result?.turns.at(-1) || (selection && !running)));
  useLayoutEffect(() => {
    if (searchTarget) {
      initialPositionSet.current = true;
      return;
    }
    if (initialPositionSet.current || !selected || transcript.historyLoading) return;
    initialPositionSet.current = true;
    if (!locateExecution) return;
    const prompt = selectedPromptRef.current;
    const scroller = scrollRef.current;
    if (!prompt || !scroller) return;
    releaseFollow();
    scroller.scrollTop += prompt.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, [locateExecution, releaseFollow, scrollRef, searchTarget, selected, transcript.historyLoading]);

  useLayoutEffect(() => { scheduleFollowScroll(); }, [messages, scheduleFollowScroll]);

  return (
    <DisclosureAnchorContext.Provider value={disclosureAnchorNotifier}>
      <TranscriptSearchContext.Provider value={searchTarget}>
        <section className="subagent-transcript-tab" aria-label={t("panel.subagent")} data-testid="subagent-transcript-tab">
          {selected && outcome ? <SubagentDetail
            message={selected.call}
            agentName={agentName}
            outcome={outcome}
            live={execution.live}
            phase={execution.phase}
            timing={timings.get(delegationIdForMessage(selected.call))}
          /> : null}
          <div className="subagent-transcript-viewport">
            <div
              ref={scrollRef}
              data-scroll-owner="follow"
              className="subagent-transcript-scroll"
              onScroll={handleScroll}
              role="log"
              aria-live="polite"
              aria-label={t("panel.subagent")}
              tabIndex={0}
            >
              <div ref={contentRef} className="subagent-transcript-list">
                {transcript.historyLoading || transcript.historyError ? (
                  <div className="subagent-transcript-empty" role="status">
                    {t(transcript.historyLoading ? "panel.subagentLoading" : "panel.subagentLoadError")}
                    {transcript.historyError ? <button type="button" onClick={transcript.retryHistory}>{t("panel.subagentRetry")}</button> : null}
                  </div>
                ) : null}
                {selected ? <SubagentSupervision message={selected.call} running={outcome === "running"} /> : null}
                {result ? result.turns.map((turn) => {
                  const turnOutcome = subagentOutcome(turn.call, statuses);
                  const failure = failures.get(delegationIdForMessage(turn.call));
                  const showFailure = failure && turnOutcome !== "completed" && turnOutcome !== "running"
                    && !turn.rows.some(({ kind, message }) => kind === "answer" && message.error?.code === failure.code
                      && (!failure.message || message.error.message.trim() === failure.message));
                  return (
                    <Fragment key={turn.call.id}>
                      <div className="message-row user" ref={turn === selected ? selectedPromptRef : undefined}>
                        <div className="message-col">
                          <div className="message-bubble">
                            <div className="message-user-text selectable">{turn.task || t("panel.subagentTaskEmpty")}</div>
                          </div>
                        </div>
                      </div>
                      {turn.rows.map((row) => (
                        <SubagentTranscriptRow key={`${row.kind}:${row.message.id}`} row={row}
                          streaming={turnOutcome === "running" && row.message.status === "streaming"} />
                      ))}
                      {showFailure ? <SubagentFailureCard outcome={turnOutcome} failure={failure} /> : null}
                    </Fragment>
                  );
                }) : !transcript.historyLoading && !transcript.historyError ? (
                  <div className="subagent-transcript-empty" role="status">{t("panel.subagentEmpty")}</div>
                ) : null}
              </div>
            </div>
            {showJump ? (
              <TooltipButton type="button" className="jump-latest-btn subagent-transcript-jump"
                tooltip={t("chat.scrollToBottom")} ariaLabel={t("chat.scrollToBottom")} onClick={jumpToLatest}>
                <IconArrowDown size={14} />
              </TooltipButton>
            ) : null}
          </div>
          {selected ? <SubagentGuideComposer
            key={JSON.stringify([execution.sessionId, execution.delegationId, execution.execution])}
            sessionId={execution.sessionId}
            delegationId={execution.delegationId}
            execution={execution.execution}
            running={running}
            stopping={execution.phase === "stopping"}
            agentName={agentName}
            messages={messages}
          /> : null}
        </section>
      </TranscriptSearchContext.Provider>
    </DisclosureAnchorContext.Provider>
  );
}

function SubagentTranscriptRow({ row, streaming }: { row: SubagentRunItem; streaming: boolean }) {
  const { kind, message } = row;
  if (kind === "tool") {
    const guide = subagentGuidance(message);
    return guide ? <SubagentGuidanceMessage guide={guide} messageId={message.id} />
      : reviewChangeFromMessage(message) ? <ReviewChangeCard message={message} asToolRow />
      : <ToolRow message={message} />;
  }
  if (kind === "thinking") return <ThinkingRow message={message} streaming={streaming} />;
  return (
    <div className="message-row assistant" data-message-id={message.id}>
      <div className="message-col">
        <div className="message-bubble">
          {message.content ? <div className="prose-chat selectable"><Markdown source={message.content} /></div> : null}
          {message.error ? <AssistantErrorMessage message={message} /> : null}
        </div>
      </div>
    </div>
  );
}
