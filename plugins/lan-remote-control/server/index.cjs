"use strict";

/** 局域网监听、密码登录与设备会话。关闭监听会断开连接，已登录设备记录保留。 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const httpHelpers = require("./http.cjs");
const network = require("./network.cjs");
const { SubscriptionPool } = require("./subscriptions.cjs");
const { DeviceStore, MAX_DEVICES } = require("./auth.cjs");
const { AttachmentStore, DEFAULT_MAX_BYTES, ID_PATTERN } = require("./uploads.cjs");
const { buildOperationTable, createRpcDispatcher, isUuid, statusForCode } = require("./rpc.cjs");

const WS_PATH = "/ws";
const AUTH_TIMEOUT_MS = 10_000;
const WS_MAX_PAYLOAD_BYTES = 64 * 1024;
const WS_HEARTBEAT_MS = 30_000;
const WS_MESSAGES_PER_MINUTE = 120;
const MAX_WS_CONNECTIONS = 16;
const MAX_WS_PER_DEVICE = 4;
const MAX_HTTP_CONNECTIONS = 64;
const RPC_BODY_MAX_BYTES = 256 * 1024;
const LOGIN_BODY_MAX_BYTES = 4 * 1024;
const DEFAULT_PORT = 7878;
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 15_000;
const KEEP_ALIVE_TIMEOUT_MS = 15_000;
const SHUTDOWN_GRACE_MS = 1500;
const SWEEP_INTERVAL_MS = 30_000;

const RATE_LIMITS = Object.freeze({
  general: { windowMs: 60_000, max: 600 },
  login: { windowMs: 60_000, max: 6 },
  rpc: { windowMs: 60_000, max: 240 },
  upload: { windowMs: 60_000, max: 40 },
});

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Coded error the panel can act on; `code` never contains user data. */
function fail(code, message) {
  const error = new Error(String(message));
  error.code = String(code);
  return error;
}

function clientAddress(req) {
  const address = req.socket?.remoteAddress ?? "";
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

function mapListenError(error) {
  switch (error?.code) {
    case "EADDRINUSE":
      return fail("PORT_IN_USE", "port is already in use");
    case "EADDRNOTAVAIL":
    case "EINVAL":
      return fail("ADDRESS_UNAVAILABLE", "address is not available on this machine");
    case "EACCES":
      return fail("PERMISSION_DENIED", "the operating system refused the listener");
    default:
      return fail("INTERNAL", error?.message ? String(error.message) : "failed to listen");
  }
}

function loadWebSocketServer() {
  let module;
  try {
    module = require("ws");
  } catch (error) {
    throw fail("DEPENDENCY_MISSING", `ws is required by the remote-control server: ${error?.message ?? error}`);
  }
  const Server = module?.WebSocketServer ?? module?.Server;
  if (typeof Server !== "function") {
    throw fail("DEPENDENCY_MISSING", "ws does not export WebSocketServer");
  }
  return Server;
}

/** Minimal HTTP rejection for a socket that failed the upgrade checks. */
function rejectUpgrade(socket, status, code) {
  const body = `${JSON.stringify({ ok: false, error: { code, message: code } })}\n`;
  try {
    socket.write(
      `HTTP/1.1 ${status} Error\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  } catch {
    // The peer is already gone; destroying below is the whole cleanup.
  }
  socket.destroy();
}

function createRemoteServer(options = {}) {
  const {
    webDir,
    dataDir,
    version = "0.0.0",
    name = "lan-remote-control",
    log = () => {},
    getAdapter = () => null,
    getOperationTable = () => buildOperationTable(getAdapter()),
    getCapabilities = null,
    hooks = {},
    limits = {},
  } = options;

  const uploadMaxBytes = Number.isFinite(limits.maxUploadBytes) ? limits.maxUploadBytes : DEFAULT_MAX_BYTES;

  const state = {
    phase: "stopped",
    address: null,
    port: null,
    startedAt: null,
    lastError: null,
    restartRequired: false,
    httpServer: null,
    webRootReal: null,
    sockets: new Set(),
    connections: new Set(),
    timers: new Set(),
    inFlight: new Set(),
    devices: new DeviceStore({ file: dataDir ? path.join(dataDir, "remote-access.json") : undefined }),
    attachments: new AttachmentStore({
      dir: path.join(dataDir ?? os.tmpdir(), "tmp", "lan-remote-control"),
      maxBytes: uploadMaxBytes,
    }),
    capabilities: { value: null, error: null, at: 0 },
    loginInFlight: 0,
  };

  let lifecycle = Promise.resolve();
  let generation = 0;
  function serializeLifecycle(operation) {
    const task = lifecycle.then(operation);
    lifecycle = task.catch(() => undefined);
    return task;
  }

  state.webRoot = path.resolve(webDir ?? path.join(__dirname, "..", "web"));

  const rateLimiters = {
    general: httpHelpers.createRateLimiter(RATE_LIMITS.general),
    login: httpHelpers.createRateLimiter(RATE_LIMITS.login),
    loginGlobal: httpHelpers.createRateLimiter({ windowMs: 60_000, max: 24 }),
    rpc: httpHelpers.createRateLimiter(RATE_LIMITS.rpc),
    upload: httpHelpers.createRateLimiter(RATE_LIMITS.upload),
    ws: httpHelpers.createRateLimiter({ windowMs: 60_000, max: MAX_WS_CONNECTIONS * 4 }),
  };

  const guard = httpHelpers.createRequestGuard({
    getAllowedHostnames: () => {
      const names = ["127.0.0.1", "localhost"];
      if (state.address) names.push(state.address);
      return names;
    },
    getPort: () => state.port,
  });

  const dispatcher = createRpcDispatcher({
    adapter: typeof getAdapter === "function" ? getAdapter : () => getAdapter,
    getOperationTable,
    getCapabilities: getCapabilities ?? (() => refreshCapabilities(false)),
    attachments: state.attachments,
    log,
  });

  // --- status ---------------------------------------------------------------

  function deviceConnections(deviceId) {
    let connections = 0;
    let subscriptions = 0;
    for (const conn of state.connections) {
      if (conn.deviceId !== deviceId) continue;
      connections += 1;
      subscriptions += conn.sessions.size;
    }
    return { connections, subscriptions };
  }

  function getStatus() {
    const running = state.phase === "running";
    const url = running && state.address ? `http://${state.address}:${state.port}/` : null;
    return {
      phase: state.phase,
      running,
      address: state.address,
      bindAddress: state.address,
      port: state.port,
      url,
      addresses: network.listLanAddresses(),
      startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
      error: state.lastError,
      restartRequired: state.restartRequired === true,
      passwordConfigured: state.devices.passwordConfigured,
      devices: state.devices.list().map((device) => ({
        ...device,
        ...deviceConnections(device.deviceId),
      })),
      capabilities: state.capabilities.value,
      capabilitiesError: state.capabilities.error,
      version,
      name,
      limits: {
        maxUploadBytes: uploadMaxBytes,
        maxDevices: MAX_DEVICES,
        maxWebSockets: MAX_WS_CONNECTIONS,
      },
    };
  }

  // --- capabilities ---------------------------------------------------------

  async function refreshCapabilities(force = false) {
    const now = Date.now();
    if (!force && state.capabilities.at && now - state.capabilities.at < 30_000) {
      return state.capabilities.value;
    }
    if (typeof getCapabilities !== "function") return state.capabilities.value;
    try {
      const value = await getCapabilities();
      state.capabilities = { value: value && typeof value === "object" ? value : null, error: null, at: now };
    } catch (error) {
      state.capabilities = {
        value: state.capabilities.value,
        error: { code: error?.code ? String(error.code) : "INTERNAL", message: String(error?.message ?? error) },
        at: now,
      };
    }
    return state.capabilities.value;
  }

  const subscriptionPool = new SubscriptionPool(hooks);

  // --- subscriptions --------------------------------------------------------

  function releaseSubscription(sessionId) {
    subscriptionPool.release(sessionId)?.catch(error => log(`unsubscribe failed: ${error.message}`));
  }

  // --- websocket plumbing ---------------------------------------------------

  function wsOpen(conn) {
    return conn.ws.readyState === 1;
  }

  function sendWs(conn, message) {
    if (!wsOpen(conn)) return;
    if (conn.ws.bufferedAmount > 2 * 1024 * 1024) {
      closeWs(conn, 1013, 'client is too slow; reconnect for snapshot');
      return;
    }
    try {
      conn.ws.send(JSON.stringify(message));
    } catch (error) {
      log(`websocket send failed: ${error?.message ?? error}`);
    }
  }

  function closeWs(conn, code, reason) {
    try {
      conn.ws.close(code, reason);
    } catch {
      /* already closing */
    }
    const timer = setTimeout(() => {
      try {
        conn.ws.terminate();
      } catch {
        /* already gone */
      }
    }, 300);
    timer.unref?.();
  }

  function wsError(conn, code, message, sessionId) {
    sendWs(conn, {
      type: "error",
      error: { code: String(code), message: String(message) },
      ...(sessionId ? { sessionId } : {}),
    });
  }

  function dropConnection(conn) {
    if (conn.authTimer) {
      clearTimeout(conn.authTimer);
      conn.authTimer = null;
    }
    for (const sessionId of [...conn.sessions]) {
      conn.sessions.delete(sessionId);
      releaseSubscription(sessionId);
    }
    state.connections.delete(conn);
  }

  async function handleSubscribe(conn, message) {
    const sessionId = message.sessionId;
    if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 200) {
      wsError(conn, "INVALID_PARAMS", "sessionId is required");
      return;
    }
    if (conn.sessions.has(sessionId)) {
      return;
    }
    if (conn.sessions.size >= 16) {
      wsError(conn, 'RATE_LIMITED', 'too many session subscriptions');
      return;
    }
    conn.sessions.add(sessionId);
    let snapshot;
    try {
      const result = await subscriptionPool.acquire(sessionId);
      snapshot=result?.snapshot;
    } catch(error) {
      if(conn.sessions.delete(sessionId))releaseSubscription(sessionId);
      wsError(conn,error?.code||'UNSUPPORTED',String(error?.message||error),sessionId);
      return;
    }
    if(!conn.sessions.has(sessionId)||!state.connections.has(conn)||!state.devices.get(conn.deviceId))return;
    sendWs(conn, {
      type: "subscribed",
      sessionId,
      ...(snapshot !== undefined ? { snapshot } : {}),
    });
  }

  function handleUnsubscribe(conn, message) {
    const sessionId = message.sessionId;
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      wsError(conn, "INVALID_PARAMS", "sessionId is required");
      return;
    }
    if (conn.sessions.delete(sessionId)) {
      releaseSubscription(sessionId);
    }
    sendWs(conn, { type: "unsubscribed", sessionId });
  }

  async function handleWsAuth(conn, message) {
    const token = typeof message.token === "string" ? message.token : "";
    const device = state.devices.authorize(token);
    if (!device) {
      wsError(conn, "UNAUTHORIZED", "device token is not valid");
      closeWs(conn, 4401, "unauthorized");
      return;
    }
    let deviceConnectionsOpen = 0;
    for (const existing of state.connections) {
      if (existing.deviceId === device.id) deviceConnectionsOpen += 1;
    }
    if (deviceConnectionsOpen >= MAX_WS_PER_DEVICE) {
      wsError(conn, "RATE_LIMITED", "too many connections for this device");
      closeWs(conn, 4429, "too many connections");
      return;
    }
    conn.device = device;
    conn.deviceId = device.id;
    if (conn.authTimer) {
      clearTimeout(conn.authTimer);
      conn.authTimer = null;
    }
    if (!state.capabilities.at) await refreshCapabilities(false);
    sendWs(conn, {
      type: "ready",
      protocolVersion: 1,
      device: { id: device.id, name: device.name },
      capabilities: state.capabilities.value,
    });
  }

  async function handleWsMessage(conn, data, isBinary) {
    if (!conn.rate.take("messages")) {
      wsError(conn, "RATE_LIMITED", "too many messages");
      closeWs(conn, 4429, "rate limited");
      return;
    }
    if (isBinary) {
      wsError(conn, "INVALID_PARAMS", "binary frames are not supported");
      return;
    }
    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
    } catch {
      wsError(conn, "INVALID_PARAMS", "message is not valid JSON");
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      wsError(conn, "INVALID_PARAMS", "message must be an object");
      return;
    }
    if (!conn.deviceId) {
      if (message.type !== "auth") {
        wsError(conn, "UNAUTHORIZED", "authenticate first");
        closeWs(conn, 4401, "unauthorized");
        return;
      }
      await handleWsAuth(conn, message);
      return;
    }
    if (state.phase !== "running" || (conn.deviceId && !state.devices.get(conn.deviceId))) {
      closeWs(conn, 4401, "unauthorized");
      return;
    }
    switch (message.type) {
      case "subscribe":
        await handleSubscribe(conn, message);
        return;
      case "unsubscribe":
        handleUnsubscribe(conn, message);
        return;
      case "ping":
        sendWs(conn, { type: "pong", ts: Date.now() });
        return;
      case "pong":
        conn.alive = true;
        return;
      case "auth":
        sendWs(conn, { type: "ready", protocolVersion: 1, device: { id: conn.deviceId, name: conn.device?.name ?? "" } });
        return;
      default:
        wsError(conn, "INVALID_PARAMS", `unsupported message type: ${String(message.type)}`);
    }
  }

  function attachConnection(ws, req) {
    const conn = {
      id: crypto.randomUUID(),
      ws,
      device: null,
      deviceId: null,
      sessions: new Set(),
      alive: true,
      ip: clientAddress(req),
      rate: httpHelpers.createRateLimiter({ windowMs: 60_000, max: WS_MESSAGES_PER_MINUTE }),
      authTimer: null,
    };
    conn.authTimer = setTimeout(() => {
      wsError(conn, "UNAUTHORIZED", "authentication timed out");
      closeWs(conn, 4401, "auth timeout");
    }, AUTH_TIMEOUT_MS);
    conn.authTimer.unref?.();
    state.connections.add(conn);
    ws.on("message", (data, isBinary) => {
      void handleWsMessage(conn, data, isBinary).catch((error) => {
        log(`websocket message failed: ${error?.message ?? error}`);
      });
    });
    ws.on("pong", () => {
      conn.alive = true;
    });
    ws.on("close", () => dropConnection(conn));
    ws.on("error", () => {
      /* close follows; dropConnection handles the rest */
    });
  }

  function handleUpgrade(req, socket, head) {
    if (state.phase !== "running" || !state.wss) {
      rejectUpgrade(socket, 503, "NOT_READY");
      return;
    }
    let url;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      rejectUpgrade(socket, 400, "INVALID_PARAMS");
      return;
    }
    if (url.pathname !== WS_PATH) {
      rejectUpgrade(socket, 404, "NOT_FOUND");
      return;
    }
    const host = guard.checkHost(req);
    if (!host.ok) {
      rejectUpgrade(socket, host.status, host.code);
      return;
    }
    const origin = guard.checkOrigin(req, { required: true });
    if (!origin.ok) {
      rejectUpgrade(socket, origin.status, origin.code);
      return;
    }
    if (state.connections.size >= MAX_WS_CONNECTIONS) {
      rejectUpgrade(socket, 503, "RATE_LIMITED");
      return;
    }
    if (!rateLimiters.ws.take(`ws:${clientAddress(req)}`)) {
      rejectUpgrade(socket, 429, "RATE_LIMITED");
      return;
    }
    state.wss.handleUpgrade(req, socket, head, (ws) => attachConnection(ws, req));
  }

  // --- http routes ----------------------------------------------------------

  /** CSP `connect-src` additions: only this listener's own WebSocket URL. */
  function connectOrigins() {
    if (!state.address || !state.port) return [];
    const host = state.address.includes(":") ? `[${state.address}]` : state.address;
    return [`ws://${host}:${state.port}`];
  }

  function authenticate(req) {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length).trim();
    if (!token || token.length > 256) return null;
    return state.devices.authorize(token);
  }

  function healthResult() {
    return {
      name,
      version,
      requiresAuth: true,
      protocolVersion: 1,
      authMode: "password",
      passwordConfigured: state.devices.passwordConfigured,
    };
  }

  async function handleLogin(req, res, address) {
    const loginGeneration = generation, authRevision = state.devices.revision;
    if (!rateLimiters.login.take(address) || !rateLimiters.loginGlobal.take("all") || state.loginInFlight >= 2) {
      httpHelpers.sendError(res, 429, "RATE_LIMITED", "登录尝试过多，请稍后重试");
      return;
    }
    const body = await httpHelpers.readJsonBody(req, { maxBytes: LOGIN_BODY_MAX_BYTES });
    if (!body.ok) { httpHelpers.sendError(res, body.status, body.code, body.message); return; }
    if (state.loginInFlight >= 2) {
      httpHelpers.sendError(res, 429, "RATE_LIMITED", "登录尝试过多，请稍后重试");
      return;
    }
    state.loginInFlight++;
    try {
      const valid = await state.devices.verify(body.value.password);
      if (!valid || generation !== loginGeneration || state.devices.revision !== authRevision || state.phase !== "running") {
        httpHelpers.sendError(res, 401, "UNAUTHORIZED", "密码错误或登录已失效");
        return;
      }
      const result = state.devices.add({ name: body.value.name, remoteAddress: address, userAgent: req.headers["user-agent"] });
      if (!result.ok) { httpHelpers.sendError(res, statusForCode(result.code), result.code, result.message); return; }
      httpHelpers.sendResult(res, { token: result.token, deviceId: result.device.id, deviceName: result.device.name,
        expiresAt: new Date(result.device.expiresAt).toISOString() });
    } finally { state.loginInFlight--; }
  }

  async function handleRpc(req, res) {
    const requestGeneration = generation;
    const address = clientAddress(req);
    if (!rateLimiters.rpc.take(`rpc:${address}`)) {
      httpHelpers.sendError(res, 429, "RATE_LIMITED", "too many requests");
      return;
    }
    const device = authenticate(req);
    if (!device) {
      httpHelpers.sendError(res, 401, "UNAUTHORIZED", "device token is missing or invalid");
      return;
    }
    if (!rateLimiters.rpc.take(`rpc-device:${device.id}`)) {
      httpHelpers.sendError(res, 429, "RATE_LIMITED", "too many requests");
      return;
    }
    const body = await httpHelpers.readJsonBody(req, { maxBytes: RPC_BODY_MAX_BYTES });
    if (!body.ok) {
      httpHelpers.sendError(res, body.status, body.code, body.message);
      return;
    }
    if (generation !== requestGeneration || state.phase !== "running" || authenticate(req)?.id !== device.id) {
      httpHelpers.sendError(res, 401, "UNAUTHORIZED", "device authorization was revoked");
      return;
    }
    const sessionId =
      body.value.input && typeof body.value.input === "object" && typeof body.value.input.sessionId === "string"
        ? body.value.input.sessionId
        : undefined;
    const task = dispatcher.handle({
      deviceId: device.id, sessionId, body: body.value,
      isAuthorized: () => generation === requestGeneration && state.phase === "running" && authenticate(req)?.id === device.id,
    });
    state.inFlight.add(task);
    try {
      const { status, envelope } = await task;
      if (generation !== requestGeneration || state.phase !== "running" || authenticate(req)?.id !== device.id) {
        httpHelpers.sendError(res, 401, "UNAUTHORIZED", "device authorization was revoked");
        return;
      }
      httpHelpers.sendJson(res, status, envelope);
    } finally {
      state.inFlight.delete(task);
    }
  }

  async function handleUpload(req, res) {
    const requestGeneration = generation;
    const address = clientAddress(req);
    if (!rateLimiters.upload.take(`upload:${address}`)) {
      httpHelpers.sendError(res, 429, "RATE_LIMITED", "too many uploads");
      return;
    }
    const device = authenticate(req);
    if (!device) {
      httpHelpers.sendError(res, 401, "UNAUTHORIZED", "device token is missing or invalid");
      return;
    }
    const headerValue = (key) => {
      const value = req.headers[key];
      return typeof value === "string" ? value : "";
    };
    const body = await httpHelpers.readBody(req, { maxBytes: uploadMaxBytes });
    if (!body.ok) {
      httpHelpers.sendError(res, body.status, body.code, body.message);
      return;
    }
    if (generation !== requestGeneration || state.phase !== "running" || authenticate(req)?.id !== device.id) {
      httpHelpers.sendError(res, 401, "UNAUTHORIZED", "device authorization was revoked");
      return;
    }
    const saved = await state.attachments.save({
      deviceId: device.id,
      sessionId: headerValue("x-session-id"),
      name: headerValue("x-filename"),
      mimeType: headerValue("content-type"),
      buffer: body.buffer,
      isAuthorized: () => generation === requestGeneration && state.phase === "running" && authenticate(req)?.id === device.id,
    });
    if (!saved.ok) {
      httpHelpers.sendError(res, statusForCode(saved.code), saved.code, saved.message);
      return;
    }
    httpHelpers.sendResult(res, saved.item);
  }

  async function handleAttachment(req, res, pathname, url) {
    const requestGeneration = generation;
    const device = authenticate(req);
    if (!device) {
      httpHelpers.sendError(res, 401, "UNAUTHORIZED", "device token is missing or invalid");
      return;
    }
    const id = pathname.slice("/api/attachment/".length);
    if (!ID_PATTERN.test(id)) {
      httpHelpers.sendError(res, 404, "NOT_FOUND", "attachment not found");
      return;
    }
    const item = state.attachments.get(id);
    if (!item || item.deviceId !== device.id) {
      httpHelpers.sendError(res, 404, "NOT_FOUND", "attachment not found");
      return;
    }
    const requestedSession = url.searchParams.get("sessionId");
    if (requestedSession && item.sessionId && requestedSession !== item.sessionId) {
      httpHelpers.sendError(res, 404, "NOT_FOUND", "attachment not found");
      return;
    }
    let file;
    let stats;
    try {
      const link = await fsp.lstat(item.filePath);
      const real = await fsp.realpath(item.filePath);
      if (link.isSymbolicLink() || !httpHelpers.isInsidePath(state.attachments.dir, real)) throw new Error("invalid file");
      file = await fsp.open(item.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      stats = await file.stat();
      if (!stats.isFile() || stats.size !== item.size || stats.ino !== link.ino || stats.dev !== link.dev) throw new Error("invalid file");
      if (generation !== requestGeneration || state.phase !== "running" || authenticate(req)?.id !== device.id) {
        await file.close();
        httpHelpers.sendError(res, 401, "UNAUTHORIZED", "device authorization was revoked");
        return;
      }
    } catch {
      await file?.close().catch(() => undefined);
      httpHelpers.sendError(res, 404, "NOT_FOUND", "attachment not found");
      return;
    }
    httpHelpers.applySecurityHeaders(res);
    res.setHeader("Content-Type", item.mimeType);
    res.setHeader("Content-Length", String(stats.size));
    res.setHeader("Content-Disposition", "inline");
    if (req.method === "HEAD") {
      await file.close();
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(200);
    await new Promise((resolve) => {
      const stream = file.createReadStream({ autoClose: true });
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
  }

  /**
   * `GET /api/mutation/:id` — read-only outcome lookup. A client that lost its
   * connection checks here instead of re-sending the original POST (which, once
   * the id has been evicted, would otherwise execute as a brand-new mutation).
   */
  function handleMutationLookup(req, res, pathname) {
    const device = authenticate(req);
    if (!device) {
      httpHelpers.sendError(res, 401, "UNAUTHORIZED", "device token is missing or invalid");
      return;
    }
    let mutationId = "";
    try {
      mutationId = decodeURIComponent(pathname.slice("/api/mutation/".length));
    } catch {
      mutationId = "";
    }
    if (!isUuid(mutationId)) {
      httpHelpers.sendError(res, 400, "INVALID_PARAMS", "mutationId must be a UUID");
      return;
    }
    const { status, envelope } = dispatcher.queryMutation({ deviceId: device.id, mutationId });
    httpHelpers.sendJson(res, status, envelope);
  }

  async function handleRequest(req, res) {
    httpHelpers.applySecurityHeaders(res);
    const address = clientAddress(req);
    try {
      if (!rateLimiters.general.take(`general:${address}`)) {
        httpHelpers.sendError(res, 429, "RATE_LIMITED", "too many requests");
        return;
      }
      let url;
      try {
        url = new URL(req.url ?? "/", "http://localhost");
      } catch {
        httpHelpers.sendError(res, 400, "INVALID_PARAMS", "invalid request target");
        return;
      }
      const pathname = url.pathname;
      const isGet = req.method === "GET" || req.method === "HEAD";

      const hostCheck = guard.checkHost(req);
      if (!hostCheck.ok) {
        httpHelpers.sendError(res, hostCheck.status, hostCheck.code, hostCheck.message);
        return;
      }
      if (pathname !== "/api/health") {
        const originCheck = guard.checkOrigin(req, { required: !isGet });
        if (!originCheck.ok) {
          httpHelpers.sendError(res, originCheck.status, originCheck.code, originCheck.message);
          return;
        }
      }

      if (state.phase !== "running") {
        httpHelpers.sendError(res, 503, "NOT_READY", "server is not running");
        return;
      }
      if (req.method === "OPTIONS") {
        httpHelpers.sendError(res, 405, "METHOD_NOT_ALLOWED", "CORS preflight is not supported");
        return;
      }

      if (pathname === "/api/health") {
        if (!isGet) {
          httpHelpers.sendError(res, 405, "METHOD_NOT_ALLOWED", "method not allowed");
          return;
        }
        httpHelpers.sendResult(res, healthResult());
        return;
      }
      if (pathname === "/api/login") {
        if (req.method !== "POST") { httpHelpers.sendError(res, 405, "METHOD_NOT_ALLOWED", "method not allowed"); return; }
        await handleLogin(req, res, address);
        return;
      }
      if (pathname === "/api/logout") {
        if (req.method !== "POST") { httpHelpers.sendError(res, 405, "METHOD_NOT_ALLOWED", "method not allowed"); return; }
        const device = authenticate(req);
        if (!device) { httpHelpers.sendError(res, 401, "UNAUTHORIZED", "登录已失效"); return; }
        await revokeDevice(device.id);
        httpHelpers.sendResult(res, { loggedOut: true });
        return;
      }
      if (pathname === "/api/rpc") {
        if (req.method !== "POST") {
          httpHelpers.sendError(res, 405, "METHOD_NOT_ALLOWED", "method not allowed");
          return;
        }
        await handleRpc(req, res);
        return;
      }
      if (pathname === "/api/upload") {
        if (req.method !== "POST") {
          httpHelpers.sendError(res, 405, "METHOD_NOT_ALLOWED", "method not allowed");
          return;
        }
        await handleUpload(req, res);
        return;
      }
      if (pathname.startsWith("/api/attachment/")) {
        if (!isGet) {
          httpHelpers.sendError(res, 405, "METHOD_NOT_ALLOWED", "method not allowed");
          return;
        }
        await handleAttachment(req, res, pathname, url);
        return;
      }
      if (pathname.startsWith("/api/mutation/")) {
        if (!isGet) {
          httpHelpers.sendError(res, 405, "METHOD_NOT_ALLOWED", "method not allowed");
          return;
        }
        handleMutationLookup(req, res, pathname);
        return;
      }
      if (pathname.startsWith("/api/")) {
        httpHelpers.sendError(res, 404, "NOT_FOUND", "not found");
        return;
      }
      if (!isGet) {
        httpHelpers.sendError(res, 405, "METHOD_NOT_ALLOWED", "method not allowed");
        return;
      }
      const served = await httpHelpers.serveStaticFile(req, res, {
        rootDir: state.webRoot,
        rootRealDir: state.webRootReal,
        pathname,
        connectOrigins: connectOrigins(),
      });
      if (!served.ok) {
        httpHelpers.sendError(res, served.status, served.code, served.message);
      }
    } catch (error) {
      log(`request failed: ${error?.stack ?? error}`);
      if (!res.writableEnded) {
        httpHelpers.sendError(res, 500, "INTERNAL", "internal error");
      }
    }
  }

  // --- timers ---------------------------------------------------------------

  function startTimers() {
    const heartbeat = setInterval(() => {
      for (const conn of [...state.connections]) {
        if (!wsOpen(conn)) continue;
        if (!conn.alive) {
          try {
            conn.ws.terminate();
          } catch {
            /* already gone */
          }
          continue;
        }
        conn.alive = false;
        try {
          conn.ws.ping();
        } catch {
          /* the close handler cleans up */
        }
        sendWs(conn, { type: "ping", ts: Date.now() });
      }
    }, WS_HEARTBEAT_MS);
    heartbeat.unref?.();
    state.timers.add(heartbeat);

    const sweep = setInterval(() => {
      void sweepNow();
    }, SWEEP_INTERVAL_MS);
    sweep.unref?.();
    state.timers.add(sweep);
  }

  function clearTimers() {
    for (const timer of state.timers) clearInterval(timer);
    state.timers.clear();
  }

  async function sweepNow() {
    for (const conn of [...state.connections]) {
      if (conn.deviceId && !state.devices.get(conn.deviceId)) closeWs(conn, 4403, "session expired");
    }
    await state.attachments.pruneExpired();
    dispatcher.mutations.sweep();
  }

  // --- lifecycle ------------------------------------------------------------

  async function listen(server, address, port) {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(mapListenError(error));
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, address);
    });
  }

  async function start({ address, port } = {}, expectedGeneration = generation) {
    if (expectedGeneration !== generation) throw fail("NOT_READY", "start was cancelled");
    if (state.phase === "running") return getStatus();
    if (!state.devices.passwordConfigured) throw fail("PASSWORD_REQUIRED", "请先在电脑端设置访问密码");
    if (state.phase === "starting" || state.phase === "stopping") {
      throw fail("NOT_READY", "server is busy");
    }
    state.phase = "starting";
    state.lastError = null;

    let server = null;
    try {
      const requested = network.normalizeRequestedAddress(address);
      if (!requested.ok) throw fail(requested.code, requested.message);
      const bindAddress = requested.address ?? network.pickDefaultAddress();
      if (!bindAddress) {
        throw fail("ADDRESS_UNAVAILABLE", "no private IPv4 address found on this machine");
      }
      let listenPort = DEFAULT_PORT;
      if (port !== undefined && port !== null) {
        const parsed = Number(port);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
          throw fail("INVALID_PARAMS", "port must be an integer between 0 and 65535");
        }
        listenPort = parsed;
      }

      const WebSocketServer = loadWebSocketServer();
      await state.attachments.init();
      state.webRootReal = await fsp.realpath(state.webRoot).catch(() => null);

      server = http.createServer((req, res) => {
        void handleRequest(req, res);
      });
      server.requestTimeout = REQUEST_TIMEOUT_MS;
      server.headersTimeout = HEADERS_TIMEOUT_MS;
      server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
      server.maxHeadersCount = 64;
      server.maxConnections = MAX_HTTP_CONNECTIONS;
      server.on("connection", (socket) => {
        state.sockets.add(socket);
        socket.on("close", () => state.sockets.delete(socket));
      });
      server.on("clientError", (error, socket) => {
        log(`client error: ${error?.message ?? error}`);
        try {
          socket.destroy();
        } catch {
          /* already gone */
        }
      });
      server.on("upgrade", (req, socket, head) => handleUpgrade(req, socket, head));

      await listen(server, bindAddress, listenPort);
      if (expectedGeneration !== generation) throw fail("NOT_READY", "start was cancelled");
      const addressInfo = server.address();
      if (!addressInfo || typeof addressInfo === "string") {
        throw fail("INTERNAL", "listener did not expose a TCP address");
      }
      if (!network.isAllowedBindAddress(addressInfo.address)) {
        throw fail("ADDRESS_UNAVAILABLE", `refusing to serve non-private address ${addressInfo.address}`);
      }

      state.httpServer = server;
      state.wss = new WebSocketServer({
        noServer: true,
        clientTracking: false,
        perMessageDeflate: false,
        maxPayload: WS_MAX_PAYLOAD_BYTES,
      });
      state.address = addressInfo.address;
      state.port = addressInfo.port;
      state.startedAt = Date.now();
      state.phase = "running";
      startTimers();
      void refreshCapabilities(true);
      log(`listening on http://${state.address}:${state.port}`);
      return getStatus();
    } catch (error) {
      const coded = error?.code ? error : fail("INTERNAL", String(error?.message ?? error));
      state.lastError = { code: String(coded.code), message: String(coded.message ?? coded) };
      state.phase = "stopped";
      clearTimers();
      if (server) {
        try {
          server.close();
        } catch {
          /* never listened */
        }
      }
      for (const socket of [...state.sockets]) {
        try {
          socket.destroy();
        } catch {
          /* already gone */
        }
      }
      state.sockets.clear();
      await state.attachments.dispose().catch(() => undefined);
      log(`start failed: ${state.lastError.code} ${state.lastError.message}`);
      throw coded;
    }
  }

  async function closeHttpServer(server) {
    const closed = new Promise((resolve) => {
      server.close(() => resolve());
    });
    if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
    const forceTimer = setTimeout(() => {
      for (const socket of [...state.sockets]) {
        try {
          socket.destroy();
        } catch {
          /* already gone */
        }
      }
    }, 500);
    forceTimer.unref?.();
    await Promise.race([closed, delay(SHUTDOWN_GRACE_MS + 500)]);
    clearTimeout(forceTimer);
    for (const socket of [...state.sockets]) {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    }
    state.sockets.clear();
  }

  async function stop() {
    if (state.phase === "stopped") return getStatus();
    state.phase = "stopping";
    clearTimers();

    // Stop talking to devices first, then give in-flight mutations a bounded
    // window to settle: a task the host already accepted is never cancelled by
    // closing the network service.
    for (const conn of [...state.connections]) {
      sendWs(conn, { type: "error", error: { code: "NOT_READY", message: "server is stopping" } });
      closeWs(conn, 4001, "server stopping");
    }
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (state.inFlight.size > 0 && Date.now() < deadline) {
      await delay(50);
    }

    const server = state.httpServer;
    const wss = state.wss;
    state.httpServer = null;
    state.wss = null;
    for (const conn of [...state.connections]) {
      try { conn.ws.terminate(); } catch {}
    }
    wss?.close();
    if (server) await closeHttpServer(server);

    await subscriptionPool.clear();
    await state.attachments.dispose();
    dispatcher.cancel();
    state.connections.clear();
    state.inFlight.clear();
    state.address = null;
    state.port = null;
    state.startedAt = null;
    state.phase = "stopped";
    return getStatus();
  }

  // --- panel-facing helpers -------------------------------------------------

  function createLink() {
    if (state.phase !== "running") return { ok: false, code: "NOT_RUNNING", message: "请先开启远程访问" };
    return { ok: true, url: `http://${state.address}:${state.port}/` };
  }

  async function setPassword(password) {
    const ids = await state.devices.setPassword(password);
    for (const id of ids) await revokeDevice(id);
    return { ok: true };
  }

  async function revokeDevice(deviceId) {
    const existed = state.devices.revoke(deviceId);
    dispatcher.mutations.entries.delete(deviceId);
    dispatcher.mutations.tombstones.delete(deviceId);
    for (const conn of [...state.connections]) {
      if (conn.deviceId !== deviceId) continue;
      wsError(conn, "UNAUTHORIZED", "device was revoked");
      closeWs(conn, 4403, "revoked");
    }
    await state.attachments.revokeDevice(deviceId);
    return existed;
  }

  async function revokeAllDevices() {
    state.devices.revision++;
    const ids = state.devices.list().map((device) => device.deviceId);
    for (const id of ids) await revokeDevice(id);
    return ids.length;
  }

  /** Fan one host event out to the devices subscribed to its session. */
  function broadcast(desktopEvent) {
    if (state.phase !== "running") return 0;
    const sessionId =
      desktopEvent && typeof desktopEvent === "object" && typeof desktopEvent.sessionId === "string"
        ? desktopEvent.sessionId
        : null;
    if (!sessionId) {
      log("dropping desktop event without sessionId");
      return 0;
    }
    let delivered = 0;
    for (const conn of state.connections) {
      if (!conn.deviceId || !state.devices.get(conn.deviceId) || !conn.sessions.has(sessionId) || !wsOpen(conn)) continue;
      sendWs(conn, { type: "event", event: desktopEvent });
      delivered += 1;
    }
    return delivered;
  }

  function markRestartRequired(required) {
    state.restartRequired = required === true;
  }

  return {
    start: (options) => {
      const expectedGeneration = generation;
      return serializeLifecycle(() => start(options, expectedGeneration));
    },
    stop: () => {
      generation += 1;
      if (state.phase !== "stopped") state.phase = "stopping";
      return serializeLifecycle(stop);
    },
    getStatus,
    createLink,
    setPassword: (password) => serializeLifecycle(() => setPassword(password)),
    revokeDevice,
    revokeAllDevices,
    broadcast,
    refreshCapabilities,
    sweepNow,
    markRestartRequired,
    getLogTail: () => [],
    constants: {
      WS_PATH,
      DEFAULT_PORT,
      MAX_WS_CONNECTIONS,
      MAX_HTTP_CONNECTIONS,
      RPC_BODY_MAX_BYTES,
      LOGIN_BODY_MAX_BYTES,
      SHUTDOWN_GRACE_MS,
    },
    _internals: state,
  };
}

module.exports = {
  DEFAULT_PORT,
  MAX_WS_CONNECTIONS,
  RATE_LIMITS,
  SHUTDOWN_GRACE_MS,
  WS_PATH,
  createRemoteServer,
};
