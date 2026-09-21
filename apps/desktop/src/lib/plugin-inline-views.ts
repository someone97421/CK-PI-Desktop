import { useSyncExternalStore } from "react";
import type { PluginInlineViewMeta } from "@pi-desktop/shared";
import { api } from "./api";
import { useAppStore } from "../stores/app-store";

const empty = { views: [] as PluginInlineViewMeta[], revision: 0, error: "" };
let snapshot = empty;
let generation = 0;
let dispose: (() => void) | undefined;
const listeners = new Set<() => void>();

function publish(next: typeof snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

async function refresh() {
  const request = ++generation;
  publish({ views: [], revision: request, error: "" });
  try {
    const views = await api.listPluginInlineViews();
    if (request === generation) publish({ views, revision: request, error: "" });
  } catch (error) {
    if (request === generation) publish({ views: [], revision: request, error: error instanceof Error ? error.message : String(error) });
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const offPlugin = api.onPluginChanged(() => { void refresh(); });
    const offWorkspace = useAppStore.subscribe((state, previous) => {
      if (state.workspace?.path !== previous.workspace?.path) void refresh();
    });
    dispose = () => { offPlugin(); offWorkspace(); };
    void refresh();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      dispose?.();
      dispose = undefined;
      generation += 1;
      snapshot = empty;
    }
  };
}

/** 所有工具行共享一次贡献目录订阅；停用或重载时立即卸载旧内容。 */
export function usePluginInlineViews() {
  return useSyncExternalStore(subscribe, () => snapshot, () => empty);
}
