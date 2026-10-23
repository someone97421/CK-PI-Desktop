import { describe, expect, it } from "vitest";
import { genericModelConfig, modelConfigWithBinding } from "./model-capabilities.js";
import { buildProviderModel, createProviderModels, type RuntimeProviderConfig } from "./provider-binding.js";

function providerFor(modelId: string, supportsReasoningEffort?: boolean | null): RuntimeProviderConfig {
  return {
    id: "custom-gateway",
    name: "Custom gateway",
    baseUrl: "https://gateway.example/v1",
    authKind: "api_key_and_base_url",
    apiKey: "fixture-key",
    apiStyle: "chat_completions",
    modelId,
    supportsReasoning: true,
    supportedThinkingLevels: ["off", "high"],
    modelConfig: modelConfigWithBinding(genericModelConfig(modelId), {
      contextWindow: 128_000,
      maxTokens: 8192,
      thinkingLevels: ["off", "high"],
      supportsReasoningEffort,
    }),
  };
}

describe("per-model Chat Completions reasoning effort override", () => {
  it.each([
    ["deepseek-v4.1-flash", undefined, undefined],
    ["deepseek-v4.1-flash", null, undefined],
    ["deepseek-v4.1-flash", true, "high"],
    ["deepseek-v4.1-flash", false, undefined],
    ["custom-reasoner", undefined, "high"],
    ["custom-reasoner", null, "high"],
    ["custom-reasoner", true, "high"],
    ["custom-reasoner", false, undefined],
  ] as const)("%s with override %s sends effort %s", async (modelId, override, expected) => {
    const provider = providerFor(modelId, override);
    const model = buildProviderModel(provider);
    const bodies: Record<string, unknown>[] = [];
    const result = await createProviderModels(provider, model).streamSimple(model, {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    }, {
      reasoning: "high",
      fetch: async (input, init) => {
        bodies.push(await new Request(input, init).json() as Record<string, unknown>);
        const chunk = {
          id: "fixture", object: "chat.completion.chunk", created: 0, model: modelId,
          choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    }).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "OK" }]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].reasoning_effort).toBe(expected);
  });

  it.each([true, false, null])("does not apply override %s to Responses", async (override) => {
    const provider = { ...providerFor("deepseek-v4.1-flash", override), apiStyle: "responses" };
    const model = buildProviderModel(provider);
    expect(model.api).toBe("openai-responses");
    expect(model.compat ?? {}).not.toHaveProperty("supportsReasoningEffort");
    const bodies: Record<string, unknown>[] = [];
    const result = await createProviderModels(provider, model).streamSimple(model, {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    }, {
      reasoning: "high",
      fetch: async (input, init) => {
        bodies.push(await new Request(input, init).json() as Record<string, unknown>);
        const completed = { type: "response.completed", response: { id: "fixture", status: "completed", output: [] } };
        return new Response(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    }).result();
    expect(result.stopReason).toBe("stop");
    expect(bodies).toHaveLength(1);
    expect(bodies[0].reasoning).toMatchObject({ effort: "high" });
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
  });

  it.each([undefined, null, false, true])("keeps official DeepSeek auto protection with override %s", (override) => {
    const provider = { ...providerFor("deepseek-v4.1-flash", override), vendorKey: "deepseek", baseUrl: "https://api.deepseek.com" };
    expect(buildProviderModel(provider).compat).toMatchObject({ supportsReasoningEffort: override === true });
  });

  it("does not mistake catalog compatibility for an explicit saved override", () => {
    const provider = providerFor("deepseek-v4.1-flash");
    provider.modelConfig = { ...provider.modelConfig!, compat: { supportsReasoningEffort: true } };
    expect(buildProviderModel(provider).compat).toMatchObject({ supportsReasoningEffort: false });
  });
});
