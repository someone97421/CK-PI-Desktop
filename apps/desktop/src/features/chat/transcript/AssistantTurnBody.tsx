import { memo, useMemo, useRef } from "react";
import type { AgentActivity } from "@pi-desktop/shared";
import { ReviewChangeCard } from "../../../components/ReviewChangeCard";
import { reuseReadonlyMap, type AssistantTurnEntry } from "../../../lib/assistant-turns";
import { collectDelegationStatuses, collectDelegationTimings, type SubagentOutcome } from "../../../lib/subagent-topology";
import { resolveShowThinking } from "../../../lib/thinking-visibility";
import { cachedVisibleProcessSteps } from "../../../lib/transcript-activity-summary";
import { resolveTranscriptDisplayMode } from "../../../lib/transcript-display-mode";
import { getAssistantTurnSummary, reuseReferences } from "../../../lib/transcript-summary";
import { segmentTurnProcess } from "../../../lib/turn-process";
import { useAppStore } from "../../../stores/app-store";
import { AssistantTurnParts } from "./AssistantTurnParts";
import { GeneratedImages } from "./GeneratedImages";
import { TaskProcessDrawer } from "./TaskProcessDrawer";
import { ToolRow } from "./ToolRow";
import { TurnProcess } from "./TurnProcess";

export const AssistantTurnBody = memo(function AssistantTurnBody({
  entry, isActive, delegationsLive, runtimeActivity, outcome, defaultProcessOpen,
}: {
  entry: AssistantTurnEntry;
  isActive: boolean;
  delegationsLive?: boolean;
  runtimeActivity?: AgentActivity;
  outcome?: SubagentOutcome;
  defaultProcessOpen?: boolean;
}) {
  const task = entry.task;
  const settledTask = task && task.status !== "running" ? task : undefined;
  const summary = getAssistantTurnSummary(entry);
  const showThinking = useAppStore((state) => resolveShowThinking(state.settings));
  const turnProcessActive = !settledTask && isActive;
  // Child execution receipts can arrive before the parent Task update.
  const delegationItemsRef = useRef(summary.toolItems);
  const delegationItems = reuseReferences(delegationItemsRef.current, summary.toolItems);
  delegationItemsRef.current = delegationItems;
  const turnLive = turnProcessActive || (!settledTask && delegationsLive === true);
  const rawStatuses = useMemo(() => collectDelegationStatuses(delegationItems, { turnLive }), [delegationItems, turnLive]);
  const rawTimings = useMemo(() => collectDelegationTimings(delegationItems), [delegationItems]);
  const statusesRef = useRef(rawStatuses);
  const timingsRef = useRef(rawTimings);
  const turnDelegationStatuses = reuseReadonlyMap(statusesRef.current, rawStatuses);
  const turnDelegationTimings = reuseReadonlyMap(timingsRef.current, rawTimings,
    (a, b) => a.startedAt === b.startedAt && a.completedAt === b.completedAt);
  statusesRef.current = turnDelegationStatuses;
  timingsRef.current = turnDelegationTimings;
  const { process, responses, lastActivityPart } = summary;
  const displayMode = useAppStore((state) => resolveTranscriptDisplayMode(state.settings));
  const segments = useMemo(() => task ? [] : segmentTurnProcess(process, displayMode), [process, displayMode, task]);
  const sourceTail = turnProcessActive ? entry.parts.at(-1) : undefined;
  let activePart = sourceTail;
  if (sourceTail?.kind === "message") {
    const processTail = process.at(-1);
    const responseTail = responses.at(-1);
    if (responseTail?.message.id === sourceTail.message.id) activePart = responseTail;
    else if (processTail?.kind === "message" &&
      (processTail.message.id === sourceTail.message.id || processTail.sourceMessageId === sourceTail.message.id)) {
      activePart = processTail;
    }
  }
  const processOwnsActiveTail = activePart !== undefined && process.includes(activePart);
  const visibleSteps = useMemo(
    () => cachedVisibleProcessSteps(process, !showThinking, turnProcessActive && processOwnsActiveTail),
    [process, showThinking, turnProcessActive, processOwnsActiveTail],
  );
  const toolsRef = useRef(summary.tools);
  const tools = reuseReferences(toolsRef.current, summary.tools);
  toolsRef.current = tools;
  const generatedImages = useMemo(() => tools.filter((message) => message.toolName === "GenerateImages")
    .map((message) => <GeneratedImages key={message.id} message={message} />), [tools]);
  const partContext = {
    isActive: turnProcessActive, activePart, lastActivityPart, runtimeActivity,
    turnDelegationStatuses, turnDelegationTimings, embedded: Boolean(settledTask) || !task,
  };

  return <>
    {settledTask ? (
      <>
        <TaskProcessDrawer key={settledTask.id} task={settledTask} processParts={process} sourceMessages={entry.sourceMessages}>
          <AssistantTurnParts parts={process} {...partContext} />
        </TaskProcessDrawer>
        <AssistantTurnParts parts={responses} {...partContext} />
      </>
    ) : !task ? (
      <>
        <TurnProcess
          turnId={entry.id} processParts={process} turnParts={entry.parts}
          visibleSteps={visibleSteps} isActive={turnProcessActive}
          defaultOpen={defaultProcessOpen}
          failed={summary.hasError || outcome === "failed" || outcome === "timed_out" || outcome === "denied"}
          stopped={outcome === "stopped" || outcome === "aborted"} activity={runtimeActivity}
        >
          {segments.map((segment) => segment.kind === "run" ? (
            <div className="turn-run-row" key={`run-${segment.key}`}>
              <ToolRow imagesInTurn message={segment.item.message}
                autoOpen={lastActivityPart?.kind === "activity" && lastActivityPart.items.at(-1) === segment.item}
                {...(segment.item.delegate ? { delegate: segment.item.delegate } : {})} />
              <ReviewChangeCard message={segment.item.message} />
            </div>
          ) : (
            <AssistantTurnParts key={`process-${segment.key}`} parts={segment.parts} {...partContext} />
          ))}
        </TurnProcess>
        <AssistantTurnParts parts={responses} {...partContext} />
      </>
    ) : (
      <AssistantTurnParts parts={process} {...partContext} />
    )}
    {generatedImages}
  </>;
});
