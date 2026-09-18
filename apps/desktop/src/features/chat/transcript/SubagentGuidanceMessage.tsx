import { useTranslation } from "react-i18next";
import type { SubagentGuideReceipt } from "@pi-desktop/shared";
import "./subagent-guidance.css";

export function SubagentGuidanceMessage({ guide, messageId }: {
  guide: SubagentGuideReceipt;
  messageId?: string;
}) {
  const { t } = useTranslation();
  const time = (value: number) => new Date(value).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  return <article className="subagent-guidance-message" data-message-id={messageId}
    data-status={guide.status} data-guide-id={guide.commandId}>
    <header>
      <strong>{t("chat.subagentGuidanceSender")}</strong>
      {guide.execution !== undefined ? <span>{t("chat.subagentExecution", { execution: guide.execution })}</span> : null}
    </header>
    <p className="subagent-guidance-content selectable">{guide.instruction}</p>
    <footer>
      <span role="status">{t(`chat.subagentGuideState.${guide.status}`)}</span>
      <time dateTime={new Date(guide.receivedAt).toISOString()} title={new Date(guide.receivedAt).toLocaleString()}>
        {t("chat.subagentGuidanceReceivedAt", { time: time(guide.receivedAt) })}
      </time>
      {guide.appliedAt !== undefined && Number.isFinite(guide.appliedAt) ? <time
        dateTime={new Date(guide.appliedAt).toISOString()} title={new Date(guide.appliedAt).toLocaleString()}>
        {t("chat.subagentGuidanceAppliedAt", { time: time(guide.appliedAt) })}
      </time> : null}
    </footer>
    {guide.status === "accepted" || guide.status === "applying" ? <p className="subagent-guidance-note">
      {t("chat.subagentGuidancePending")}
    </p> : null}
    {guide.reason ? <p className="subagent-guidance-note selectable">{guide.reason}</p> : null}
  </article>;
}
