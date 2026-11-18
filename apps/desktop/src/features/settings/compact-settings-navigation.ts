import { SETTINGS_NAV, type SettingsTabId } from "../../lib/settings-search";

export type CompactSettingsLayer = "settings-directory" | "settings-detail";

type CompactSettingsNavigation = Readonly<{
  layer: CompactSettingsLayer;
  settingsTarget?: string;
}>;

type SettingsDestination =
  | { kind: "builtin"; tab: SettingsTabId; anchor?: string }
  | { kind: "extension"; ref: string };

export function parseCompactSettingsTarget(target?: string): SettingsDestination | undefined {
  if (target?.startsWith("extension:")) {
    const ref = target.slice("extension:".length);
    return ref ? { kind: "extension", ref } : undefined;
  }
  if (!target?.startsWith("builtin:")) return;
  const [id, anchor] = target.slice("builtin:".length).split("#", 2);
  const tab = SETTINGS_NAV.find((entry) => entry.id === id)?.id;
  if (tab) return { kind: "builtin", tab, anchor: anchor || undefined };
}

let navigation: CompactSettingsNavigation = { layer: "settings-directory" };
const listeners = new Set<() => void>();

export function getCompactSettingsNavigation() {
  return navigation;
}

export function subscribeCompactSettingsNavigation(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function requestCompactSettingsNavigation(layer: CompactSettingsLayer, settingsTarget?: string) {
  if (layer === navigation.layer && settingsTarget === navigation.settingsTarget) return;
  navigation = { layer, settingsTarget };
  for (const listener of listeners) listener();
}
