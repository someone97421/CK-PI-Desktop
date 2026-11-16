import type { api as desktopApi } from "./api";
import type { useAppStore } from "../stores/app-store";
import { clearSessionAsks, dropSessionAskDrafts } from "./pending-asks";
import { clearSessionPermissions } from "./pending-permissions";

type Store = Pick<typeof useAppStore, "getState" | "setState" | "subscribe">;
type Api = Pick<typeof desktopApi, "getSettings" | "listSessions" | "onAgentEvent">;

export async function refreshRemoteSessionState(store: Store, api: Api): Promise<void> {
  const updates: Record<string, boolean> = {};
  const queueSessions = new Set<string>();
  const unsubscribeStore = store.subscribe((current, previous) => {
    if (current.runningSessions === previous.runningSessions) return;
    for (const id of new Set([...Object.keys(current.runningSessions), ...Object.keys(previous.runningSessions)])) {
      if (current.runningSessions[id] !== previous.runningSessions[id]) updates[id] = current.runningSessions[id] === true;
    }
  });
  const unsubscribeEvents = api.onAgentEvent(({ sessionId, event }) => {
    if (["agent_start", "turn_start", "compaction_start"].includes(event.type)) updates[sessionId] = true;
    else if (event.type === "agent_end" || event.type === "error" || event.type === "compaction_end" && event.reason === "manual") updates[sessionId] = false;
  });
  try {
    const [settings, sessions] = await Promise.all([api.getSettings(), api.listSessions()]);
    store.setState((current) => {
      const runningSessions = { ...Object.fromEntries((sessions.runningSessionIds ?? []).map((id) => [id, true])), ...updates };
      const ended = new Set([
        ...Object.keys(current.runningSessions).filter(id => current.runningSessions[id] === true), ...Object.keys(current.agentStatuses),
        ...Object.keys(current.pendingPermissions), ...Object.keys(current.pendingAsks),
      ].filter(id => runningSessions[id] !== true));
      let pendingPermissions = current.pendingPermissions;
      let pendingAsks = current.pendingAsks;
      let askDrafts = current.askDrafts;
      for (const id of ended) {
        queueSessions.add(id);
        pendingPermissions = clearSessionPermissions(pendingPermissions, id);
        askDrafts = dropSessionAskDrafts(askDrafts, pendingAsks, id);
        pendingAsks = clearSessionAsks(pendingAsks, id);
      }
      return {
        settings, runningSessions, isRunning: !!current.activeSessionId && runningSessions[current.activeSessionId] === true,
        agentStatuses: Object.fromEntries(Object.entries(current.agentStatuses).filter(([id]) => !ended.has(id))),
        pendingPermissions, pendingAsks, askDrafts,
      };
    });
  } finally {
    unsubscribeEvents();
    unsubscribeStore();
  }
  const state = store.getState();
  for (const id of Object.keys(state.queuedPrompts)) queueSessions.add(id);
  if (state.activeSessionId) queueSessions.add(state.activeSessionId);
  await Promise.allSettled([
    state.refreshSessions(), state.refreshProviders(), state.refreshPlugins(),
    state.refreshNotifications(), state.refreshPlanCheckpoints(),
    ...[...queueSessions].map(id => state.refreshQueuedPrompts(id)),
  ]);
  const current = store.getState();
  if (current.page === "chat" && current.activeSessionId) {
    await current.selectSession(current.activeSessionId, { record: false });
  }
}
