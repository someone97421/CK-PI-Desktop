import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import {
  base64ByteLength,
  GEMINI_INLINE_REQUEST_BYTES,
  mediaMimeType,
  supportsMediaMime,
  type MediaInputCapabilities,
} from "@pi-desktop/shared";

export type ToolInputCapabilities = MediaInputCapabilities & { supportsVision: boolean };

const IMAGE_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif",
};
const TARGET_REQUEST_BYTES = 50_000_000;

/** 仅消费宿主 Read 已授权并解析的文件引用，不接受模型直接提供的绝对路径。 */
export async function readMediaToolResult(
  path: string,
  capabilities: ToolInputCapabilities,
  signal?: AbortSignal,
) {
  const mimeType = mediaMimeType(undefined, path) ?? IMAGE_MIME[extname(path).toLowerCase()];
  const details = { path, mimeType };
  const textResult = (text: string, isError = false) => ({
    content: [{ type: "text" as const, text }], details, isError,
  });
  if (!mimeType) return textResult(`无法识别媒体格式：${path}`, true);
  const supported = mimeType.startsWith("image/")
    ? capabilities.supportsVision
    : supportsMediaMime(mimeType, capabilities);
  if (!supported) {
    return textResult(`未载入媒体 ${path}（${mimeType}）：当前模型未启用对应理解能力。图片理解=${capabilities.supportsVision}，音频理解=${capabilities.supportsAudio === true}，视频理解=${capabilities.supportsVideo === true}。可改用支持的素材形式或将能力缺口返回主代理。`);
  }
  const meta = await stat(path);
  if (!meta.isFile()) return textResult(`Read 需要普通文件：${path}`, true);
  const encodedBytes = base64ByteLength(meta.size);
  if (encodedBytes >= GEMINI_INLINE_REQUEST_BYTES) {
    return textResult(`媒体 ${path} 编码后约 ${(encodedBytes / 1_000_000).toFixed(2)}MB，已无法放入 100MB 完整请求。请裁剪、转码或分段；单次完整请求目标约 50MB，历史媒体与其他内容也计入预算。`, true);
  }
  const bytes = await readFile(path, { signal });
  signal?.throwIfAborted();
  const actualEncodedBytes = base64ByteLength(bytes.length);
  if (actualEncodedBytes >= GEMINI_INLINE_REQUEST_BYTES) {
    return textResult(`媒体读取期间体积变化，编码后达到 100MB 请求上限，请缩小素材后重试。`, true);
  }
  return {
    content: [
      { type: "text" as const, text: `已读取媒体 ${path}（${mimeType}），文件 ${bytes.length} 字节，Base64 ${actualEncodedBytes} 字节。完整请求目标约 50MB，100MB 硬封顶，历史媒体与其他请求内容计入总量。${actualEncodedBytes > TARGET_REQUEST_BYTES ? " 本素材已超过预期预算，可按任务需要裁剪或分段。" : ""}` },
      { type: "image" as const, data: bytes.toString("base64"), mimeType },
    ],
    details: { ...details, fileBytes: bytes.length, encodedBytes: actualEncodedBytes },
    isError: false,
  };
}
