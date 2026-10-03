import { describe, expect, it, vi } from "vitest";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { retryProviderRequest } from "@earendil-works/pi-ai/utils/provider-retry";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { normalizeContext, type AssistantMessage, type Model } from "@earendil-works/pi-ai";

const testModel: Model<"openai-responses"> = {
  id: "test-model",
  name: "test model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_000,
};

describe("Pi 1.0 upstream regression contracts", () => {
  it("replays a grammar tool-call item with the required ctc_ identifier", () => {
    const message: AssistantMessage = {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call_123|ctc_response_item",
        name: "lookup",
        arguments: { query: "pi" },
      }],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 1,
    };
    const replay = convertResponsesMessages(
      testModel,
      normalizeContext({ messages: [message] }),
      new Set(),
      { grammarToolInputProperties: new Map([["lookup", "query"]]) },
    );
    expect(replay).toContainEqual(expect.objectContaining({
      type: "custom_tool_call",
      id: "ctc_response_item",
      call_id: "call_123",
      name: "lookup",
    }));
  });

  it("uses the bounded exponential fallback for an invalid Retry-After value", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const rateLimit = Object.assign(new Error("rate limited"), {
        status: 429,
        headers: new Headers({ "retry-after": "not-a-date" }),
      });
      let requests = 0;
      const pending = retryProviderRequest(async () => {
        requests += 1;
        if (requests === 1) throw rateLimit;
        return "recovered";
      }, { maxRetries: 1 });

      await Promise.resolve();
      await Promise.resolve();
      expect(requests).toBe(1);
      await vi.advanceTimersByTimeAsync(499);
      expect(requests).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe("recovered");
      expect(requests).toBe(2);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("recognizes the Z.AI context-overflow finish reason", () => {
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "zai",
      model: "test-model",
      usage: {
        input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "model_context_window_exceeded",
      timestamp: 1,
    };
    expect(isContextOverflow(message)).toBe(true);
  });
});
