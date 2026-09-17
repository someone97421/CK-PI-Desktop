import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";
import { IconMonitor } from "./icons";
import { TooltipButton } from "./ui";

/** 入口在宿主侧栏，管理面板及监听仍由已安装的远程插件拥有。 */
export function RemoteAccessButton() {
  const { t } = useTranslation();
  const [status, setStatus] = useState({ available: false, running: false, failed: false });
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const result = await api.getRemoteAccessStatus();
        if (!disposed) setStatus({ ...result, failed: !!result.failed });
      } catch {
        if (!disposed) setStatus((previous) => ({ ...previous, running: false, failed: true }));
      } finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    const unsubscribe = api.onPluginChanged(() => void refresh());
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);
  if (!status.available) return null;
  const label = t(status.failed ? "nav.remoteUnavailable" : status.running ? "nav.remoteOn" : "nav.remoteOff");
  return (
    <TooltipButton type="button" className="footer-action remote-access-action" tooltip={label} ariaLabel={label}
      disabled={opening} data-nav="remote-access" onClick={() => {
        setOpening(true);
        void api.openPluginPanel("local.lan-remote-control")
          .catch((error) => useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" }))
          .finally(() => setOpening(false));
      }}>
      <IconMonitor size={14} aria-hidden />
      <span className={`remote-access-dot ${status.running ? "is-on" : "is-off"}`} aria-hidden />
    </TooltipButton>
  );
}
