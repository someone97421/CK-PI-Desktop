import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fetch as uploadFetch, FormData as UploadFormData } from "undici";
import type { Api, Model, StreamOptions } from "@earendil-works/pi-ai";
import {
  LITTERBOX_MAX_FILE_BYTES, MOONSHOT_MAX_FILE_BYTES,
  type ExternalMediaReference, type FileHostingSettings, type MediaReference,
} from "@pi-desktop/shared";
import type { MediaStore } from "./media-store.js";

export type MediaTransportOptions = {
  fileHosting?: FileHostingSettings;
  providerId?: string;
  authKind?: string;
  headers?: Record<string, string>;
};

type ProviderFile = { id?: unknown; status?: string; expires_at?: number };
const LITTERBOX_API = "https://litterbox.catbox.moe/resources/internals/api.php";
const EXPIRATION_HOURS = { "1h": 1, "12h": 12, "24h": 24, "72h": 72 } as const;
const uploads = new Map<string, ExternalMediaReference>();

function remember(key: string, value: ExternalMediaReference): ExternalMediaReference {
  for (const [id, item] of uploads) if (item.expiresAt !== undefined && item.expiresAt <= Date.now()) uploads.delete(id);
  uploads.set(key, value);
  return value;
}

function cached(key: string): ExternalMediaReference | undefined {
  const entry = uploads.get(key);
  return entry && (entry.expiresAt ?? Infinity) > Date.now() + 60_000 ? entry : undefined;
}

function fileName(ref: MediaReference): string {
  const extension: Record<string, string> = {
    "video/mp4": "mp4", "video/mov": "mov", "video/quicktime": "mov",
    "video/mpeg": "mpeg", "video/avi": "avi", "video/x-flv": "flv",
    "video/webm": "webm", "video/wmv": "wmv", "video/3gpp": "3gp",
  };
  return `video.${extension[ref.mimeType] ?? "mp4"}`;
}

export async function uploadVideo(
  ref: MediaReference,
  store: MediaStore,
  transport: "url" | "provider-file",
  model: Model<Api>,
  config: MediaTransportOptions,
  options?: StreamOptions,
): Promise<ExternalMediaReference> {
  const signal = options?.signal;
  signal?.throwIfAborted();
  const maxBytes = transport === "url" ? LITTERBOX_MAX_FILE_BYTES : MOONSHOT_MAX_FILE_BYTES;
  if (ref.size > maxBytes) throw new Error(`视频超过${transport === "url" ? " Litterbox 1GB" : " Moonshot 100MiB"} 单文件上传上限。`);
  if (transport === "url") {
    const hosting = config.fileHosting?.litterbox;
    if (hosting?.enabled !== true) throw new Error("视频使用 URL 传输，但 Litterbox 文件托管尚未开启。请在设置 → 模型和服务 → 文件托管中开启，或改用 Base64。");
    const expiration = hosting.expiration ?? "24h";
    const hours = EXPIRATION_HOURS[expiration];
    if (!hours) throw new Error("Litterbox 文件有效期无效。");
    const key = `litterbox:${expiration}:${ref.mimeType}:${ref.ref}`;
    const previous = cached(key);
    if (previous) return previous;
    const body = new UploadFormData();
    body.set("reqtype", "fileupload");
    body.set("time", expiration);
    body.set("fileToUpload", await store.blob(ref, signal), fileName(ref));
    const startedAt = Date.now();
    // 公共托管使用独立请求，不能继承模型的认证 headers 或 fetch 包装器。
    const response = await uploadFetch(LITTERBOX_API, { method: "POST", body, signal });
    if (!response.ok) throw new Error(`Litterbox 视频上传失败（HTTP ${response.status}）。`);
    const text = (await response.text()).trim();
    let url: URL;
    try { url = new URL(text); } catch { throw new Error("Litterbox 未返回有效文件链接。"); }
    if (url.protocol !== "https:" || url.hostname !== "litter.catbox.moe" || url.username || url.password) {
      throw new Error("Litterbox 返回了非预期文件链接。");
    }
    return remember(key, { url: url.href, mimeType: ref.mimeType, size: ref.size, expiresAt: startedAt + hours * 3_600_000 });
  }

  if (model.api !== "openai-completions") throw new Error("Moonshot 文件引用仅适用于支持该扩展的 Chat Completions 接口。");
  const endpoint = `${model.baseUrl.replace(/\/+$/, "")}/files`;
  const headers = new Headers();
  if (config.authKind !== "none" && options?.apiKey) headers.set("Authorization", `Bearer ${options.apiKey}`);
  for (const source of [model.headers, options?.headers, config.headers]) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value === null) headers.delete(key);
      else headers.set(key, value);
    }
  }
  headers.delete("Content-Type");
  headers.delete("Content-Length");
  const fetchProvider = options?.fetch ?? globalThis.fetch;
  const scope = createHash("sha256").update(JSON.stringify([config.providerId, endpoint, [...headers]])).digest("hex");
  const key = `moonshot:${scope}:${ref.mimeType}:${ref.ref}`;
  const previous = cached(key);
  if (previous) {
    const status = await fetchProvider(`${endpoint}/${encodeURIComponent(previous.url.slice(5))}`, { headers, signal });
    if (status.ok) {
      const file = await status.json() as ProviderFile;
      if (!["error", "failed", "deleted", "expired"].includes(file.status ?? "") &&
          !(typeof file.expires_at === "number" && file.expires_at * 1000 <= Date.now() + 60_000)) return previous;
    } else if (status.status !== 404 && status.status !== 410) {
      throw new Error(`确认厂商视频文件状态失败（HTTP ${status.status}）。`);
    }
    uploads.delete(key);
  }
  const body = new FormData();
  body.set("purpose", "video");
  body.set("file", await store.blob(ref, signal), fileName(ref));
  const response = await fetchProvider(endpoint, { method: "POST", headers, body, signal });
  if (!response.ok) throw new Error(`厂商视频上传失败（HTTP ${response.status}）；当前端点需要支持 Moonshot 文件上传协议。`);
  let file = await response.json() as ProviderFile;
  if (typeof file.id !== "string" || !file.id.trim()) throw new Error("厂商上传接口未返回文件 ID。");
  const fileEndpoint = `${endpoint}/${encodeURIComponent(file.id)}`;
  const id = file.id;
  try {
    const processingSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]);
    while (["processing", "pending", "uploaded"].includes(file.status ?? "")) {
      await delay(1000, undefined, { signal: processingSignal });
      const status = await fetchProvider(fileEndpoint, { headers, signal: processingSignal });
      if (!status.ok) throw new Error(`读取厂商视频处理状态失败（HTTP ${status.status}）。`);
      file = await status.json() as ProviderFile;
    }
    if (["error", "failed", "deleted", "expired"].includes(file.status ?? "")) throw new Error("厂商未能处理视频文件。");
    signal?.throwIfAborted();
    return remember(key, {
      url: `ms://${id}`, mimeType: ref.mimeType, size: ref.size,
      ...(typeof file.expires_at === "number" ? { expiresAt: file.expires_at * 1000 } : {}),
    });
  } catch (error) {
    try {
      const cleanup = await fetchProvider(fileEndpoint, { method: "DELETE", headers, signal: AbortSignal.timeout(5000) });
      await cleanup.body?.cancel();
    } catch { /* 清理失败不替换原始上传错误。 */ }
    throw error;
  }
}
