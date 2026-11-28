import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionTodo } from "@pi-desktop/shared";
import { api, type BackgroundTaskOutput, type BackgroundTaskSummary } from "../../../lib/api";
import { selectVisibleTasks } from "./bar-visibility";
import {
  EMPTY_DOCK_VIEW,
  badgeLabel,
  isReading,
  pruneDockView,
  selectTab,
  sessionDockState,
  sidesFor,
  toggleCollapsed,
  visibleDockTab,
} from "./dock-state";

const REFRESH_MS = 1_000;
type Failure = "load" | "output" | "stop" | "remove";
type Preview = { sessionId: string; id: string };

export function useBackgroundTasks(sessionId: string | null | undefined, todos: readonly SessionTodo[] = []) {
  const [allTasks, setAllTasks] = useState<BackgroundTaskSummary[]>([]);
  const [dockView, setDockView] = useState(EMPTY_DOCK_VIEW);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [output, setOutput] = useState<BackgroundTaskOutput | null>(null);
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<Failure | null>(null);
  const mounted = useRef(false);
  const pendingStops = useRef(new Set<string>());
  const refreshList = useRef<(() => void) | null>(null);

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
        setAllTasks(result.tasks);
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

  const sessionTasks = useMemo(
    () => sessionId ? allTasks.filter((task) => task.sessionId === sessionId) : [],
    [allTasks, sessionId],
  );
  useEffect(() => {
    const live = new Set(allTasks.map((task) => task.sessionId));
    if (sessionId) live.add(sessionId);
    setDockView((current) => pruneDockView(current, live));
  }, [allTasks, sessionId]);

  const dock = sessionDockState(dockView, sessionId);
  const selectedTask = preview && preview.sessionId === sessionId
    ? sessionTasks.find((task) => task.id === preview.id)
    : undefined;
  const selectedState = selectedTask?.state;
  const reading = isReading(dock, todos.length > 0, selectedTask?.id ?? null);
  const expandedId = reading ? selectedTask?.id ?? null : null;
  const tasks = selectVisibleTasks(sessionTasks, expandedId);
  const sides = sidesFor(tasks, todos);
  const activeTab = visibleDockTab(dock, sides, reading);
  const badge = sides.runningTasks;

  // 隐藏时保留运行中任务的选择，便于回来继续读。任务结束或切换会话后释放选择。
  useEffect(() => {
    if (preview && !reading && selectedState !== "running") {
      setPreview((current) => current === preview ? null : current);
      setOutput(null);
      setError((current) => current === "output" ? null : current);
    }
  }, [preview, reading, selectedState]);

  useEffect(() => {
    if (!expandedId || !sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
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
        if (!disposed && selectedState === "running") timer = setTimeout(() => void refresh(), REFRESH_MS);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [expandedId, selectedState, sessionId]);

  const toggleOutput = useCallback((id: string) => {
    if (!sessionId) return;
    setPreview((current) => current?.sessionId === sessionId && current.id === id ? null : { sessionId, id });
    setOutput(null);
    setError((current) => current === "output" ? null : current);
  }, [sessionId]);

  const openTasksTab = useCallback(() => {
    if (!sessionId) return;
    setDockView((current) => selectTab(current, sessionId, "tasks"));
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
    setPreview((current) => current?.id === id ? null : current);
    setOutput(null);
    setError((current) => current === "output" ? null : current);
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

  return {
    tasks, activeTab, openTasksTab, openTodoTab,
    collapsed: dock.collapsed, setCollapsed, badge, badgeText: badgeLabel(badge),
    expandedId, output, stoppingIds, error, toggleOutput, stop, remove,
  };
}
