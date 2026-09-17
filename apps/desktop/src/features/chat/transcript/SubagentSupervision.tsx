import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SubagentCollaborationSnapshot, SubagentRecallStatus, UiMessage } from "@pi-desktop/shared";
import { api } from "../../../lib/api";
import { toolResultPayload } from "../../../lib/tool-presentation";
import { useAppStore } from "../../../stores/app-store";
import { IconStop } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";

export function subagentCollaboration(message: UiMessage): SubagentCollaborationSnapshot | undefined {
  const payload = toolResultPayload(message);
  if (!payload || typeof payload !== "object") return undefined;
  const data = (payload as { collaboration?: SubagentCollaborationSnapshot }).collaboration;
  return data && Number.isSafeInteger(data.reportIntervalSteps) && data.reportIntervalSteps > 0 ? data : undefined;
}

/** 用任务所属会话和轮次判断活跃性，历史卡片不能控制另一个会话的新运行。 */
export function useSubagentExecution(message: UiMessage) {
  const payload = toolResultPayload(message);
  const details = payload && typeof payload === "object" ? payload as { sessionId?: string; turnId?: string } : {};
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const sessionId = details.sessionId ?? activeSessionId;
  const sessionRunning = useAppStore((state) => sessionId ? state.runningSessions[sessionId] : false);
  const status = useAppStore((state) => sessionId ? state.agentStatuses?.[sessionId] : undefined);
  const live = Boolean(sessionRunning && (!details.turnId || !status?.currentTurnId || details.turnId === status.currentTurnId));
  const collaboration = subagentCollaboration(message);
  return { sessionId, live, parentTurnId: status?.currentTurnId, phase: collaboration?.phase, collaboration };
}

export function SubagentSupervision({ message, running, compact = false }: { message: UiMessage; running: boolean; compact?: boolean }) {
  const { t } = useTranslation();
  const { sessionId, live, parentTurnId } = useSubagentExecution(message);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState("");
  const [recall, setRecall] = useState<SubagentRecallStatus>();
  const payload = toolResultPayload(message);
  const id = payload && typeof payload === "object" ? (payload as { delegationId?: string }).delegationId : undefined;
  const data = subagentCollaboration(message);
  const execution = data?.execution;
  useEffect(() => { setRequested(false); setError(""); }, [id, sessionId, execution]);
  useEffect(() => {
    let cancelled = false;
    setRecall(undefined);
    if (id && sessionId && !running) {
      void api.subagentRecallStatus(sessionId, id).then((status) => {
        if (!cancelled) setRecall(status);
      }).catch(() => { /* 查询失败不能把历史快照当成可召回的活实例。 */ });
    }
    return () => { cancelled = true; };
  }, [id, sessionId, execution, running, live, parentTurnId, message.toolResult]);
  const resumable = recall?.canResume && recall.execution === execution;
  const stopping = live && running && (requested || data?.phase === "stopping");
  const canStop = Boolean(id && sessionId && live && running && data?.phase !== "finished");
  const reportInProgress = live && running && !stopping && data?.phase !== "finished";
  // 旧快照或无工具调用的召回轮次可能没有最近汇报，不能据此把累计汇报数写成 0。
  const reportCount = data?.latestReport?.reportSeq ?? (data?.completedSteps === 0 ? 0 : undefined);
  if (!id) return null;
  return <div className={`subagent-supervision${compact ? " compact" : ""}`}>
    <div className="subagent-supervision-status">
      <div className="subagent-supervision-status-copy">
      {data ? <span title={`${t(reportInProgress ? "chat.subagentReportProgressHint" : "chat.subagentReportSummaryHint", { interval: data.reportIntervalSteps })} · ${t(`chat.subagentIntervalSource.${data.intervalSource}`)}`}>
        {t(reportInProgress ? "chat.subagentReportProgress" : reportCount !== undefined ? "chat.subagentReportSummary" : "chat.subagentCallSummary",
          { current: data.stepsSinceReport, interval: data.reportIntervalSteps, total: data.completedSteps, reports: reportCount })}
      </span> : null}
      {execution ? <span>{t(running && execution > 1 ? "chat.subagentReworking" : "chat.subagentExecution", { execution })}</span> : null}
      {!running && execution ? <span title={t("chat.subagentRecallMemoryOnly")}>
        {t(resumable ? "chat.subagentRecallReady" : "chat.subagentRecallCheck")}
      </span> : null}
      {!live && running ? <span>{t("chat.subagentHistorical")}</span> : stopping ? <span role="status">{t("chat.subagentStoppingNow")}</span>
        : data?.phase === "guiding" ? <span role="status">{t("chat.subagentGuidingNow")}</span> : null}
      </div>
      {canStop ? <TooltipButton type="button" className="subagent-stop-button" disabled={stopping}
        tooltip={t(stopping ? "chat.subagentStoppingNow" : "chat.stopThisSubagent")}
        aria-label={t("chat.stopThisSubagent")} onClick={async (event) => {
          event.stopPropagation();
          if (!sessionId || !id || stopping) return;
          setRequested(true); setError("");
          try { await api.stopSubagent(sessionId, id, execution); }
          catch (failure) { setRequested(false); setError(failure instanceof Error ? failure.message : String(failure)); }
        }}><IconStop size={12} aria-hidden /></TooltipButton> : null}
    </div>
    {!compact && data ? <div className="subagent-supervision-detail">
      <span>{t("chat.subagentSegment", { segment: data.segmentId, steps: data.segmentCompletedSteps })}</span>
      <span>{t(`chat.subagentIntervalSource.${data.intervalSource}`)}</span>
      {data.stopSource ? <span>{t(`chat.subagentStopSource.${data.stopSource}`)}</span> : null}
      {data.latestGuide ? <div>
        <strong>{t(`chat.subagentGuideState.${data.latestGuide.status}`)}</strong>
        <p className="selectable">{data.latestGuide.instruction}</p>
      </div> : null}
      {data.latestReport ? <details>
        <summary>{t("chat.subagentLatestReport", { seq: data.latestReport.reportSeq, from: data.latestReport.fromStep, to: data.latestReport.toStep })}</summary>
        <p>{new Date(data.latestReport.capturedAt).toLocaleString()} · {data.latestReport.summary}</p>
        {data.latestReport.statement ? <p>{t("chat.subagentReportedStatement")} {data.latestReport.statement}</p> : null}
        <ol>{data.latestReport.steps.map((step) => <li key={step.toolCallId}>
          <strong>#{step.seq} {step.toolName}</strong> · {t(`chat.subagentStepStatus.${step.status}`)}
          <pre className="selectable">{step.args}{"\n"}{step.result}</pre>
        </li>)}</ol>
        {data.latestReport.truncated ? <p>{t("chat.subagentReportTruncated")}</p> : null}
      </details> : null}
    </div> : null}
    {error ? <div role="alert">{error}</div> : null}
  </div>;
}
