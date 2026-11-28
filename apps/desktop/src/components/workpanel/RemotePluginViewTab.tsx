import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IPC } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { pluginViewIcon } from "../../lib/plugin-view-icons";
import { IconPlug } from "../icons";
import { Button } from "../ui";
import { WorkTabEmpty } from "./WorkTabEmpty";

type Props = { pluginId: string; viewId: string; title: string; icon?: string; sessionId?: string; location?: string; blocked?: boolean };
type PanelEvent = { event: string; payload: unknown };

export function RemotePluginViewTab({ pluginId, viewId, title, icon, sessionId, location, blocked }: Props) {
  const { t } = useTranslation();
  const frame = useRef<HTMLIFrameElement>(null);
  const currentLocation = useRef(location);
  currentLocation.current = location;
  const [src, setSrc] = useState<string>();
  const [error, setError] = useState<string>();
  const [generation, reload] = useState(0);
  const ready = useRef(false);
  const deliveredLocation = useRef<string | undefined>(undefined);
  const post = (item: PanelEvent) => frame.current?.contentWindow?.postMessage({ type: "pi-plugin-view:event", ...item }, "*");

  useEffect(() => {
    const bridge = window.__piDesktopPluginViews;
    let disposed = false;
    let lease: string | undefined;
    let timeout: number | undefined;
    const queued: PanelEvent[] = [];
    ready.current = false;
    setSrc(undefined);
    setError(undefined);
    const release = () => {
      if (lease) void bridge?.close(lease).catch(() => undefined);
      lease = undefined;
    };
    const handleReady = (message: MessageEvent) => {
      const child = frame.current?.contentWindow;
      if (!child || message.source !== child || message.origin !== "null") return;
      if (message.data?.type === "pi-plugin-view:file-lines" && pluginId === "pi.file-manager" && viewId === "manager" && sessionId) {
        bridge?.addFileLines(sessionId, message.data.reference);
        return;
      }
      if (message.data?.type !== "pi-plugin-view:ready") return;
      window.clearTimeout(timeout);
      ready.current = true;
      for (const item of queued.splice(0)) post(item);
      if (currentLocation.current && deliveredLocation.current !== currentLocation.current) {
        post({ event: "view:open", payload: { path: currentLocation.current } });
        deliveredLocation.current = currentLocation.current;
      }
    };
    window.addEventListener("message", handleReady);
    const unsubscribe = window.piDesktop?.on(IPC.event.remotePluginViewEvent, (value) => {
      const item = value as PanelEvent & { pluginId: string; sessionId?: string; viewId?: string };
      if (!item || item.pluginId !== pluginId || (item.sessionId && item.sessionId !== sessionId) || (item.viewId && item.viewId !== viewId)) return;
      if (ready.current) post({ event: item.event, payload: item.payload });
      else queued.push({ event: item.event, payload: item.payload });
    });
    const retry = () => reload(value => value + 1);
    const changed = api.onPluginChanged(change => { if (!change.pluginId || change.pluginId === pluginId) retry(); });
    window.addEventListener("pi-desktop:remote-reconnected", retry);
    if (bridge) {
      void bridge.open({ pluginId, viewId, sessionId }).then(handle => {
        lease = handle.id;
        if (disposed) { release(); return; }
        const entry = new URL(handle.url);
        deliveredLocation.current = currentLocation.current;
        if (currentLocation.current) entry.searchParams.set("piViewOpen", currentLocation.current);
        setSrc(entry.href);
        timeout = window.setTimeout(() => { release(); setError(""); setSrc(undefined); }, 30_000);
      }).catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); });
    } else setError("");
    return () => {
      disposed = true;
      ready.current = false;
      window.clearTimeout(timeout);
      window.removeEventListener("message", handleReady);
      window.removeEventListener("pi-desktop:remote-reconnected", retry);
      unsubscribe?.(); changed(); release();
    };
  }, [pluginId, viewId, sessionId, generation]);

  useEffect(() => {
    if (ready.current && location && deliveredLocation.current !== location) {
      post({ event: "view:open", payload: { path: location } });
      deliveredLocation.current = location;
    }
  }, [location]);

  return <div className="work-plugin-view" aria-busy={!src && error === undefined}>
    {error !== undefined ? <WorkTabEmpty icon={pluginViewIcon(icon) ?? IconPlug} title={title}>
      <Button size="sm" variant="ghost" title={error || t("panel.pluginView.failed")} onClick={() => reload(value => value + 1)}>{t("updates.retry")}</Button>
    </WorkTabEmpty> : src ? <iframe ref={frame} className="work-plugin-view-frame" src={src} title={title}
      sandbox="allow-scripts allow-forms allow-downloads" referrerPolicy="no-referrer" inert={blocked} /> : null}
  </div>;
}
