import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { TooltipButton } from "./ui";

/**
 * Renderer-drawn window controls for Windows/Linux (D-frameless chrome).
 *
 * macOS keeps native inset traffic lights; other platforms run a frameless
 * window. Controls sit at the shell level so work-panel stacking contexts
 * cannot cover them; each button has a square hit target in the titlebar.
 */
export function WindowControls({
  contained = false,
}: {
  contained?: boolean;
} = {}) {
  const { t } = useTranslation();
  const platform = window.piDesktop?.platform ?? "darwin";
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (platform === "darwin") return;
    let mounted = true;
    void api.windowControl("getState").then((state) => {
      if (mounted) setMaximized(state.maximized);
    }).catch(() => undefined);
    const unsubscribe = api.onWindowMaximized((e) =>
      setMaximized(e.maximized),
    );
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [platform]);

  if (platform === "darwin") return null;

  return (
    <div
      className={`window-controls no-drag${
        contained ? " window-controls-in-pane" : ""
      }`}
    >
      <TooltipButton
        type="button"
        className="window-control-btn"
        tooltip={t("window.minimize", "Minimize")}
        ariaLabel={t("window.minimize", "Minimize")}
        onClick={() => void api.windowControl("minimize")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
          <path d="M1 6h10" />
        </svg>
      </TooltipButton>
      <TooltipButton
        type="button"
        className="window-control-btn"
        tooltip={
          maximized
            ? t("window.restore", "Restore")
            : t("window.maximize", "Maximize")
        }
        ariaLabel={
          maximized
            ? t("window.restore", "Restore")
            : t("window.maximize", "Maximize")
        }
        onClick={() =>
          void api.windowControl("toggleMaximize").then((r) =>
            setMaximized(r.maximized),
          )
        }
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
          {maximized ? (
            <><path d="M4 3V1.5h6.5V8H9" /><rect x="1.5" y="4" width="6.5" height="6.5" rx=".5" /></>
          ) : (
            <rect x="1.5" y="1.5" width="9" height="9" rx=".5" />
          )}
        </svg>
      </TooltipButton>
      <TooltipButton
        type="button"
        className="window-control-btn window-control-close"
        tooltip={t("window.close", "Close")}
        ariaLabel={t("window.close", "Close")}
        onClick={() => void api.windowControl("close")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
          <path d="m2 2 8 8m0-8-8 8" />
        </svg>
      </TooltipButton>
    </div>
  );
}
