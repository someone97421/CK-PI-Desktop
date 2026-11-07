import type { BackgroundTaskSummary } from "../../../lib/api";

export type DockTab = "todo" | "tasks";
export type DockSessionState = {
  readonly chosenTab: DockTab | null;
  readonly newCount: number;
  readonly collapsed: boolean;
};
export type DockViewState = Readonly<{
  sessions: Readonly<Record<string, DockSessionState>>;
  collapsed: boolean;
}>;
export const EMPTY_DOCK_VIEW: DockViewState = { sessions: {}, collapsed: true };
export const EMPTY_SESSION_DOCK: DockSessionState = { chosenTab: null, newCount: 0, collapsed: EMPTY_DOCK_VIEW.collapsed };
export const MAX_BADGE = 9;
export function sessionDockState(view: DockViewState, sessionId: string | null | undefined): DockSessionState {
  if (!sessionId) return EMPTY_SESSION_DOCK;
  const session = view.sessions[sessionId];
  if (!session) return { ...EMPTY_SESSION_DOCK, collapsed: view.collapsed };
  return session.collapsed === view.collapsed ? session : { ...session, collapsed: view.collapsed };
}
function withSession(view: DockViewState, sessionId: string, patch: Partial<DockSessionState>): DockViewState {
  const current = sessionDockState(view, sessionId);
  const session = { ...current, ...patch, collapsed: view.collapsed };
  if (session.chosenTab === current.chosenTab && session.newCount === current.newCount) return view;
  return { ...view, sessions: { ...view.sessions, [sessionId]: session } };
}
export function resolveDockTab(state: DockSessionState, hasTodo: boolean, hasTasks: boolean, runningTasks: number, inProgressTodos: number): DockTab {
  if (hasTodo && hasTasks) {
    if (state.chosenTab === "todo") return "todo";
    if (state.chosenTab === "tasks") return "tasks";
    if (runningTasks > 0) return "tasks";
    if (inProgressTodos > 0) return "todo";
    return "todo";
  }
  return hasTasks ? "tasks" : "todo";
}
export type DockSides = { hasTodo: boolean; hasTasks: boolean; runningTasks: number; inProgressTodos: number };
export function resolveDockTabFor(state: DockSessionState, sides: DockSides): DockTab {
  return resolveDockTab(state, sides.hasTodo, sides.hasTasks, sides.runningTasks, sides.inProgressTodos);
}
export function tasksPanelVisible(state: DockSessionState, sides: DockSides): boolean {
  return !state.collapsed && resolveDockTabFor(state, sides) === "tasks";
}
export function observeSessionTasks(view: DockViewState, sessionId: string, tasks: readonly BackgroundTaskSummary[], options: { knownIds: ReadonlySet<string>; tasksVisible: boolean }): { view: DockViewState; knownIds: Set<string> } {
  const knownIds = new Set<string>();
  let added = 0;
  for (const task of tasks) {
    knownIds.add(task.id);
    if (options.knownIds.has(task.id) || task.state !== "running") continue;
    if (!options.tasksVisible) added += 1;
  }
  if (added === 0) return { view, knownIds };
  const current = sessionDockState(view, sessionId);
  return { view: withSession(view, sessionId, { newCount: current.newCount + added }), knownIds };
}
export function clearBadge(view: DockViewState, sessionId: string): DockViewState {
  const current = sessionDockState(view, sessionId);
  return current.newCount === 0 ? view : withSession(view, sessionId, { newCount: 0 });
}
export function chooseTab(view: DockViewState, sessionId: string, tab: DockTab): DockViewState {
  return withSession(view, sessionId, { chosenTab: tab });
}
export function selectTab(view: DockViewState, sessionId: string, tab: DockTab): DockViewState {
  return withSession({ ...view, collapsed: false }, sessionId, { chosenTab: tab });
}
export function toggleCollapsed(view: DockViewState): DockViewState {
  return { ...view, collapsed: !view.collapsed };
}
export function badgeLabel(count: number): string {
  return count > MAX_BADGE ? `${MAX_BADGE}+` : String(count);
}
export function pruneDockView(view: DockViewState, liveSessionIds: ReadonlySet<string>): DockViewState {
  let changed = false;
  const next: Record<string, DockSessionState> = {};
  for (const [id, state] of Object.entries(view.sessions)) {
    if (liveSessionIds.has(id)) next[id] = state;
    else changed = true;
  }
  return changed ? { ...view, sessions: next } : view;
}
