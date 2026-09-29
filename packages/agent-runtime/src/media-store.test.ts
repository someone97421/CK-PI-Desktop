import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, normalizeContext, type Message, type ProviderStreams } from "@earendil-works/pi-ai";
import { mediaReferenceBlock } from "@pi-desktop/shared";
import { MediaStore } from "./media-store.js";
import { withMediaInput } from "./media-provider.js";
import { buildProviderModel } from "./provider-binding.js";
import { decodeAgentMessages, encodeAgentMessages } from "./subagent-checkpoint.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "media-ref-"));
  dirs.push(dir);
  return { dir, store: new MediaStore(join(dir, "attachments")) };
}
const model = buildProviderModel({ id: "test", name: "Test", apiStyle: "google_generative_ai",
  modelId: "gemini-test", apiKey: "test", supportsReasoning: false, supportedThinkingLevels: [] });

describe("媒体文件引用", () => {
  it("文件按内容去重，源文件删除后仍可恢复原始内容", async () => {
    const { dir, store } = await fixture();
    const source = join(dir, "sample.mp4");
    await writeFile(source, "video-content");
    const ref = await store.putFile(source, "video/mp4", 100);
    expect(await store.putBase64(Buffer.from("video-content").toString("base64"), "video/mp4")).toEqual(ref);
    await unlink(source);
    expect(await store.read(ref)).toBe(Buffer.from("video-content").toString("base64"));
    expect(await readFile(join(dir, ref.ref), "utf8")).toBe("video-content");
  });

  it("拒绝越界引用、已篡改文件及畸形 base64", async () => {
    const { dir, store } = await fixture();
    const ref = await store.putBase64("YWJj", "video/mp4");
    await expect(store.read({ ...ref, ref: "attachments/../../secret" })).rejects.toThrow("无效");
    await writeFile(join(dir, ref.ref), "xyz");
    await expect(store.read(ref)).rejects.toThrow("校验失败");
    await expect(store.putBase64("not base64!", "video/mp4")).rejects.toThrow("Base64");
  });

  it("旧工具结果迁移保留消息身份和文本，去掉 base64 的两份副本", async () => {
    const { store } = await fixture();
    const data = Buffer.alloc(256_000, 1).toString("base64");
    const toolResult = { content: [{ type: "text", text: "sample.mp4" }, { type: "image", mimeType: "video/mp4", data }] };
    const original = { role: "tool", id: "call-1", content: JSON.stringify(toolResult), toolResult };
    const migrated = await store.externalize(original);
    expect(migrated.id).toBe(original.id);
    expect(JSON.stringify(migrated).length).toBeLessThan(2000);
    expect(original.toolResult.content[1].data).toBe(data);
    expect(await store.read((migrated.toolResult.content[1] as any).mediaRef)).toBe(data);
  });

  it("子代理快照往返后，请求适配层仍装载原始视频而不是占位文本", async () => {
    const { store } = await fixture();
    const ref = await store.putBase64("YWJj", "video/mp4");
    const messages = decodeAgentMessages(encodeAgentMessages([
      { role: "user", content: [mediaReferenceBlock(ref)], timestamp: 0 },
    ])) as Message[];
    const streamSimple = vi.fn<ProviderStreams["streamSimple"]>(() => {
      const stream = createAssistantMessageEventStream(); stream.end(); return stream;
    });
    const stream = withMediaInput({ stream: streamSimple, streamSimple }, { supportsVideo: true }, 5000, store)
      .streamSimple(model, normalizeContext({ messages }));
    for await (const _event of stream) { /* 等待异步装载 */ }
    const sent = JSON.stringify(streamSimple.mock.calls[0][1]);
    expect(sent).toContain('"data":"YWJj"');
    expect(sent).toContain('"mimeType":"video/mp4"');
    expect(sent).not.toContain('"mediaRef"');
    expect(JSON.stringify(messages)).not.toContain("YWJj");
  });

  it("超预算时不会读文件，且最新素材不会被静默当成已理解", async () => {
    const { store } = await fixture();
    const ref = await store.putBase64(Buffer.alloc(1000).toString("base64"), "video/mp4");
    const read = vi.spyOn(store, "read");
    const streamSimple = vi.fn<ProviderStreams["streamSimple"]>();
    const result = await withMediaInput({ stream: streamSimple, streamSimple }, { supportsVideo: true }, 1000, store)
      .streamSimple(model, normalizeContext({ messages: [
        { role: "toolResult", toolCallId: "read", toolName: "Read", content: [mediaReferenceBlock(ref)], isError: false, timestamp: 0 },
      ] })).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("超过");
    expect(read).not.toHaveBeenCalled();
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it("文件丢失时明确失败，不发送无媒体的成功请求", async () => {
    const { dir, store } = await fixture();
    const ref = await store.putBase64("YWJj", "video/mp4");
    await unlink(join(dir, ref.ref));
    const streamSimple = vi.fn<ProviderStreams["streamSimple"]>();
    const result = await withMediaInput({ stream: streamSimple, streamSimple }, { supportsVideo: true }, 5000, store)
      .streamSimple(model, normalizeContext({ messages: [{ role: "user", content: [mediaReferenceBlock(ref)], timestamp: 0 }] })).result();
    expect(result.stopReason).toBe("error");
    expect(streamSimple).not.toHaveBeenCalled();
  });
});
