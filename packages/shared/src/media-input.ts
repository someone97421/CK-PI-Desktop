/** Gemini 音视频沿用普通文件持久化，发送时由 MIME 决定内联格式。 */
export const GEMINI_INLINE_REQUEST_BYTES = 100_000_000;

export type MediaInputCapabilities = {
  supportsAudio?: boolean;
  supportsVideo?: boolean;
};

export const MEDIA_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  wav: "audio/wav", mp3: "audio/mpeg", aiff: "audio/aiff", aif: "audio/aiff",
  aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", flac: "audio/flac",
  m4a: "audio/m4a", opus: "audio/opus", mp4: "video/mp4", m4v: "video/mp4",
  mpeg: "video/mpeg", mpg: "video/mpeg", mov: "video/mov", avi: "video/avi",
  flv: "video/x-flv", webm: "video/webm", wmv: "video/wmv", "3gp": "video/3gpp",
};

export function mediaMimeType(supplied?: string, ...names: Array<string | undefined>): string | undefined {
  const mime = supplied?.trim().toLowerCase();
  if (mime?.startsWith("audio/") || mime?.startsWith("video/")) {
    return ({ "audio/x-wav": "audio/wav", "audio/x-m4a": "audio/m4a",
      "video/quicktime": "video/mov", "video/x-msvideo": "video/avi",
      "video/x-ms-wmv": "video/wmv" } as Record<string, string>)[mime] ?? mime;
  }
  if (mime && mime !== "application/octet-stream") return undefined;
  for (const name of names) {
    const found = MEDIA_MIME_BY_EXTENSION[name?.split(".").at(-1)?.toLowerCase() ?? ""];
    if (found) return found;
  }
  return undefined;
}

export function supportsMediaMime(mime: string | undefined, capabilities: MediaInputCapabilities): boolean {
  return (mime?.startsWith("audio/") === true && capabilities.supportsAudio === true) ||
    (mime?.startsWith("video/") === true && capabilities.supportsVideo === true);
}

export function base64ByteLength(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}
