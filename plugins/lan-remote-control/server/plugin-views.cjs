"use strict";

const { randomBytes } = require("node:crypto");
const http = require("./http.cjs");

const PREFIX = "/api/plugin-view/";
const HOST_CHANNEL = "pi-desktop/remotePluginView";
const HOST_EVENT = "pi-desktop/remotePluginViewEvent";
const MAX_PER_DEVICE = 32;
const IDLE_TTL_MS = 6 * 60 * 60 * 1000;
const VIEW_ID = /^[A-Za-z0-9_-]{43}$/;

const VIEW_CSP = [
  "sandbox allow-scripts allow-downloads",
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self' chrome-extension:",
].join("; ");

function installBridge(invokeUrl, capabilities) {
  const handlers = new Map();
  let launcherPayload = null;
  async function invoke(channel, payload = {}) {
    const response = await fetch(invokeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      body: JSON.stringify({ channel, payload: payload ?? {} }),
    });
    const reply = await response.json();
    if (!response.ok || reply.ok !== true) {
      throw Object.assign(new Error(reply.error?.message || "Plugin view request failed"), { code: reply.error?.code });
    }
    if (channel === "composer.addFileLines" && capabilities?.composerFileLines && reply.result?.ok && reply.result.reference) {
      window.parent.postMessage({ type: "pi-plugin-view:file-lines", reference: reply.result.reference }, "*");
    }
    return reply.result;
  }
  function off(event, handler) {
    const listeners = handlers.get(event);
    listeners?.delete(handler);
    if (listeners?.size === 0) handlers.delete(event);
  }
  function on(event, handler) {
    if (typeof event !== "string" || typeof handler !== "function") return () => {};
    const listeners = handlers.get(event) ?? new Set();
    listeners.add(handler);
    handlers.set(event, listeners);
    return () => off(event, handler);
  }
  const bridge = Object.freeze({
    ...(capabilities ? { capabilities: Object.freeze(capabilities) } : {}),
    invoke,
    send(channel, payload) {
      void invoke(channel, payload).catch(() => {});
      return { ok: true, accepted: true };
    },
    on,
    off,
    consumeLauncherPayload() {
      const current = launcherPayload;
      launcherPayload = null;
      return current;
    },
    getDroppedFilePath: () => null,
    widget: Object.freeze({
      on,
      invoke: async () => { throw new Error("Native plugin widgets are unavailable in the browser"); },
    }),
  });
  Object.defineProperty(window, "pluginBridge", { value: bridge, enumerable: true });
  window.addEventListener("message", ({ source, data }) => {
    if (window.parent === window || source !== window.parent || data?.type !== "pi-plugin-view:event" || typeof data.event !== "string") return;
    const { event, payload } = data;
    if (event === "launcher:payload") {
      launcherPayload = typeof payload?.triggerId === "string" && typeof payload.payload === "string"
        ? { triggerId: payload.triggerId, payload: payload.payload }
        : null;
    }
    for (const handler of [...(handlers.get(event) ?? [])]) {
      try { handler(payload); } catch (error) { console.error(error); }
    }
  });
  window.addEventListener("load", () => {
    if (window.parent !== window) window.parent.postMessage({ type: "pi-plugin-view:ready" }, "*");
  }, { once: true });
}

const OPENING_HTML = /^(?:\uFEFF)?(?:\s|<!--[\s\S]*?-->)*(?:<!doctype\b[^>]*>(?:\s|<!--[\s\S]*?-->)*)?(?:<html\b(?:[^>"']|"[^"]*"|'[^']*')*>(?:\s|<!--[\s\S]*?-->)*)?(?:<head\b(?:[^>"']|"[^"]*"|'[^']*')*>)?/i;
const TAG_OR_RAW_TEXT = /<!--[\s\S]*?-->|<(script|style|textarea|title|xmp|iframe|noembed|noframes)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?(?:<\/\1\s*>|$)|<\/?[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const META_CSP_ATTR = /(?:^|\s)http-equiv\s*=\s*(?:"content-security-policy"|'content-security-policy'|content-security-policy(?=[\s/>]))/i;

function injectBridge(html, invokeUrl, capabilities) {
  const args = JSON.stringify([invokeUrl, capabilities ?? null]).replace(/</g, "\\u003c");
  const script = `<script>(${installBridge.toString()})(...${args});</script>`;
  const source = html.replace(TAG_OR_RAW_TEXT, (tag) => {
    return /^<meta\b/i.test(tag) && META_CSP_ATTR.test(tag) ? "" : tag;
  });
  return source.replace(OPENING_HTML, (opening) => opening + script);
}

function relativePath(value) {
  return typeof value === "string" && !/[\\:\u0000-\u001f\u007f]/.test(value) &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function decodeAssetPath(value) {
  try {
    const segments = value.split("/").map(decodeURIComponent);
    const decoded = segments.join("/");
    return segments.some((segment) => segment.includes("/")) || !relativePath(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

function createPluginViews({ ipcInvoke, authenticate, deviceActive, currentGeneration, inFlight, statusForCode, maxBodyBytes }) {
  const views = new Map();

  function usable(view) {
    return view.generation === currentGeneration() && deviceActive(view.deviceId) && view.expiresAt > Date.now();
  }

  function sweep() {
    for (const [id, view] of views) if (!usable(view)) views.delete(id);
  }

  function revoke(deviceId) {
    for (const [id, view] of views) if (view.deviceId === deviceId) views.delete(id);
  }

  function acceptsEvent(deviceId, event) {
    if (typeof event?.event !== "string") return false;
    return [...views.values()].some((view) => view.ready && view.deviceId === deviceId && usable(view) &&
      view.input.pluginId === event.pluginId && (!event.viewId || view.input.viewId === event.viewId) &&
      (!event.sessionId || view.input.sessionId === event.sessionId));
  }

  function unauthorized(res) {
    http.sendError(res, 401, "UNAUTHORIZED", "plugin view authorization is missing or invalid");
  }

  async function invokeHost(input, authorized) {
    const denied = () => Object.assign(new Error("plugin view authorization is missing or invalid"), { code: "UNAUTHORIZED" });
    const task = Promise.resolve().then(() => {
      if (!authorized()) throw denied();
      return ipcInvoke(HOST_CHANNEL, [input]);
    });
    inFlight.add(task);
    try {
      const reply = await task;
      if (reply?.ok === true && Object.hasOwn(reply, "data")) return reply.data;
      if (reply?.ok === false) throw Object.assign(new Error(reply.error?.message), { code: reply.error?.code });
      throw new Error("invalid host IPC response");
    } catch (error) {
      throw authorized() ? error : denied();
    } finally {
      inFlight.delete(task);
    }
  }

  async function control(req, res, op) {
    if (req.method !== "POST") return http.sendError(res, 405, "METHOD_NOT_ALLOWED", "method not allowed");
    const device = authenticate(req);
    if (!device) return unauthorized(res);
    const generation = currentGeneration();
    const body = await http.readJsonBody(req, { maxBytes: maxBodyBytes });
    if (!body.ok) return http.sendBodyError(req, res, body);
    if (currentGeneration() !== generation || authenticate(req)?.id !== device.id) return unauthorized(res);
    if (op === "close") {
      const { id } = body.value;
      if (typeof id !== "string" || !VIEW_ID.test(id)) return http.sendError(res, 400, "INVALID_PARAMS", "invalid plugin view id");
      const view = views.get(id);
      if (view?.deviceId === device.id) views.delete(id);
      return http.sendResult(res, { closed: view?.deviceId === device.id });
    }
    const { pluginId, viewId, sessionId } = body.value;
    if (![pluginId, viewId, sessionId].every((value) => typeof value === "string" && value.trim())) {
      return http.sendError(res, 400, "INVALID_PARAMS", "pluginId, viewId and sessionId are required");
    }
    if (typeof ipcInvoke !== "function") return http.sendError(res, 501, "UNSUPPORTED", "host IPC invoke is unavailable");
    sweep();
    if ([...views.values()].filter((view) => view.deviceId === device.id).length >= MAX_PER_DEVICE) {
      return http.sendError(res, 429, "RATE_LIMITED", "too many open plugin views");
    }
    const id = randomBytes(32).toString("base64url");
    const input = { pluginId, viewId, sessionId };
    const view = { deviceId: device.id, generation, input, expiresAt: Date.now() + IDLE_TTL_MS, ready: false };
    views.set(id, view);
    try {
      const authorized = () => usable(view) && views.get(id) === view;
      const result = await invokeHost({ op: "open", ...input }, authorized);
      if (!authorized()) return unauthorized(res);
      if (res.destroyed) return;
      if (!relativePath(result?.entry)) throw new Error("invalid plugin view entry");
      const entry = result.entry.split("/").map(encodeURIComponent).join("/");
      view.capabilities = result.capabilities;
      view.ready = true;
      http.sendResult(res, { id, url: `${PREFIX}${id}/asset/${entry}` });
    } finally {
      if (!view.ready) views.delete(id);
    }
  }

  async function instance(req, res, pathname) {
    const match = /^([A-Za-z0-9_-]{43})\/(invoke|asset\/(.+))$/.exec(pathname);
    if (!match) return http.sendError(res, 404, "NOT_FOUND", "plugin view route not found");
    const [, id, action, asset] = match;
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Vary", "Origin");
    if (req.headers.origin === "null") res.setHeader("Access-Control-Allow-Origin", "null");
    // Applies even when an asset document is opened outside the parent's iframe.
    res.setHeader("Content-Security-Policy", VIEW_CSP);
    const view = views.get(id);
    const authorized = () => view?.ready && views.get(id) === view && usable(view) &&
      (req.headers.authorization === undefined || authenticate(req)?.id === view.deviceId);
    if (!authorized()) return unauthorized(res);
    if (action === "invoke") {
      if (req.method === "OPTIONS" && req.headers.origin === "null" && req.headers["access-control-request-method"] === "POST") {
        res.writeHead(204, { "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" });
        res.end();
        return;
      }
      if (req.method !== "POST") return http.sendError(res, 405, "METHOD_NOT_ALLOWED", "method not allowed");
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
        return http.sendError(res, 400, "INVALID_PARAMS", "JSON body required");
      }
      const body = await http.readJsonBody(req, { maxBytes: maxBodyBytes });
      if (!body.ok) return http.sendBodyError(req, res, body);
      const { channel, payload = {} } = body.value;
      if (typeof channel !== "string" || !channel.trim() || !payload || typeof payload !== "object" || Array.isArray(payload)) {
        return http.sendError(res, 400, "INVALID_PARAMS", "channel and object payload are required");
      }
      if (!authorized()) return unauthorized(res);
      view.expiresAt = Date.now() + IDLE_TTL_MS;
      const result = await invokeHost({ op: "invoke", ...view.input, channel, payload }, authorized);
      if (!authorized()) return unauthorized(res);
      return http.sendResult(res, result);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return http.sendError(res, 405, "METHOD_NOT_ALLOWED", "method not allowed");
    const path = decodeAssetPath(asset);
    if (!path) return http.sendError(res, 400, "INVALID_PARAMS", "invalid plugin view asset path");
    view.expiresAt = Date.now() + IDLE_TTL_MS;
    const result = await invokeHost({ op: "asset", ...view.input, path }, authorized);
    if (!authorized()) return unauthorized(res);
    if (typeof result?.contentType !== "string" || typeof result.body !== "string") throw new Error("invalid plugin view asset response");
    const html = /^text\/html(?:\s*;|$)/i.test(result.contentType);
    const content = Buffer.from(result.body, "base64");
    const bytes = html ? Buffer.from(injectBridge(content.toString("utf8"), `${PREFIX}${id}/invoke`, view.capabilities)) : content;
    res.writeHead(200, { "Content-Type": html ? "text/html; charset=utf-8" : result.contentType, "Content-Length": String(bytes.length) });
    res.end(req.method === "HEAD" ? undefined : bytes);
  }

  async function handle(req, res, pathname) {
    const action = pathname.slice(PREFIX.length);
    try {
      if (action === "open" || action === "close") await control(req, res, action);
      else await instance(req, res, action);
    } catch (error) {
      http.sendError(res, statusForCode(error?.code), error?.code ?? "INTERNAL", error?.message ?? "plugin view request failed");
    }
  }

  return { handle, sweep, revoke, acceptsEvent, clear: () => views.clear() };
}

module.exports = { createPluginViews, PREFIX, HOST_CHANNEL, HOST_EVENT };
