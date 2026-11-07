import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { normalizeContext, type Message } from "@earendil-works/pi-ai";
import { hostedSearchFromMessage } from "@pi-desktop/shared";
import { buildProviderModel, createProviderModels, type RuntimeProviderConfig } from "./provider-binding.js";
import { genericModelConfig, modelConfigWithBinding } from "./model-capabilities.js";
import { omitThinkingModel } from "./thinking-level.js";

const providerFor = (enabled = true): RuntimeProviderConfig => ({
  id: "google-fixture", name: "Gemini", vendorKey: "custom", apiStyle: "google_generative_ai",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta", modelId: "gemini-3.8-flash",
  apiKey: "synthetic-test-key", supportsReasoning: true, supportedThinkingLevels: ["off", "high", "xhigh", "max"],
  modelConfig: modelConfigWithBinding(genericModelConfig("gemini-3.8-flash"), {
    contextWindow: 128000, maxTokens: 8192, thinkingLevels: ["off", "high", "xhigh", "max"],
    nativeWebSearch: enabled, thinkingProtocol: "adaptive",
  }),
});
const metadata = {
  webSearchQueries: ["Gemini grounding", "Gemini grounding"],
  groundingChunks: [
    { web: { uri: "https://example.com/source", title: "Source" } },
    { web: { uri: "https://example.com/source", title: "Source" } },
    { web: { uri: "javascript:alert(1)", title: "Unsafe" } },
  ],
  searchEntryPoint: { renderedContent: '<a href="https://www.google.com/search?q=Gemini" target="_blank">Google</a>' },
};
function fixture() {
  const requests: Record<string, any>[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
    return new Response(
      chunk({ candidates: [{ content: { role: "model", parts: [{ text: "Thinking", thought: true, thoughtSignature: "c2ln" }] } }] }) +
      chunk({ candidates: [{ content: { role: "model", parts: [
        { toolCall: { id: "search-tool", toolType: "GOOGLE_SEARCH", args: { queries: ["Gemini grounding"] } }, thoughtSignature: "c2VydmVy" },
        { toolResponse: { id: "search-tool", toolType: "GOOGLE_SEARCH", response: { results: [] } } },
      ] } }] }) +
      chunk({ candidates: [{ content: { role: "model", parts: [{ text: "Answer", thoughtSignature: "c2ln" }] }, groundingMetadata: metadata }] }) +
      chunk({ candidates: [{ finishReason: "STOP", groundingMetadata: metadata }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 1, totalTokenCount: 8 } }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  return requests;
}
afterEach(() => vi.unstubAllGlobals());

describe("Gemini native format", () => {
  it.each(["xhigh", "max"] as const)("maps saved %s to HIGH without changing the binding", async reasoning => {
    const requests = fixture();
    const provider = providerFor();
    const saved = structuredClone(provider);
    const model = buildProviderModel(provider);
    expect(model.compat).not.toHaveProperty("forceAdaptiveThinking");
    const result = await createProviderModels(provider, model).streamSimple(model,
      normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] }), { reasoning }).result();
    expect(result.stopReason).toBe("stop");
    expect(requests[0].generationConfig.thinkingConfig.thinkingLevel).toBe("HIGH");
    expect(provider).toEqual(saved);
  });

  it("requests only thought parts for omit while preserving explicit off", async () => {
    const requests = fixture();
    const provider = providerFor(false);
    const model = buildProviderModel(provider);
    const models = createProviderModels(provider, model);
    const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
    const omitted = await models.stream(omitThinkingModel(model), context).result();
    await models.streamSimple(omitThinkingModel(model), context).result();
    await models.streamSimple(model, context).result();
    expect(requests[0].generationConfig.thinkingConfig).toEqual({ includeThoughts: true });
    expect(requests[1].generationConfig.thinkingConfig).toEqual({ includeThoughts: true });
    expect(requests[2].generationConfig.thinkingConfig).not.toHaveProperty("includeThoughts");
    expect(omitted.content).toContainEqual(expect.objectContaining({ type: "thinking", thinking: "Thinking" }));
  });

  it("keeps function tools, signatures and searchable sources across history replay", async () => {
    const requests = fixture();
    const provider = providerFor();
    const model = buildProviderModel(provider);
    const models = createProviderModels(provider, model);
    const tools = [{ name: "lookup", description: "Lookup a local file", parameters: Type.Object({}) }];
    const messages: Message[] = [{ role: "user", content: "Search", timestamp: 1 }];
    const events = [];
    const stream = models.streamSimple(model, normalizeContext({ tools, messages }), { reasoning: "high" });
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(requests[0].tools).toContainEqual({ googleSearch: {} });
    expect(requests[0].tools.some((tool: any) => tool.functionDeclarations?.[0]?.name === "lookup")).toBe(true);
    expect(requests[0].toolConfig.includeServerSideToolInvocations).toBe(true);
    expect(result.content).toContainEqual(expect.objectContaining({ type: "thinking", thinkingSignature: "c2ln" }));
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "Answer", textSignature: "c2ln" }));
    expect(events.some(event => event.type === "hosted_search_update")).toBe(true);
    const search = hostedSearchFromMessage({ content: result.content, citations: result.hostedSearchCitations });
    expect(search?.rounds).toHaveLength(1);
    expect(search?.rounds[0].query).toBe("Gemini grounding");
    expect(search?.rounds[0].sources).toEqual([{ url: "https://example.com/source", title: "Source" }]);
    expect(search?.replay?.[0].wire).toMatchObject({ provider: "google", searchEntryPoint: metadata.searchEntryPoint.renderedContent });
    messages.push(result, { role: "user", content: "Continue", timestamp: 2 });
    const next = await models.streamSimple(model, normalizeContext({ tools, messages }), { reasoning: "high" }).result();
    expect(requests[1].contents.find((content: any) => content.role === "model").parts).toEqual([
      { text: "Thinking", thought: true, thoughtSignature: "c2ln" },
      { toolCall: { id: "search-tool", toolType: "GOOGLE_SEARCH", args: { queries: ["Gemini grounding"] } }, thoughtSignature: "c2VydmVy" },
      { toolResponse: { id: "search-tool", toolType: "GOOGLE_SEARCH", response: { results: [] } } },
      { text: "Answer", thoughtSignature: "c2ln" },
    ]);
    expect(JSON.stringify(requests[1].contents)).not.toContain("google-replay:");
    expect(next.stopReason).toBe("stop");
    expect(JSON.stringify(requests[1].contents)).toContain("c2ln");
    expect(JSON.stringify(requests[1].contents)).not.toContain("web_search_call");
  });

  it("does not add search tools or display unrequested grounding when the switch is off", async () => {
    const requests = fixture();
    const provider = providerFor(false);
    const model = buildProviderModel(provider);
    const result = await createProviderModels(provider, model).streamSimple(model,
      normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] })).result();
    expect(requests[0].tools ?? []).toEqual([]);
    expect(result.content.some(part => part.type === "hostedSearch")).toBe(false);
  });
});
