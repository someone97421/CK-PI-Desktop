import { useId, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { ReviewChange, UiMessage } from "@pi-desktop/shared";
import { reviewChangesFromMessages } from "../../../lib/workspace-review";
import { IconDiff } from "../../../components/icons";
import "./task-delivery.css";

/** 读取消息自带的不可变证据，不读取当前工作树，也不调用模型或回滚接口。 */
export function TaskReviewCard({ messages }: { messages: UiMessage[] }) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const noteId = useId();
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
        <button ref={triggerRef} type="button" className="task-review-open"
          disabled={files.length === 0} aria-haspopup="dialog"
          onClick={() => dialogRef.current?.showModal()}>
          {t("chat.taskDelivery.review")}
        </button>
      </div>
      <p className="task-review-note">{t("chat.taskDelivery.scope")}</p>
      {untracked ? <p className="task-review-note">{t("chat.taskDelivery.missingEvidence")}</p> : null}
      {files.length ? <ul className="task-review-files">
        {files.map(([path, changes]) => <li key={path}>
          <span className="task-review-path">{path}</span>
          <span>{t("chat.taskDelivery.edits", { count: changes.length })}</span>
        </li>)}
      </ul> : null}
      <dialog ref={dialogRef} className="task-review-dialog" aria-labelledby={titleId}
        aria-describedby={noteId} onClose={() => triggerRef.current?.focus()}>
        <header className="task-review-dialog-header">
          <h2 id={titleId}>{t("chat.taskDelivery.review")}</h2>
          <button type="button" autoFocus onClick={() => dialogRef.current?.close()}>
            {t("chat.taskDelivery.close")}
          </button>
        </header>
        <p id={noteId} className="task-review-note">{t("chat.taskDelivery.evidenceOnly")}</p>
        <div className="task-review-evidence">
          {files.map(([path, changes]) => <section key={path}>
            <h3 className="task-review-path">{path}</h3>
            {changes.map((change, index) => <details key={change.snapshotId} className="task-review-snapshot" open={changes.length === 1}>
              <summary>
                {t("chat.taskDelivery.editNumber", { number: index + 1 })}
                {" · "}{t(`panel.review.status.${change.status}`)}
                {change.state === "rolledBack" ? ` · ${t("panel.review.rolledBack")}` : ""}
                <span className="diff-counts">
                  <span className="diff-count-add">+{change.additions}</span>
                  <span className="diff-count-del">−{change.deletions}</span>
                </span>
              </summary>
              {change.binary ? <p className="review-change-note">{t("panel.review.binary")}</p>
                : change.truncated ? <p className="review-change-note">{t("panel.review.tooLarge")}</p>
                : change.hunks.length ? <div className="review-change-diff">
                  {change.hunks.map((hunk, hunkIndex) => <div className="diff-hunk" key={hunkIndex}>
                    <div className="diff-line hunk"><span className="diff-line-text">{hunk.header}</span></div>
                    {hunk.lines.map((line, lineIndex) => <div className={`diff-line ${line.type}`} key={lineIndex}>
                      <span className="diff-line-sign" aria-hidden="true">{line.type === "add" ? "+" : line.type === "del" ? "−" : " "}</span>
                      <span className="diff-line-text">{line.text}</span>
                    </div>)}
                  </div>)}
                </div> : <p className="review-change-note">{t("panel.review.noLineDetails")}</p>}
            </details>)}
          </section>)}
        </div>
      </dialog>
    </section>
  );
}
