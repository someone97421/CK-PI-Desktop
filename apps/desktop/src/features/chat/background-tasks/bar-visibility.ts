import type { BackgroundTaskSummary } from "../../../lib/api";

/** 已结束的任务留在宿主历史中，只有正在查看输出的任务继续显示。 */
export function selectVisibleTasks(
  tasks: readonly BackgroundTaskSummary[],
  pinnedId: string | null = null,
): BackgroundTaskSummary[] {
  return tasks.filter((task) => task.state === "running" || task.id === pinnedId);
}
