import { describe, expect, it, vi } from "vitest";
import { normalizeContext, type Message, type ProviderStreams } from "@earendil-works/pi-ai";
import { buildProviderModel } from "./provider-binding.js";
import { withMediaInput } from "./media-provider.js";

const model = buildProviderModel({
  id: "test", name: "Test", apiStyle: "google_generative_ai",
  modelId: "gemini-test", apiKey: "test", supportsReasoning: false, supportedThinkingLevels: [],
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
