import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_DOCK_VIEW,
  EMPTY_SESSION_DOCK,
  badgeLabel,
  isReading,
  pruneDockView,
  selectTab,
  sessionDockState,
  sidesFor,
  toggleCollapsed,
  visibleDockTab,
} from "../src/features/chat/background-tasks/dock-state.ts";

const todo = [{ status: "in_progress" }];
const running = { id: "r", state: "running" };
const exited = { id: "r", state: "exited" };
const open = { ...EMPTY_SESSION_DOCK, collapsed: false };

test("展开状态跨会话共享，标签选择按会话记忆", () => {
  assert.deepEqual(sessionDockState(EMPTY_DOCK_VIEW, "a"), EMPTY_SESSION_DOCK);
  const tasks = selectTab(EMPTY_DOCK_VIEW, "a", "tasks");
  assert.deepEqual(sessionDockState(tasks, "a"), { collapsed: false, chosenTab: "tasks" });
  assert.deepEqual(sessionDockState(tasks, "b"), open);
  const todoView = selectTab(tasks, "b", "todo");
  const collapsed = toggleCollapsed(todoView);
  assert.equal(sessionDockState(collapsed, "b").chosenTab, "todo");
  assert.equal(sessionDockState(collapsed, "a").collapsed, true);
  assert.equal(sessionDockState(selectTab(collapsed, "a", "tasks"), "b").collapsed, false);
  assert.equal(sessionDockState(pruneDockView(todoView, new Set(["a"])), "b").chosenTab, null);
});

test("运行数量随任务状态变化，切换面板不清空徽标", () => {
  const live = sidesFor([running, { ...running, id: "r2" }, { ...exited, id: "e1" }], todo);
  assert.equal(live.runningTasks, 2);
  assert.equal(visibleDockTab(open, live, false), "tasks");
  const chosenTodo = sessionDockState(selectTab(EMPTY_DOCK_VIEW, "a", "todo"), "a");
  assert.equal(visibleDockTab(chosenTodo, live, false), "todo");
  assert.equal(badgeLabel(live.runningTasks), "2");
  assert.equal(sidesFor([exited], todo).runningTasks, 0);
  assert.equal(badgeLabel(9), "9");
  assert.equal(badgeLabel(10), "9+");
});

test("最后一个任务结束时仍保留可见预览，待办或折叠可覆盖预览", () => {
  const endedSides = sidesFor([exited], todo);
  assert.equal(visibleDockTab(open, endedSides, false), "todo");
  assert.equal(isReading(open, true, exited.id), true);
  assert.equal(visibleDockTab(open, endedSides, true), "tasks");
  assert.equal(visibleDockTab(open, sidesFor([], todo), false), "todo");
  assert.equal(isReading(EMPTY_SESSION_DOCK, true, exited.id), false);
  assert.equal(isReading(open, true, null), false);

  const chosenTodo = { ...open, chosenTab: "todo" };
  assert.equal(isReading(chosenTodo, true, exited.id), false);
  assert.equal(isReading(chosenTodo, false, exited.id), true);
  assert.equal(visibleDockTab(chosenTodo, sidesFor([exited], []), true), "tasks");
  assert.equal(visibleDockTab({ ...open, chosenTab: "tasks" }, sidesFor([], todo), false), "todo");
});
