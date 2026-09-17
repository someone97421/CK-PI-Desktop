"use strict";

/**
 * HTTP plumbing for the remote-control server: response envelope, request
 * guards (Host / Origin), body limits, rate limiting, static file serving.
 *
 * Everything here is deliberately dependency-free and framework-free; the
 * plugin process is not an OS sandbox, but the network surface is kept as
 * small as a hand-written router can make it.
 */

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
  ".txt": "text/plain; charset=utf-8",
});

/** Upper bound for one static file; larger assets must be split or dropped. */
const MAX_STATIC_BYTES = 8 * 1024 * 1024;

/**
 * Content-Security-Policy for served HTML. `connect-src 'self'` matches the
 * page's own origin (fetch over http); the WebSocket endpoint is added as an
 * explicit `ws://host:port` entry, so no wildcard `ws:` scheme is opened.
 */
function buildCsp({ connectOrigins = [] } = {}) {
  const connect = ["'self'", ...connectOrigins.filter((origin) => typeof origin === "string" && origin)];
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    `connect-src ${connect.join(" ")}`,
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function mimeForFile(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? null;
}

function applySecurityHeaders(res, { html = false, connectOrigins = [] } = {}) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (html) res.setHeader("Content-Security-Policy", buildCsp({ connectOrigins }));
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

/** `Host` / `Host:port` per RFC 7230, including the bracketed IPv6 form. */
function parseHostHeader(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = raw.trim();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return null;
    const hostname = value.slice(1, end);
    const rest = value.slice(end + 1);
    if (!rest) return { hostname, port: null };
    if (!rest.startsWith(":")) return null;
    const port = Number(rest.slice(1));
    return Number.isInteger(port) ? { hostname, port } : null;
  }
  const separator = value.lastIndexOf(":");
  if (separator < 0) return { hostname: value, port: null };
  const hostname = value.slice(0, separator);
  const portText = value.slice(separator + 1);
  if (!/^\d+$/.test(portText)) return null;
  return { hostname, port: Number(portText) };
}

/**
 * Host and Origin enforcement.
 *
 * The allowed host set is exactly the bound address plus loopback names when
 * the bind itself is loopback: a request whose Host does not name the interface
 * the server listens on is either a proxy mistake or a DNS-rebinding attempt.
 * Origins are compared as full `http://host:port` strings, so no wildcard, no
 * subdomain and no port confusion can slip through.
 */
function createRequestGuard({ getAllowedHostnames, getPort }) {
  const allowedNames = () => {
    const names = new Set();
    for (const name of getAllowedHostnames() ?? []) {
      if (typeof name === "string" && name) names.add(name.toLowerCase());
    }
    return names;
  };

  const checkHost = (req) => {
    const parsed = parseHostHeader(req.headers.host);
    if (!parsed) {
      return { ok: false, status: 400, code: "INVALID_PARAMS", message: "Host header is required" };
    }
    const names = allowedNames();
    if (!names.has(parsed.hostname.toLowerCase())) {
      return { ok: false, status: 403, code: "FORBIDDEN_HOST", message: "Host header is not allowed" };
    }
    const port = getPort();
    if (port === null || port === undefined) {
      return { ok: false, status: 503, code: "NOT_READY", message: "server is not listening" };
    }
    if (parsed.port !== null && parsed.port !== port) {
      return { ok: false, status: 403, code: "FORBIDDEN_HOST", message: "Host header port is not allowed" };
    }
    if (parsed.port === null && port !== 80) {
      return { ok: false, status: 403, code: "FORBIDDEN_HOST", message: "Host header must carry the port" };
    }
    return { ok: true, hostname: parsed.hostname };
  };

  const expectedOrigins = () => {
    const port = getPort();
    if (port === null || port === undefined) return new Set();
    const origins = new Set();
    for (const name of allowedNames()) {
      const host = name.includes(":") ? `[${name}]` : name;
      origins.add(`http://${host}${port === 80 ? "" : `:${port}`}`);
    }
    return origins;
  };

  const checkOrigin = (req, { required }) => {
    const raw = req.headers.origin;
    if (Array.isArray(raw)) {
      return { ok: false, status: 403, code: "FORBIDDEN_ORIGIN", message: "Origin header is malformed" };
    }
    if (raw === undefined || raw === "") {
      if (required) {
        return { ok: false, status: 403, code: "FORBIDDEN_ORIGIN", message: "Origin header is required" };
      }
      return { ok: true, origin: null };
    }
    if (raw === "null") {
      return { ok: false, status: 403, code: "FORBIDDEN_ORIGIN", message: "Origin header is not allowed" };
    }
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return { ok: false, status: 403, code: "FORBIDDEN_ORIGIN", message: "Origin header is malformed" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, status: 403, code: "FORBIDDEN_ORIGIN", message: "Origin header is not allowed" };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, status: 403, code: "FORBIDDEN_ORIGIN", message: "Origin header is not allowed" };
    }
    const origin = `${parsed.protocol}//${parsed.host}`;
    if (!expectedOrigins().has(origin)) {
      return { ok: false, status: 403, code: "FORBIDDEN_ORIGIN", message: "Origin header is not allowed" };
    }
    return { ok: true, origin };
  };

  return { checkHost, checkOrigin };
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
async function serveStaticFile(req, res, { rootDir, rootRealDir, pathname, connectOrigins = [] }) {
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
  applySecurityHeaders(res, { html, connectOrigins });
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
  createRequestGuard,
  isInsidePath,
  mimeForFile,
  parseHostHeader,
  readBody,
  readJsonBody,
  resolveStaticPath,
  sendBodyError,
  sendError,
  sendJson,
  sendResult,
  serveStaticFile,
};
