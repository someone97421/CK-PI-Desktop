import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { reviewChangesFromMessages, summarizeReviewChanges } from "../../lib/workspace-review";
import { useAppStore } from "../../stores/app-store";
import { IconDiff } from "../icons";
import { ReviewChangeCard } from "../ReviewChangeCard";
import { WorkTabEmpty } from "./WorkTabEmpty";

export function ReviewTab() {
  const { t } = useTranslation();
  const messages = useAppStore((state) => state.messages);
  const tab = useAppStore((state) => state.workPanelTabs.find(
    (item) => item.id === state.activeWorkPanelTabId && item.kind === "review",
  ));
  const openWorkPanelTab = useAppStore((state) => state.openWorkPanelTab);
  const scope = tab?.reviewScope;
  const taskOnly = !!scope && !scope.showAll;
  const selectedMessages = useMemo(() => {
    if (!scope || scope.showAll) return messages;
    const ids = new Set(scope.messageIds);
    return messages.filter((message) => ids.has(message.id));
  }, [messages, scope]);
  const entries = useMemo(() => {
    const seen = new Set<string>();
    return reviewChangesFromMessages(selectedMessages).filter(({ change }) => {
      if (seen.has(change.snapshotId)) return false;
      seen.add(change.snapshotId);
      return true;
    });
  }, [selectedMessages]);
  const summary = useMemo(() => summarizeReviewChanges(entries), [entries]);
  const files = useMemo(() => {
    const grouped = new Map<string, typeof entries>();
    for (const entry of entries) {
      const changes = grouped.get(entry.change.path) ?? [];
      changes.push(entry);
      grouped.set(entry.change.path, changes);
    }
    return [...grouped.entries()];
  }, [entries]);
  const missingEvidence = useMemo(() => {
    const tracked = new Set(entries.map(({ message }) => message.id));
    return selectedMessages.some((message) => message.role === "tool"
      && (message.toolName === "Write" || message.toolName === "Edit")
      && message.toolStatus === "success" && !tracked.has(message.id));
  }, [selectedMessages, entries]);

  return (
    <div className="review-tab">
      <div className="review-scope" role="group" aria-label={t("panel.review.scope")}>
        {scope ? <>
          <button type="button" aria-pressed={taskOnly} onClick={() => {
            if (tab) openWorkPanelTab({ ...tab, reviewScope: { ...scope, showAll: false } });
          }}>{t("panel.review.taskScope")}</button>
          <button type="button" aria-pressed={!taskOnly} onClick={() => {
            if (tab) openWorkPanelTab({ ...tab, reviewScope: { ...scope, showAll: true } });
          }}>{t("panel.review.sessionScope")}</button>
        </> : <span>{t("panel.review.sessionScope")}</span>}
      </div>
      <div className="review-toolbar">
        <span className="review-summary">
          {t("panel.review.changes", { count: summary.changeCount })}
        </span>
        <span className="review-toolbar-counts diff-counts">
          <span className="diff-count-add">+{summary.additions}</span>
          <span className="diff-count-del">−{summary.deletions}</span>
        </span>
      </div>
      <div className="review-scroll" key={taskOnly ? scope.messageIds.join(":") : "session"}>
        <p className="review-scope-note">{t("panel.review.snapshotNote")}</p>
        {missingEvidence ? <p className="review-scope-note">{t("chat.taskDelivery.missingEvidence")}</p> : null}
        {entries.length === 0 ? <WorkTabEmpty icon={IconDiff}
          title={t(taskOnly ? "panel.review.noTaskChanges" : "panel.review.noChanges")} /> : null}
        {files.map(([path, changes]) => (
          <section className="review-file-group" key={path}>
            <h3 className="review-file-heading" title={path}>
              <span>{path}</span>
              <span>{t("chat.taskDelivery.edits", { count: changes.length })}</span>
            </h3>
            {changes.map((entry, index) => (
              <div key={entry.change.snapshotId}>
                <div className="review-operation-label">{t("chat.taskDelivery.editNumber", { number: index + 1 })}</div>
                <ReviewChangeCard message={entry.message} compact />
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
