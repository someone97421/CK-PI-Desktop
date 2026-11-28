import type { SessionTodo } from "@pi-desktop/shared";
import type { BackgroundTaskSummary } from "../../../lib/api";

export type DockTab = "todo" | "tasks";
export type DockSessionState = {
  readonly chosenTab: DockTab | null;
  readonly collapsed: boolean;
};
export type DockViewState = Readonly<{
  sessions: Readonly<Record<string, DockSessionState>>;
  collapsed: boolean;
}>;

export const EMPTY_DOCK_VIEW: DockViewState = { sessions: {}, collapsed: true };
export const EMPTY_SESSION_DOCK: DockSessionState = { chosenTab: null, collapsed: EMPTY_DOCK_VIEW.collapsed };
export const MAX_BADGE = 9;

export function sessionDockState(view: DockViewState, sessionId: string | null | undefined): DockSessionState {
  if (!sessionId) return EMPTY_SESSION_DOCK;
  const session = view.sessions[sessionId] ?? EMPTY_SESSION_DOCK;
  return session.collapsed === view.collapsed ? session : { ...session, collapsed: view.collapsed };
}

export type DockSides = { hasTodo: boolean; hasTasks: boolean; runningTasks: number };

export function sidesFor(rows: readonly BackgroundTaskSummary[], todos: readonly SessionTodo[]): DockSides {
  return {
    hasTodo: todos.length > 0,
    hasTasks: rows.length > 0,
    runningTasks: rows.filter((task) => task.state === "running").length,
  };
}

export function visibleDockTab(state: DockSessionState, sides: DockSides, reading: boolean): DockTab {
  if (!sides.hasTasks) return "todo";
  if (reading || !sides.hasTodo) return "tasks";
  return state.chosenTab ?? (sides.runningTasks > 0 ? "tasks" : "todo");
}

/** 自动切换不会打断预览。显式选择待办时，其面板有内容才会覆盖预览。 */
export function isReading(state: DockSessionState, hasTodo: boolean, expandedId: string | null): boolean {
  return expandedId !== null && !state.collapsed && !(state.chosenTab === "todo" && hasTodo);
}

export function selectTab(view: DockViewState, sessionId: string, tab: DockTab): DockViewState {
  const current = sessionDockState(view, sessionId);
  if (current.chosenTab === tab) return view.collapsed ? { ...view, collapsed: false } : view;
  return { collapsed: false, sessions: { ...view.sessions, [sessionId]: { chosenTab: tab, collapsed: false } } };
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
