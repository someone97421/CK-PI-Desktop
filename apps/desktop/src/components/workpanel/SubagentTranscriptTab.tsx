import { toolResultPayload } from "../../lib/tool-presentation";
import { SubagentGuideComposer } from "./SubagentGuideComposer";
import { useSubagentExecution } from "../../features/chat/transcript/SubagentSupervision";
import { delegationExecutionKey, isDelegationStartTool } from "../../lib/tool-display";
import { collectDelegationStatuses, subagentOutcome } from "../../lib/subagent-topology";
import { Fragment, useLayoutEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import { useFollowScroll } from "../../hooks/use-follow-scroll";
import { useSubagentTranscriptView } from "../../hooks/use-subagent-transcript-view";
import { useTranscriptSearchFocus } from "../../hooks/use-transcript-search-focus";
import { IconArrowDown } from "../icons";
import { TooltipButton } from "../ui";
import { DisclosureAnchorContext } from "../../lib/disclosure-anchor-context";
import { TranscriptDisclosureProvider } from "../../features/chat/transcript/disclosure";
import { buildSubagentTranscript } from "../../lib/subagent-transcript";
import { reviewChangeFromMessage } from "../../lib/workspace-review";
import {
  AssistantErrorMessage,
  ThinkingRow,
} from "../../features/chat/transcript/shared";
import {
  ReviewChangeCard,
} from "../ReviewChangeCard";
import { ToolRow } from "../../features/chat/transcript/ToolRow";
import { Markdown } from "../Markdown";
import { delegateModelId, delegateThinkingLevel } from "../../features/chat/transcript/model";

/**
 * The work-panel tab showing one delegation as a conversation (issue #917).
 *
 * Every `Task` call of the delegation chain opens a turn: the prompt the
 * parent sent renders as a user row, and the rows the delegate produced under
 * that call render with the main transcript's own message-list language —
 * tool rows, thinking rows, and answer bubbles alike. Follow-up `Task` calls
 * on the same delegation append further turns, so a resumed delegate reads as
 * one continuing user/assistant exchange.
 *
 * 底部提供当前执行的文字引导、模型展示和停止操作。
 */
export function SubagentTranscriptTab({ delegationId }: { delegationId: string }) {
  const sessionId = useAppStore((state) => state.activeSessionId);
  return (
    <TranscriptDisclosureProvider key={`${sessionId}:${delegationId}`}>
      <SubagentTranscriptSurface delegationId={delegationId} />
    </TranscriptDisclosureProvider>
  );
}

function SubagentTranscriptSurface({ delegationId }: { delegationId: string }) {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  // A tab only renders inside a presented panel, which always has a session;
  // the empty key keeps the hook's contract while nothing is active.
  const transcript = useSubagentTranscriptView(activeSessionId ?? "");
  const { messages } = transcript;
  const delegateMessage = useMemo(() => [...messages].reverse().find(message => {
    if (message.role !== "tool" || !isDelegationStartTool(message.toolName)) return false;
    return delegationExecutionKey(toolResultPayload(message)) === delegationId;
  }), [messages, delegationId]);
  const delegateExecution = useSubagentExecution(delegateMessage);
  const delegateRunning = useMemo(() => {
    if (!delegateMessage) return false;
    const items = messages.filter(message => message.role === "tool")
      .map(message => ({ kind: "tool" as const, message }));
    return subagentOutcome(delegateMessage, collectDelegationStatuses(items)) === "running";
  }, [messages, delegateMessage]);
  const delegateSettings = {
    modelId: delegateMessage ? delegateModelId(delegateMessage) : "",
    thinkingLevel: delegateMessage ? delegateThinkingLevel(delegateMessage) : undefined,
  };
  const transcriptResult = useMemo(
    () => buildSubagentTranscript(messages, delegationId),
    [messages, delegationId],
  );
  const {
    scrollRef,
    contentRef,
    showJump,
    handleScroll,
    jumpToLatest,
    scheduleFollowScroll,
    releaseFollow,
    disclosureAnchorNotifier,
  } = useFollowScroll();

  // Several delegation tabs can be open at once, so an explicit search hit
  // is claimed only by the tab whose own conversation contains the message;
  // the other tabs stay where the reader left them.
  const searchTarget = useMemo(() => {
    const focus = transcript.focus;
    if (!focus) return null;
    const claimed = transcriptResult?.turns.some((turn) =>
      turn.rows.some((row) => row.message.id === focus.messageId),
    );
    return claimed ? focus : null;
  }, [transcript.focus, transcriptResult]);

  useTranscriptSearchFocus({
    target: searchTarget,
    source:
      messages.find((message) => message.id === searchTarget?.messageId)?.content ?? "",
    scrollRef,
    contentRef,
    contentVersion: messages,
    onNavigate: releaseFollow,
  });

  useLayoutEffect(() => {
    if (!searchTarget) jumpToLatest();
  }, [jumpToLatest, searchTarget]);

  useLayoutEffect(() => {
    scheduleFollowScroll();
  }, [messages, scheduleFollowScroll]);

  return (
    <DisclosureAnchorContext.Provider value={disclosureAnchorNotifier}>
      <div className="subagent-transcript-tab" data-testid="subagent-transcript-tab">
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
            {transcriptResult ? (
              transcriptResult.turns.map((turn, turnIndex) => (
                <Fragment key={`turn-${turnIndex}`}>
                  <div className="message-row user">
                    <div className="message-col">
                      <div className="message-bubble">
                        <div className="message-user-text selectable">
                          {turn.task || t("panel.subagentTaskEmpty")}
                        </div>
                      </div>
                    </div>
                  </div>
                  {turn.rows.map((row) =>
                    row.kind === "tool" ? (
                      reviewChangeFromMessage(row.message) ? (
                        <ReviewChangeCard
                          key={row.message.id}
                          message={row.message}
                          asToolRow
                        />
                      ) : (
                        <ToolRow key={row.message.id} message={row.message} />
                      )
                    ) : row.kind === "thinking" ? (
                      <ThinkingRow
                        key={`thinking-${row.message.id}`}
                        message={row.message}
                        streaming={delegateRunning && delegateExecution.live && row.message.status === "streaming"}
                      />
                    ) : (
                      <div
                        className="message-row assistant"
                        data-message-id={row.message.id}
                        key={`answer-${row.message.id}`}
                      >
                        <div className="message-col">
                          <div className="message-bubble">
                            {row.message.content ? (
                              <div className="prose-chat selectable">
                                <Markdown source={row.message.content} />
                              </div>
                            ) : null}
                            {row.message.error ? (
                              <AssistantErrorMessage message={row.message} />
                            ) : null}
                          </div>
                        </div>
                      </div>
                    ),
                  )}
                </Fragment>
              ))
            ) : !transcript.historyLoading && !transcript.historyError ? (
              <div className="subagent-transcript-empty" role="status">
                {t("panel.subagentEmpty")}
              </div>
            ) : null}
          </div>
        </div>
        {showJump ? (
          <TooltipButton
            type="button"
            className="jump-latest-btn subagent-transcript-jump"
            tooltip={t("chat.scrollToBottom")}
            ariaLabel={t("chat.scrollToBottom")}
            onClick={jumpToLatest}
          >
            <IconArrowDown size={14} />
          </TooltipButton>
        ) : null}
        <SubagentGuideComposer
          key={`${delegateExecution.sessionId}:${delegateExecution.delegationId}:${delegateExecution.execution}`}
          sessionId={delegateExecution.sessionId}
          delegationId={delegateExecution.delegationId}
          execution={delegateExecution.execution}
          running={delegateRunning && delegateExecution.live}
          stopping={delegateExecution.phase === "stopping"}
          modelId={delegateSettings.modelId}
          thinkingLevel={delegateSettings.thinkingLevel}
          messages={messages}
        />
      </div>
    </DisclosureAnchorContext.Provider>
  );
}
