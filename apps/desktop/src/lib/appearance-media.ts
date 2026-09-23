import { useEffect, useSyncExternalStore } from "react";
import { IPC, type AppearanceMediaState } from "@pi-desktop/shared";
import { api } from "./api";

const empty: AppearanceMediaState = { icon: null, home: null };
let state = empty;
let loaded = false;
let pending: Promise<void> | null = null;
let revision = 0;
const listeners = new Set<() => void>();
let unsubscribeMedia: (() => void) | undefined;

function subscribe(listener: () => void) {
  if (!listeners.size) {
    unsubscribeMedia = window.piDesktop?.on(IPC.event.appearanceMediaChanged, (payload) => {
      setAppearanceMedia(payload as AppearanceMediaState);
    });
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      unsubscribeMedia?.();
      unsubscribeMedia = undefined;
      loaded = false;
    }
  };
}

function notify() {
  for (const listener of listeners) listener();
}

export function setAppearanceMedia(next: AppearanceMediaState) {
  revision++;
  state = next;
  loaded = true;
  notify();
}

export function refreshAppearanceMedia(): Promise<void> {
  if (pending) return pending;
  const requestedRevision = revision;
  pending = api.getAppearanceMedia().then((next) => {
    if (requestedRevision === revision) setAppearanceMedia(next);
  }).finally(() => { pending = null; });
  return pending;
}

export function useAppearanceMedia() {
  const value = useSyncExternalStore(
    subscribe,
    () => state,
  );
  useEffect(() => {
    if (!loaded) void refreshAppearanceMedia().catch(() => undefined);
  }, []);
  return value;
}
