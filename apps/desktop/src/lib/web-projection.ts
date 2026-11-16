export type ProjectionLayer = "projects" | "chat" | "workpanel";

export function webProjectionEnabled(dataset: { webRemote?: string; lanProjection?: string }) {
  return dataset.webRemote === "true" && dataset.lanProjection === "true";
}

export function projectionLayerFor(
  sidebarCollapsed: boolean,
  presentedWorkPanelOpen: boolean,
  workPanelExiting: boolean,
): ProjectionLayer {
  return !sidebarCollapsed ? "projects"
    : presentedWorkPanelOpen || workPanelExiting ? "workpanel" : "chat";
}

export function projectionNavigationLayer(event: Event): ProjectionLayer | null {
  const layer = (event as CustomEvent<{ layer?: unknown }>).detail?.layer;
  return layer === "projects" || layer === "chat" || layer === "workpanel" ? layer : null;
}

type ProjectionState = { ready: boolean; layer: ProjectionLayer; page: string; navigationRejected?: boolean };

export function publishProjectionState(target: EventTarget, state: ProjectionState) {
  target.dispatchEvent(new CustomEvent("pi-desktop:projection-state", { detail: state }));
}

export function listenProjectionNavigation(
  target: EventTarget,
  state: ProjectionState,
  navigate: (layer: ProjectionLayer) => boolean,
) {
  const listener = (event: Event) => {
    const layer = projectionNavigationLayer(event);
    if (!layer) return;
    if (layer === state.layer) publishProjectionState(target, state);
    else if (!navigate(layer)) publishProjectionState(target, { ...state, navigationRejected: true });
  };
  target.addEventListener("pi-desktop:projection-navigate", listener);
  return () => target.removeEventListener("pi-desktop:projection-navigate", listener);
}
