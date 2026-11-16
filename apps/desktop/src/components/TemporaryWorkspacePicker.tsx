import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";
import { IconFolder, IconRefresh, IconX } from "./icons";
import { TooltipButton } from "./ui";

export function TemporaryWorkspacePicker({
  path,
  editable,
}: {
  path: string | null;
  editable: boolean;
}) {
  const { t } = useTranslation();
  const setDraftTemporaryWorkspacePath = useAppStore(
    (state) => state.setDraftTemporaryWorkspacePath,
  );
  const showToast = useAppStore((state) => state.showToast);
  const [busy, setBusy] = useState(false);

  const choose = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.pickProjectFolders({
        single: true,
        defaultPath: path ?? undefined,
      });
      const nextPath = result.folders[0]?.trim();
      if (nextPath) setDraftTemporaryWorkspacePath(nextPath);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  if (!editable && !path) return null;

  return (
    <div className="temporary-workspace-picker" data-testid="temporary-workspace-picker">
      {path ? (
        <span className="temporary-workspace-path" title={path}>
          {path}
        </span>
      ) : null}
      {editable ? (
        <div className="temporary-workspace-actions">
          <TooltipButton
            type="button"
            className="temporary-workspace-button"
            tooltip={t(path ? "chat.changeTemporaryWorkspace" : "chat.chooseTemporaryWorkspace")}
            ariaLabel={t(path ? "chat.changeTemporaryWorkspace" : "chat.chooseTemporaryWorkspace")}
            disabled={busy}
            onClick={() => void choose()}
          >
            {path ? <IconRefresh size={15} /> : <IconFolder size={15} />}
          </TooltipButton>
          {path ? (
            <TooltipButton
              type="button"
              className="temporary-workspace-button"
              tooltip={t("chat.clearTemporaryWorkspace")}
              ariaLabel={t("chat.clearTemporaryWorkspace")}
              disabled={busy}
              onClick={() => setDraftTemporaryWorkspacePath(null)}
            >
              <IconX size={15} />
            </TooltipButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
