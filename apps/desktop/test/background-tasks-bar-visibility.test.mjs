import assert from "node:assert/strict";
import test from "node:test";
import { selectVisibleTasks } from "../src/features/chat/background-tasks/bar-visibility.ts";

const running = { id: "r", state: "running" };
const exited = { id: "e", state: "exited" };
const failed = { id: "f", state: "failed" };
const stopped = { id: "s", state: "stopped" };

test("只显示当前运行的任务，任务结束后立即退出列表", () => {
  assert.deepEqual(selectVisibleTasks([running, exited, failed, stopped]), [running]);
  assert.deepEqual(selectVisibleTasks([{ ...running, state: "exited" }]), []);
});

test("只保留正在预览的已结束任务，关闭预览后不会恢复", () => {
  const registry = [running, exited, failed, stopped];
  for (const finished of [exited, failed, stopped]) {
    assert.deepEqual(selectVisibleTasks(registry, finished.id), [running, finished]);
  }
  assert.deepEqual(selectVisibleTasks(registry, "missing"), [running]);
  assert.deepEqual(selectVisibleTasks(registry), [running]);
});
