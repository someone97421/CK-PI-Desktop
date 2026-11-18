import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAppStore } from "../../stores/app-store";
import { backFromProjectionSettings, listenProjectionNavigation, publishProjectionState, type ProjectionLayer } from "../../lib/web-projection";
import {
  getCompactSettingsNavigation, requestCompactSettingsNavigation, subscribeCompactSettingsNavigation,
  type CompactSettingsLayer,
} from "../settings/compact-settings-navigation";

type Destination = ProjectionLayer | CompactSettingsLayer;
const selectors: Record<ProjectionLayer, string> = { projects: ".sidebar", chat: ".main-pane", workpanel: ".work-panel, .compact-panel-back" };
const focusable = 'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]';
function visible(node: HTMLElement | undefined): node is HTMLElement {
  return !!node?.isConnected && !node.closest('[hidden], [inert], [aria-hidden="true"]') && node.getClientRects().length > 0;
}
function overlayOpen() {
  return Array.from(document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"][aria-modal="true"], [role="menu"], [role="listbox"]')).some(visible);
}

export function useCompactHistory({ compact, projection, ready, page, layer, setLayer }: {
  compact: boolean; projection: boolean; ready: boolean; page: string; layer: ProjectionLayer; setLayer: (layer: ProjectionLayer) => void;
}) {
  const settings = useSyncExternalStore(subscribeCompactSettingsNavigation, getCompactSettingsNavigation);
  const current = page === "settings" ? settings.layer : layer;
  useLayoutEffect(() => useAppStore.subscribe((next, prev) => {
    if (next.page !== "settings") {
      if (prev.page === "settings") requestCompactSettingsNavigation("settings-directory");
      return;
    }
    if (next.settingsTabNonce !== prev.settingsTabNonce || (next.settingsAnchor && next.settingsAnchor !== prev.settingsAnchor)) {
      const anchor = next.settingsAnchor ? `#${next.settingsAnchor}` : "";
      requestCompactSettingsNavigation("settings-detail", `builtin:${next.settingsTab}${anchor}`);
    }
  }), []);
  const settingsTarget = current === "settings-detail" ? settings.settingsTarget : undefined;
  const [initialized, setInitialized] = useState(false);
  useLayoutEffect(() => {
    if (!projection || !ready || initialized) return;
    useAppStore.getState().setPage("chat", { record: false });
    setLayer(window.__piDesktopBrowseAction ? "chat" : "projects");
    setInitialized(true);
  }, [projection, ready, initialized, setLayer]);

  const navigate = useCallback((destination: Destination, target?: string) => {
    const store = useAppStore.getState();
    if (destination === "settings-directory" || destination === "settings-detail") {
      requestCompactSettingsNavigation(destination, target);
      if (store.page !== "settings") store.setPage("settings");
    } else {
      if (destination === "workpanel" && !store.activeSessionId) return false;
      if (store.page !== "chat") store.setPage("chat");
      if (destination === "workpanel" && !store.workPanelOpen && !store.subagentPanel) store.openWorkPanel();
      setLayer(destination);
    }
    return true;
  }, [setLayer]);

  useEffect(() => {
    if (!projection || !ready || !initialized) return;
    return listenProjectionNavigation(window, { ready, page, layer: current, settingsTarget }, navigate);
  }, [projection, ready, initialized, page, current, settingsTarget, navigate]);
  useEffect(() => {
    if (projection && ready && initialized) publishProjectionState(window, { ready, page, layer: current, settingsTarget });
  }, [projection, ready, initialized, page, current, settingsTarget]);

  const remembered = useRef(new Map<ProjectionLayer, HTMLElement>());
  useEffect(() => {
    if (!compact || !ready) return;
    const paneSelector = current === "settings-detail" || current === "settings-directory" ? null : selectors[current];
    const elements = () => Array.from(document.querySelectorAll<HTMLElement>(focusable)).filter(el => paneSelector && el.closest(paneSelector) && visible(el));
    const frame = requestAnimationFrame(() => {
      if (!paneSelector || overlayOpen() || document.activeElement?.closest(paneSelector)) return;
      const previous = remembered.current.get(layer);
      const target = visible(previous) && previous.closest(paneSelector) ? previous : elements()[0];
      target?.focus({ preventScroll: true });
    });
    const remember = (event: FocusEvent) => {
      if (paneSelector && event.target instanceof HTMLElement && event.target.closest(paneSelector)) remembered.current.set(layer, event.target);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || (event.key !== "Escape" && event.key !== "Tab") || overlayOpen()) return;
      if (event.key === "Escape") {
        if (current === "projects" || (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]'))) return;
        event.preventDefault();
        if (current === "settings-directory" && backFromProjectionSettings()) return;
        navigate(current === "settings-detail" ? "settings-directory" : current === "chat" ? "projects" : "chat");
      } else if (current === "workpanel" && projection) {
        const items = elements();
        const end = event.shiftKey ? items[0] : items.at(-1);
        if (end && (document.activeElement === end || !items.includes(document.activeElement as HTMLElement))) {
          event.preventDefault();
          (event.shiftKey ? items.at(-1) : items[0])?.focus();
        }
      }
    };
    document.addEventListener("focusin", remember);
    window.addEventListener("keydown", keydown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", remember);
      window.removeEventListener("keydown", keydown);
    };
  }, [compact, ready, current, page, layer, projection, navigate]);
}
