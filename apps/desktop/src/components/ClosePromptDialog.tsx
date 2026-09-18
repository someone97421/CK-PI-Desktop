import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { Button, portalOverlay } from "./ui";

/** 关闭与退出确认沿用应用主题，选择仍由主进程执行。 */
export function ClosePromptDialog() {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState<{ id: string; kind: "close" | "quit" } | null>(null);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const responding = useRef(false);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => api.onClosePrompt((next) => {
    responding.current = false;
    setError("");
    setPrompt(next);
  }), []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (prompt && dialog && !dialog.open) dialog.showModal();
  }, [prompt]);

  async function respond(choice: "tray" | "quit" | null) {
    if (!prompt || responding.current) return;
    responding.current = true;
    try {
      await api.respondClosePrompt(prompt.id, choice);
      dialogRef.current?.close();
      setPrompt(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      responding.current = false;
    }
  }

  if (!prompt) return null;
  return portalOverlay(
    <dialog ref={dialogRef} className="dialog close-prompt-dialog"
      aria-labelledby={titleId} aria-describedby={bodyId}
      onCancel={(event) => { event.preventDefault(); void respond(null); }}>
      <h2 id={titleId}>{t(prompt.kind === "close" ? "tray.askTitle" : "tray.confirmQuitTitle")}</h2>
      <p id={bodyId}>{t(prompt.kind === "close" ? "tray.askBody" : "tray.confirmQuitBody")}</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="close-prompt-actions">
        <Button autoFocus variant="ghost" onClick={() => void respond(null)}>{t("common.cancel")}</Button>
        <Button variant={prompt.kind === "quit" ? "primary" : "secondary"}
          onClick={() => void respond("quit")}>{t(prompt.kind === "close" ? "tray.quit" : "tray.confirmQuit")}</Button>
        {prompt.kind === "close" ? <Button variant="primary" onClick={() => void respond("tray")}>
          {t("tray.closeToTray")}
        </Button> : null}
      </div>
    </dialog>,
  );
}
