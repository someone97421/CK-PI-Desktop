import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type TranscriptContext, type Model, type Api, type Message, type ImageContent, type ProviderStreams, type StreamOptions } from "@earendil-works/pi-ai";
import { GEMINI_INLINE_REQUEST_BYTES, base64ByteLength, mediaReferenceOf, mediaMimeType, supportsMediaMime, type MediaInputCapabilities } from "@pi-desktop/shared";
import { mediaStore, type MediaStore } from "./media-store.js";

/** pi-ai 用 image 内容块承载二进制；只在 Gemini 适配边界放行音视频 MIME。 */
export function withMediaInput(
  adapter: ProviderStreams,
  capabilities: MediaInputCapabilities,
  requestLimitBytes?: number,
  store: MediaStore = mediaStore,
): ProviderStreams {
  function prepare(model: Model<Api>, context: TranscriptContext) {
    const gemini = model.api === "google-generative-ai";
    let hasMedia = false;
    let messages: Message[] = context.messages.map((message) => {
      if ((message.role !== "user" && message.role !== "toolResult") || typeof message.content === "string") return message;
      return { ...message, content: message.content.map((part) => {
        const mediaRef = mediaReferenceOf(part);
        if (mediaRef) part = { type: "image", data: "", mimeType: mediaRef.mimeType, ...{ mediaRef } };
        if (part.type !== "image") return part;
        if (!mediaMimeType(part.mimeType)) {
          return !model.input.includes("image")
            ? { type: "text" as const, text: "[图片附件：当前模型未启用图片理解能力]" }
            : part;
        }
        if (!gemini || !supportsMediaMime(part.mimeType, capabilities)) {
          return { type: "text" as const, text: `[媒体附件 ${part.mimeType}：当前模型未启用对应理解能力]` };
        }
        hasMedia = true;
        return part;
      }) };
    });

    const hasPayload = messages.some((message) =>
      (message.role === "user" || message.role === "toolResult") &&
      Array.isArray(message.content) && message.content.some((part) => part.type === "image"));
    const budget = requestLimitBytes ?? (gemini && hasPayload ? GEMINI_INLINE_REQUEST_BYTES : undefined);
    if (budget !== undefined) {
      // 只裁减本次请求视图中的 Read 二进制，保留转录、来源文本及分析结论。
      // 从旧到新释放空间，避免多轮分段分析不断累计媒体；最终大小仍由 onPayload 兜底。
      let estimatedBytes = Buffer.byteLength(JSON.stringify({ ...context, messages }), "utf8");
      for (const message of messages) {
        if ((message.role !== "user" && message.role !== "toolResult") || typeof message.content === "string") continue;
        for (const part of message.content) {
          const ref = mediaReferenceOf(part);
          if (ref) estimatedBytes += base64ByteLength(ref.size);
        }
      }
      const newestRead = messages.findLastIndex((message) => message.role === "toolResult" && message.toolName === "Read");
      messages = messages.map((message, index) => {
        if (estimatedBytes <= budget || index === newestRead || message.role !== "toolResult" || message.toolName !== "Read") return message;
        return { ...message, content: message.content.map((part) => {
          if (estimatedBytes <= budget || part.type !== "image") return part;
          const notice = { type: "text" as const, text: `[为控制请求体积，本次未附带此 Read 的 ${part.mimeType} 二进制，来源文字仍保留；需要细查时请按原路径读取较小片段。]` };
          estimatedBytes -= Buffer.byteLength(JSON.stringify(part), "utf8") - Buffer.byteLength(JSON.stringify(notice), "utf8");
          const ref = mediaReferenceOf(part);
          if (ref) estimatedBytes -= base64ByteLength(ref.size);
          return notice;
        }) };
      });
    }

    if (gemini && hasMedia) {
      // 音视频统一使用普通 user inlineData，避免 SDK 按模型名称将其嵌入
      // 图片专用的多模态 functionResponse 路径；同批工具回执保持相邻。
      const lifted: Message[] = [];
      let pending: ImageContent[] = [];
      let timestamp = 0;
      const flush = () => {
        if (pending.length === 0) return;
        lifted.push({ role: "user", content: [
          { type: "text", text: "以下是前述工具读取的音视频素材，来源和文件顺序见工具结果。" },
          ...pending,
        ], timestamp });
        pending = [];
      };
      for (const message of messages) {
        if (message.role !== "toolResult") {
          flush();
          lifted.push(message);
          continue;
        }
        timestamp = message.timestamp;
        lifted.push({ ...message, content: message.content.filter((part) => {
          if (part.type !== "image" || !mediaMimeType(part.mimeType)) return true;
          pending.push(part);
          return false;
        }) });
      }
      flush();
      messages = lifted;
    }
    // 仅用于 SDK 编码，不更改模型实际的图片能力或持久化附件类型。
    const wireModel = hasMedia && !model.input.includes("image")
      ? { ...model, input: [...model.input, "image" as const] }
      : model;
    return { model: wireModel, context: { ...context, messages }, hasMedia: hasMedia || (gemini && hasPayload), budget };
  }

  function hydrateAndStream(
    model: Model<Api>, context: TranscriptContext, options: StreamOptions | undefined, budget: number | undefined,
    start: (context: TranscriptContext) => AssistantMessageEventStream,
  ): AssistantMessageEventStream {
    const hasRefs = context.messages.some((message) =>
      (message.role === "user" || message.role === "toolResult") &&
      Array.isArray(message.content) && message.content.some((part) => mediaReferenceOf(part)));
    if (!hasRefs) return start(context);
    const output = createAssistantMessageEventStream();
    void (async () => {
      try {
        // 引用的大小也计入预算，在分配大块 base64 之前拒绝装不下的请求。
        if (budget !== undefined) {
          let bytes = Buffer.byteLength(JSON.stringify(context), "utf8");
          for (const message of context.messages) {
            if ((message.role !== "user" && message.role !== "toolResult") || typeof message.content === "string") continue;
            for (const part of message.content) {
              const ref = mediaReferenceOf(part);
              if (ref) bytes += base64ByteLength(ref.size);
            }
          }
          if (bytes > budget) throw new Error(`媒体请求预计超过 ${(budget / 1_000_000).toFixed(0)}MB 上限，请减少附件或缩小素材。`);
        }
        const messages: Message[] = [];
        for (const message of context.messages) {
          options?.signal?.throwIfAborted();
          if ((message.role !== "user" && message.role !== "toolResult") || typeof message.content === "string") {
            messages.push(message);
            continue;
          }
          const content = [];
          for (const part of message.content) {
            const ref = mediaReferenceOf(part);
            content.push(ref
              ? { type: "image" as const, mimeType: ref.mimeType, data: await store.read(ref, options?.signal) }
              : part);
          }
          messages.push({ ...message, content });
        }
        options?.signal?.throwIfAborted();
        for await (const event of start({ ...context, messages })) output.push(event);
        output.end();
      } catch (error) {
        const reason = options?.signal?.aborted ? "aborted" : "error";
        const failed: AssistantMessage = {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: reason, errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
        };
        output.push({ type: "error", reason, error: failed });
        output.end(failed);
      }
    })();
    return output;
  }

  function requestOptions<T extends StreamOptions>(options: T | undefined, hasMedia: boolean): T | undefined {
    const limit = requestLimitBytes ?? (hasMedia ? GEMINI_INLINE_REQUEST_BYTES : undefined);
    if (limit === undefined) return options;
    return {
      ...options,
      onPayload: async (payload: unknown, model: Model<Api>) => {
        const replaced = await options?.onPayload?.(payload, model);
        const current = replaced ?? payload;
        const bytes = Buffer.byteLength(JSON.stringify(current), "utf8");
        if (bytes > limit) {
          throw new Error(`媒体请求 ${(bytes / 1_000_000).toFixed(2)}MB 超过 ${(limit / 1_000_000).toFixed(0)}MB 上限（包含 Base64、历史消息及其他请求内容），请裁剪、转码或分段后重试。`);
        }
        return replaced;
      },
    } as T;
  }

  return {
    ...adapter,
    stream(model, context, options) {
      const prepared = prepare(model, context);
      return hydrateAndStream(prepared.model, prepared.context, options, prepared.budget,
        (hydrated) => adapter.stream(prepared.model, hydrated, requestOptions(options, prepared.hasMedia)));
    },
    streamSimple(model, context, options) {
      const prepared = prepare(model, context);
      return hydrateAndStream(prepared.model, prepared.context, options, prepared.budget,
        (hydrated) => adapter.streamSimple(prepared.model, hydrated, requestOptions(options, prepared.hasMedia)));
    },
  };
}
