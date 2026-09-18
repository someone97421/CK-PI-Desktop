import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ReviewChange, UiMessage } from "@pi-desktop/shared";
import { reviewChangesFromMessages } from "../../../lib/workspace-review";
import { IconDiff } from "../../../components/icons";
import { toolWorkPanelTab } from "../../../lib/work-panel-tabs";
import { useAppStore } from "../../../stores/app-store";
import "./task-delivery.css";

/** 读取消息自带的不可变证据，不读取当前工作树，也不调用模型或回滚接口。 */
export function TaskReviewCard({ messages }: { messages: UiMessage[] }) {
  const { t } = useTranslation();
  const openWorkPanelTab = useAppStore((state) => state.openWorkPanelTab);
  const closeSubagentPanel = useAppStore((state) => state.closeSubagentPanel);
  const { files, untracked } = useMemo(() => {
    const entries = reviewChangesFromMessages(messages);
    const grouped = new Map<string, ReviewChange[]>();
    const snapshots = new Set<string>();
    for (const { change } of entries) {
      if (snapshots.has(change.snapshotId)) continue;
      snapshots.add(change.snapshotId);
      const changes = grouped.get(change.path) ?? [];
      changes.push(change);
      grouped.set(change.path, changes);
    }
    const trackedMessages = new Set(entries.map(({ message }) => message.id));
    return {
      files: [...grouped.entries()],
      untracked: messages.some((message) => message.role === "tool"
        && (message.toolName === "Write" || message.toolName === "Edit")
        && message.toolStatus === "success" && !trackedMessages.has(message.id)),
    };
  }, [messages]);

  return (
    <section className="task-review-card" aria-label={t("chat.taskDelivery.review")}>
      <div className="task-review-heading">
        <IconDiff size={16} />
        <span>{files.length ? t("chat.taskDelivery.files", { count: files.length })
          : t("chat.taskDelivery.noChanges")}</span>
        <button type="button" className="task-review-open"
          disabled={files.length === 0}
          onClick={() => {
            closeSubagentPanel();
            openWorkPanelTab({
              ...toolWorkPanelTab("review"),
              reviewScope: { messageIds: messages.map((message) => message.id) },
            });
          }}>
          {t("chat.taskDelivery.review")}
        </button>
      </div>
      {untracked ? <p className="task-review-note">{t("chat.taskDelivery.missingEvidence")}</p> : null}
      {files.length ? <ul className="task-review-files">
        {files.map(([path, changes]) => <li key={path}>
          <span className="task-review-path">{path}</span>
          <span>{t("chat.taskDelivery.edits", { count: changes.length })}</span>
        </li>)}
      </ul> : null}
    </section>
  );
}
