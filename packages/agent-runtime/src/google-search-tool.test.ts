import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleSearchTool } from "./google-search-tool.js";
import { genericModelConfig, modelConfigWithBinding } from "./model-capabilities.js";
import { buildProviderModel, createProviderModels, type RuntimeProviderConfig } from "./provider-binding.js";
import { normalizeContext } from "@earendil-works/pi-ai";

const provider = (enabled = true): RuntimeProviderConfig => ({
  id: "google-search-test", name: "Google", vendorKey: "custom", apiStyle: "google_generative_ai",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta", modelId: "gemini-3.8-flash-medium-g",
  apiKey: "fixture-key", supportsReasoning: false, supportedThinkingLevels: ["off"],
  modelConfig: modelConfigWithBinding(genericModelConfig("gemini-3.8-flash-medium-g"), {
    contextWindow: 128000, maxTokens: 8192,
    nativeWebSearch: enabled, thinkingLevels: ["off"],
  }),
});
function fixture(grounded = true, finishReason = "STOP") {
  const requests: Record<string, any>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const data = { candidates: [{ content: { role: "model", parts: [{ text: "Grounded answer" }] }, finishReason,
      ...(grounded ? { groundingMetadata: {
        webSearchQueries: ["query"], groundingChunks: [{ web: { uri: "https://example.com/source", title: "Source" } }],
      } } : {}),
    }] };
    return new Response(`data: ${JSON.stringify(data)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  }));
  return requests;
}
afterEach(() => vi.unstubAllGlobals());

describe("GoogleSearch compatibility tool", () => {
  it("is absent when search is disabled or the wire is not Gemini", () => {
    expect(createGoogleSearchTool(provider(false))).toBeUndefined();
    expect(createGoogleSearchTool({ ...provider(), extensionAgentKey: "extension" })).toBeUndefined();
    expect(createGoogleSearchTool({ ...provider(), apiStyle: "responses" })).toBeUndefined();
    expect(createGoogleSearchTool({ ...provider(), modelConfig: undefined })).toBeUndefined();
  });

  it("uses one isolated native search request and returns verifiable sources", async () => {
    const requests = fixture();
    const result = await createGoogleSearchTool(provider())!.execute("search", { query: "query" });
    expect(result.isError).not.toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].tools).toEqual([{ googleSearch: {} }]);
    expect(requests[0].contents).toEqual([{ role: "user", parts: [{ text: "query" }] }]);
    expect(requests[0].systemInstruction).toBeUndefined();
    expect(result.details).toMatchObject({ sources: [{ url: "https://example.com/source", title: "Source" }], queries: ["query"] });
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("Grounded answer") }]);
  });

  it("does not label an ungrounded answer as a successful search", async () => {
    fixture(false);
    const result = await createGoogleSearchTool(provider())!.execute("search", { query: "query" });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ errorCode: "GOOGLE_SEARCH_NOT_GROUNDED" });
    expect(JSON.stringify(result.content)).not.toContain("Grounded answer");
  });

  it("does not send an empty or already cancelled search", async () => {
    const requests = fixture();
    const tool = createGoogleSearchTool(provider())!;
    const empty = await tool.execute("empty", { query: " " });
    const cancelled = await tool.execute("cancelled", { query: "query" }, AbortSignal.abort());
    expect(empty.isError).toBe(true);
    expect(cancelled.details).toMatchObject({ errorCode: "GOOGLE_SEARCH_ABORTED" });
    expect(requests).toEqual([]);
  });

  it("keeps the main function request separate from the native search request", async () => {
    const requests = fixture();
    const config = provider();
    const tool = createGoogleSearchTool(config)!;
    const model = buildProviderModel(config);
    await createProviderModels(config, model).streamSimple(model, normalizeContext({
      tools: [tool], messages: [{ role: "user", content: "Search", timestamp: 1 }],
    })).result();
    expect(requests[0].tools).not.toContainEqual({ googleSearch: {} });
    expect(requests[0].tools[0].functionDeclarations[0].name).toBe("GoogleSearch");
    await tool.execute("search", { query: "query" });
    expect(requests[1].tools).toEqual([{ googleSearch: {} }]);
  });

  it("keeps grounded partial results and marks output truncation", async () => {
    fixture(true, "MAX_TOKENS");
    const result = await createGoogleSearchTool(provider())!.execute("search", { query: "query" });
    expect(result.isError).not.toBe(true);
    expect(result.details).toMatchObject({ truncated: true });
  });

  it("preserves provider failure diagnostics without exposing the API key", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: {
      code: 401, message: "Invalid credential fixture-key", status: "UNAUTHENTICATED",
    } }), { status: 401, headers: { "content-type": "application/json" } }));
    const result = await createGoogleSearchTool(provider())!.execute("search", { query: "query" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("fixture-key");
    expect(JSON.stringify(result.content)).toContain("Invalid credential");
  });
});
