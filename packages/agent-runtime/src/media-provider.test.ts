import { describe, expect, it, vi } from "vitest";
import { normalizeContext, type Message, type ProviderStreams } from "@earendil-works/pi-ai";
import { buildProviderModel } from "./provider-binding.js";
import { withMediaInput } from "./media-provider.js";
import * as google from "@earendil-works/pi-ai/api/google-generative-ai";
import { externalMediaBlock } from "@pi-desktop/shared";
import { applyGoogleMediaUrls } from "./google-media-url.js";
import { encodeAgentMessages, decodeAgentMessages } from "./subagent-checkpoint.js";

const model = buildProviderModel({
  id: "test", name: "Test", apiStyle: "google_generative_ai",
  modelId: "gemini-test", apiKey: "test", supportsReasoning: false, supportedThinkingLevels: [],
});

describe("Gemini 外链媒体", () => {
  const media = { url: "https://litter.catbox.moe/test.mp4", mimeType: "video/mp4", size: 1234 };
  it("真实 SDK 请求构造将标记转换为 fileData，不发送 base64", async () => {
    let payload: unknown;
    const controller = new AbortController();
    const result = withMediaInput(google, { supportsVideo: true }).streamSimple(model,
      normalizeContext({ messages: [{ role: "user", content: [externalMediaBlock(media)], timestamp: 0 }] }), {
        apiKey: "test-not-a-real-key",
        signal: controller.signal,
        onPayload(value) { payload = value; throw new Error("测试在网络请求之前停止"); },
      });
    await result.result();
    expect(payload).toMatchObject({ contents: [{ parts: [{ fileData: { fileUri: media.url, mimeType: media.mimeType } }] }] });
    expect(JSON.stringify(payload)).not.toContain("inlineData");
    expect(JSON.stringify(payload)).not.toContain("pi-external-media");
    expect((payload as { config: { abortSignal: AbortSignal } }).config.abortSignal).toBe(controller.signal);
  });
  it("旧链接到期后保留提示，新上传可以继续", () => {
    const message: Message = { role: "user", content: [externalMediaBlock({ ...media, expiresAt: 1 }), externalMediaBlock(media)], timestamp: 0 };
    const { sent } = capture([message], 10000);
    expect(JSON.stringify(sent)).toContain("已过期");
    expect(sent.messages.reduce((count, m) => count + (Array.isArray(m.content) ? m.content.filter(p => p.type === "image").length : 0), 0)).toBe(1);
  });
  it("不支持 URL 的 Gemini 2.0 在请求前明确失败", async () => {
    const adapter = { stream: vi.fn(), streamSimple: vi.fn() };
    const result = withMediaInput(adapter, { supportsVideo: true }).streamSimple({ ...model, id: "gemini-2.0-flash" },
      normalizeContext({ messages: [{ role: "user", content: [externalMediaBlock(media)], timestamp: 0 }] }));
    expect((await result.result()).errorMessage).toContain("不支持");
    expect(adapter.streamSimple).not.toHaveBeenCalled();
  });
  it("标记丢失时失败，普通内联数据保持原样", () => {
    const refs = new Map([["marker", media]]);
    expect(() => applyGoogleMediaUrls({}, refs)).toThrow("未包含全部");
    const result = applyGoogleMediaUrls({ contents: [{ parts: [{ inlineData: { data: "marker" } }, { inlineData: { data: "AAAA", mimeType: "image/png" } }] }] }, refs);
    expect(result).toMatchObject({ contents: [{ parts: [{ fileData: { fileUri: media.url } }, { inlineData: { data: "AAAA" } }] }] });
  });
  it("外链快照恢复保留结构化信息，获取预算优先保留最新素材", () => {
    const messages = decodeAgentMessages(encodeAgentMessages([
      { role: "user", timestamp: 0, content: [externalMediaBlock({ ...media, size: 60_000_000 })] },
      { role: "user", timestamp: 1, content: [externalMediaBlock({ ...media, url: "https://litter.catbox.moe/new.mp4", size: 60_000_000 })] },
    ])) as Message[];
    expect(JSON.stringify(messages)).toContain('"mediaUrl"');
    const { sent } = capture(messages, 10000);
    expect(JSON.stringify(sent)).toContain("本次未附带较早");
    expect(sent.messages.reduce((count, m) => count + (Array.isArray(m.content) ? m.content.filter(p => p.type === "image").length : 0), 0)).toBe(1);
  });
});

function capture(messages: Message[], limit: number) {
  const streamSimple = vi.fn<ProviderStreams["streamSimple"]>();
  const adapter = { stream: vi.fn<ProviderStreams["stream"]>(), streamSimple };
  const context = { ...normalizeContext({ messages: [] }), messages };
  withMediaInput(adapter, { supportsVideo: true }, limit).streamSimple(model, context);
  return { original: context, sent: streamSimple.mock.calls[0][1], options: streamSimple.mock.calls[0][2] };
}

function clip(id: string, data: string): Message {
  return { role: "toolResult", toolCallId: id, toolName: "Read", isError: false, timestamp: 0,
    content: [{ type: "text", text: `${id}.mp4` }, { type: "image", mimeType: "video/mp4", data }] };
}

describe("媒体请求预算", () => {
  it("超预算时移除较早 Read 的二进制，保留最新片段及原始转录", () => {
    const { sent, original } = capture([clip("old", "A".repeat(1600)), clip("new", "B".repeat(1600))], 2600);
    const wire = JSON.stringify(sent.messages);
    expect(wire).not.toContain("A".repeat(1600));
    expect(wire).toContain("B".repeat(1600));
    expect(wire).toContain("old.mp4");
    expect(wire).toContain("本次未附带");
    expect(JSON.stringify(original.messages)).toContain("A".repeat(1600));
  });

  it("最终完整请求按 UTF-8 字节封顶，并计入上游 payload 替换", async () => {
    const streamSimple = vi.fn<ProviderStreams["streamSimple"]>();
    const adapter = { stream: vi.fn<ProviderStreams["stream"]>(), streamSimple };
    withMediaInput(adapter, {}, 100).streamSimple(model, normalizeContext({ messages: [] }), {
      onPayload: () => ({ text: "中".repeat(40) }),
    });
    const onPayload = streamSimple.mock.calls[0][2]?.onPayload;
    expect(onPayload).toBeDefined();
    await expect(onPayload!({}, model)).rejects.toThrow("超过");
  });

  it("允许完整请求恰好达到上限", async () => {
    const { options } = capture([], 100);
    // JSON.stringify({text: ...}) 的固定部分为 11 个字节。
    await expect(options!.onPayload!({ text: "x".repeat(89) }, model)).resolves.toBeUndefined();
    await expect(options!.onPayload!({ text: "x".repeat(90) }, model)).rejects.toThrow("超过");
  });
});
