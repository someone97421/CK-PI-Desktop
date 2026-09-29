import type { ExternalMediaReference } from "@pi-desktop/shared";

/** pi-ai 暂无 fileData 内容块，只在 Google 请求构造边界替换本轮标记。 */
export function applyGoogleMediaUrls(payload: unknown, files: ReadonlyMap<string, ExternalMediaReference>): unknown {
  if (files.size === 0) return payload;
  const found = new Set<string>();
  function visit(value: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(visit);
    const record = value as Record<string, unknown>;
    const inline = record.inlineData as { data?: unknown } | undefined;
    const ref = typeof inline?.data === "string" ? files.get(inline.data) : undefined;
    if (ref) {
      found.add(inline!.data as string);
      const { inlineData: _inline, ...rest } = record;
      return { ...rest, fileData: { fileUri: ref.url, mimeType: ref.mimeType } };
    }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, visit(item)]));
  }
  // config 含有 AbortSignal 等非 JSON 对象，必须保留身份及原型。
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
  const result = record ? { ...record, contents: visit(record.contents) } : payload;
  if (found.size !== files.size) throw new Error("Gemini 请求未包含全部外部媒体，已停止发送；请检查模型媒体能力与适配器版本。");
  return result;
}
