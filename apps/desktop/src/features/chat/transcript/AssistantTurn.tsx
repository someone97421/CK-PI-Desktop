import {
  memo,
  useContext,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentActivity,
  ContextCompactionMark,
} from "@pi-desktop/shared";
import { formatCompactTokenCount } from "@pi-desktop/shared";
import {
  assistantTurnContent,
  assistantTurnMessages,
  assistantTurnResponseDuration,
  assistantTurnResponseOutputTokens,
  assistantTurnUsage,
  reuseReadonlyMap,
  subagentRunsEqual,
  type AssistantTurnEntry,
  type TranscriptEntry,
} from "../../../lib/assistant-turns";
import {
  collectDelegationStatuses,
  collectDelegationTimings,
} from "../../../lib/subagent-topology";
import {
  isLastActivityPart,
  projectTurnProcess,
  resolveThinkingDisplayMode,
  shouldGroupTurnProcess,
} from "../../../lib/turn-process";
import { useAppStore } from "../../../stores/app-store";
import { TranscriptReadOnlyContext } from "./context";
import { selectionMarkdownWithinRow } from "../../../lib/selection-quote";
import { selectionAnnotationAnchorWithinRow } from "../../../lib/response-annotation-anchor";
import { IconQuote, IconChat } from "../../../components/icons";
import { Markdown } from "../../../components/Markdown";
import { IconBranch, IconReview } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import {
  AssistantErrorMessage,
  CopyButton,
  MessageMeta,
} from "./shared";
import { activityItemsEqual, ActivityGroup } from "./ActivityGroup";
import { MessageRow } from "./MessageRow";
import { TaskProcessDrawer } from "./TaskProcessDrawer";
import { TaskReviewCard } from "./TaskReviewCard";
import { assistantTurnMenuItems } from "./menu-items";
import {
  useChatTextActions,
  useTranscriptMenu,
} from "./TranscriptMenu";
import { TurnProcess } from "./TurnProcess";

type AssistantTurnProps = {
  entry: AssistantTurnEntry;
  isActive: boolean;
  runtimeActivity?: AgentActivity;
};

function assistantTurnPropsEqual(
  previous: AssistantTurnProps,
  next: AssistantTurnProps,
) {
  if (
    previous.isActive !== next.isActive ||
    previous.runtimeActivity !== next.runtimeActivity ||
    previous.entry.anchorId !== next.entry.anchorId ||
    previous.entry.task !== next.entry.task ||
    previous.entry.sourceMessages !== next.entry.sourceMessages ||
    previous.entry.finalMessageId !== next.entry.finalMessageId ||
    previous.entry.parts.length !== next.entry.parts.length
  ) {
    return false;
  }
  return previous.entry.parts.every((part, index) => {
    const nextPart = next.entry.parts[index];
    if (part.kind !== nextPart.kind) return false;
    if (part.kind === "compaction" && nextPart.kind === "compaction") {
      return compactionMarksEqual(part.mark, nextPart.mark);
    }
    if (part.kind === "message" && nextPart.kind === "message") {
      return part.message === nextPart.message;
    }
    if (part.kind === "activity" && nextPart.kind === "activity") {
      return (
        part.endedAt === nextPart.endedAt &&
        part.items.length === nextPart.items.length &&
        part.items.every((item, itemIndex) =>
          activityItemsEqual(item, nextPart.items[itemIndex]),
        )
      );
    }
    return false;
  });
}

export function compactionMarksEqual(
  previous: ContextCompactionMark,
  next: ContextCompactionMark,
): boolean {
  return (
    previous.id === next.id &&
    previous.throughMessageId === next.throughMessageId &&
    previous.generation === next.generation &&
    previous.summaryTokens === next.summaryTokens &&
    previous.summarized === next.summarized &&
    previous.fallback === next.fallback
  );
}

/** Compare the data that can change a transcript row's rendered output. */
export function transcriptEntryEqual(
  previous: TranscriptEntry,
  next: TranscriptEntry,
): boolean {
  if (previous === next) return true;
  if (previous.kind !== next.kind) return false;
  if (previous.kind === "message" && next.kind === "message") {
    return previous.message === next.message;
  }
  if (previous.kind === "compaction" && next.kind === "compaction") {
    return compactionMarksEqual(previous.mark, next.mark);
  }
  if (previous.kind === "assistant-turn" && next.kind === "assistant-turn") {
    return assistantTurnPropsEqual(
      { entry: previous, isActive: false },
      { entry: next, isActive: false },
    );
  }
  return false;
}

export function TranscriptEntryView({
  entry,
  isRunning,
  isActive,
  runtimeActivity,
}: {
  entry: TranscriptEntry;
  isRunning: boolean;
  isActive: boolean;
  runtimeActivity?: AgentActivity;
}) {
  if (entry.kind === "assistant-turn") {
    return (
      <AssistantTurn
        entry={entry}
        isActive={isActive}
        runtimeActivity={runtimeActivity}
      />
    );
  }
  if (entry.kind === "compaction") {
    return <CompactionRow mark={entry.mark} />;
  }
  return <MessageRow message={entry.message} isRunning={isRunning} />;
}

function transcriptEntryKey(entry: TranscriptEntry): string {
  if (entry.kind === "compaction") return entry.mark.id;
  if (entry.kind === "assistant-turn") return entry.id;
  return entry.message.id;
}

type TranscriptHistoryProps = {
  entries: TranscriptEntry[];
  isRunning: boolean;
};

/**
 * Keep the completed transcript out of the streaming reconciliation path.
 * The projection is still rebuilt for correctness, but React can now bail out
 * before walking every historical row when only the active tail changed.
 */
export const TranscriptHistory = memo(function TranscriptHistory({
  entries,
  isRunning,
}: TranscriptHistoryProps) {
  return (
    <>
      {entries.map((entry) => (
        <TranscriptEntryView
          key={transcriptEntryKey(entry)}
          entry={entry}
          isRunning={isRunning}
          isActive={false}
        />
      ))}
    </>
  );
}, (previous, next) => {
  if (
    previous.isRunning !== next.isRunning ||
    previous.entries.length !== next.entries.length
  ) {
    return false;
  }
  return previous.entries.every((entry, index) =>
    transcriptEntryEqual(entry, next.entries[index]),
  );
});

export const TranscriptTail = memo(function TranscriptTail({
  entry,
  isRunning,
  isActive,
  runtimeActivity,
}: {
  entry: TranscriptEntry;
  isRunning: boolean;
  isActive: boolean;
  runtimeActivity?: AgentActivity;
}) {
  return (
    <TranscriptEntryView
      entry={entry}
      isRunning={isRunning}
      isActive={isActive}
      runtimeActivity={runtimeActivity}
    />
  );
}, (previous, next) =>
  previous.isRunning === next.isRunning &&
  previous.isActive === next.isActive &&
  previous.runtimeActivity === next.runtimeActivity &&
  transcriptEntryEqual(previous.entry, next.entry)
);

export const AssistantTurn = memo(function AssistantTurn({
  entry,
  isActive,
  runtimeActivity,
}: AssistantTurnProps) {
  const { t } = useTranslation();
  const openTranscriptMenu = useTranscriptMenu();
  const { copyText, selectText } = useChatTextActions();
  const retryAssistantMessage = useAppStore((s) => s.retryAssistantMessage);
  const forkAssistantMessage = useAppStore((s) => s.forkAssistantMessage);
  const annotateLabel = t("chat.annotate");
  const sideChatLabel = t("chat.startSideChat");
  const openSideChat = useAppStore((s) => s.openSideChat);
  const openResponseAnnotationEditor = useAppStore(
    (s) => s.openResponseAnnotationEditor,
  );
  const transcriptReadOnly = useContext(TranscriptReadOnlyContext);
  // The host refuses a fork while the source turn is still running, so the
  // affordance is disabled rather than silently doing nothing.
  const sessionRunning = useAppStore((s) =>
    s.activeSessionId ? s.runningSessions[s.activeSessionId] === true : false,
  );
  const messages = assistantTurnMessages(entry);
  const task = entry.task;
  const settledTask = task && task.status !== "running" ? task : undefined;
  const { process, responses } = projectTurnProcess(entry);
  const finalMessage = task ? responses.at(-1)?.message : undefined;
  const content = task
    ? responses.map((part) => part.message.content).join("\n\n")
    : assistantTurnContent(entry);
  const actionMessage = task ? finalMessage : [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && (message.content || "").trim());
  const metaMessage = [...messages]
    .reverse()
    .find(
      (message) =>
        message.modelId ||
        message.usage ||
        message.responseDurationMs ||
        message.responseOutputTokens,
    );
  const latestUsageMessage = [...messages]
    .reverse()
    .find((message) => message.usage);
  const usage = assistantTurnUsage(entry);
  const responseDurationMs = assistantTurnResponseDuration(entry);
  const responseOutputTokens = assistantTurnResponseOutputTokens(entry);
  const modelId = metaMessage?.modelId ?? latestUsageMessage?.modelId;
  const hasError = messages.some((message) => Boolean(message.error));
  const complete = task
    ? task.status === "completed" && Boolean(content) && Boolean(actionMessage)
    : !isActive && !hasError && Boolean(content) && Boolean(actionMessage);
  const streaming = !settledTask &&
    isActive && messages.some((message) => message.status === "streaming");
  /*
    The turn owns the menu for its whole subtree, the answer rows it renders
    included: Regenerate and Branch act on the turn's answer message, so a menu
    owned by a single message part could not offer them honestly.
  */
  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    openTranscriptMenu(event, {
      label: t("chat.messageMenu"),
      items: assistantTurnMenuItems({
        t,
        answer: content,
        selectTarget:
          [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              ".message-bubble",
            ),
          ].at(-1) ?? null,
        complete: complete && Boolean(actionMessage) && !transcriptReadOnly && !sessionRunning,
        actions: { copyText, selectText },
        onRegenerate: () => {
          if (actionMessage) void retryAssistantMessage(actionMessage.id);
        },
        onBranch: () => {
          if (actionMessage) void forkAssistantMessage(actionMessage.id);
        },
      }),
    });
  };

  // Collect delegation statuses across ALL activity parts of this turn so that
  // a TaskWait in one part can inform the Task cards in a different part.
  const turnAllActivityItems = useMemo(
    () =>
      entry.parts.flatMap((part) =>
        part.kind === "activity" ? part.items : [],
      ),
    [entry.parts],
  );
  const rawDelegationStatuses = useMemo(
    () =>
      collectDelegationStatuses(turnAllActivityItems, { turnLive: isActive && !settledTask }),
    [turnAllActivityItems, isActive, settledTask],
  );
  const rawDelegationTimings = useMemo(
    () => collectDelegationTimings(turnAllActivityItems),
    [turnAllActivityItems],
  );
  const statusesRef = useRef(rawDelegationStatuses);
  const timingsRef = useRef(rawDelegationTimings);
  const turnDelegationStatuses = reuseReadonlyMap(
    statusesRef.current,
    rawDelegationStatuses,
  );
  const turnDelegationTimings = reuseReadonlyMap(
    timingsRef.current,
    rawDelegationTimings,
    (left, right) =>
      left.startedAt === right.startedAt && left.completedAt === right.completedAt,
  );
  statusesRef.current = turnDelegationStatuses;
  timingsRef.current = turnDelegationTimings;
  const isPlainHistory = !task;
  const groupProcess = useAppStore((state) =>
    shouldGroupTurnProcess(
      resolveThinkingDisplayMode(state.settings?.thinkingDisplayMode),
    ),
  );
  const turnProcessActive = !settledTask && isActive;
  const activePart = turnProcessActive ? entry.parts.at(-1) : undefined;
  const renderPart = (part: AssistantTurnEntry["parts"][number], index: number) => {
    if (part.kind === "compaction") return <CompactionRow key={part.mark.id} mark={part.mark} />;
    if (part.kind === "activity") return (
      <ActivityGroup
        key={`activity-${part.items[0]?.message.id ?? index}`}
        items={part.items}
        endedAt={part.endedAt}
        isActive={part === activePart}
        isLast={isLastActivityPart(entry.parts, part)}
        runtimeActivity={part === activePart ? runtimeActivity : undefined}
        turnDelegationStatuses={turnDelegationStatuses}
        turnDelegationTimings={turnDelegationTimings}
        embedded={Boolean(settledTask) || isPlainHistory}
      />
    );
    if (part.message.role !== "assistant") return (
      <div className="task-steering-message" key={part.message.id}>
        {part.message.role === "user" && part.message.steering
          ? <p className="task-steering-label">{t("chat.taskDelivery.steering")}</p> : null}
        <MessageRow message={part.message} isRunning={!settledTask && isActive} />
      </div>
    );
    return (
      <div
        className={`message-bubble assistant-turn-fragment${
          !settledTask && isActive && part.message.status === "streaming" ? " streaming" : ""
        }`}
        data-message-id={part.message.id}
        key={part.message.id}
      >
        {part.message.content ? <div className="prose-chat"><Markdown source={part.message.content} /></div> : null}
        {part.message.error ? <AssistantErrorMessage message={part.message} /> : null}
      </div>
    );
  };

  return (
    <div
      className={`message-row assistant assistant-turn${streaming ? " streaming" : ""}`}
      data-minimap-id={entry.anchorId}
      data-row-role="assistant"
      onContextMenu={onContextMenu}
      role="article"
      aria-label={t("chat.assistantMessage")}
    >
      <div className="message-col">
        {settledTask ? (
          <>
            <TaskProcessDrawer key={settledTask.id} task={settledTask}>
              {process.map((part) => renderPart(part, entry.parts.indexOf(part)))}
            </TaskProcessDrawer>
            {responses.map((part) => renderPart(part, entry.parts.indexOf(part)))}
          </>
        ) : isPlainHistory && groupProcess ? (
          <>
            <TurnProcess processParts={process} turnParts={entry.parts} isActive={turnProcessActive}>
              {process.map((part) => renderPart(part, entry.parts.indexOf(part)))}
            </TurnProcess>
            {responses.map((part) => renderPart(part, entry.parts.indexOf(part)))}
          </>
        ) : (
          entry.parts.map(renderPart)
        )}
        {!task && !isActive && metaMessage ? (
          <MessageMeta
            modelId={modelId}
            usage={usage}
            responseDurationMs={responseDurationMs}
            responseOutputTokens={responseOutputTokens}
          />
        ) : null}
        {(content || hasError) && actionMessage && !transcriptReadOnly ? (
          <div className="message-actions">
            {complete ? (
              <CopyButton text={content} label={t("chat.copy")} />
            ) : null}
            {complete ? (
              <TooltipButton
                className="copy-btn icon"
                tooltip={t("chat.forkResponse")}
                ariaLabel={t("chat.forkResponse")}
                disabled={sessionRunning}
                onClick={() => void forkAssistantMessage(actionMessage.id)}
              >
                <IconBranch size={13} />
              </TooltipButton>
            ) : null}
            {complete ? (
              <TooltipButton
                className="copy-btn icon"
                tooltip={t("chat.retry")}
                ariaLabel={t("chat.retry")}
                onClick={() => void retryAssistantMessage(actionMessage.id)}
              >
                <IconReview size={13} />
              </TooltipButton>
            ) : null}
            {complete ? (
              <TooltipButton
                className="copy-btn icon"
                tooltip={annotateLabel}
                ariaLabel={annotateLabel}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  // An annotation is a response concept (D-LOCAL-response-annotations): the selection
                  // when there is one, the whole answer otherwise. The excerpt
                  // is read before the editor takes focus. A turn without an
                  // anchor has no row to annotate.
                  if (!entry.anchorId) return;
                  const selection = selectionMarkdownWithinRow(entry.anchorId);
                  openResponseAnnotationEditor({
                    messageId: entry.anchorId,
                    text: selection || content,
                    anchor: selectionAnnotationAnchorWithinRow(entry.anchorId),
                  });
                }}
              >
                <IconQuote size={13} />
              </TooltipButton>
            ) : null}
            {complete ? (
              <TooltipButton
                className="copy-btn icon"
                tooltip={sideChatLabel}
                ariaLabel={sideChatLabel}
                disabled={sessionRunning}
                onClick={() => void openSideChat(actionMessage.id)}
              >
                <IconChat size={13} />
              </TooltipButton>
            ) : null}
          </div>
        ) : null}
        {settledTask ? <TaskReviewCard messages={entry.sourceMessages ?? messages} /> : null}
      </div>
    </div>
  );
}, assistantTurnPropsEqual);

/**
 * The transcript trace of one compaction, matching Codex's `ContextCompaction`
 * turn item: a divider that says the earlier turns above it are now a summary.
 * It carries no actions — nothing about a persisted checkpoint is undoable.
 */
export function CompactionRow({ mark }: { mark: ContextCompactionMark }) {
  const { t } = useTranslation();
  return (
    <div className="transcript-compaction-row" role="separator">
      <span className="transcript-compaction-label">
        {t("chat.compactionRow", { times: mark.generation })}
      </span>
      <span className="transcript-compaction-detail">
        {mark.fallback
          ? t("chat.compactionRowSummaryFailed")
          : mark.summarized
            ? t("chat.compactionRowSummary", {
                tokens: formatCompactTokenCount(mark.summaryTokens),
              })
            : t("chat.compactionRowNoSummary")}
      </span>
    </div>
  );
}
