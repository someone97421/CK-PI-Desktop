import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const window = {};
vm.runInNewContext(await readFile(new URL("../resources/plugins/local.subagent-observer/views/parser.js", import.meta.url), "utf8"), { window });
const { buildTasks, searchTask } = window.ObserverParser;

function row(id, toolName, toolCallId, details, second, parentToolCallId) {
  return { id, role: "tool", toolName, toolCallId, toolResult: { details },
    createdAt: `2026-09-21T10:00:${String(second).padStart(2, "0")}Z`,
    ...(parentToolCallId ? { parentToolCallId } : {}) };
}

test("观测按执行键和父工具调用隔离同一子代理的多轮记录", () => {
  const tasks = buildTasks([
    row("first", "Task", "call-1", { delegationId: "d", execution: 1, status: "running" }, 0),
    row("first-end", "TaskExecution", "end-1", { delegationId: "d", execution: 1, status: "completed" }, 1, "call-1"),
    row("second", "TaskResume", "call-2", { delegationId: "d", executionId: "d:2", execution: 2, status: "running" }, 2),
    row("second-step", "Read", "read-2", {}, 3, "call-2"),
    row("stop", "TaskStop", "stop-2", { stopped: [{ delegationId: "d", executionId: "d:2", status: "running" }] }, 4),
  ]);
  assert.equal(tasks.length, 2);
  const first = tasks.find((task) => task.key === "d");
  const second = tasks.find((task) => task.key === "d:2");
  assert.equal(first.outcome, "completed");
  assert.equal(second.outcome, "stopped");
  assert.equal(first.children[0].id, "first-end");
  assert.equal(second.children[0].id, "second-step");
  assert.equal(searchTask(tasks, { task: "d", message: "second-step" }), null);
  assert.equal(searchTask(tasks, { task: "call-2", message: "second-step" }).task.key, "d:2");
});

test("搜索指定消息时不被前面的同词消息抢占，工具调用别名可定位已创建的任务", () => {
  const task = row("task-row", "Task", "pending-call", { delegationId: "d", executionId: "d:1", status: "completed" }, 0);
  const children = ["early", "target"].map((id, index) => ({ id, role: "assistant", content: "needle", parentToolCallId: "pending-call", createdAt: `2026-09-21T10:00:0${index + 1}Z` }));
  const tasks = buildTasks([task, ...children]);
  assert.equal(searchTask(tasks, { task: "pending-call", message: "target", query: "needle" }).message.id, "target");
  assert.equal(searchTask(tasks, { task: "d:1", message: "missing", query: "needle" }), null);
  assert.equal(searchTask(tasks, { task: "d:1", query: "needle" }).message.id, "early");
});
