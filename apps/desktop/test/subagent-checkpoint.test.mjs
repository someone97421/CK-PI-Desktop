import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { encodeAgentMessages, decodeAgentMessages } = await import("../../../packages/agent-runtime/src/subagent-checkpoint.ts");

const zeroUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

for (const thinkingLevel of ["off", "high"]) {
  test(`保存并恢复运行库消息的思考档位 ${thinkingLevel} 和工具用量`, () => {
    const toolUsage = { ...zeroUsage, input: 3, output: 2, totalTokens: 5 };
    const nestedCalls = { calls: [{ id: "nested-1", name: "Read", status: "ok", durationMs: 5 }], complete: true };
    const messages = [
      { role: "user", content: "读取文件并返回结果", timestamp: 1, futureMetadata: { trace: "ignored" } },
      {
        role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture-model",
        thinkingLevel, usage: zeroUsage, stopReason: "toolUse", timestamp: 2, durationMs: 120,
        content: [{ type: "toolCall", id: "read-1", name: "Read", arguments: { path: "file.txt" } }],
      },
      {
        role: "toolResult", toolCallId: "read-1", toolName: "Read",
        content: [{ type: "text", text: "文件内容" }], details: undefined,
        usage: undefined, isError: false, timestamp: 3,
      },
      {
        role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture-model",
        thinkingLevel, usage: zeroUsage, stopReason: "toolUse", timestamp: 4,
        content: [{ type: "toolCall", id: "read-2", name: "Read", arguments: { path: "other.txt" } }],
      },
      {
        role: "toolResult", toolCallId: "read-2", toolName: "Read",
        content: [{ type: "text", text: "其他文件内容" }], usage: toolUsage,
        isError: false, timestamp: 5, durationMs: 30, nestedCalls,
      },
      {
        role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture-model",
        thinkingLevel, usage: zeroUsage, stopReason: "stop", timestamp: 6, futureMetadata: "ignored",
        content: [{ type: "text", text: "读取完成" }],
      },
    ];
    const snapshot = JSON.parse(JSON.stringify(encodeAgentMessages(messages)));
    const restored = decodeAgentMessages(snapshot);
    assert.equal(restored[1].thinkingLevel, thinkingLevel);
    assert.equal(restored[3].thinkingLevel, thinkingLevel);
    assert.equal(restored[5].thinkingLevel, thinkingLevel);
    assert.equal(restored[2].usage, undefined);
    assert.equal(restored[1].durationMs, 120);
    assert.equal(restored[4].durationMs, 30);
    assert.deepEqual(restored[4].nestedCalls, nestedCalls);
    assert.equal("futureMetadata" in snapshot[0], false);
    assert.equal("futureMetadata" in snapshot[5], false);
    assert.deepEqual(restored[4].usage, toolUsage);
    assert.deepEqual(encodeAgentMessages(restored), snapshot);
  });
}
