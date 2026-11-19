"use strict";

/** HTTP 响应、请求体限制、限流与静态资源服务。 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

/** Static extensions the mobile page is allowed to reference. */
const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
});

/** Upper bound for one static file; larger assets must be split or dropped. */
const MAX_STATIC_BYTES = 8 * 1024 * 1024;

function buildCsp() {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "media-src 'self' data: blob: https:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self' chrome-extension:",
  ].join("; ");
}

function mimeForFile(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? null;
}

function applySecurityHeaders(res, { html = false } = {}) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (html) res.setHeader("Content-Security-Policy", buildCsp());
}

function sendJson(res, status, payload, extraHeaders) {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    ...(extraHeaders ?? {}),
  });
  res.end(body);
}

/** `{ ok: true, result, requestId? }` — the only success shape clients parse. */
function sendResult(res, result, options = {}) {
  const payload = { ok: true, result: result === undefined ? null : result };
  if (options.requestId) payload.requestId = options.requestId;
  sendJson(res, options.status ?? 200, payload, options.headers);
}

/** `{ ok: false, error: { code, message }, requestId? }` */
function sendError(res, status, code, message, options = {}) {
  const payload = { ok: false, error: { code: String(code), message: String(message) } };
  if (options.requestId) payload.requestId = options.requestId;
  sendJson(res, status, payload, options.headers);
}

/**
 * A body that was refused for size is never drained, so the socket is closed
 * once the response is flushed instead of waiting for bytes nobody will read.
 */
function closeAfterResponse(req, res) {
  const socket = req.socket;
  if (!socket) return;
  const end = () => {
    try {
      socket.end();
    } catch {
      /* already gone */
    }
  };
  if (res.writableEnded) end();
  else res.once("finish", end);
}

/** Send one failed body-read result; closes the socket when it was not drained. */
function sendBodyError(req, res, body) {
  sendError(
    res,
    body.status,
    body.code,
    body.message,
    body.closeConnection ? { headers: { Connection: "close" } } : undefined,
  );
  if (body.closeConnection) closeAfterResponse(req, res);
}

/**
 * Read a bounded request body.
 *
 * An oversized body is not drained: the caller must answer with
 * `Connection: close` and end the socket (see `sendBodyError`), otherwise the
 * unread bytes leave the connection hanging.
 */
function readBody(req, { maxBytes }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      resolve(value);
    };
    const tooLarge = () =>
      finish({
        ok: false,
        status: 413,
        code: "PAYLOAD_TOO_LARGE",
        message: `request body exceeds ${maxBytes} bytes`,
        closeConnection: true,
      });

    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.pause();
      tooLarge();
      return;
    }

    const chunks = [];
    let total = 0;
    function onData(chunk) {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        req.pause();
        tooLarge();
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      finish({ ok: true, buffer: Buffer.concat(chunks, total) });
    }
    function onError(error) {
      finish({
        ok: false,
        status: 400,
        code: "REQUEST_ABORTED",
        message: error?.message ? String(error.message) : "request failed",
      });
    }
    function onAborted() {
      finish({ ok: false, status: 400, code: "REQUEST_ABORTED", message: "request aborted" });
    }

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

async function readJsonBody(req, { maxBytes }) {
  const body = await readBody(req, { maxBytes });
  if (!body.ok) return body;
  if (body.buffer.length === 0) return { ok: false, status: 400, code: "INVALID_PARAMS", message: "JSON body required" };
  try {
    const parsed = JSON.parse(body.buffer.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, status: 400, code: "INVALID_PARAMS", message: "body must be a JSON object" };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, status: 400, code: "INVALID_PARAMS", message: "body is not valid JSON" };
  }
}

/**
 * Fixed-window limiter. Keys are pruned once the map grows past `maxKeys`, so a
 * spray of distinct source addresses cannot turn the limiter itself into the
 * memory exhaustion.
 */
function createRateLimiter({ windowMs, max, maxKeys = 1024, now = Date.now }) {
  const buckets = new Map();
  const prune = () => {
    const current = now();
    for (const [key, bucket] of buckets) {
      if (current - bucket.start >= windowMs) buckets.delete(key);
    }
    while (buckets.size > maxKeys) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  };
  return {
    take(key) {
      const current = now();
      const bucket = buckets.get(key);
      if (!bucket || current - bucket.start >= windowMs) {
        if (buckets.size >= maxKeys) prune();
        buckets.set(key, { start: current, count: 1 });
        return true;
      }
      bucket.count += 1;
      return bucket.count <= max;
    },
    reset() {
      buckets.clear();
    },
    get size() {
      return buckets.size;
    },
  };
}

function isInsidePath(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Resolve a URL pathname to a file inside `rootDir`.
 *
 * Rejects absolute paths, backslashes, null bytes, any `.`/`..` segment, and
 * dot-prefixed segments. The caller still re-checks the real path, which is
 * what catches a symlink (or Windows junction) pointing outside the root.
 */
function resolveStaticPath(rootDir, pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) {
    return { ok: false, status: 400, code: "INVALID_PARAMS", message: "invalid path" };
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { ok: false, status: 400, code: "INVALID_PARAMS", message: "invalid path encoding" };
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    return { ok: false, status: 400, code: "INVALID_PARAMS", message: "invalid path" };
  }
  const segments = decoded.split("/").filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment === "." || segment === ".." || segment.startsWith(".")) {
      return { ok: false, status: 400, code: "INVALID_PARAMS", message: "invalid path" };
    }
  }
  const relative = segments.length ? segments.join("/") : "index.html";
  const absolute = path.resolve(rootDir, relative);
  if (!isInsidePath(rootDir, absolute)) {
    return { ok: false, status: 400, code: "INVALID_PARAMS", message: "invalid path" };
  }
  return { ok: true, filePath: absolute, relative };
}

/**
 * Serve one file from the plugin's static directory. Symlinks are refused by
 * `lstat` and the resolved real path must stay inside the real root, so neither
 * a link nor a reparse point can escape into the plugin or the user's disk.
 */
async function serveStaticFile(req, res, { rootDir, rootRealDir, pathname, renderer = false, projection = false }) {
  const resolved = resolveStaticPath(rootDir, pathname);
  if (!resolved.ok) return resolved;
  const mime = mimeForFile(resolved.filePath);
  if (!mime) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "not found" };
  }
  let stats;
  try {
    stats = await fsp.lstat(resolved.filePath);
  } catch {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "not found" };
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "not found" };
  }
  if (stats.size > MAX_STATIC_BYTES) {
    return { ok: false, status: 413, code: "PAYLOAD_TOO_LARGE", message: "asset too large" };
  }
  let realPath;
  try {
    realPath = await fsp.realpath(resolved.filePath);
  } catch {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "not found" };
  }
  if (rootRealDir && !isInsidePath(rootRealDir, realPath) && realPath !== rootRealDir) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "not found" };
  }
  const html = mime.startsWith("text/html");
  applySecurityHeaders(res, { html });
  if (html && renderer) {
    const source = await fsp.readFile(resolved.filePath, "utf8");
    let content = source.replace(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) =>
      /\bhttp-equiv\s*=\s*(["'])Content-Security-Policy\1/i.test(tag) ? "" : tag,
    ).replace(/\b(src|href)=(['"])\.\/assets\//g, "$1=$2/assets/");
    if (projection) {
      const adapter = '<link rel="stylesheet" href="/__lan-remote/file-actions.css"><script src="/__lan-remote/file-actions.js"></script><script src="/__lan-remote/browser-grip.js"></script><script src="/__lan-remote/projection.js"></script>';
      content = /<\/head>/i.test(content) ? content.replace(/<\/head>/i, `${adapter}</head>`) : `${adapter}${content}`;
    }
    const body = Buffer.from(content, "utf8");
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", String(body.length));
    res.writeHead(200);
    res.end(req.method === "HEAD" ? undefined : body);
    return { ok: true };
  }
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Length", String(stats.size));
  if (req.method === "HEAD") {
    res.writeHead(200);
    res.end();
    return { ok: true };
  }
  res.writeHead(200);
  await new Promise((resolve) => {
    const stream = fs.createReadStream(resolved.filePath);
    stream.on("error", () => {
      if (!res.writableEnded) res.destroy();
      resolve();
    });
    stream.on("end", resolve);
    res.on("close", () => {
      stream.destroy();
      resolve();
    });
    stream.pipe(res);
  });
  return { ok: true };
}

module.exports = {
  MAX_STATIC_BYTES,
  MIME_TYPES,
  applySecurityHeaders,
  buildCsp,
  closeAfterResponse,
  createRateLimiter,
  isInsidePath,
  mimeForFile,
  readBody,
  readJsonBody,
  resolveStaticPath,
  sendBodyError,
  sendError,
  sendJson,
  sendResult,
  serveStaticFile,
};
