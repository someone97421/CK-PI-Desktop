import { describe, expect, it, vi } from "vitest";
import { normalizeContext } from "@earendil-works/pi-ai";
import { completeOneShot } from "./one-shot-complete.js";
import { subagentModelBinding } from "./subagent-model-binding.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import { genericModelConfig } from "./model-capabilities.js";

/**
 * The Google adapter refuses any `fetch` that is not `globalThis.fetch`
 * (issue #1072). Every request path must therefore reach it without one, while
 * the request still carries the provider's own headers.
 */
const googleProvider: RuntimeProviderConfig = {
  id: "google",
  name: "Google Gemini",
  vendorKey: "google",
  apiStyle: "google_generative_ai",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  modelId: "gemini-3.8-flash",
  apiKey: "AIza-test",
  authKind: "api_key",
  supportsReasoning: true,
  supportedThinkingLevels: ["off", "high"],
  headers: { "X-Team": "platform" },
};

type Captured = { url: string; headers: Record<string, string>; body: any };

function googleStreamResponse(): Response {
  const chunk = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;
  return new Response(
    chunk({ candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, index: 0 }] }) +
      chunk({
        candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
      }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function withStubbedGoogle<T>(
  run: (captured: Captured[]) => Promise<T>,
): Promise<T> {
  const captured: Captured[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const body = init?.body ?? (input instanceof Request ? await input.text() : "{}");
    captured.push({ url: input instanceof Request ? input.url : String(input), headers, body: JSON.parse(String(body)) });
    return googleStreamResponse();
  });
  try {
    return await run(captured);
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("Google Generative AI requests", () => {
  it.each(["audio/mpeg", "video/mp4"])("sends %s as official inlineData with image input disabled", async (mimeType) => {
    await withStubbedGoogle(async (captured) => {
      await completeOneShot({
        ...googleProvider,
        baseUrl: "https://gemini-gateway.example/v1beta",
        modelConfig: { ...genericModelConfig("media-model"), supportsAudio: true, supportsVideo: true },
      }, { messages: [{ role: "user", timestamp: 0, content: [
        { type: "text", text: "总结附件" },
        { type: "image", mimeType, data: "AQID" },
      ] }] }, "off");
      expect(captured).toHaveLength(1);
      expect(captured[0].url).toContain("https://gemini-gateway.example/");
      expect(captured[0].body.contents[0].parts).toEqual([
        { text: "总结附件" }, { inlineData: { mimeType, data: "AQID" } },
      ]);
    });
  });

  it("keeps audio and video opt-ins independent for replayed messages", async () => {
    await withStubbedGoogle(async (captured) => {
      await completeOneShot({
        ...googleProvider,
        modelConfig: { ...genericModelConfig("media-model"), supportsAudio: true, supportsVideo: false },
      }, { messages: [{ role: "user", timestamp: 0, content: [
        { type: "image", mimeType: "audio/wav", data: "AQID" },
        { type: "image", mimeType: "video/mp4", data: "BAUG" },
        { type: "image", mimeType: "image/png", data: "BwgJ" },
      ] }] }, "off");
      expect(captured[0].body.contents[0].parts).toEqual([
        { inlineData: { mimeType: "audio/wav", data: "AQID" } },
        { text: expect.stringContaining("未启用") },
        { text: expect.stringContaining("未启用图片") },
      ]);
    });
  });
  it("keeps media from Read in user inlineData after the tool response", async () => {
    await withStubbedGoogle(async (captured) => {
      await completeOneShot({
        ...googleProvider,
        modelConfig: { ...genericModelConfig("media-model"), supportsVideo: true },
      }, { messages: [
        { role: "user", timestamp: 0, content: "分析片段" },
        { role: "assistant", timestamp: 1, api: "google-generative-ai", provider: "google",
          model: googleProvider.modelId, stopReason: "toolUse",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          content: [{ type: "toolCall", id: "read-clip", name: "Read", arguments: { path: "clip.mp4" } }] },
        { role: "toolResult", timestamp: 2, toolCallId: "read-clip", toolName: "Read", isError: false,
          content: [{ type: "text", text: "clip.mp4" }, { type: "image", mimeType: "video/mp4", data: "AQID" }] },
      ] }, "off");
      const parts = captured[0].body.contents.flatMap((entry: any) => entry.parts);
      expect(parts).toContainEqual({ inlineData: { mimeType: "video/mp4", data: "AQID" } });
      const response = parts.find((part: any) => part.functionResponse)?.functionResponse;
      expect(response?.name).toBe("Read");
      expect(response?.parts).toBeUndefined();
    });
  });

  it("completes a one-shot completion through the native endpoint", async () => {
    const result = await withStubbedGoogle(async (captured) => {
      const oneShot = await completeOneShot(
        googleProvider,
        { systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
        "off",
      );
      return { oneShot, captured };
    });

    expect(result.oneShot.text).toBe("hello");
    expect(result.captured).toHaveLength(1);
    expect(result.captured[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
    );
    expect(result.captured[0].headers["x-team"]).toBe("platform");
  });

  it("streams a subagent turn through the native endpoint", async () => {
    const binding = subagentModelBinding(
      { provider: googleProvider, thinkingLevel: "off", sessionId: "session-1" },
      { claim: () => undefined },
    );

    const text = await withStubbedGoogle(async (captured) => {
      const result = await binding
        .streamFn(
          binding.model,
          normalizeContext({
            messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
          }),
          {},
        )
        .result();
      expect(captured).toHaveLength(1);
      return result.content;
    });

    expect(text).toEqual([{ type: "text", text: "hello" }]);
  });
});
