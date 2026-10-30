import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type TranscriptContext, type Model, type Api, type Message, type ImageContent, type ProviderStreams, type StreamOptions } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { GEMINI_INLINE_REQUEST_BYTES, mediaInlineBytes, videoUploadByteLimit, mediaReferenceOf, externalMediaReferenceOf, mediaMimeType, supportsMediaMime, type ExternalMediaReference, type MediaInputCapabilities } from "@pi-desktop/shared";
import { mediaStore, type MediaStore } from "./media-store.js";
import { applyGoogleMediaUrls } from "./google-media-url.js";
import { applyChatVideoInput } from "./chat-video-input.js";
import { uploadVideo, type MediaTransportOptions } from "./video-upload.js";

function findLastMessageIndex(messages: readonly Message[], predicate: (message: Message) => boolean): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (predicate(messages[index])) return index;
  }
  return -1;
}

export function withMediaInput(
  adapter: ProviderStreams,
  capabilities: MediaInputCapabilities,
  requestLimitBytes?: number,
  store: MediaStore = mediaStore,
  transportOptions: MediaTransportOptions = {},
): ProviderStreams {
  function extraInlineBytes(part: ImageContent): number {
    const ref = mediaReferenceOf(part);
    if (ref) return mediaInlineBytes(ref.size, ref.mimeType, capabilities);
    return videoUploadByteLimit(part.mimeType, capabilities) === undefined ? 0 : -part.data.length;
  }

  function estimate(context: TranscriptContext): number {
    let bytes = Buffer.byteLength(JSON.stringify(context), "utf8");
    for (const message of context.messages) {
      if ((message.role !== "user" && message.role !== "toolResult") || typeof message.content === "string") continue;
      for (const part of message.content) if (part.type === "image") bytes += extraInlineBytes(part);
    }
    return bytes;
  }

  function prepare(model: Model<Api>, context: TranscriptContext) {
    const gemini = model.api === "google-generative-ai";
    const chat = model.api === "openai-completions";
    const supportsMime = (mime: string) => supportsMediaMime(mime, capabilities) && (gemini || (chat && mime.startsWith("video/")));
    let hasMedia = false;
    const externalFiles = new Map<string, ExternalMediaReference>();
    let externalError: Error | undefined;
    let messages: Message[] = context.messages.map((message) => {
      if ((message.role !== "user" && message.role !== "toolResult") || typeof message.content === "string") return message;
      return { ...message, content: message.content.map((part) => {
        const mediaRef = mediaReferenceOf(part);
        if (mediaRef) part = { type: "image", data: "", mimeType: mediaRef.mimeType, ...{ mediaRef } };
        const mediaUrl = externalMediaReferenceOf(part);
        if (mediaUrl) {
          if (mediaUrl.expiresAt !== undefined && mediaUrl.expiresAt <= Date.now()) {
            return { type: "text" as const, text: `[外部媒体 ${mediaUrl.mimeType} 的临时链接已过期，本次未附带素材；需要继续理解时请重新上传原文件。]` };
          }
          const supported = mediaUrl.mimeType.startsWith("image/")
            ? gemini && model.input.includes("image") : supportsMime(mediaUrl.mimeType);
          if (!supported || (gemini && /^gemini-2\.0(?:-|$)/i.test(model.id))) {
            externalError = new Error("当前模型不支持此媒体的外部 URL 输入，请切换支持的模型或使用本地附件。");
          }
          const marker = `pi-external-media:${randomUUID()}`;
          externalFiles.set(marker, mediaUrl);
          hasMedia = true;
          part = { type: "image", data: marker, mimeType: mediaUrl.mimeType };
        }
        if (part.type !== "image") return part;
        if (!mediaMimeType(part.mimeType)) {
          return !model.input.includes("image")
            ? { type: "text" as const, text: "[图片附件：当前模型未启用图片理解能力]" }
            : part;
        }
        if (!supportsMime(part.mimeType)) {
          return { type: "text" as const, text: `[媒体附件 ${part.mimeType}：当前模型未启用对应理解能力]` };
        }
        if (part.mimeType.startsWith("video/") && !mediaUrl) {
          const limit = videoUploadByteLimit(part.mimeType, capabilities);
          const size = mediaRef?.size ?? Buffer.byteLength(part.data, "base64");
          if (limit !== undefined && size > limit) externalError = new Error(`视频文件超过当前传输方式的 ${(limit / 1_000_000).toFixed(0)}MB 上限。`);
          if (gemini && capabilities.videoTransport === "provider-file") externalError = new Error("Gemini 视频请选择 Base64 或 HTTP URL 传输。");
          if (gemini && capabilities.videoTransport === "url" && /^gemini-2\.0(?:-|$)/i.test(model.id)) externalError = new Error("当前 Gemini 模型不支持外部 URL 输入，请选择 Base64。");
        }
        hasMedia = true;
        return part;
      }) };
    });

    const hasPayload = messages.some((message) =>
      (message.role === "user" || message.role === "toolResult") &&
      Array.isArray(message.content) && message.content.some((part) => part.type === "image"));
    const budget = requestLimitBytes ?? ((gemini && hasPayload) || hasMedia ? GEMINI_INLINE_REQUEST_BYTES : undefined);
    if (budget !== undefined) {
      let estimatedBytes = estimate({ ...context, messages });
      const newestRead = findLastMessageIndex(messages, (message) => message.role === "toolResult" && message.toolName === "Read");
      messages = messages.map((message, index) => {
        if (estimatedBytes <= budget || index === newestRead || message.role !== "toolResult" || message.toolName !== "Read") return message;
        return { ...message, content: message.content.map((part) => {
          if (estimatedBytes <= budget || part.type !== "image") return part;
          const notice = { type: "text" as const, text: `[为控制请求体积，本次未附带此 Read 的 ${part.mimeType} 二进制，来源文字仍保留；需要细查时请按原路径读取较小片段。]` };
          estimatedBytes -= Buffer.byteLength(JSON.stringify(part), "utf8") + extraInlineBytes(part) - Buffer.byteLength(JSON.stringify(notice), "utf8");
          return notice;
        }) };
      });
    }

    function fetchedSize(part: ImageContent): number {
      const external = externalFiles.get(part.data);
      if (external) return external.size ?? 0;
      if (videoUploadByteLimit(part.mimeType, capabilities) === undefined) return 0;
      return mediaReferenceOf(part)?.size ?? Buffer.byteLength(part.data, "base64");
    }
    if (gemini) {
      let fetchedBytes = messages.reduce((total, message) => total + (
        (message.role === "user" || message.role === "toolResult") && Array.isArray(message.content)
          ? message.content.reduce((sum, part) => sum + (part.type === "image" ? fetchedSize(part) : 0), 0) : 0), 0);
      const newestExternal = findLastMessageIndex(messages, (message) =>
        (message.role === "user" || message.role === "toolResult") && Array.isArray(message.content) &&
        message.content.some((part) => part.type === "image" && (externalFiles.has(part.data) || fetchedSize(part) > 0)));
      messages = messages.map((message, index) => {
        if (fetchedBytes <= GEMINI_INLINE_REQUEST_BYTES || index === newestExternal ||
            (message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) return message;
        return { ...message, content: message.content.map((part) => {
          const size = part.type === "image" ? fetchedSize(part) : 0;
          if (!size || fetchedBytes <= GEMINI_INLINE_REQUEST_BYTES) return part;
          fetchedBytes -= size;
          return { type: "text" as const, text: "[为控制 Gemini 获取文件总量，本次未附带较早的外链媒体；需要重新理解时请再次附加素材。]" };
        }) };
      });
      if (fetchedBytes > GEMINI_INLINE_REQUEST_BYTES) externalError = new Error("外部媒体文件合计超过 Gemini 100MB 获取上限，请减少素材。");
    }

    if ((gemini || chat) && hasMedia) {
      // 工具结果保留来源文本，媒体按原顺序放到相邻 user 内容中。
      const lifted: Message[] = [];
      let pending: ImageContent[] = [];
      let timestamp = 0;
      const flush = () => {
        if (pending.length === 0) return;
        lifted.push({ role: "user", content: [
          { type: "text", text: "以下是前述工具提供的媒体素材，来源和文件顺序见工具结果。" }, ...pending,
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
          if (part.type !== "image" || (!mediaMimeType(part.mimeType) && !externalFiles.has(part.data))) return true;
          pending.push(part);
          return false;
        }) });
      }
      flush();
      messages = lifted;
    }
    const wireModel = hasMedia && !model.input.includes("image") ? { ...model, input: [...model.input, "image" as const] } : model;
    const retained = new Set(messages.flatMap((message) =>
      (message.role === "user" || message.role === "toolResult") && Array.isArray(message.content)
        ? message.content.flatMap((part) => part.type === "image" ? [part.data] : []) : []));
    for (const marker of externalFiles.keys()) if (!retained.has(marker)) externalFiles.delete(marker);
    return { model: wireModel, context: { ...context, messages }, hasMedia: hasMedia || (gemini && hasPayload), budget, externalFiles, externalError };
  }

  function hydrateAndStream(
    prepared: ReturnType<typeof prepare>, options: StreamOptions | undefined,
    start: (context: TranscriptContext) => AssistantMessageEventStream,
  ): AssistantMessageEventStream {
    const { model, context, budget, externalError, externalFiles } = prepared;
    const needsHydration = context.messages.some((message) =>
      (message.role === "user" || message.role === "toolResult") && Array.isArray(message.content) &&
      message.content.some((part) => mediaReferenceOf(part) || (part.type === "image" &&
        !externalFiles.has(part.data) && videoUploadByteLimit(part.mimeType, capabilities) !== undefined)));
    if (!needsHydration && !externalError) return start(context);
    const output = createAssistantMessageEventStream();
    void (async () => {
      try {
        if (externalError) throw externalError;
        if (budget !== undefined && estimate(context) > budget) throw new Error(`媒体请求预计超过 ${(budget / 1_000_000).toFixed(0)}MB 上限，请减少附件或缩小素材。`);
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
            if (part.type === "image" && !externalFiles.has(part.data) && videoUploadByteLimit(part.mimeType, capabilities) !== undefined) {
              const source = ref ?? await store.putBase64(part.data, part.mimeType);
              const uploaded = await uploadVideo(source, store, capabilities.videoTransport as "url" | "provider-file", model, transportOptions, options);
              const marker = `pi-external-media:${randomUUID()}`;
              externalFiles.set(marker, uploaded);
              content.push({ type: "image" as const, data: marker, mimeType: source.mimeType });
            } else {
              content.push(ref ? { type: "image" as const, mimeType: ref.mimeType, data: await store.read(ref, options?.signal) } : part);
            }
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

  function requestOptions<T extends StreamOptions>(options: T | undefined, prepared: ReturnType<typeof prepare>): T | undefined {
    const { budget, externalFiles, hasMedia } = prepared;
    if (budget === undefined && !hasMedia) return options;
    return {
      ...options,
      onPayload: async (payload: unknown, model: Model<Api>) => {
        const translated = model.api === "google-generative-ai" ? applyGoogleMediaUrls(payload, externalFiles)
          : model.api === "openai-completions" ? applyChatVideoInput(payload, externalFiles) : payload;
        const replaced = await options?.onPayload?.(translated, model);
        const current = replaced ?? translated;
        const bytes = Buffer.byteLength(JSON.stringify(current), "utf8");
        if (budget !== undefined && bytes > budget) {
          throw new Error(`媒体请求 ${(bytes / 1_000_000).toFixed(2)}MB 超过 ${(budget / 1_000_000).toFixed(0)}MB 上限（包含 Base64、历史消息及其他请求内容），请裁剪、转码或分段后重试。`);
        }
        return current;
      },
    } as T;
  }

  return {
    ...adapter,
    stream(model, context, options) {
      const prepared = prepare(model, context);
      return hydrateAndStream(prepared, options,
        (hydrated) => adapter.stream(prepared.model, hydrated, requestOptions(options, prepared)));
    },
    streamSimple(model, context, options) {
      const prepared = prepare(model, context);
      return hydrateAndStream(prepared, options,
        (hydrated) => adapter.streamSimple(prepared.model, hydrated, requestOptions(options, prepared)));
    },
  };
}
