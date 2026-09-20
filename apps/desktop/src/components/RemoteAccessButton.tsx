import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";
import { IconKeyboard, IconMonitor } from "./icons";
import { TooltipButton } from "./ui";

const entries = {
  remote: {
    pluginId: "local.lan-remote-control",
    nav: "remote-access",
    readStatus: api.getRemoteAccessStatus,
    Icon: IconMonitor,
    labels: { on: "nav.remoteOn", off: "nav.remoteOff", starting: "nav.remoteOn", failed: "nav.remoteUnavailable" },
  },
  computer: {
    pluginId: "cn.star.computer-use",
    nav: "computer-use",
    readStatus: api.getComputerUseStatus,
    Icon: IconKeyboard,
    labels: { on: "nav.computerUseOn", off: "nav.computerUseOff", starting: "nav.computerUseStarting", failed: "nav.computerUseUnavailable" },
  },
} as const;

type Status = { available: boolean; running: boolean; starting?: boolean; failed?: boolean };

/** 入口在宿主侧栏，管理面板及启停仍由插件拥有。 */
export function RemoteAccessButton({ kind = "remote" }: { kind?: keyof typeof entries }) {
  const { t } = useTranslation();
  const entry = entries[kind];
  const [status, setStatus] = useState<Status>({ available: false, running: false });
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const result = await entry.readStatus();
        if (!disposed) setStatus(result);
      } catch {
        if (!disposed) setStatus((previous) => ({ ...previous, running: false, starting: false, failed: true }));
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
  }, [entry]);
  if (!status.available) return null;
  const state = status.failed ? "failed" : status.starting ? "starting" : status.running ? "on" : "off";
  const label = t(entry.labels[state]);
  const Icon = entry.Icon;
  return (
    <TooltipButton type="button" className="footer-action remote-access-action" tooltip={label} ariaLabel={label}
      disabled={opening} data-nav={entry.nav} onClick={() => {
        setOpening(true);
        void api.openPluginPanel(entry.pluginId)
          .catch((error) => useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" }))
          .finally(() => setOpening(false));
      }}>
      <Icon size={14} aria-hidden />
      <span className={`remote-access-dot is-${state}`} aria-hidden />
    </TooltipButton>
  );
}
