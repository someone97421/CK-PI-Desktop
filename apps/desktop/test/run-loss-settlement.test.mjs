import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { settleLocalRunLoss } = await import("../src/stores/runtime/run-loss-settlement.ts");

const streamingAssistant = {
  id: "a1",
  role: "assistant",
  content: "partial answer",
  createdAt: "2026-10-01T04:44:00Z",
  status: "streaming",
};
const runningTool = {
  id: "t1",
  role: "tool",
  content: "",
  createdAt: "2026-10-01T04:44:01Z",
  toolCallId: "t1",
  toolName: "Bash",
  toolStatus: "running",
  status: "streaming",
};

function baseState() {
  return {
    activeSessionId: "local-active",
    isRunning: true,
    runningSessions: { "local-active": true, "local-bg": true },
    agentStatuses: {
      "local-active": { sessionId: "local-active", isRunning: true, pendingToolConfirmations: 0 },
      "local-bg": { sessionId: "local-bg", isRunning: true, pendingToolConfirmations: 0 },
    },
    pendingPermissions: {
      "local-bg": [{ requestId: "p1", sessionId: "local-bg" }],
    },
    pendingAsks: {},
    messages: [streamingAssistant, runningTool],
    retainedTranscripts: { "local-bg": [{ ...runningTool, id: "t2", toolCallId: "t2" }] },
  };
}

test("本地执行端失联后清理运行状态与未完成消息", () => {
  const patch = settleLocalRunLoss(baseState(), ["local-active", "local-bg"]);
  assert.equal(patch.isRunning, false);
  assert.equal(patch.runningSessions["local-active"], false);
  assert.equal(patch.runningSessions["local-bg"], false);
  assert.equal(patch.agentStatuses["local-active"], undefined);
  assert.equal(patch.agentStatuses["local-bg"], undefined);
  assert.equal(patch.pendingPermissions["local-bg"], undefined);
  // 助手与工具行标记为 error，不伪造取消回执。
  assert.equal(patch.messages[0].status, "error");
  assert.equal(patch.messages[0].isError, true);
  assert.equal(patch.messages[1].toolStatus, "error");
  assert.equal(patch.messages[1].status, "error");
  assert.ok(patch.messages[1].toolCompletedAt);
  assert.equal(patch.retainedTranscripts["local-bg"][0].toolStatus, "error");
});

test("没有陈旧状态时不产生补丁", () => {
  const state = baseState();
  state.runningSessions = {};
  state.agentStatuses = {};
  state.isRunning = false;
  state.messages = [];
  const patch = settleLocalRunLoss(state, ["local-active"]);
  assert.deepEqual(patch, {});
});

test("收尾指定本地会话时保留远程当前会话", () => {
  const state = baseState();
  state.activeSessionId = "remote";
  state.runningSessions.remote = true;
  state.agentStatuses.remote = { sessionId: "remote", isRunning: true };
  const patch = settleLocalRunLoss(state, ["local-bg"]);
  assert.equal(patch.isRunning, undefined);
  assert.equal(patch.messages, undefined);
  assert.equal(patch.runningSessions.remote, true);
  assert.equal(patch.agentStatuses.remote, state.agentStatuses.remote);
  assert.equal(patch.retainedTranscripts["local-bg"][0].toolStatus, "error");
});
