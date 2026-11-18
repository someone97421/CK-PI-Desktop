import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { formatToolDuration } from "../../../lib/tool-display";
import { delegationIsCreating, type DelegationFailure, type SubagentOutcome, type SubagentTiming } from "../../../lib/subagent-topology";
import { IconBot, IconChevronRight, IconCircleAlert } from "../../../components/icons";
import { CopyButton } from "./shared";
import type { useSubagentExecution } from "./SubagentSupervision";
import { delegateModelId, delegateThinkingLevel } from "./model";

export function SubagentFailureCard({
  outcome,
  failure,
}: {
  outcome: SubagentOutcome;
  failure: DelegationFailure;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const detailsId = useId();
  const headingId = useId();
  // A known runtime code already has a localized sentence; otherwise the
  // outcome's own label is the summary, which stays truthful and localized.
  const localizedKey = `errors.${failure.code}`;
  const localized = failure.code ? t(localizedKey) : localizedKey;
  const summary =
    failure.code && localized !== localizedKey
      ? localized
      : t(`chat.subagentStatus.${outcome}`);
  // A code-only error carries no detail to disclose, so it stays a one-line
  // card rather than opening onto an empty box.
  const hasMessage = failure.message.length > 0;

  return (
    <section
      className="message-error subagent-failure"
      aria-labelledby={headingId}
      data-testid="subagent-failure"
    >
      <div className="message-error-heading">
        <span className="message-error-icon" aria-hidden>
          <IconCircleAlert size={16} />
        </span>
        <div className="message-error-copy">
          <strong id={headingId}>{summary}</strong>
          {failure.code ? <code>{failure.code}</code> : null}
        </div>
        <div className="message-error-actions">
          {/* The toggle stays outside the collapsed region, otherwise hiding
            * the details would take away the control that brings them back. */}
          {hasMessage ? (
            <button
              type="button"
              className="message-error-toggle"
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => setOpen((value) => !value)}
            >
              <IconChevronRight size={12} aria-hidden />
              {open ? t("chat.hideErrorDetails") : t("chat.showErrorDetails")}
            </button>
          ) : null}
        </div>
      </div>
      {hasMessage ? (
        <div
          id={detailsId}
          className={`message-error-details ${open ? "open" : ""}`}
          hidden={!open}
        >
          <div className="message-error-raw">
            <pre className="selectable">{failure.message}</pre>
            <CopyButton text={failure.message} label={t("chat.copyErrorDetails")} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function SubagentDetail({
  message, agentName, outcome, live, phase, timing,
}: {
  message: UiMessage;
  agentName: string;
  outcome: SubagentOutcome;
  live: boolean;
  phase?: ReturnType<typeof useSubagentExecution>["phase"];
  timing?: SubagentTiming;
}) {
  const { t } = useTranslation();
  const modelLabel = [delegateModelId(message), delegateThinkingLevel(message)].filter(Boolean).join(" ");
  const creating = outcome === "running" && delegationIsCreating(message);
  const historical = outcome === "running" && !creating && !live;
  const statusKey = creating ? "chat.subagentCreating"
    : historical ? "chat.subagentHistorical"
    : outcome === "running" && phase === "stopping" ? "chat.subagentStoppingNow"
    : outcome === "running" && phase === "guiding" ? "chat.subagentGuidingNow"
    : `chat.subagentStatus.${outcome}`;
  const ticking = outcome === "running" && (creating || live);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);

  const startedAt = timing?.startedAt ?? (creating && message.createdAt ? Date.parse(message.createdAt) : undefined);
  const completedAt = timing?.completedAt ?? (ticking ? now : undefined);
  const durationMs = startedAt !== undefined && completedAt !== undefined
    ? completedAt - startedAt : historical ? undefined : message.toolDurationMs;
  const duration = typeof durationMs === "number" && durationMs > 0 ? formatToolDuration(durationMs / 1000) : "";
  const status = creating ? "creating" : historical ? "historical" : outcome.replaceAll("_", "-");

  return (
    <header className="subagent-detail-hero" data-testid="subagent-detail">
      <div className="subagent-detail-heading">
        <span className="subagent-detail-avatar" aria-hidden>
          <IconBot size={18} />
          <span className={`subagent-detail-status outcome-${status}`} />
        </span>
        <div className="subagent-detail-heading-copy">
          <strong className="subagent-detail-name">{agentName || t("chat.subagentUnnamed")}</strong>
          {modelLabel ? <span className="subagent-detail-model" title={modelLabel}>{modelLabel}</span> : null}
        </div>
      </div>
      <div className="subagent-detail-summary">
        <span className={`subagent-detail-badge outcome-${status}`}>{t(statusKey)}</span>
        {duration ? <span className="subagent-detail-meta">{duration}</span> : null}
      </div>
    </header>
  );
}
