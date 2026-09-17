import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SubagentCollaborationSnapshot, UiMessage } from "@pi-desktop/shared";
import { api } from "../../../lib/api";
import { toolResultPayload } from "../../../lib/tool-presentation";
import { useAppStore } from "../../../stores/app-store";
import { IconStop } from "../../../components/icons";

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
  return { sessionId, live, phase: collaboration?.phase, collaboration };
}

export function SubagentSupervision({ message, running, compact = false }: { message: UiMessage; running: boolean; compact?: boolean }) {
  const { t } = useTranslation();
  const { sessionId, live } = useSubagentExecution(message);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState("");
  const payload = toolResultPayload(message);
  const id = payload && typeof payload === "object" ? (payload as { delegationId?: string }).delegationId : undefined;
  useEffect(() => { setRequested(false); setError(""); }, [id, sessionId]);
  const data = subagentCollaboration(message);
  const stopping = live && running && (requested || data?.phase === "stopping");
  const canStop = Boolean(id && sessionId && live && running && data?.phase !== "finished");
  if (!id) return null;
  return <div className={`subagent-supervision${compact ? " compact" : ""}`}>
    <div className="subagent-supervision-status">
      {data ? <span title={t(`chat.subagentIntervalSource.${data.intervalSource}`)}>
        {t("chat.subagentReportProgress", { current: data.stepsSinceReport, interval: data.reportIntervalSteps, total: data.completedSteps })}
      </span> : null}
      {!live && running ? <span>{t("chat.subagentHistorical")}</span> : stopping ? <span role="status">{t("chat.subagentStoppingNow")}</span>
        : data?.phase === "guiding" ? <span role="status">{t("chat.subagentGuidingNow")}</span> : null}
      {canStop ? <button type="button" className="subagent-stop-button" disabled={stopping}
        aria-label={t("chat.stopThisSubagent")} onClick={async (event) => {
          event.stopPropagation();
          if (!sessionId || !id || stopping) return;
          setRequested(true); setError("");
          try { await api.stopSubagent(sessionId, id); }
          catch (failure) { setRequested(false); setError(failure instanceof Error ? failure.message : String(failure)); }
        }}><IconStop size={12} />{t("chat.stopThisSubagent")}</button> : null}
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
