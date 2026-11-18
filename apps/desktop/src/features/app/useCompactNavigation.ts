import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useAppStore } from "../../stores/app-store";
import type { ProjectionLayer } from "../../lib/web-projection";

export function useCompactNavigation(compact: boolean, sidebarCollapsed: boolean) {
  const [layer, setLayer] = useState<ProjectionLayer>("chat");
  const lastPane = useRef<ProjectionLayer>("chat");
  const showChat = useCallback(() => setLayer("chat"), []);

  useLayoutEffect(() => {
    if (compact) {
      const state = useAppStore.getState();
      const panelVisible = state.page === "chat" && (state.workPanelOpen || state.subagentPanel);
      let destination = lastPane.current;
      if ((destination === "projects" && sidebarCollapsed) || (destination === "workpanel" && !panelVisible)) {
        destination = "chat";
      }
      setLayer(destination);
    }
    const remember = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const pane = event.target.closest(".main-pane, .work-panel, .sidebar");
      if (pane?.matches(".sidebar")) lastPane.current = "projects";
      else if (pane?.matches(".work-panel")) lastPane.current = "workpanel";
      else if (pane) lastPane.current = "chat";
    };
    if (!compact) {
      document.addEventListener("pointerdown", remember, true);
      document.addEventListener("focusin", remember, true);
    }
    const unsubscribe = useAppStore.subscribe((next, prev) => {
      if (next.page === "settings") return;
      let destination: ProjectionLayer;
      if (next.page !== prev.page || next.activeSessionId !== prev.activeSessionId) {
        destination = "chat";
      } else if (next.page === "chat" && (
        next.workPanelRevealNonce !== prev.workPanelRevealNonce ||
        (next.subagentPanel && next.subagentPanel !== prev.subagentPanel)
      )) {
        destination = "workpanel";
      } else if (lastPane.current === "workpanel" && (prev.workPanelOpen || prev.subagentPanel) &&
        !next.workPanelOpen && !next.subagentPanel) {
        destination = "chat";
      } else {
        return;
      }
      lastPane.current = destination;
      if (compact) setLayer(destination);
    });
    return () => {
      unsubscribe();
      document.removeEventListener("pointerdown", remember, true);
      document.removeEventListener("focusin", remember, true);
    };
  }, [compact, sidebarCollapsed]);

  useLayoutEffect(() => {
    if (compact) lastPane.current = layer;
  }, [compact, layer]);
  return { layer, setLayer, showChat };
}
