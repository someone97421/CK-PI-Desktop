export type ProjectionLayer = "projects" | "chat" | "workpanel";
export type ProjectionDestinationLayer = ProjectionLayer | "settings-directory" | "settings-detail";

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

function projectionDestination(event: Event) {
  const detail = (event as CustomEvent<{ layer?: unknown; settingsTarget?: unknown }>).detail;
  const layer = detail?.layer;
  if (layer !== "projects" && layer !== "chat" && layer !== "workpanel"
    && layer !== "settings-directory" && layer !== "settings-detail") return null;
  const settingsTarget = layer === "settings-detail" && typeof detail?.settingsTarget === "string"
    ? detail.settingsTarget || undefined : undefined;
  return { layer, settingsTarget } as const;
}

export function projectionNavigationLayer(event: Event): ProjectionDestinationLayer | null {
  return projectionDestination(event)?.layer ?? null;
}

export type ProjectionState = {
  ready: boolean;
  layer: ProjectionDestinationLayer;
  page: string;
  settingsTarget?: string;
  navigationRejected?: boolean;
};

export function backFromProjectionSettings() {
  return !window.dispatchEvent(new Event("pi-desktop:projection-settings-back", { cancelable: true }));
}

export function publishProjectionState(target: EventTarget, state: ProjectionState) {
  target.dispatchEvent(new CustomEvent("pi-desktop:projection-state", { detail: state }));
}

export function listenProjectionNavigation(
  target: EventTarget,
  state: ProjectionState,
  navigate: (layer: ProjectionDestinationLayer, settingsTarget?: string) => boolean,
) {
  const listener = (event: Event) => {
    const destination = projectionDestination(event);
    if (!destination) return;
    const { layer, settingsTarget } = destination;
    if (layer === state.layer && (settingsTarget === undefined || settingsTarget === state.settingsTarget)) {
      publishProjectionState(target, state);
    } else if (!navigate(layer, settingsTarget)) {
      publishProjectionState(target, { ...state, navigationRejected: true });
    }
  };
  target.addEventListener("pi-desktop:projection-navigate", listener);
  return () => target.removeEventListener("pi-desktop:projection-navigate", listener);
}
