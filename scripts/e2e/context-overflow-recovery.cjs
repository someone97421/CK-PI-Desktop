const assert = require("node:assert/strict");
const { DesktopAgentRuntime } = require("../../packages/agent-runtime/dist/runtime.js");

const provider = {
  id: "local",
  name: "Fixture",
  baseUrl: "http://127.0.0.1:11434/v1",
  modelId: "fixture-model",
  apiKey: "",
  authKind: "none",
  supportsReasoning: true,
  supportedThinkingLevels: ["off", "low", "medium", "high"],
  modelConfig: {
    source: "generic",
    name: "Fixture Model",
    baseUrl: "http://127.0.0.1:11434/v1",
    reasoning: true,
    thinkingLevelMap: { minimal: null, xhigh: null, max: null },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 8_192,
  },
};

function assistantMessage(content, stopReason = "stop") {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "local",
    model: "fixture-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 2,
    content,
  };
}

module.exports = async function runContextOverflowRecovery(window) {
  const events = [];
  let delivered = 0;
  const runtime = new DesktopAgentRuntime({
    host: { call: async () => undefined, onNotification: () => () => undefined },
    sessionId: "context-overflow-fixture",
    mode: "agent",
    provider,
    commandShell: {
      id: "bash",
      label: "Bash",
      dialect: "posix",
      available: true,
      isDefault: true,
    },
    thinkingLevel: "medium",
    onEvent: (envelope) => events.push(envelope),
  });
  const internal = runtime;
  const agent = internal.agent;
  const handleAgentEvent = internal.handleAgentEvent.bind(internal);
  const deliverPendingEvents = async () => {
    const pending = events.slice(delivered);
    const result = await window.webContents.executeJavaScript(
      `window.contextOverflowRecoveryProbe(${JSON.stringify(pending)})`,
    );
    delivered = events.length;
    return result;
  };

  try {
    await window.webContents.executeJavaScript(
      "window.resetContextOverflowRecoveryProbe()",
    );
    agent.prompt = async () => {
      const user = { role: "user", content: "hello", timestamp: 1 };
      const failed = {
        ...assistantMessage([{ type: "text", text: "partial response" }], "error"),
        errorMessage: "400: prompt is too long: 1077172 tokens > 1000000 maximum",
      };
      agent.state.messages = [user, failed];
      await handleAgentEvent({ type: "agent_start" });
      await handleAgentEvent({ type: "turn_start" });
      await handleAgentEvent({
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      await handleAgentEvent({ type: "message_end", message: failed });
      await handleAgentEvent({ type: "turn_end" });
      await handleAgentEvent({ type: "agent_end", messages: [] });
    };
    agent.waitForIdle = async () => undefined;
    agent.continue = async () => {
      const recovered = assistantMessage([
        { type: "text", text: "recovered response" },
      ]);
      await handleAgentEvent({ type: "agent_start" });
      await handleAgentEvent({ type: "turn_start" });
      await handleAgentEvent({
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      await handleAgentEvent({ type: "message_end", message: recovered });
      await handleAgentEvent({ type: "turn_end" });
      await handleAgentEvent({ type: "agent_end", messages: [] });
    };
    internal.runCompaction = async () => {
      internal.emit({ type: "compaction_start", reason: "overflow" });
      const recovery = await deliverPendingEvents();
      assert.equal(recovery.ok, true, JSON.stringify(recovery));
      assert.equal(recovery.phase, "recovering");
      internal.emit({ type: "compaction_end", reason: "overflow", ok: true });
      return true;
    };

    await runtime.prompt("hello", "user-1");
    const recovered = await deliverPendingEvents();
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.phase, "complete");
    assert.equal(recovered.assistantId, recovered.initialAssistantId);
    assert.equal(recovered.assistantCount, 1);
    return { ok: true, recovery: recovered };
  } finally {
    await runtime.dispose();
  }
};
