import type { ExternalMediaReference } from "@pi-desktop/shared";

/** 将 SDK 的二进制内容块转换为 Chat Completions 视频扩展。 */
export function applyChatVideoInput(payload: unknown, files: ReadonlyMap<string, ExternalMediaReference>): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.messages)) return payload;
  const found = new Set<string>();
  const messages = record.messages.map((message: Record<string, unknown>) => {
    if (!Array.isArray(message.content)) return message;
    return { ...message, content: message.content.map((part: Record<string, unknown>) => {
      const image = part.image_url as { url?: unknown } | undefined;
      if (part.type !== "image_url" || typeof image?.url !== "string") return part;
      const match = /^data:(video\/[^;,]+);base64,([\s\S]*)$/.exec(image.url);
      if (!match) return part;
      const ref = files.get(match[2]!);
      if (ref) found.add(match[2]!);
      return { type: "video_url", video_url: { url: ref?.url ?? image.url } };
    }) };
  });
  if (found.size !== files.size) throw new Error("请求未包含全部视频链接，请检查模型媒体能力与适配器版本。");
  return { ...record, messages };
}
