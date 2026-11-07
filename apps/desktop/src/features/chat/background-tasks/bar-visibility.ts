import type { BackgroundTaskSummary } from "../../../lib/api";

export const ENDED_VISIBLE_MS = 10_000;
export type BarVisibility = {
  seenRunning: ReadonlySet<string>;
  endedAt: ReadonlyMap<string, number>;
  dismissed: ReadonlySet<string>;
};
export const EMPTY_VISIBILITY: BarVisibility = {
  seenRunning: new Set(), endedAt: new Map(), dismissed: new Set(),
};
function pruneSet(source: ReadonlySet<string>, liveIds: ReadonlySet<string>): Set<string> {
  return new Set([...source].filter((id) => liveIds.has(id)));
}
function pruneMap(source: ReadonlyMap<string, number>, liveIds: ReadonlySet<string>): Map<string, number> {
  return new Map([...source].filter(([id]) => liveIds.has(id)));
}
export function observeTasks(state: BarVisibility, tasks: readonly BackgroundTaskSummary[], now: number): BarVisibility {
  const liveIds = new Set(tasks.map((task) => task.id));
  const seenRunning = pruneSet(state.seenRunning, liveIds);
  const endedAt = pruneMap(state.endedAt, liveIds);
  const dismissed = pruneSet(state.dismissed, liveIds);
  let changed = seenRunning.size !== state.seenRunning.size || endedAt.size !== state.endedAt.size || dismissed.size !== state.dismissed.size;
  for (const task of tasks) {
    if (task.state === "running") {
      if (!seenRunning.has(task.id)) {
        seenRunning.add(task.id);
        changed = true;
      }
      if (endedAt.delete(task.id)) changed = true;
      continue;
    }
    if (seenRunning.has(task.id) && !endedAt.has(task.id)) {
      endedAt.set(task.id, now);
      changed = true;
    }
  }
  return changed ? { seenRunning, endedAt, dismissed } : state;
}
export function selectVisibleTasks(state: BarVisibility, tasks: readonly BackgroundTaskSummary[], now: number, pinnedId: string | null = null): BackgroundTaskSummary[] {
  return tasks.filter((task) => {
    if (state.dismissed.has(task.id)) return false;
    if (task.state === "running" || task.id === pinnedId) return true;
    const ended = state.endedAt.get(task.id);
    return ended !== undefined && now - ended < ENDED_VISIBLE_MS;
  });
}
export function nextExpiryAt(state: BarVisibility, tasks: readonly BackgroundTaskSummary[], now: number, pinnedId: string | null = null): number | null {
  let earliest: number | null = null;
  for (const task of selectVisibleTasks(state, tasks, now, pinnedId)) {
    if (task.id === pinnedId) continue;
    const ended = state.endedAt.get(task.id);
    if (ended === undefined) continue;
    const expiry = ended + ENDED_VISIBLE_MS;
    if (earliest === null || expiry < earliest) earliest = expiry;
  }
  return earliest;
}
export function dismissTask(state: BarVisibility, task: Pick<BackgroundTaskSummary, "id" | "state"> | null): BarVisibility {
  if (!task || task.state === "running" || state.dismissed.has(task.id)) return state;
  const dismissed = new Set(state.dismissed);
  dismissed.add(task.id);
  return { ...state, dismissed };
}
export function canDismiss(state: BarVisibility, task: Pick<BackgroundTaskSummary, "id" | "state">): boolean {
  return task.state !== "running" && !state.dismissed.has(task.id);
}
