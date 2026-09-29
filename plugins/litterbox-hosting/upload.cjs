"use strict";
const { randomUUID } = require("node:crypto");
const { basename, extname } = require("node:path");
const ENDPOINT = "https://litterbox.catbox.moe/resources/internals/api.php";
const TYPES = { ".mp4":"video/mp4", ".webm":"video/webm", ".mov":"video/quicktime", ".mpeg":"video/mpeg", ".mpg":"video/mpeg", ".avi":"video/avi", ".wmv":"video/wmv", ".flv":"video/x-flv", ".3gp":"video/3gpp", ".mp3":"audio/mpeg", ".wav":"audio/wav", ".ogg":"audio/ogg", ".flac":"audio/flac", ".m4a":"audio/mp4", ".aac":"audio/aac", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".webp":"image/webp", ".bmp":"image/bmp", ".gif":"image/gif", ".pdf":"application/pdf" };

async function uploadFile(fs, args, signal, fetcher = fetch) {
  const path = String(args.path || "").trim();
  const expiration = args.expiration || "24h";
  if (!path) throw new Error("请提供文件路径。");
  if (!["1h", "12h", "24h", "72h"].includes(expiration)) throw new Error("有效期必须为 1h、12h、24h 或 72h。");
  const mimeType = args.mimeType || TYPES[extname(path).toLowerCase()] || "application/octet-stream";
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(mimeType)) throw new Error("无效 MIME 类型。");
  const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10 * 60 * 1000)]);
  combined.throwIfAborted();
  const original = await fs.stat(path);
  const size = original.size;
  if (!Number.isSafeInteger(size) || size <= 0 || size > 1_000_000_000) throw new Error("文件必须非空且不超过 Litterbox 的 1 GB 上限。");
  const boundary = `pi-litterbox-${randomUUID()}`;
  const filename = basename(path).replace(/[^a-zA-Z0-9._-]/g, "_");
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n--${boundary}\r\nContent-Disposition: form-data; name="time"\r\n\r\n${expiration}\r\n--${boundary}\r\nContent-Disposition: form-data; name="fileToUpload"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  async function* body() {
    yield head;
    for (let offset = 0; offset < size;) {
      combined.throwIfAborted();
      const length = Math.min(256 * 1024, size - offset);
      const part = await fs.readRange(path, offset, length);
      const bytes = Buffer.from(part.bytes);
      if (part.totalSize !== size || bytes.length !== length) throw new Error("上传期间文件大小发生变化，请重试。");
      offset += bytes.length;
      yield bytes;
    }
    const after = await fs.stat(path);
    if (after.size !== size || after.mtimeMs !== original.mtimeMs) throw new Error("上传期间文件已修改，请重试。");
    yield tail;
  }
  const startedAt = Date.now();
  const response = await fetcher(ENDPOINT, { method:"POST", headers:{ "Content-Type":`multipart/form-data; boundary=${boundary}`, "Content-Length":String(head.length + size + tail.length) }, body:body(), duplex:"half", redirect:"error", signal:combined });
  // 服务端错误页面也不能变成巨型工具日志。
  let text = "";
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Litterbox 返回空响应。");
  let received = 0;
  try {
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > 4096) throw new Error("Litterbox 返回异常长响应。");
      chunks.push(Buffer.from(value));
    }
    text = Buffer.concat(chunks).toString("utf8").trim();
  } finally { await reader.cancel().catch(() => {}); }
  if (!response.ok) throw new Error(`Litterbox 上传失败（HTTP ${response.status}）：${text.slice(0, 300)}`);
  let url;
  try { url = new URL(text); } catch { throw new Error(`Litterbox 未返回文件链接：${text.slice(0, 300)}`); }
  if (url.protocol !== "https:" || url.hostname !== "litter.catbox.moe" || url.username || url.password || url.port || !/^\/[a-zA-Z0-9._-]+$/.test(url.pathname) || url.search || url.hash) throw new Error("Litterbox 返回了非预期文件地址。");
  const expiresAt = startedAt + Number.parseInt(expiration, 10) * 3600_000;
  const media = /^(image|audio|video)\//.test(mimeType);
  return { ok:true, url:url.href, path, mimeType, size, expiresAt,
    ...(media && size <= 100_000_000 ? { mediaUrl:{ url:url.href, mimeType, size, expiresAt } } : {}),
    ...(media && size > 100_000_000 ? { warning:"上传成功，但文件超过 Gemini 外链媒体 100 MB 上限；请裁剪后重新上传。" } : {}),
  };
}
module.exports = { uploadFile };
