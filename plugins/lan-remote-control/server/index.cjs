"use strict";

/** 局域网监听、密码登录与设备会话。关闭监听会断开连接，已登录设备记录保留。 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const httpHelpers = require("./http.cjs");
const network = require("./network.cjs");
const { DeviceStore, MAX_DEVICES } = require("./auth.cjs");
const { AttachmentStore, DEFAULT_MAX_BYTES } = require("./uploads.cjs");
const { OPERATION_META: BROWSE_OPERATIONS } = require("../browse-bridge.cjs");
const { RESOURCE_SCHEMES, rewriteResourceCsp, rewriteResourceText } = require("./resources.cjs");
const { fileResponse, fileViewUrl, parseFileViewUrl } = require("./files.cjs");

const WS_PATH = "/ws";
const AUTH_TIMEOUT_MS = 10_000;
const WS_MAX_PAYLOAD_BYTES = 64 * 1024;
const WS_HEARTBEAT_MS = 30_000;
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
  login: { windowMs: 60_000, max: 6 },
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

function statusForCode(code) {
  return ({ INVALID_PARAMS: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, OPERATION_NOT_ALLOWED: 403,
    NOT_FOUND: 404, PAYLOAD_TOO_LARGE: 413, RATE_LIMITED: 429, UNSUPPORTED: 501,
    NOT_READY: 503, UNAVAILABLE: 503, TIMEOUT: 504 })[code] ?? 500;
}

function clientAddress(req) {
  const address = req.socket?.remoteAddress ?? "";
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

function isLoopback(address) {
  return address === "::1" || /^127\./.test(address);
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
    rendererDir,
    projectionDir = null,
    dataDir,
    version = "0.0.0",
    name = "lan-remote-control",
    log = () => {},
    getExtensionIds = () => [],
    ipcInvoke = null,
    localOperations = {},
    rendererUpload = null,
    rendererResource = null,
    rendererFile = null,
    limits = {},
  } = options;
  if (typeof rendererDir !== "string" || !rendererDir.trim()) {
    throw fail("RENDERER_UNAVAILABLE", "必须提供同一安装的 Renderer 目录 rendererDir");
  }
  if (typeof dataDir !== "string" || !dataDir.trim()) {
    throw fail("INVALID_PARAMS", "必须提供插件数据目录 dataDir");
  }

  const uploadMaxBytes = Number.isFinite(limits.maxUploadBytes) ? limits.maxUploadBytes : DEFAULT_MAX_BYTES;

  const state = {
    phase: "stopped",
    address: null,
    port: null,
    startedAt: null,
    lastError: null,
    restartRequired: false,
    listeners: [],
    requestedAddresses: [],
    remoteAccess: false,
    warning: null,
    webRootReal: null,
    projectionRootReal: null,
    sockets: new Set(),
    connections: new Set(),
    timers: new Set(),
    inFlight: new Set(),
    devices: new DeviceStore({ file: path.join(dataDir, "remote-access.json") }),
    extensionDevices: new DeviceStore({ maxDevices: Infinity }),
    attachments: new AttachmentStore({
      dir: path.join(dataDir, "tmp", "lan-remote-control"),
      maxBytes: uploadMaxBytes,
    }),
    loginInFlight: 0,
  };

  let lifecycle = Promise.resolve();
  let generation = 0;
  function serializeLifecycle(operation) {
    const task = lifecycle.then(operation);
    lifecycle = task.catch(() => undefined);
    return task;
  }

  state.webRoot = path.resolve(rendererDir);

  const rateLimiters = {
    login: httpHelpers.createRateLimiter(RATE_LIMITS.login),
    loginGlobal: httpHelpers.createRateLimiter({ windowMs: 60_000, max: 24 }),
    ws: httpHelpers.createRateLimiter({ windowMs: 60_000, max: MAX_WS_CONNECTIONS * 4 }),
  };

  const guard = httpHelpers.createRequestGuard({
    getAllowedHostnames: () => {
      const names = ["127.0.0.1", "localhost"];
      names.push(...state.listeners.map((entry) => entry.address));
      return names;
    },
    getPort: () => state.port,
    getExtensionIds,
  });


  // --- status ---------------------------------------------------------------

  function deviceConnections(deviceId) {
    let connections = 0;
    for (const conn of state.connections) {
      if (conn.deviceId !== deviceId) continue;
      connections += 1;
    }
    return { connections };
  }

  function getStatus() {
    const running = state.phase === "running";
    const url = running && state.address ? `http://${state.address}:${state.port}/` : null;
    const addresses = listenerAddresses(state.remoteAccess);
    const networkChanged = running && (addresses.length !== state.requestedAddresses.length ||
      addresses.some((entry) => !state.requestedAddresses.includes(entry.address)));
    return {
      phase: state.phase,
      running,
      remoteAccess: state.remoteAccess,
      address: state.address,
      bindAddress: state.address,
      port: state.port,
      url,
      links: running ? state.listeners.filter((entry) => entry.server.listening).map(({ address, label }) => ({
        address, label, url: `http://${address}:${state.port}/`,
      })) : [],
      warning: state.warning,
      addresses,
      startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
      error: state.lastError,
      restartRequired: state.restartRequired === true || networkChanged,
      passwordConfigured: state.devices.passwordConfigured,
      devices: state.devices.list().map((device) => ({
        ...device,
        ...deviceConnections(device.deviceId),
      })),
      version,
      name,
      limits: {
        maxUploadBytes: uploadMaxBytes,
        maxDevices: MAX_DEVICES,
        maxWebSockets: MAX_WS_CONNECTIONS,
      },
    };
  }


  function listenerAddresses(remoteAccess) {
    return network.listenerAddresses().filter((entry) => remoteAccess || isLoopback(entry.address));
  }

  function authorizeToken(token, address) {
    return state.devices.authorize(token) || (isLoopback(address) ? state.extensionDevices.authorize(token) : null);
  }

  function connectionDevice(conn) {
    return state.devices.get(conn.deviceId) || (isLoopback(conn.ip) ? state.extensionDevices.get(conn.deviceId) : null);
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
    dropConnection(conn);
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

  function wsError(conn, code, message) {
    sendWs(conn, { type: "error", error: { code: String(code), message: String(message) } });
  }

  function dropConnection(conn) {
    if (conn.authTimer) {
      clearTimeout(conn.authTimer);
      conn.authTimer = null;
    }
    const removed = state.connections.delete(conn);
    if (removed && conn.deviceId && typeof ipcInvoke === "function") {
      void Promise.resolve().then(() => ipcInvoke("pi-desktop/browserReferences/update", [{ sourceId: conn.id, active: false, closed: true }]))
        .catch((error) => log(`clear browser references failed: ${error?.message ?? error}`));
    }
  }

  function handleWsAuth(conn, message) {
    const token = typeof message.token === "string" ? message.token : "";
    const device = authorizeToken(token, conn.ip);
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
    sendWs(conn, {
      type: "ready",
      protocolVersion: 2,
      connectionId: conn.id,
      device: { id: device.id, name: device.name },
    });
  }

  async function handleWsMessage(conn, data, isBinary) {
    if (state.phase !== "running") {
      closeWs(conn, 4001, "server stopping");
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
      handleWsAuth(conn, message);
      return;
    }
    if (conn.deviceId && !connectionDevice(conn)) {
      closeWs(conn, 4401, "unauthorized");
      return;
    }
    switch (message.type) {
      case "browser-context": {
        if (typeof ipcInvoke !== "function" || (message.active === true && !Array.isArray(message.tabs))) {
          wsError(conn, "INVALID_PARAMS", "browser context is unavailable");
          return;
        }
        const result = await ipcInvoke("pi-desktop/browserReferences/update", [{
          sourceId: conn.id, active: message.active === true, tabs: message.tabs ?? [],
          ...(typeof message.browserId === "string" ? { browserId: message.browserId } : {}),
        }]);
        if (result?.ok === false) wsError(conn, result.error?.code || "INTERNAL", result.error?.message || "browser context update failed");
        return;
      }
      case "ping":
        sendWs(conn, { type: "pong", ts: Date.now() });
        return;
      case "pong":
        conn.alive = true;
        return;
      case "auth":
        sendWs(conn, { type: "ready", protocolVersion: 2, connectionId: conn.id, device: { id: conn.deviceId, name: conn.device?.name ?? "" } });
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
      alive: true,
      ip: clientAddress(req),
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

  /** CSP 允许当前服务的 HTTP/WS 地址及已配置的扩展来源。 */
  function connectOrigins() {
    const origins = [];
    for (const { address } of state.listeners.filter((entry) => entry.server.listening)) {
      const host = address.includes(":") ? `[${address}]` : address;
      origins.push(`http://${host}:${state.port}`, `ws://${host}:${state.port}`);
    }
    for (const id of getExtensionIds() ?? []) {
      if (typeof id === "string" && /^[a-p]{32}$/.test(id)) origins.push(`chrome-extension://${id}`);
    }
    origins.push("chrome-extension://afeafocngkodbmaipcngoamamfmekgfo");
    return [...new Set(origins)];
  }

  function authenticate(req) {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length).trim();
    if (!token || token.length > 256) return null;
    return authorizeToken(token, clientAddress(req));
  }

  function healthResult() {
    return {
      name,
      version,
      requiresAuth: true,
      protocolVersion: 2,
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
    if (!body.ok) { httpHelpers.sendBodyError(req, res, body); return; }
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

  async function handleExtensionSession(req, res, originCheck) {
    const address = clientAddress(req);
    if (originCheck.extension !== true || !isLoopback(address)) {
      httpHelpers.sendError(res, 403, "FORBIDDEN", "仅本机浏览器扩展可建立此会话");
      return;
    }
    const body = await httpHelpers.readJsonBody(req, { maxBytes: LOGIN_BODY_MAX_BYTES });
    if (!body.ok) { httpHelpers.sendBodyError(req, res, body); return; }
    if (state.phase !== "running") { httpHelpers.sendError(res, 503, "NOT_READY", "server is not running"); return; }
    const result = state.extensionDevices.add({ name: "Chrome 侧边栏", remoteAddress: address, userAgent: req.headers["user-agent"] });
    httpHelpers.sendResult(res, { token: result.token, deviceId: result.device.id, deviceName: result.device.name,
      expiresAt: new Date(result.device.expiresAt).toISOString() });
  }

  async function handleIpc(req, res) {
    const requestGeneration = generation;
    const device = authenticate(req);
    if (!device) {
      httpHelpers.sendError(res, 401, "UNAUTHORIZED", "device token is missing or invalid");
      return;
    }
    const body = await httpHelpers.readJsonBody(req, { maxBytes: RPC_BODY_MAX_BYTES });
    if (!body.ok) {
      httpHelpers.sendBodyError(req, res, body);
      return;
    }
    const { channel, args } = body.value;
    if (typeof channel !== "string" || !channel.trim() || !Array.isArray(args)) {
      httpHelpers.sendError(res, 400, "INVALID_PARAMS", "channel must be a string and args must be an array");
      return;
    }
    if (typeof ipcInvoke !== "function") {
      httpHelpers.sendError(res, 501, "UNSUPPORTED", "host IPC invoke is unavailable");
      return;
    }
    const authorized = () => generation === requestGeneration && state.phase === "running" && authenticate(req)?.id === device.id;
    if (!authorized()) {
      httpHelpers.sendError(res, 401, "UNAUTHORIZED", "device authorization was revoked");
      return;
    }
    const task = Promise.resolve().then(() => ipcInvoke(channel, args));
    state.inFlight.add(task);
    try {
      const result = await task;
      if (!authorized()) {
        httpHelpers.sendError(res, 401, "UNAUTHORIZED", "device authorization was revoked");
        return;
      }
      httpHelpers.sendJson(res, 200, result === undefined ? null : result);
    } catch (error) {
      httpHelpers.sendError(res, statusForCode(error?.code), error?.code ?? "INTERNAL", error?.message ?? error);
    } finally {
      state.inFlight.delete(task);
    }
  }

  async function handleRpc(req, res) {
    const requestGeneration = generation;
    const device = authenticate(req);
    if (!device) {
      httpHelpers.sendError(res, 401, "UNAUTHORIZED", "device token is missing or invalid");
      return;
    }
    const body = await httpHelpers.readJsonBody(req, { maxBytes: RPC_BODY_MAX_BYTES });
    if (!body.ok) {
      httpHelpers.sendBodyError(req, res, body);
      return;
    }
    if (generation !== requestGeneration || state.phase !== "running" || authenticate(req)?.id !== device.id) {
      httpHelpers.sendError(res, 401, "UNAUTHORIZED", "device authorization was revoked");
      return;
    }
    const { operation, requestId } = body.value;
    const responseOptions = typeof requestId === "string" && requestId.length <= 64 ? { requestId } : {};
    if (typeof operation !== "string" || !Object.hasOwn(BROWSE_OPERATIONS, operation) ||
        !Object.hasOwn(localOperations, operation) || typeof localOperations[operation] !== "function") {
      httpHelpers.sendError(res, 403, "OPERATION_NOT_ALLOWED", "only declared Browse operations are available", responseOptions);
      return;
    }
    const task = Promise.resolve().then(() => localOperations[operation]());
    state.inFlight.add(task);
    try {
      const result = await task;
      if (generation !== requestGeneration || state.phase !== "running" || authenticate(req)?.id !== device.id) {
        httpHelpers.sendError(res, 401, "UNAUTHORIZED", "device authorization was revoked");
        return;
      }
      httpHelpers.sendResult(res, result, responseOptions);
    } catch (error) {
      httpHelpers.sendError(res, statusForCode(error?.code), error?.code ?? "INTERNAL", error?.message ?? error, responseOptions);
    } finally {
      state.inFlight.delete(task);
    }
  }

  async function handleUpload(req, res, url) {
    if (url.searchParams.has("target") && url.searchParams.get("target") !== "renderer") {
      httpHelpers.sendError(res, 400, "INVALID_PARAMS", "only Renderer uploads are supported");
      return;
    }
    const requestGeneration = generation;
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
      httpHelpers.sendBodyError(req, res, body);
      return;
    }
    if (generation !== requestGeneration || state.phase !== "running" || authenticate(req)?.id !== device.id) {
      httpHelpers.sendError(res, 401, "UNAUTHORIZED", "device authorization was revoked");
      return;
    }
    const saved = await state.attachments.save({
      deviceId: device.id,
      name: headerValue("x-filename"),
      mimeType: headerValue("content-type"),
      buffer: body.buffer,
      isAuthorized: () => generation === requestGeneration && state.phase === "running" && authenticate(req)?.id === device.id,
    });
    if (!saved.ok) {
      httpHelpers.sendError(res, statusForCode(saved.code), saved.code, saved.message);
      return;
    }
    let task;
    try {
      if (typeof rendererUpload !== "function") throw fail("UNSUPPORTED", "renderer upload is unavailable");
      const item = state.attachments.get(saved.item.id);
      if (!item) throw fail("INTERNAL", "staged upload is unavailable");
      task = Promise.resolve().then(() => rendererUpload({
        ...(headerValue("x-session-id") ? { sessionId: headerValue("x-session-id") } : {}),
        ...(url.searchParams.get("draftId") ? { draftId: url.searchParams.get("draftId") } : {}),
        files: [{ path: item.filePath, name: item.name, kind: item.kind, mimeType: item.mimeType, size: item.size }],
      }));
      state.inFlight.add(task);
      const result = await task;
      await state.attachments.remove(saved.item.id, device.id);
      if (generation !== requestGeneration || state.phase !== "running" || authenticate(req)?.id !== device.id) {
        httpHelpers.sendError(res, 401, "UNAUTHORIZED", "device authorization was revoked");
        return;
      }
      httpHelpers.sendJson(res, 200, result === undefined ? null : result);
    } catch (error) {
      await state.attachments.remove(saved.item.id, device.id);
      httpHelpers.sendError(res, statusForCode(error?.code), error?.code ?? "INTERNAL", error?.message ?? error);
    } finally {
      state.inFlight.delete(task);
    }
  }

  async function handleFile(req, res) {
    const requestGeneration = generation;
    const device = authenticate(req);
    if (!device) { httpHelpers.sendError(res, 401, "UNAUTHORIZED", "登录已失效"); return; }
    const body = await httpHelpers.readJsonBody(req, { maxBytes: RPC_BODY_MAX_BYTES });
    if (!body.ok) { httpHelpers.sendBodyError(req, res, body); return; }
    const { path: filePath, sessionId } = body.value;
    if (typeof filePath !== "string" || !filePath.trim() ||
        (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId))) {
      httpHelpers.sendError(res, 400, "INVALID_PARAMS", "文件路径或会话无效"); return;
    }
    const authorized = () => generation === requestGeneration && state.phase === "running" && authenticate(req)?.id === device.id;
    if (!authorized()) { httpHelpers.sendError(res, 401, "UNAUTHORIZED", "登录已失效"); return; }
    if (typeof rendererFile !== "function") { httpHelpers.sendError(res, 501, "UNSUPPORTED", "请更新主程序以启用文件预览和下载"); return; }
    const task = Promise.resolve().then(() => rendererFile({ path: filePath, ...(sessionId ? { sessionId } : {}) }));
    state.inFlight.add(task);
    try {
      const file = fileResponse(await task);
      if (!authorized()) { httpHelpers.sendError(res, 401, "UNAUTHORIZED", "登录已失效"); return; }
      res.setHeader("Content-Type", file.mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (value) => `%${value.charCodeAt(0).toString(16)}`)}`);
      res.setHeader("X-File-Name", encodeURIComponent(file.name));
      const previewUrl = fileViewUrl(req.headers.authorization.replace(/^Bearer\s+/i, "").trim(), { path: file.path || filePath, sessionId });
      if (previewUrl) res.setHeader("X-File-Preview", previewUrl);
      res.setHeader("Access-Control-Expose-Headers", "X-File-Name, X-File-Preview, Content-Disposition");
      res.setHeader("Content-Length", String(file.body.length));
      res.writeHead(200);
      res.end(file.body);
    } catch (error) {
      httpHelpers.sendError(res, statusForCode(error?.code), error?.code ?? "INTERNAL", error?.message ?? "文件读取失败");
    } finally { state.inFlight.delete(task); }
  }

  async function handleFileView(req, res, url) {
    const requestGeneration = generation;
    const target = parseFileViewUrl(url.pathname);
    const device = target?.token ? authorizeToken(target.token, clientAddress(req)) : null;
    if (!device) { httpHelpers.sendError(res, 401, "UNAUTHORIZED", "登录已失效"); return; }
    if (typeof rendererFile !== "function") { httpHelpers.sendError(res, 501, "UNSUPPORTED", "请更新主程序以启用文件预览和下载"); return; }
    const task = Promise.resolve().then(() => rendererFile(target.input));
    state.inFlight.add(task);
    try {
      const file = fileResponse(await task);
      if (generation !== requestGeneration || state.phase !== "running" || authorizeToken(target.token, clientAddress(req))?.id !== device.id) {
        httpHelpers.sendError(res, 401, "UNAUTHORIZED", "登录已失效"); return;
      }
      res.setHeader("Content-Type", file.mimeType);
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-downloads; default-src 'self' data: blob: http: https: 'unsafe-inline' 'unsafe-eval'");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      if (req.headers.origin === "null") res.setHeader("Access-Control-Allow-Origin", "null");
      res.setHeader("Content-Length", String(file.body.length));
      res.writeHead(200);
      res.end(req.method === "HEAD" ? undefined : file.body);
    } catch (error) {
      httpHelpers.sendError(res, statusForCode(error?.code), error?.code ?? "INTERNAL", error?.message ?? "文件读取失败");
    } finally { state.inFlight.delete(task); }
  }

  async function handleResource(req, res, url) {
    const requestGeneration = generation;
    const parts = /^\/api\/resource\/([^/]+)\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    let token;
    try { token = parts ? decodeURIComponent(parts[1]) : ""; }
    catch { token = ""; }
    const device = token && token.length <= 256 ? authorizeToken(token, clientAddress(req)) : null;
    if (!device) {
      httpHelpers.sendError(res, 401, "UNAUTHORIZED", "device token is missing or invalid");
      return;
    }
    const scheme = parts[2];
    if (!RESOURCE_SCHEMES.has(scheme)) {
      httpHelpers.sendError(res, 403, "UNSUPPORTED", "resource protocol is not allowed");
      return;
    }
    let resourceUrl;
    try {
      const hostname = decodeURIComponent(parts[3]);
      resourceUrl = new URL(`${scheme}://${hostname}${parts[4] || "/"}${url.search}`);
      if (!resourceUrl.hostname || resourceUrl.host !== hostname || resourceUrl.username || resourceUrl.password || resourceUrl.port) throw new Error("invalid resource host");
    } catch {
      httpHelpers.sendError(res, 400, "INVALID_PARAMS", "resource URL is invalid");
      return;
    }
    if (typeof rendererResource !== "function") {
      httpHelpers.sendError(res, 501, "UNSUPPORTED", "host resource reader is unavailable");
      return;
    }
    const authorized = () => requestGeneration === generation && state.phase === "running" && authorizeToken(token, clientAddress(req))?.id === device.id;
    const task = Promise.resolve().then(() => rendererResource(resourceUrl.href));
    state.inFlight.add(task);
    try {
      const resource = await task;
      if (!authorized()) {
        httpHelpers.sendError(res, 401, "UNAUTHORIZED", "device authorization was revoked");
        return;
      }
      if (!Number.isInteger(resource?.status) || resource.status < 200 || resource.status > 599 || typeof resource.body !== "string") throw fail("INTERNAL", "invalid resource response");
      const headers = new Map(Object.entries(resource.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
      const contentType = headers.get("content-type") || "application/octet-stream";
      let body = Buffer.from(resource.body, "base64");
      if (/^(?:text\/(?:html|css|javascript)|application\/(?:javascript|x-javascript))(?:\s*;|$)/i.test(contentType)) {
        body = Buffer.from(rewriteResourceText(body.toString("utf8"), {
          token, url: resourceUrl.href, html: /^text\/html(?:\s*;|$)/i.test(contentType),
        }), "utf8");
      }
      res.setHeader("Content-Type", contentType);
      for (const name of ["content-security-policy", "content-security-policy-report-only"]) {
        if (typeof headers.get(name) === "string") res.setHeader(name, rewriteResourceCsp(headers.get(name)));
      }
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      if (req.headers.origin === "null") {
        res.setHeader("Access-Control-Allow-Origin", "null");
        res.setHeader("Vary", "Origin");
      }
      res.setHeader("Content-Length", String(body.length));
      res.writeHead(resource.status);
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (error) {
      httpHelpers.sendError(res, statusForCode(error?.code), error?.code ?? "INTERNAL", "resource read failed");
    } finally {
      state.inFlight.delete(task);
    }
  }

  async function handleRequest(req, res) {
    httpHelpers.applySecurityHeaders(res);
    try {
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
      const sandboxResource = isGet && (pathname.startsWith("/api/resource/") || pathname.startsWith("/api/file-view/")) && req.headers.origin === "null";
      const originCheck = sandboxResource ? { ok: true, origin: "null" } : guard.checkOrigin(req, { required: !isGet });
      if (!originCheck.ok) {
        httpHelpers.sendError(res, originCheck.status, originCheck.code, originCheck.message);
        return;
      }
      const cors = guard.applyCors(req, res, originCheck);

      if (state.phase !== "running") {
        httpHelpers.sendError(res, 503, "NOT_READY", "server is not running");
        return;
      }
      if (req.method === "OPTIONS") {
        const method = req.headers["access-control-request-method"];
        const headers = String(req.headers["access-control-request-headers"] || "").toLowerCase().split(",").map((value) => value.trim()).filter(Boolean);
        if (!cors || !["GET", "POST", "HEAD"].includes(method) || headers.some((value) => !["content-type", "authorization", "x-filename", "x-session-id"].includes(value))) {
          httpHelpers.sendError(res, 403, "FORBIDDEN_ORIGIN", "preflight is not allowed");
          return;
        }
        res.writeHead(204);
        res.end();
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
      if (pathname === "/api/extension-session") {
        if (req.method !== "POST") { httpHelpers.sendError(res, 405, "METHOD_NOT_ALLOWED", "method not allowed"); return; }
        await handleExtensionSession(req, res, originCheck);
        return;
      }
      if (pathname === "/api/login") {
        if (req.method !== "POST") { httpHelpers.sendError(res, 405, "METHOD_NOT_ALLOWED", "method not allowed"); return; }
        await handleLogin(req, res, clientAddress(req));
        return;
      }
      if (pathname === "/api/logout") {
        if (req.method !== "POST") { httpHelpers.sendError(res, 405, "METHOD_NOT_ALLOWED", "method not allowed"); return; }
        const device = authenticate(req);
        if (!device) { httpHelpers.sendError(res, 401, "UNAUTHORIZED", "登录已失效"); return; }
        await revokeDevice(device.id, state.extensionDevices.get(device.id) ? state.extensionDevices : state.devices);
        httpHelpers.sendResult(res, { loggedOut: true });
        return;
      }
      if (pathname.startsWith("/api/file-view/")) {
        if (!isGet) { httpHelpers.sendError(res, 405, "METHOD_NOT_ALLOWED", "method not allowed"); return; }
        await handleFileView(req, res, url);
        return;
      }
      if (pathname === "/api/file") {
        if (req.method !== "POST") { httpHelpers.sendError(res, 405, "METHOD_NOT_ALLOWED", "method not allowed"); return; }
        await handleFile(req, res);
        return;
      }
      if (pathname === "/api/ipc") {
        if (req.method !== "POST") {
          httpHelpers.sendError(res, 405, "METHOD_NOT_ALLOWED", "method not allowed");
          return;
        }
        await handleIpc(req, res);
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
        await handleUpload(req, res, url);
        return;
      }
      if (pathname.startsWith("/api/resource/")) {
        if (!isGet) {
          httpHelpers.sendError(res, 405, "METHOD_NOT_ALLOWED", "method not allowed");
          return;
        }
        await handleResource(req, res, url);
        return;
      }
      if (pathname.startsWith("/api/")) {
        httpHelpers.sendError(res, 404, "NOT_FOUND", "not found");
        return;
      }
      if (pathname.startsWith("/__lan-remote/")) {
        if (!isGet) { httpHelpers.sendError(res, 405, "METHOD_NOT_ALLOWED", "method not allowed"); return; }
        const asset = pathname.slice("/__lan-remote/".length);
        if (!state.projectionRootReal || !["projection.js", "file-actions.css", "file-actions.js", "browser-grip.js"].includes(asset)) {
          httpHelpers.sendError(res, 404, "NOT_FOUND", "not found"); return;
        }
        const served = await httpHelpers.serveStaticFile(req, res, {
          rootDir: state.projectionRootReal, rootRealDir: state.projectionRootReal,
          pathname: `/${asset}`, connectOrigins: connectOrigins(),
        });
        if (!served.ok) httpHelpers.sendError(res, served.status, served.code, served.message);
        return;
      }
      if (!isGet) {
        httpHelpers.sendError(res, 405, "METHOD_NOT_ALLOWED", "method not allowed");
        return;
      }
      const staticOptions = {
        rootDir: state.webRoot,
        rootRealDir: state.webRootReal,
        pathname,
        connectOrigins: connectOrigins(),
        renderer: true,
        projection: state.projectionRootReal !== null,
      };
      let served = await httpHelpers.serveStaticFile(req, res, staticOptions);
      if (!served.ok && served.code === "NOT_FOUND" && path.extname(pathname) === "") {
        served = await httpHelpers.serveStaticFile(req, res, { ...staticOptions, pathname: "/index.html" });
      }
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
      if (conn.deviceId && !connectionDevice(conn)) closeWs(conn, 4403, "session expired");
    }
    await state.attachments.pruneExpired();
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

  async function start({ address, port, remoteAccess = true } = {}, expectedGeneration = generation) {
    if (expectedGeneration !== generation) throw fail("NOT_READY", "start was cancelled");
    // 旧 address 仅作为首选链接，不限制监听集合；旧网卡地址失效也能恢复。
    if (address && (typeof address !== "string" || !network.isAllowedBindAddress(address))) {
      throw fail("INVALID_PARAMS", "address must be a private or loopback IPv4 address");
    }
    let listenPort = port === undefined || port === null ? DEFAULT_PORT : Number(port);
    if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65_535) {
      throw fail("INVALID_PARAMS", "port must be an integer between 0 and 65535");
    }
    if (remoteAccess && !state.devices.passwordConfigured) throw fail("PASSWORD_REQUIRED", "请先在电脑端设置访问密码");
    const candidates = listenerAddresses(remoteAccess);
    candidates.sort((a, b) => Number(b.address === address) - Number(a.address === address));
    if (state.phase === "running") {
      const sameAddresses = candidates.length === state.listeners.length &&
        candidates.every((entry) => state.listeners.some((active) => active.address === entry.address && active.server.listening));
      if (sameAddresses && remoteAccess === state.remoteAccess && (listenPort === 0 || listenPort === state.port)) return getStatus();
      generation += 1;
      expectedGeneration = generation;
      await stop();
      if (expectedGeneration !== generation) throw fail("NOT_READY", "start was cancelled");
    }
    if (state.phase === "starting" || state.phase === "stopping") {
      throw fail("NOT_READY", "server is busy");
    }
    state.phase = "starting";
    state.remoteAccess = remoteAccess;
    state.lastError = null;

    state.warning = null;
    state.requestedAddresses = candidates.map((entry) => entry.address);
    const failures = [];
    try {
      const WebSocketServer = loadWebSocketServer();
      await state.attachments.init();
      try {
        state.webRootReal = await fsp.realpath(state.webRoot);
        if (!(await fsp.stat(state.webRootReal)).isDirectory()) throw new Error("not a directory");
        const index = path.join(state.webRootReal, "index.html");
        if (!(await fsp.stat(index)).isFile()) throw new Error("index.html is not a file");
        await fsp.access(index, fs.constants.R_OK);
      } catch (error) {
        throw fail("RENDERER_UNAVAILABLE", `无法读取同一安装的 Renderer：${state.webRoot}（${error.message}）`);
      }
      if (projectionDir) {
        state.projectionRootReal = await fsp.realpath(projectionDir);
        for (const name of ["projection.js", "file-actions.css", "file-actions.js", "browser-grip.js"]) {
          await fsp.access(path.join(state.projectionRootReal, name), fs.constants.R_OK);
        }
      }

      for (const candidate of candidates) {
        if (expectedGeneration !== generation) throw fail("NOT_READY", "start was cancelled");
        const server = http.createServer((req, res) => {
          void handleRequest(req, res);
        });
        server.requestTimeout = REQUEST_TIMEOUT_MS;
        server.headersTimeout = HEADERS_TIMEOUT_MS;
        server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
        server.maxHeadersCount = 64;
        server.maxConnections = MAX_HTTP_CONNECTIONS;
        server.on("connection", (socket) => {
          if (state.sockets.size >= MAX_HTTP_CONNECTIONS) { socket.destroy(); return; }
          state.sockets.add(socket);
          socket.on("close", () => state.sockets.delete(socket));
        });
        server.on("clientError", (error, socket) => {
          log(`client error: ${error?.message ?? error}`);
          try { socket.destroy(); } catch { /* already gone */ }
        });
        server.on("upgrade", (req, socket, head) => handleUpgrade(req, socket, head));
        // 全生命周期接住错误；过期监听器的回调不能关闭后来开启的服务。
        server.on("error", (error) => {
          log(`listener error: ${error?.message ?? error}`);
          if (state.phase !== "running" || !state.listeners.some((entry) => entry.server === server)) return;
          state.lastError = { code: "LISTEN_ERROR", message: String(error?.message ?? error) };
          if (!server.listening) noteUnexpectedStop("LISTENER_CLOSED", "listener closed after an error");
        });
        server.once("close", () => {
          if (state.phase === "running" && state.listeners.some((entry) => entry.server === server)) {
            noteUnexpectedStop("LISTENER_CLOSED", "listener closed unexpectedly");
          }
        });

        try {
          await listen(server, candidate.address, listenPort);
          const addressInfo = server.address();
          if (!addressInfo || typeof addressInfo === "string" ||
              addressInfo.address !== candidate.address || !network.isAllowedBindAddress(addressInfo.address)) {
            throw fail("ADDRESS_UNAVAILABLE", "listener did not bind the requested address");
          }
          listenPort = addressInfo.port;
          state.port = listenPort;
          state.listeners.push({ ...candidate, server });
        } catch (error) {
          try { server.close(); } catch {}
          failures.push({ address: candidate.address, label: candidate.label,
            code: error?.code ?? "INTERNAL", message: String(error?.message ?? error) });
          log(`监听 ${candidate.address} 失败：${error?.message ?? error}`);
        }
      }
      if (expectedGeneration !== generation) throw fail("NOT_READY", "start was cancelled");
      if (!state.listeners.length) throw fail(failures[0]?.code ?? "ADDRESS_UNAVAILABLE",
        failures.map((entry) => `${entry.address}: ${entry.message}`).join("；"));
      if (failures.length) state.warning = { code: "PARTIAL_LISTEN_FAILED",
        message: `部分地址监听失败：${failures.map((entry) => `${entry.address}（${entry.message}）`).join("；")}`,
        failures };
      state.wss = new WebSocketServer({
        noServer: true,
        clientTracking: false,
        perMessageDeflate: false,
        maxPayload: WS_MAX_PAYLOAD_BYTES,
      });
      state.address = state.listeners[0].address;
      state.restartRequired = false;
      state.startedAt = Date.now();
      state.phase = "running";
      startTimers();
      log(`listening on ${getStatus().links.map((entry) => entry.url).join(", ")}`);
      return getStatus();
    } catch (error) {
      const coded = error?.code ? error : fail("INTERNAL", String(error?.message ?? error));
      state.lastError = { code: String(coded.code), message: String(coded.message ?? coded) };
      state.phase = "stopped";
      clearTimers();
      const listeners = state.listeners.splice(0);
      await Promise.all(listeners.map(({ server }) => closeHttpServer(server)));
      try { state.wss?.close(); } catch {}
      state.wss = null;
      state.address = null;
      state.port = null;
      state.startedAt = null;
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

  /** 监听意外关闭时使在途请求失效，并保留设备以供重新开启。 */
  function noteUnexpectedStop(code, message) {
    if (state.phase !== "running") return;
    state.phase = "stopped";
    state.lastError = { code: String(code), message: String(message || code) };
    generation += 1;
    clearTimers();
    const listeners = state.listeners.splice(0);
    const wss = state.wss;
    state.wss = null;
    for (const conn of [...state.connections]) {
      dropConnection(conn);
      try {
        conn.ws.terminate();
      } catch {
        /* already gone */
      }
    }
    state.connections.clear();
    try {
      wss?.close();
    } catch {
      /* already closed */
    }
    for (const { server } of listeners) {
      try { server.close(); } catch { /* already closed */ }
    }
    for (const socket of [...state.sockets]) {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    }
    state.sockets.clear();
    state.address = null;
    state.port = null;
    state.startedAt = null;
    log(`listener stopped unexpectedly: ${code} ${state.lastError.message}`);
  }

  async function stop() {
    if (state.phase === "stopped") return getStatus();
    state.phase = "stopping";
    clearTimers();

    // 宿主已接收的操作继续执行，停止服务只等待有限的收尾时间。
    for (const conn of [...state.connections]) {
      sendWs(conn, { type: "error", error: { code: "NOT_READY", message: "server is stopping" } });
      closeWs(conn, 4001, "server stopping");
    }
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (state.inFlight.size > 0 && Date.now() < deadline) {
      await delay(50);
    }

    const listeners = state.listeners.splice(0);
    const wss = state.wss;
    state.wss = null;
    for (const conn of [...state.connections]) {
      dropConnection(conn);
      try { conn.ws.terminate(); } catch {}
    }
    wss?.close();
    await Promise.all(listeners.map(({ server }) => closeHttpServer(server)));

    await state.attachments.dispose();
    state.connections.clear();
    state.inFlight.clear();
    state.address = null;
    state.port = null;
    state.startedAt = null;
    state.warning = null;
    state.restartRequired = false;
    state.phase = "stopped";
    return getStatus();
  }

  // --- panel-facing helpers -------------------------------------------------

  function createLink() {
    if (state.phase !== "running") return { ok: false, code: "NOT_RUNNING", message: "请先开启远程访问" };
    const { url, links, warning } = getStatus();
    return { ok: true, url, links, warning };
  }

  async function setPassword(password) {
    const ids = await state.devices.setPassword(password);
    for (const id of ids) await revokeDevice(id);
    return { ok: true };
  }

  async function revokeDevice(deviceId, store = state.devices) {
    const existed = store.revoke(deviceId);
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

  /** 状态事件共享，引用插入仅投递到目标连接。 */
  function broadcastIpc(event) {
    if (state.phase !== "running" || typeof event?.channel !== "string" || !Array.isArray(event.args)) return 0;
    let delivered = 0;
    for (const conn of state.connections) {
      if (!conn.deviceId || !connectionDevice(conn) || !wsOpen(conn)) continue;
      if (event.channel === "pi-desktop/browserReferences/event/insertRequested" && event.args[0]?.connectionId !== conn.id) continue;
      sendWs(conn, { type: "ipc-event", channel: event.channel, args: event.args });
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
    broadcastIpc,
    sweepNow,
    markRestartRequired,
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
