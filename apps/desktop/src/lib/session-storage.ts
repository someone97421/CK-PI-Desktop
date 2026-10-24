import type { SessionStorageUsage } from "@pi-desktop/shared";

export const SESSION_STORAGE_UPDATED_EVENT = "pi-desktop:session-storage-updated";

type SessionStorageUpdatedDetail = {
  id: string;
  usage: SessionStorageUsage;
};

export function formatSessionBytes(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`;
}

export function notifySessionStorageUpdated(id: string, usage: SessionStorageUsage): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<SessionStorageUpdatedDetail>(
    SESSION_STORAGE_UPDATED_EVENT,
    { detail: { id, usage } },
  ));
}

export function onSessionStorageUpdated(
  listener: (detail: SessionStorageUpdatedDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onEvent = (event: Event) => {
    const detail = (event as CustomEvent<SessionStorageUpdatedDetail>).detail;
    if (detail?.id && detail.usage) listener(detail);
  };
  window.addEventListener(SESSION_STORAGE_UPDATED_EVENT, onEvent);
  return () => window.removeEventListener(SESSION_STORAGE_UPDATED_EVENT, onEvent);
}
