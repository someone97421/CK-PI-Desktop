import { describe, expect, it } from "vitest";
import { LocalRequestError } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, HostedSearchContent, Message } from "@earendil-works/pi-ai";
import { hostedSearchReplayProjection } from "@earendil-works/pi-ai/utils/hosted-search";
import { serializeConversation } from "./pi-runtime-messages.js";

function assistant(
  content: AssistantMessage["content"],
  api: Api = "anthropic-messages",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api,
    provider: api === "anthropic-messages" ? "anthropic" : "openai",
    model: "test-model",
    timestamp: 2,
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function hostedSearch(size = 1, api: Api = "anthropic-messages"): HostedSearchContent[] {
  return api === "anthropic-messages"
    ? [
        {
          type: "hostedSearch",
          phase: "server_tool_use",
          blockId: "srv_1",
          name: "web_search",
          input: { query: "q" },
        },
        {
          type: "hostedSearch",
          phase: "web_search_tool_result",
          blockId: "srv_1",
          wire: {
            type: "web_search_tool_result",
            tool_use_id: "srv_1",
            content: [{ type: "web_search_result", encrypted_content: "x".repeat(size) }],
          },
        },
      ]
    : [
        {
          type: "hostedSearch",
          phase: "web_search_call",
          blockId: "ws_1",
          wire: {
            type: "web_search_call",
            id: "ws_1",
            status: "completed",
            action: { type: "search", query: "x".repeat(size) },
          },
        },
      ];
}

describe("desktop compaction hosted-search serialization", () => {
  it("keeps hosted-search wire projections exactly once without fabricating tool calls", () => {
    const blocks = hostedSearch(8);
    const message = assistant([
      { type: "text", text: "answer text" },
      ...blocks,
      { type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/x" } },
    ]);

    const output = serializeConversation([message]);
    expect(output.split("[Assistant hosted search]:").length - 1).toBe(1);
    for (const block of blocks) {
      const projection = hostedSearchReplayProjection(block);
      expect(projection).toBeDefined();
      expect(output.split(JSON.stringify(projection)).length - 1).toBe(1);
    }
    expect(output.split('"srv_1"').length - 1).toBe(2);
    expect(output).toContain("[Assistant]: answer text");
    expect(output).toContain("read(");
    expect(output).not.toContain("web_search(");
    expect(output).not.toContain('"hostedSearch"');
  });

  it("keeps a nameless search result and a large replay buffer intact", () => {
    const nameless: HostedSearchContent = {
      type: "hostedSearch",
      phase: "web_search_tool_result",
      blockId: "srv_9",
      wire: {
        type: "web_search_tool_result",
        tool_use_id: "srv_9",
        content: [{ type: "web_search_result", encrypted_content: "opaque-result", title: "Result" }],
      },
    };
    const namelessOutput = serializeConversation([assistant([nameless])]);
    const projection = hostedSearchReplayProjection(nameless);
    expect(namelessOutput.split(JSON.stringify(projection)).length - 1).toBe(1);
    expect(namelessOutput).toContain("opaque-result");
    expect(namelessOutput).not.toContain("undefined(");

    const large = serializeConversation([assistant(hostedSearch(5_000))]);
    expect(large).toContain("x".repeat(5_000));
  });

  it("rejects malformed replay blocks instead of dropping them", () => {
    const malformed = assistant([
      {
        type: "hostedSearch",
        phase: "web_search_tool_result",
        blockId: "srv_1",
        wire: { type: "web_search_tool_result", tool_use_id: "srv_1" },
      },
    ]);
    expect(() => serializeConversation([malformed])).toThrow(LocalRequestError);
  });

  it("keeps legacy text-only conversations byte-identical", () => {
    const legacy = [
      { role: "user" as const, content: "hello", timestamp: 1 },
      assistant([
        { type: "text", text: "hi" },
        { type: "toolCall", id: "t", name: "run", arguments: { a: 1 } },
      ]),
      {
        role: "toolResult" as const,
        toolCallId: "t",
        toolName: "run",
        content: [{ type: "text" as const, text: "done" }],
        isError: false,
        timestamp: 3,
      },
    ];
    const expected =
      "[User]: hello\n\n" +
      "[Assistant]: hi\n\n" +
      "[Assistant tool calls]: run(a=1)\n\n" +
      "[Tool result]: done";
    expect(serializeConversation(legacy as Message[])).toBe(expected);
  });
});
