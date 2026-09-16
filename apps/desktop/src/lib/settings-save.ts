import type { AppSettings } from "@pi-desktop/shared";
import { api } from "./api";
import { useAppStore } from "../stores/app-store";

type SettingKey = keyof AppSettings;
type PendingEdit = {
  baseline: { value: AppSettings[SettingKey] };
  value: AppSettings[SettingKey];
};

// Navigation must not adopt optimistic values as persisted defaults or start
// a second writer. This state belongs to the renderer, not the settings page.
let queue: Promise<unknown> = Promise.resolve();
let revision = 0;
const pending = new Map<SettingKey, PendingEdit>();
let saveError = false;
const listeners = new Set<() => void>();

export const getSettingsSaveError = () => saveError;
export function subscribeSettingsSaveError(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function reportError(value: boolean) {
  if (saveError === value) return;
  saveError = value;
  for (const listener of listeners) listener();
}

export function saveSettingsPatch(patch: Partial<AppSettings>): Promise<void> {
  const current = useAppStore.getState().settings;
  if (!current) return Promise.resolve();
  for (const key of Object.keys(patch) as SettingKey[]) {
    const previous = pending.get(key);
    // An intervening external update starts a new local edit chain.
    const baseline = previous && current[key] === previous.value
      ? previous.baseline
      : { value: current[key] };
    pending.set(key, { baseline, value: patch[key] });
  }
  useAppStore.setState({ settings: { ...current, ...patch } });
  reportError(false);
  const writeRevision = ++revision;
  const write = queue.then(async () => {
    if (writeRevision !== revision) return;
    const snapshot = useAppStore.getState().settings;
    if (!snapshot) return;
    for (const [key, edit] of pending) {
      if (snapshot[key] !== edit.value) pending.delete(key);
    }
    const sent = new Map(pending);
    if (!sent.size) return;
    try {
      // Host shallow-merges fields and returns only { ok: true }. The panel
      // has already assembled the complete appearance value from live state.
      // API validation normalizes top-level fields in place; do not mutate the
      // live store or the identities used to recognize our optimistic edits.
      await api.setSettings({ ...snapshot });
      for (const [key, edit] of sent) {
        edit.baseline.value = snapshot[key];
        if (pending.get(key) === edit) pending.delete(key);
      }
      if (writeRevision === revision) reportError(false);
    } catch (error) {
      if (writeRevision === revision) {
        const latest = useAppStore.getState().settings;
        if (latest) {
          const rollback = Object.fromEntries([...pending]
            .filter(([key, edit]) => latest[key] === edit.value)
            .map(([key, edit]) => [key, edit.baseline.value]));
          useAppStore.setState({ settings: { ...latest, ...rollback } });
        }
        pending.clear();
        reportError(true);
      }
      throw error;
    }
  });
  queue = write.catch(() => undefined);
  return write;
}
