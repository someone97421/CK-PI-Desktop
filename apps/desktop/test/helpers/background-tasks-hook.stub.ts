import type { BackgroundTaskOutput, BackgroundTaskSummary } from "../../src/lib/api";
import { badgeLabel, sidesFor } from "../../src/features/chat/background-tasks/dock-state";

/**
 * Stand-in for `useBackgroundTasks` in the container's render tests.
 *
 * The hook's data source is the host registry, which is not reachable from a
 * static render, so the test installs the two lists the hook keeps apart:
 * `tasks` are the rows the container may render, `sessionTasks` are every
 * registry entry the host still lists for the session — including finished
 * tasks it keeps as history after their rows left. Keeping both in the fixture
 * is the point: the rendered container must answer only to `tasks`.
 */
export type DockFixture = {
  tasks: BackgroundTaskSummary[];
  sessionTasks: BackgroundTaskSummary[];
  collapsed?: boolean;
  activeTab?: "todo" | "tasks";
  expandedId?: string;
  output?: BackgroundTaskOutput;
};

declare global {
  // Installed by the render test before each render.
  var __piDockFixture: DockFixture | undefined;
}

export function useBackgroundTasks() {
  const fixture = globalThis.__piDockFixture ?? { tasks: [], sessionTasks: [] };
  const badge = sidesFor(fixture.tasks, []).runningTasks;
  return {
    tasks: fixture.tasks,
    sessionTasks: fixture.sessionTasks,
    activeTab: fixture.activeTab ?? "tasks",
    openTasksTab() {},
    openTodoTab() {},
    collapsed: fixture.collapsed ?? true,
    setCollapsed() {},
    badge,
    badgeText: badgeLabel(badge),
    expandedId: fixture.expandedId ?? null,
    output: fixture.output ?? null,
    toggleOutput() {},
    stop() {},
    remove() {
      return true;
    },
    error: null,
    stoppingIds: new Set<string>(),
  };
}
