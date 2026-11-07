import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type BackgroundTaskOutput, type BackgroundTaskSummary } from "../../../lib/api";
import { type BarVisibility, EMPTY_VISIBILITY, dismissTask, nextExpiryAt, observeTasks, selectVisibleTasks } from "./bar-visibility";
import { type DockSides, EMPTY_DOCK_VIEW, type DockTab, type DockViewState, badgeLabel, clearBadge, observeSessionTasks, pruneDockView, resolveDockTabFor, selectTab, sessionDockState, tasksPanelVisible, toggleCollapsed } from "./dock-state";
import type { SessionTodo } from "@pi-desktop/shared";

const REFRESH_MS = 1_000;
type Failure = "load" | "output" | "stop" | "remove";
function sidesFor(rows: readonly BackgroundTaskSummary[], todos: readonly SessionTodo[]): DockSides {
  return {
    hasTodo: todos.length > 0,
    hasTasks: rows.length > 0,
    runningTasks: rows.filter((task) => task.state === "running").length,
    inProgressTodos: todos.filter((todo) => todo.status === "in_progress").length,
  };
}

export function useBackgroundTasks(sessionId: string | null | undefined, todos: readonly SessionTodo[] = []) {
  const [allTasks, setAllTasks] = useState<BackgroundTaskSummary[]>([]);
  const [visibility, setVisibility] = useState<BarVisibility>(EMPTY_VISIBILITY);
  const [dockView, setDockView] = useState<DockViewState>(EMPTY_DOCK_VIEW);
  const [clock, setClock] = useState(() => Date.now());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [output, setOutput] = useState<BackgroundTaskOutput | null>(null);
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<Failure | null>(null);
  const mounted = useRef(false);
  const pendingStops = useRef(new Set<string>());
  const refreshList = useRef<(() => void) | null>(null);
  const knownIds = useRef(new Map<string, Set<string>>());
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let inFlight = false;
    let queued = false;
    let pollAgain = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      clearTimeout(timer);
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      try {
        const result = await api.backgroundTasksList();
        if (disposed) return;
        const observedAt = Date.now();
        setAllTasks(result.tasks);
        setVisibility((current) => observeTasks(current, result.tasks, observedAt));
        setClock(observedAt);
        const currentSession = sessionIdRef.current;
        if (currentSession) {
          const sessionTasks = result.tasks.filter((task) => task.sessionId === currentSession);
          const seen = knownIds.current.get(currentSession) ?? new Set<string>();
          setDockView((current) => {
            const state = sessionDockState(current, currentSession);
            const tasksVisible = tasksPanelVisible(state, sidesRef.current);
            const folded = observeSessionTasks(current, currentSession, sessionTasks, { knownIds: seen, tasksVisible });
            knownIds.current.set(currentSession, folded.knownIds);
            return folded.view;
          });
        }
        setError((current) => current === "load" ? null : current);
        pollAgain = result.tasks.some((task) => task.state === "running");
      } catch (failure) {
        if (disposed) return;
        console.error("Background task list failed", failure);
        setError("load");
        pollAgain = true;
      } finally {
        inFlight = false;
        if (!disposed) {
          if (queued) {
            queued = false;
            void refresh();
          } else if (pollAgain) timer = setTimeout(() => void refresh(), REFRESH_MS);
        }
      }
    };
    refreshList.current = () => void refresh();
    const unsubscribe = api.onBackgroundTasksChanged(() => void refresh());
    void refresh();
    return () => {
      disposed = true;
      mounted.current = false;
      refreshList.current = null;
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  const sessionTasks = useMemo(() => sessionId ? allTasks.filter((task) => task.sessionId === sessionId) : [], [allTasks, sessionId]);
  useEffect(() => {
    const live = new Set(allTasks.map((task) => task.sessionId));
    if (sessionId) live.add(sessionId);
    setDockView((current) => pruneDockView(current, live));
    for (const id of knownIds.current.keys()) {
      if (!live.has(id)) knownIds.current.delete(id);
    }
  }, [allTasks, sessionId]);
  const visibleTasks = selectVisibleTasks(visibility, sessionTasks, clock, expandedId);
  useEffect(() => {
    const expiry = nextExpiryAt(visibility, sessionTasks, clock, expandedId);
    if (expiry === null) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, expiry - clock));
    return () => clearTimeout(timer);
  }, [visibility, sessionTasks, clock, expandedId]);

  const selectedState = sessionTasks.find((task) => task.id === expandedId)?.state;
  useEffect(() => {
    setOutput(null);
    if (!expandedId || !sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sessionAtRequest = sessionId;
    const refresh = async () => {
      try {
        const result = await api.backgroundTasksOutput(expandedId);
        if (disposed) return;
        setOutput(result);
        setError((current) => current === "output" ? null : current);
      } catch (failure) {
        if (disposed) return;
        console.error("Background task output failed", failure);
        setError("output");
      } finally {
        if (!disposed && selectedState === "running" && sessionIdRef.current === sessionAtRequest) timer = setTimeout(() => void refresh(), REFRESH_MS);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [expandedId, selectedState, sessionId]);

  const toggleOutput = useCallback((id: string) => {
    setExpandedId((current) => current === id ? null : id);
    setError((current) => current === "output" ? null : current);
  }, []);
  const openTasksTab = useCallback(() => {
    if (!sessionId) return;
    setDockView((current) => clearBadge(selectTab(current, sessionId, "tasks"), sessionId));
  }, [sessionId]);
  const openTodoTab = useCallback(() => {
    if (!sessionId) return;
    setDockView((current) => selectTab(current, sessionId, "todo"));
  }, [sessionId]);
  const setCollapsed = useCallback((collapsed: boolean) => {
    setDockView((current) => current.collapsed === collapsed ? current : toggleCollapsed(current));
  }, []);
  const remove = useCallback((id: string): boolean => {
    const task = sessionTasks.find((candidate) => candidate.id === id);
    if (!task || task.state === "running") {
      setError("remove");
      return false;
    }
    setVisibility((current) => dismissTask(current, task));
    setExpandedId((current) => current === id ? null : current);
    return true;
  }, [sessionTasks]);
  const stop = useCallback(async (id: string) => {
    if (pendingStops.current.has(id)) return;
    pendingStops.current.add(id);
    setStoppingIds(new Set(pendingStops.current));
    setError(null);
    try {
      await api.backgroundTasksStop(id);
      if (mounted.current) refreshList.current?.();
    } catch (failure) {
      if (mounted.current) {
        console.error("Background task stop failed", failure);
        setError("stop");
      }
    } finally {
      pendingStops.current.delete(id);
      if (mounted.current) setStoppingIds(new Set(pendingStops.current));
    }
  }, []);

  const dock = sessionDockState(dockView, sessionId);
  const sides = sidesFor(visibleTasks, todos);
  const activeTab: DockTab = resolveDockTabFor(dock, sides);
  const sidesRef = useRef(sides);
  sidesRef.current = sides;
  return {
    tasks: visibleTasks, activeTab, openTasksTab, openTodoTab,
    collapsed: dock.collapsed, setCollapsed, badge: dock.newCount, badgeText: badgeLabel(dock.newCount),
    expandedId, output, stoppingIds, error, toggleOutput, stop, remove,
  };
}
