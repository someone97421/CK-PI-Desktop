export type VideoTransport = "base64" | "url" | "provider-file";
export type LitterboxExpiration = "1h" | "12h" | "24h" | "72h";
export type FileHostingSettings = {
  litterbox?: { enabled: boolean; expiration: LitterboxExpiration };
};

export const GEMINI_INLINE_REQUEST_BYTES = 100_000_000;
export const LITTERBOX_MAX_FILE_BYTES = 1_000_000_000;
export const MOONSHOT_MAX_FILE_BYTES = 100 * 1024 * 1024;

export type MediaInputCapabilities = {
  supportsAudio?: boolean;
  supportsVideo?: boolean;
  videoTransport?: VideoTransport;
  maxVideoBytes?: number;
};

export function videoUploadByteLimit(mime: string | undefined, capabilities: MediaInputCapabilities): number | undefined {
  if (!mime?.startsWith("video/") || !capabilities.supportsVideo ||
      !capabilities.videoTransport || capabilities.videoTransport === "base64") return undefined;
  return capabilities.maxVideoBytes ?? (capabilities.videoTransport === "provider-file"
    ? MOONSHOT_MAX_FILE_BYTES : LITTERBOX_MAX_FILE_BYTES);
}

export function mediaInlineBytes(size: number, mime: string | undefined, capabilities: MediaInputCapabilities): number {
  return videoUploadByteLimit(mime, capabilities) === undefined ? base64ByteLength(size) : 0;
}

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
