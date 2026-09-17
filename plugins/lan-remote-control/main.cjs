"use strict";

/**
 * LAN remote control — plugin entry.
 *
 * The host injects the global `pi` object before calling `onLoad`. This file
 * wires four things together:
 *
 *   1. the desktop panel channels (`onPanelInvoke`) — the only place a device
 *      can set the access password or revoke devices;
 *   2. the resident service declared as `lan-remote-control`, which owns the
 *      network server's lifecycle but never starts it on its own;
 *   3. the host adapter (`host-adapter.cjs`) through
 *      a single narrow interface: capabilities() / invoke() / subscribe() /
 *      unsubscribe();
 *   4. host `desktop:event` events, filtered per session by device subscription
 *      and with one adapter subscribe per session (reference counted in the
 *      server).
 *
 * No listener is created until the user starts the service from the panel, and
 * stopping it leaves nothing behind: no socket or staged file; password hashes and device records stay in plugin data.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createRemoteServer } = require("./server.cjs");
const network = require("./server/network.cjs");
const { buildOperationTable } = require("./server/rpc.cjs");
const { DEFAULT_MAX_BYTES } = require("./server/uploads.cjs");

const PLUGIN_DIR = __dirname;
const WEB_DIR = path.join(PLUGIN_DIR, "web");

const COMMAND_OPEN = "lan-remote-control.open";
const SERVICE_ID = "lan-remote-control";

const DEFAULT_SETTINGS = Object.freeze({
  bindAddress: "",
  port: 7878,
});
const SETTINGS_CACHE_MS = 5000;
const APPEARANCE_CACHE_MS = 15_000;
const LOG_RING_SIZE = 50;
const MAX_LOG_MESSAGE_LENGTH = 400;

/** Channels the desktop panel may call. Nothing here is reachable over HTTP. */
const PANEL_CHANNELS = Object.freeze([
  "remote.status",
  "remote.refresh",
  "remote.start",
  "remote.stop",
  "remote.link",
  "remote.setPassword",
  "remote.indicator",
  "remote.revoke",
  "remote.revokeAll",
]);

let remote = null;
let adapter = null;
let adapterModule = null;
let adapterError = null;
let dataDir = null;
let settings = { ...DEFAULT_SETTINGS };
let settingsError = null;
let settingsLoadedAt = 0;
let appearance = null;
let appearanceLoadedAt = 0;
let wired = false;
let registeredCommands = [];
let serviceRegistered = false;
let shuttingDown = false;
let webReady = false;
const recentLog = [];

function recordLog(level, message) {
  const text = String(message ?? "").slice(0, MAX_LOG_MESSAGE_LENGTH);
  recentLog.push({ at: new Date().toISOString(), level: String(level), message: text });
  if (recentLog.length > LOG_RING_SIZE) recentLog.splice(0, recentLog.length - LOG_RING_SIZE);
}

function safeManifest() {
  try {
    const manifest = pi.plugin.getManifest();
    return manifest && typeof manifest === "object" ? manifest : {};
  } catch (error) {
    recordLog("warn", `getManifest failed: ${error?.message ?? error}`);
    return {};
  }
}

function pluginVersion(manifest) {
  return typeof manifest?.version === "string" && manifest.version ? manifest.version : "0.0.0";
}

function panelTitle(manifest) {
  const title = manifest?.ui?.title;
  if (typeof title === "string" && title) return title;
  if (title && typeof title === "object") return title["zh-CN"] || title.en || "局域网远程控制";
  return "局域网远程控制";
}

// --- settings ---------------------------------------------------------------

function normalizeSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const errors = [];

  let bindAddress = "";
  if (source.bindAddress !== undefined) {
    if (typeof source.bindAddress === "string") {
      const candidate = source.bindAddress.trim();
      if (!candidate) {
        bindAddress = "";
      } else if (!network.isAllowedBindAddress(candidate)) {
        errors.push("bindAddress 必须是私网或回环 IPv4 地址，已回退为自动选择");
      } else {
        bindAddress = candidate;
      }
    } else {
      errors.push("bindAddress 必须是字符串，已回退为自动选择");
    }
  }

  let port = DEFAULT_SETTINGS.port;
  if (source.port !== undefined) {
    const parsed = Number(source.port);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535) {
      port = parsed;
    } else {
      errors.push("port 必须是 1..65535 的整数，已回退为默认端口");
    }
  }

  return {
    settings: { bindAddress, port },
    error: errors.length ? errors.join("；") : null,
  };
}

async function refreshSettings(force = false) {
  const now = Date.now();
  if (!force && settingsLoadedAt && now - settingsLoadedAt < SETTINGS_CACHE_MS) return settings;
  let raw = {};
  try {
    raw = await pi.plugin.getSettings();
  } catch (error) {
    recordLog("warn", `getSettings failed: ${error?.message ?? error}`);
    settingsError = "读取插件设置失败，使用默认值";
    settingsLoadedAt = now;
    return settings;
  }
  const normalized = normalizeSettings(raw);
  settings = normalized.settings;
  settingsError = normalized.error;
  settingsLoadedAt = now;

  const status = remote?.getStatus();
  if (status?.running) {
    const addressChanged = settings.bindAddress && settings.bindAddress !== status.address;
    const portChanged = settings.port !== status.port;
    if (addressChanged || portChanged) remote.markRestartRequired(true);
  }
  return settings;
}

async function refreshAppearance(force = false) {
  const now = Date.now();
  if (!force && appearanceLoadedAt && now - appearanceLoadedAt < APPEARANCE_CACHE_MS) return appearance;
  try {
    const value = await pi.app.getAppearance();
    appearance = value && typeof value === "object"
      ? {
          theme: String(value.theme ?? ""),
          base: String(value.base ?? ""),
          locale: String(value.locale ?? ""),
          pluginTheme:
            value.pluginTheme && typeof value.pluginTheme === "object"
              ? { id: String(value.pluginTheme.id ?? ""), base: String(value.pluginTheme.base ?? "") }
              : null,
        }
      : null;
  } catch (error) {
    recordLog("warn", `getAppearance failed: ${error?.message ?? error}`);
    appearance = null;
  }
  appearanceLoadedAt = now;
  return appearance;
}

// --- host adapter -----------------------------------------------------------

function loadAdapter() {
  let module;
  try {
    module = require("./host-adapter.cjs");
  } catch (error) {
    adapterError = {
      code: "ADAPTER_MISSING",
      message: `宿主适配器未加载：${error?.message ?? error}`,
    };
    recordLog("warn", adapterError.message);
    return null;
  }
  if (!module || typeof module.createHostAdapter !== "function") {
    adapterError = { code: "ADAPTER_INVALID", message: "host-adapter.cjs 未导出 createHostAdapter" };
    recordLog("warn", adapterError.message);
    return null;
  }
  let instance;
  try {
    instance = module.createHostAdapter(pi);
  } catch (error) {
    adapterError = { code: "ADAPTER_INVALID", message: `createHostAdapter 失败：${error?.message ?? error}` };
    recordLog("warn", adapterError.message);
    return null;
  }
  if (!instance || typeof instance.invoke !== "function") {
    adapterError = { code: "ADAPTER_INVALID", message: "createHostAdapter 返回的对象缺少 invoke()" };
    recordLog("warn", adapterError.message);
    return null;
  }
  adapterError = null;
  adapterModule = module;
  return instance;
}

async function handleAdapterSubscribe(sessionId) {
  if (!adapter || typeof adapter.subscribe !== "function") {
    const error = new Error("host adapter cannot subscribe to sessions");
    error.code = "UNSUPPORTED";
    throw error;
  }
  // `pi.desktop.subscribe` answers with `{ subscriptionId, sessionId, snapshot }`;
  // the snapshot rides along on the `subscribed` frame so the phone can render
  // without an immediate round trip.
  const result = await adapter.subscribe(sessionId);
  return result && typeof result === "object" ? result : null;
}

async function handleAdapterUnsubscribe(sessionId) {
  if (!adapter || typeof adapter.unsubscribe !== "function") return;
  await adapter.unsubscribe(sessionId);
}

function getCapabilities() {
  if (!adapter || typeof adapter.capabilities !== "function") return null;
  return adapter.capabilities();
}

// --- data directory ---------------------------------------------------------

async function resolveDataDir() {
  try {
    const dir = await pi.plugin.getDataPath();
    if (typeof dir === "string" && dir.trim()) return dir;
  } catch (error) {
    recordLog("warn", `getDataPath failed: ${error?.message ?? error}`);
  }
  const suffix = crypto.createHash("sha1").update(PLUGIN_DIR).digest("hex").slice(0, 8);
  return path.join(os.tmpdir(), `lan-remote-control-${suffix}`);
}

// --- desktop events ---------------------------------------------------------

/**
 * Normalize one host event.
 *
 * The adapter/`pi.desktop` side emits
 * `{ subscriptionId, sessionId, kind, at, payload }`; the full object is passed
 * through untouched (the phone renders from `kind`/`payload`), and only the
 * session id is lifted out for routing. An event without a session id cannot be
 * routed at all and is dropped rather than fanned out to every device.
 */
function normalizeDesktopEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (typeof event.sessionId === "string" && event.sessionId) {
    // Compatibility with a host that wraps the payload one level deeper.
    const inner = event.payload && typeof event.payload === "object" && typeof event.payload.sessionId === "string"
      ? event.payload
      : null;
    return { sessionId: event.sessionId, event: inner && inner.kind !== undefined ? inner : event };
  }
  const nested = event.payload && typeof event.payload === "object" ? event.payload : null;
  if (nested && typeof nested.sessionId === "string" && nested.sessionId) {
    return { sessionId: nested.sessionId, event: nested };
  }
  return null;
}

function onDesktopEvent(...args) {
  const payload = args.length === 1 ? args[0] : args[1] ?? args[0];
  const normalized = normalizeDesktopEvent(payload);
  if (!normalized) return;
  remote?.broadcast(normalized);
}

function onSettingsChanged() {
  settingsLoadedAt = 0;
}

function ensureWired() {
  if (wired) return;
  wired = true;
  if (typeof pi.events?.on === "function") {
    pi.events.on("desktop:event", onDesktopEvent);
    pi.events.on("plugin:settingsChanged", onSettingsChanged);
  } else {
    recordLog("warn", "host does not expose pi.events.on; live updates are unavailable");
  }
}

function unwireEvents() {
  if (!wired) return;
  wired = false;
  try {
    pi.events?.off?.("desktop:event", onDesktopEvent);
    pi.events?.off?.("plugin:settingsChanged", onSettingsChanged);
  } catch (error) {
    recordLog("warn", `event unsubscribe failed: ${error?.message ?? error}`);
  }
}

// --- server -----------------------------------------------------------------

async function ensureRemote() {
  if (remote) return remote;
  const manifest = safeManifest();
  dataDir = await resolveDataDir();
  webReady = fs.existsSync(WEB_DIR);
  remote = createRemoteServer({
    webDir: WEB_DIR,
    dataDir,
    version: pluginVersion(manifest),
    name: "lan-remote-control",
    log: (message) => recordLog("info", message),
    getAdapter: () => adapter,
    getOperationTable: () => buildOperationTable(adapterModule),
    getCapabilities,
    hooks: {
      onSubscribe: handleAdapterSubscribe,
      onUnsubscribe: handleAdapterUnsubscribe,
    },
    limits: { maxUploadBytes: DEFAULT_MAX_BYTES },
  });
  return remote;
}

async function buildStatus() {
  await refreshSettings(false);
  await refreshAppearance(false);
  const base = remote
    ? remote.getStatus()
    : {
        phase: "stopped",
        running: false,
        address: null,
        port: null,
        url: null,
        addresses: network.listLanAddresses(),
        startedAt: null,
        error: null,
        restartRequired: false,
        passwordConfigured: false,
        devices: [],
        capabilities: null,
        capabilitiesError: null,
        version: "0.0.0",
        limits: { maxUploadBytes: DEFAULT_MAX_BYTES },
      };
  return {
    ...base,
    settings,
    settingsError,
    appearance,
    web: { ready: webReady, root: "web" },
    adapter: adapter
      ? { available: true, error: null }
      : { available: false, error: adapterError ?? { code: "ADAPTER_MISSING", message: "宿主适配器不可用" } },
    log: recentLog.slice(-10),
  };
}

function errorPayload(error, fallbackCode = "INTERNAL") {
  return {
    code: error?.code ? String(error.code) : fallbackCode,
    message: String(error?.message ?? error),
  };
}

async function startFromPanel(input) {
  try {
    await ensureRemote();
    await refreshSettings(true);
    const requestedAddress =
      typeof input.address === "string" && input.address.trim() ? input.address.trim() : settings.bindAddress;
    const requestedPort = Number.isInteger(input.port) ? input.port : settings.port;
    const status = await remote.start({ address: requestedAddress, port: requestedPort });
    remote.markRestartRequired(false);
    recordLog("info", `remote service listening on ${status.address}:${status.port}`);
    return { ok: true, status: await buildStatus() };
  } catch (error) {
    recordLog("warn", `start failed: ${error?.message ?? error}`);
    return { ok: false, error: errorPayload(error), status: await buildStatus() };
  }
}

async function stopFromPanel() {
  if (!remote) return { ok: true, status: await buildStatus() };
  try {
    await remote.stop();
    return { ok: true, status: await buildStatus() };
  } catch (error) {
    recordLog("warn", `stop failed: ${error?.message ?? error}`);
    return { ok: false, error: errorPayload(error), status: await buildStatus() };
  }
}

async function linkFromPanel() {
  if (!remote) return { ok: false, error: { code: "NOT_RUNNING", message: "请先开启远程访问" } };
  const result = remote.createLink();
  return result.ok ? result : { ok: false, error: { code: result.code, message: result.message } };
}

async function refreshFromPanel() {
  await refreshSettings(true);
  await refreshAppearance(true);
  if (remote) await remote.refreshCapabilities(true);
  return { ok: true, status: await buildStatus() };
}

// --- panel channel dispatch -------------------------------------------------

async function onPanelInvoke(channel, payload) {
  const input = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  switch (channel) {
    case "remote.status":
      return { ok: true, status: await buildStatus() };
    case "remote.refresh":
      return refreshFromPanel();
    case "remote.start":
      return startFromPanel(input);
    case "remote.stop":
      return stopFromPanel();
    case "remote.link":
      return linkFromPanel();
    case "remote.indicator":
      return { running: remote?.getStatus().running === true };
    case "remote.setPassword": {
      try {
        await ensureRemote();
        await remote.setPassword(input.password);
        return { ok: true, status: await buildStatus() };
      } catch (error) { return { ok: false, error: errorPayload(error) }; }
    }
    case "remote.revoke": {
      if (!remote) return { ok: false, error: { code: "NOT_RUNNING", message: "远程服务未启动" } };
      const deviceId = typeof input.deviceId === "string" ? input.deviceId : "";
      if (!deviceId) return { ok: false, error: { code: "INVALID_PARAMS", message: "deviceId 必填" } };
      const existed = await remote.revokeDevice(deviceId);
      return { ok: true, revoked: existed, status: await buildStatus() };
    }
    case "remote.revokeAll": {
      if (!remote) return { ok: true, revoked: 0, status: await buildStatus() };
      const count = await remote.revokeAllDevices();
      return { ok: true, revoked: count, status: await buildStatus() };
    }
    default:
      return { ok: false, error: { code: "UNSUPPORTED", message: `unsupported panel channel: ${channel}` } };
  }
}

// --- commands ---------------------------------------------------------------

function actionForCommandId(id) {
  const tail = id.includes(".") ? id.slice(id.lastIndexOf(".") + 1) : id;
  switch (tail) {
    case "open":
      return "open";
    case "start":
      return "start";
    case "stop":
      return "stop";
    case "link":
      return "link";
    default:
      return null;
  }
}

async function openPanel(title) {
  try {
    await pi.ui.openPanel({ title });
  } catch (error) {
    recordLog("warn", `openPanel failed: ${error?.message ?? error}`);
  }
}

async function runCommandAction(action, title) {
  switch (action) {
    case "start": {
      const result = await startFromPanel({});
      if (!result.ok) {
        try {
          await pi.ui.showToast(`远程服务启动失败：${result.error.message}`, "error");
        } catch {
          /* ignore */
        }
      }
      await openPanel(title);
      return;
    }
    case "stop": {
      await stopFromPanel();
      return;
    }
    case "link": {
      await openPanel(title);
      return;
    }
    default:
      await openPanel(title);
  }
}

async function registerCommands(manifest) {
  const declared = Array.isArray(manifest?.contributes?.commands) ? manifest.contributes.commands : [];
  const title = panelTitle(manifest);
  const wanted = [];
  for (const command of declared) {
    if (!command || typeof command.id !== "string" || !command.id) continue;
    const action = actionForCommandId(command.id);
    if (!action) continue;
    wanted.push({ id: command.id, title: typeof command.title === "string" && command.title ? command.title : title, action });
  }
  if (!wanted.length) {
    wanted.push({ id: COMMAND_OPEN, title, action: "open" });
  }
  for (const entry of wanted) {
    try {
      await pi.commands.register({
        id: entry.id,
        title: entry.title,
        keywords: ["remote", "lan", "访问链接", "手机"],
        run: () => runCommandAction(entry.action, title),
      });
      registeredCommands.push(entry.id);
    } catch (error) {
      recordLog("warn", `command ${entry.id} registration failed: ${error?.message ?? error}`);
    }
  }
}

async function unregisterCommands() {
  const ids = registeredCommands;
  registeredCommands = [];
  for (const id of ids) {
    try {
      await pi.commands.unregister(id);
    } catch (error) {
      recordLog("warn", `command ${id} unregister failed: ${error?.message ?? error}`);
    }
  }
}

function registerService() {
  if (serviceRegistered) return;
  if (!pi.services || typeof pi.services.register !== "function") {
    recordLog("warn", "host does not expose pi.services.register");
    return;
  }
  try {
    pi.services.register({
      id: SERVICE_ID,
      start: () => {
        // Wiring only: the resident service owns teardown, never the listener.
        ensureWired();
        recordLog("info", "remote control service ready (listener starts from the panel)");
      },
      stop: async () => {
        await remote?.stop();
      },
    });
    serviceRegistered = true;
  } catch (error) {
    recordLog("warn", `service registration failed: ${error?.message ?? error}`);
  }
}

async function unregisterService() {
  if (!serviceRegistered) return;
  serviceRegistered = false;
  try {
    await pi.services.unregister(SERVICE_ID);
  } catch (error) {
    recordLog("warn", `service unregister failed: ${error?.message ?? error}`);
  }
}

// --- lifecycle --------------------------------------------------------------

async function onLoad() {
  const manifest = safeManifest();
  await refreshSettings(true);
  adapter = loadAdapter();
  await ensureRemote();
  ensureWired();
  registerService();
  await registerCommands(manifest);
  recordLog("info", "lan-remote-control loaded");
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    unwireEvents();
    const server = remote;
    remote = null;
    if (server) {
      try {
        await server.stop();
      } catch (error) {
        recordLog("warn", `server stop failed: ${error?.message ?? error}`);
      }
    }
    adapter = null;
    adapterModule = null;
  } finally {
    shuttingDown = false;
  }
}

async function onUnload() {
  await shutdown();
  await unregisterCommands();
  await unregisterService();
  recordLog("info", "lan-remote-control unloaded");
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  PANEL_CHANNELS,
  SERVICE_ID,
  COMMAND_OPEN,
};
