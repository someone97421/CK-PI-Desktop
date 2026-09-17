import type { TFunction } from "i18next";
import { TooltipButton } from "../../../components/ui";
import {
  IconArrowDown,
  IconArrowUp,
  IconFolder,
  IconPencil,
  IconX,
} from "../../../components/icons";
import type { ComposerDropItem } from "../../../lib/composer-drop";
import {
  isPendingQueuedPrompt,
  type QueuedPrompt,
  type QueuedPromptDirection,
} from "../../../lib/queued-prompts";
import { requestTextWithoutAnnotations } from "../../../lib/response-annotations";

export type ComposerStatusProps = {
  t: TFunction;
  queuedPrompts: readonly QueuedPrompt[];
  removeQueuedPrompt: (id: string) => void;
  moveQueuedPrompt: (id: string, direction: QueuedPromptDirection) => Promise<void>;
  editQueuedPrompt: (id: string) => void;
  sendQueuedNow: (id: string) => Promise<void>;
  approvalPending: boolean;
  enhancementError: { message: string; code: string } | null;
  clearEnhancementError: () => void;
  droppedDirectories: ComposerDropItem[];
  openDroppedFolderAsProject: () => Promise<void>;
  insertDroppedDirectoryPaths: () => void;
  dismissDroppedDirectories: () => void;
};

/** Non-editor composer status rows: queue, enhancement errors, and folder drops. */
export function ComposerStatus({
  t,
  queuedPrompts,
  removeQueuedPrompt,
  moveQueuedPrompt,
  editQueuedPrompt,
  sendQueuedNow,
  approvalPending,
  enhancementError,
  clearEnhancementError,
  droppedDirectories,
  openDroppedFolderAsProject,
  insertDroppedDirectoryPaths,
  dismissDroppedDirectories,
}: ComposerStatusProps) {
  return (
    <>
      {queuedPrompts.length ? (
        <div
          className="composer-queued-prompts"
          role="list"
          aria-label={t("chat.queuedPrompts")}
        >
          {queuedPrompts.map((item) => {
            const label =
              requestTextWithoutAnnotations(item.content).trim() ||
              item.draft.fileReferences.map((reference) => reference.name).join(", ") ||
              t("chat.queuedPromptEmpty");
            const pending = isPendingQueuedPrompt(item) || item.sendPending === true;
            // Send now locks only while its own request is in flight: a row the
            // Host already promoted locally must not stay locked, and neither
            // must a row whose steering request just finished.
            const sendNowLocked = approvalPending || pending;
            const actionLocked = approvalPending || pending;
            const editOrMoveLocked = actionLocked || item.priority !== undefined;
            return (
              <div
                key={item.id}
                className="composer-queued-prompt"
                role="listitem"
                data-testid="queued-prompt"
                data-priority={item.priority !== undefined ? "true" : "false"}
              >
                <span className="composer-queued-prompt-text" title={label}>
                  {label}
                </span>
                <TooltipButton
                  type="button"
                  className="composer-queued-prompt-action composer-queued-prompt-move-up"
                  tooltip={t("chat.moveQueuedPromptUp")}
                  ariaLabel={t("chat.moveQueuedPromptUp")}
                  disabled={editOrMoveLocked}
                  aria-disabled={editOrMoveLocked}
                  onClick={() => void moveQueuedPrompt(item.id, "up")}
                >
                  <IconArrowUp size={13} aria-hidden />
                </TooltipButton>
                <TooltipButton
                  type="button"
                  className="composer-queued-prompt-action composer-queued-prompt-move-down"
                  tooltip={t("chat.moveQueuedPromptDown")}
                  ariaLabel={t("chat.moveQueuedPromptDown")}
                  disabled={editOrMoveLocked}
                  aria-disabled={editOrMoveLocked}
                  onClick={() => void moveQueuedPrompt(item.id, "down")}
                >
                  <IconArrowDown size={13} aria-hidden />
                </TooltipButton>
                <button
                  type="button"
                  className="composer-queued-prompt-send-now"
                  disabled={sendNowLocked}
                  aria-disabled={sendNowLocked}
                  onClick={() => void sendQueuedNow(item.id)}
                >
                  {pending ? t("chat.sendNowPending") : t("chat.sendNow")}
                </button>
                <TooltipButton
                  type="button"
                  className="composer-queued-prompt-action composer-queued-prompt-edit"
                  tooltip={t("chat.editQueuedPrompt")}
                  ariaLabel={t("chat.editQueuedPrompt")}
                  disabled={editOrMoveLocked}
                  aria-disabled={editOrMoveLocked}
                  onClick={() => editQueuedPrompt(item.id)}
                >
                  <IconPencil size={13} aria-hidden />
                </TooltipButton>
                <TooltipButton
                  type="button"
                  className="composer-queued-prompt-action composer-queued-prompt-remove"
                  tooltip={t("chat.removeQueuedPrompt")}
                  ariaLabel={t("chat.removeQueuedPrompt")}
                  disabled={actionLocked}
                  aria-disabled={actionLocked}
                  onClick={() => removeQueuedPrompt(item.id)}
                >
                  <IconX size={13} aria-hidden />
                </TooltipButton>
              </div>
            );
          })}
        </div>
      ) : null}
      {enhancementError ? (
        <div className="composer-enhancement-error" role="alert">
          <span className="composer-enhancement-error-message">
            {t("chat.enhancementFailed")}: {enhancementError.message}
          </span>
          <code>{enhancementError.code}</code>
          <TooltipButton
            type="button"
            className="composer-enhancement-error-dismiss"
            tooltip={t("chat.dismissEnhancementError")}
            ariaLabel={t("chat.dismissEnhancementError")}
            onClick={clearEnhancementError}
          >
            <IconX size={13} aria-hidden="true" />
          </TooltipButton>
        </div>
      ) : null}
      {droppedDirectories.length ? (
        <div className="composer-directory-drop" role="status">
          <IconFolder size={13} aria-hidden />
          <span className="composer-directory-drop-name">
            {t("project.droppedFolder", {
              count: droppedDirectories.length,
              defaultValue: "Folder dropped",
            })}
          </span>
          <button
            type="button"
            className="composer-directory-drop-action"
            data-action="open-dropped-folder-project"
            onClick={() => void openDroppedFolderAsProject()}
          >
            {t("project.openAsProject", { defaultValue: "Open as project" })}
          </button>
          <button
            type="button"
            className="composer-directory-drop-action"
            data-action="reference-dropped-folder"
            onClick={insertDroppedDirectoryPaths}
          >
            {t("project.referenceFolder", { defaultValue: "Reference folder" })}
          </button>
          <TooltipButton
            type="button"
            className="composer-directory-drop-dismiss"
            tooltip={t("nav.dismissFolderDrop")}
            ariaLabel={t("nav.dismissFolderDrop")}
            onClick={dismissDroppedDirectories}
          >
            <IconX size={13} aria-hidden />
          </TooltipButton>
        </div>
      ) : null}
    </>
  );
}
