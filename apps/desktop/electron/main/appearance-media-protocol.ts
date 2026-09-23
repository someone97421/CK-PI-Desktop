import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import { APPEARANCE_MEDIA_SCHEME } from "@pi-desktop/shared";
import { resolveAppearanceMediaProtocolPath } from "./appearance-media";

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
};

function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain", "x-content-type-options": "nosniff" },
  });
}

export function registerAppearanceMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: APPEARANCE_MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  }]);
}

export function installAppearanceMediaProtocol(dataDir: string): void {
  protocol.handle(APPEARANCE_MEDIA_SCHEME, async (request) => {
    let fileName: string;
    try {
      const url = new URL(request.url);
      if (url.hostname !== "local") return notFound();
      fileName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    } catch {
      return notFound();
    }
    const path = resolveAppearanceMediaProtocolPath(dataDir, fileName);
    if (!path) return notFound();
    const mimeType = MIME_TYPES[fileName.split(".").pop()?.toLowerCase() ?? ""];
    if (!mimeType) return notFound();
    try {
      // Chromium 的 file loader 提供流式读取及视频 Range/206 支持。
      const response = await net.fetch(pathToFileURL(path).toString(), {
        method: request.method,
        headers: request.headers,
      });
      const headers = new Headers(response.headers);
      headers.set("content-type", mimeType);
      headers.set("cache-control", "no-store");
      headers.set("x-content-type-options", "nosniff");
      headers.set("access-control-allow-origin", "*");
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return notFound();
    }
  });
}
