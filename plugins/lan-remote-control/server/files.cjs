"use strict";

const TYPES = {
  html: "text/html", htm: "text/html", txt: "text/plain", md: "text/plain", csv: "text/plain",
  log: "text/plain", json: "application/json", js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript", jsx: "text/javascript",
  ts: "text/plain", tsx: "text/plain", css: "text/css", xml: "text/plain", yaml: "text/plain", yml: "text/plain",
  py: "text/plain", rs: "text/plain", c: "text/plain", h: "text/plain", cpp: "text/plain", java: "text/plain",
  sh: "text/plain", sql: "text/plain", toml: "text/plain", ini: "text/plain", conf: "text/plain",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon", pdf: "application/pdf",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", zip: "application/zip",
};

function fileResponse(file) {
  if (!file || typeof file.name !== "string" || !file.name || typeof file.body !== "string") {
    throw Object.assign(new Error("主程序返回的文件无效"), { code: "INTERNAL" });
  }
  const name = file.name.replace(/[\\/\x00-\x1f\x7f]/g, "_");
  const mimeType = TYPES[name.split(".").at(-1).toLowerCase()] || "application/octet-stream";
  return { path: typeof file.path === "string" ? file.path : null, name, mimeType, body: Buffer.from(file.body, "base64") };
}

function fileViewUrl(token, input) {
  const normalized = input.path.replaceAll("\\", "/");
  const windows = /^[A-Za-z]:\//.test(normalized);
  if (!windows && !normalized.startsWith("/")) return null;
  return `/api/file-view/${encodeURIComponent(token)}/${encodeURIComponent(input.sessionId || "-")}/${windows ? "windows" : "posix"}/${normalized.replace(/^\//, "").split("/").map(encodeURIComponent).join("/")}`;
}

function parseFileViewUrl(pathname) {
  const match = /^\/api\/file-view\/([^/]+)\/([^/]+)\/(posix|windows)\/(.+)$/.exec(pathname);
  if (!match) return null;
  try {
    const path = match[4].split("/").map(decodeURIComponent).join("/");
    return { token: decodeURIComponent(match[1]), input: {
      path: match[3] === "posix" ? `/${path}` : path,
      ...(match[2] !== "-" ? { sessionId: decodeURIComponent(match[2]) } : {}),
    } };
  } catch { return null; }
}

module.exports = { fileResponse, fileViewUrl, parseFileViewUrl };
