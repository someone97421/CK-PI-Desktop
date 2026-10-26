import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { pluginViewIcon } from "../../lib/plugin-view-icons";
import { useNativeViewOcclusion } from "../../lib/native-view-occlusion";
import { useAppStore } from "../../stores/app-store";
import { IconPlug } from "../icons";
import { WorkTabEmpty } from "./WorkTabEmpty";

/**
 * A plugin-contributed work panel view (ADR 0104).
 *
 * The surface itself is a main-process `WebContentsView`, the same isolated
 * page a `ui.panel` window hosts; this component renders nothing into it. It
 * measures the placeholder rect and drives visibility. Native content yields
 * to blocking dialogs and global floating surfaces that overlap its bounds.
 */
export function PluginViewTab({
  pluginId,
  viewId,
  title,
  icon,
  blocked = false,
  sessionId,
  location,
  tabId,
}: {
  pluginId: string;
  viewId: string;
  title: string;
  icon?: string;
  blocked?: boolean;
  sessionId?: string;
  location?: string;
  tabId?: string;
}) {
  const { t } = useTranslation();
  const session = useAppStore((s) => sessionId ? s.sessions.find((item) => item.id === sessionId) : undefined);
  const draftKind = useAppStore((s) => s.draftSessionKind);
  const draftWorkspacePath = useAppStore((s) => s.draftTemporaryWorkspacePath);
  const scopedWorkspace = pluginId === "pi.file-manager" && (session ? !session.projectPath : draftKind === "temporary");
  const workspacePath = session?.temporaryWorkspacePath ?? draftWorkspacePath;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const locationRef = useRef(location);
  locationRef.current = location;
  const viewLocation = pluginId === "pi.browser" && viewId === "browser" ? undefined : location;
  const [failed, setFailed] = useState(false);
  const occluded = useNativeViewOcclusion(surfaceRef, !failed);
  const viewIdentity = JSON.stringify([pluginId, viewId, sessionId, viewLocation, tabId, scopedWorkspace, workspacePath]);
  const [readyIdentity, setReadyIdentity] = useState<string | null>(null);
  const boundsFrameRef = useRef(0);
  const reportBounds = useCallback(() => {
    // Replacing a pending frame on every commit can starve bounds updates.
    if (boundsFrameRef.current) return;
    boundsFrameRef.current = requestAnimationFrame(() => {
      boundsFrameRef.current = 0;
      const surface = surfaceRef.current;
      if (!surface || failed) return;
      const rect = surface.getBoundingClientRect();
      void api.pluginViewSetBounds({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    });
  }, [failed]);

  // ResizeObserver does not cover position-only movement caused by an ancestor
  // layout or transform. Every React layout commit supplies the final rect.
  useLayoutEffect(() => {
    reportBounds();
  });

  // Create the view, and re-create it whenever the plugin's lifecycle changed
  // underneath us: a crash, a development reload, or a re-enable all destroy
  // the previous web contents while this tab stays open.
  useEffect(() => {
    let current = true;
    const open = () => {
      setReadyIdentity(null);
      void (async () => {
        const root = scopedWorkspace && sessionId
          ? session?.temporaryWorkspacePath || (await api.getSessionScratchPath(sessionId)).path
          : workspacePath;
        if (!current) return;
        await api.pluginViewOpen(pluginId, viewId, {
          sessionId, location: locationRef.current, tabId,
          ...(scopedWorkspace ? { workspacePath: root ?? null } : {}),
        });
      })().then(
        () => {
          if (current) {
            setFailed(false);
            setReadyIdentity(viewIdentity);
          }
        },
        () => {
          if (current) setFailed(true);
        },
      );
    };
    open();
    const off = api.onPluginChanged((event) => {
      if (event?.pluginId && event.pluginId !== pluginId) return;
      open();
    });
    return () => {
      current = false;
      off();
    };
  }, [pluginId, viewId, sessionId, viewLocation, tabId, scopedWorkspace, workspacePath, viewIdentity]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || failed) return;
    void api.pluginViewSetVisible(pluginId, viewId, readyIdentity === viewIdentity && !blocked && !occluded, sessionId);
    return () => {
      void api.pluginViewSetVisible(pluginId, viewId, false);
    };
  }, [pluginId, viewId, blocked, occluded, failed, sessionId, readyIdentity, viewIdentity]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || failed) return;
    const observer = new ResizeObserver(reportBounds);
    observer.observe(surface);
    window.addEventListener("resize", reportBounds);
    reportBounds();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reportBounds);
      cancelAnimationFrame(boundsFrameRef.current);
      boundsFrameRef.current = 0;
    };
  }, [pluginId, viewId, failed, reportBounds]);

  if (failed) {
    return (
      <div className="work-plugin-view">
        <WorkTabEmpty
          icon={pluginViewIcon(icon) ?? IconPlug}
          title={title}
          body={t("panel.pluginView.failed")}
        />
      </div>
    );
  }

  return (
    <div className="work-plugin-view">
      <div ref={surfaceRef} className="work-plugin-view-surface" />
    </div>
  );
}
