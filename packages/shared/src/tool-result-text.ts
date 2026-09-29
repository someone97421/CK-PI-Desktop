/**
 * 工具结果的文本副本只保留媒体元信息。完整 payload 仍由 toolResult 保存，
 * 避免视频等 base64 在界面、搜索文本和持久化请求中重复膨胀。
 */
export function toolResultText(result: unknown, space?: number): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result, function (key, value) {
    if (typeof value !== "string") return value;
    const mediaData = key === "data" && (
      this.type === "image" || this.type === "audio" ||
      typeof this.mimeType === "string" || typeof this.media_type === "string"
    );
    if (mediaData || key === "dataBase64" || /^data:[^,]*;base64,/i.test(value)) {
      return `[media payload: ${value.length} chars]`;
    }
    return value;
  }, space) ?? "";
}

/** 兼容旧队列：只缩减工具消息的冗余文本，不修改原始结果或消息身份。 */
export function compactToolMessage<T>(message: T): T {
  if (!message || typeof message !== "object") return message;
  const row = message as Record<string, unknown>;
  if (row.role !== "tool" || typeof row.content !== "string" ||
      row.content.length <= 64 * 1024 || !row.toolResult ||
      typeof row.toolResult !== "object") return message;
  const content = toolResultText(row.toolResult);
  return content.length < row.content.length ? { ...message, content } : message;
}
