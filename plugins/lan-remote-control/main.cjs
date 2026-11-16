"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRemoteServer } = require("./server.cjs");
const network = require("./server/network.cjs");
const { createBrowseBridge } = require("./browse-bridge.cjs");

const SERVICE_ID = "lan-remote-control";
const COMMAND_OPEN = "lan-remote-control.open";
const PANEL_CHANNELS = Object.freeze([
  "remote.status", "remote.refresh", "remote.start", "remote.stop",
  "remote.link", "remote.indicator", "remote.setPassword",
  "remote.revoke", "remote.revokeAll", "remote.setConnectorSettings",
]);
const browse = createBrowseBridge();
const localOperations = {
  "browse.status": () => browse.status(),
  "browse.ensureRelay": () => browse.ensureRelay(),
  "browse.mintPairingCode": () => browse.mintPairingCode(),
};
let settings = { port: 7878, bindAddress: "", extensionIds: [], autoStart: false };
let unsaved = {};
let settingsError = null;
let initializationError = null;
let lastError = null;
let remote = null;
let initializing = null;
let subscriptionId = null;
let rendererRoot = null;
let active = false;
let epoch = 0;
let retryTimer = null;
let livenessTimer = null;
let retryCount = 0;
let lifecycle = Promise.resolve();
let serviceRegistered = false;
let commandRegistered = false;

const failure = (error) => ({ code: String(error?.code || "INTERNAL"), message: String(error?.message || error) });
const fail = (code, message) => Object.assign(new Error(message), { code });
const serial = (operation) => {
  const result = lifecycle.then(operation);
  lifecycle = result.catch(() => undefined);
  return result;
};
const clearRetry = () => {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
};

function normalize(raw) {
  const port = Number(raw.port ?? 7878);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail("INVALID_PARAMS", "端口须为 1～65535 的整数");
  const bindAddress = typeof raw.bindAddress === "string" ? raw.bindAddress.trim() : "";
  if (bindAddress && !network.isAllowedBindAddress(bindAddress)) throw fail("INVALID_PARAMS", "监听地址须为本机私网或回环 IPv4 地址");
  return {
    port, bindAddress, autoStart: raw.autoStart === true,
    extensionIds: Array.isArray(raw.extensionIds) ? [...new Set(raw.extensionIds.filter((id) => typeof id === "string" && /^[a-p]{32}$/.test(id)))] : [],
  };
}

async function readSettings() {
  settings = normalize({ ...await pi.plugin.getSettings(), ...unsaved });
}

async function persist(partial) {
  settings = { ...settings, ...partial };
  unsaved = { ...unsaved, ...partial };
  try {
    await pi.plugin.setSettings(unsaved);
    unsaved = {};
    settingsError = null;
  } catch (error) {
    settingsError = `设置尚未保存：${error?.message || error}`;
    throw fail("SETTINGS_NOT_PERSISTED", settingsError);
  }
}

async function ensureRemote() {
  if (remote) return remote;
  if (initializing) return initializing;
  initializing = (async () => {
    for (const name of ["getRendererRoot", "invokeIpc", "subscribeIpc", "unsubscribeIpc", "importUploadedFiles", "readRendererResource"]) {
      if (typeof pi.desktop?.[name] !== "function") throw fail("UNSUPPORTED", `当前宿主缺少 Renderer 转换能力：${name}`);
    }
    const root = await pi.desktop.getRendererRoot();
    if (typeof root !== "string" || !path.isAbsolute(root) || !fs.existsSync(path.join(root, "index.html"))) {
      throw fail("RENDERER_UNAVAILABLE", "当前安装的 Renderer 不可用，请先构建或更新主程序");
    }
    rendererRoot = root;
    const dataDir = await pi.plugin.getDataPath();
    if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) throw fail("DATA_DIR_UNAVAILABLE", "宿主没有返回插件数据目录");
    remote = createRemoteServer({
      rendererDir: rendererRoot, dataDir,
      projectionDir: path.join(__dirname, "adapter"),
      version: pi.plugin.getManifest().version,
      name: "lan-remote-control",
      getExtensionIds: () => settings.extensionIds,
      ipcInvoke: (channel, args) => pi.desktop.invokeIpc(channel, args),
      rendererUpload: (input) => pi.desktop.importUploadedFiles(input),
      rendererResource: (url) => pi.desktop.readRendererResource(url),
      localOperations,
    });
    initializationError = null;
    return remote;
  })();
  try { return await initializing; }
  catch (error) { initializationError = failure(error); throw error; }
  finally { initializing = null; }
}

async function subscribe() {
  if (subscriptionId) return;
  const result = await pi.desktop.subscribeIpc();
  if (!result?.subscriptionId) throw fail("UNSUPPORTED", "宿主未建立 Renderer 事件订阅");
  subscriptionId = result.subscriptionId;
}

async function unsubscribe() {
  if (!subscriptionId) return;
  await pi.desktop.unsubscribeIpc(subscriptionId);
  subscriptionId = null;
}

async function stopListener() {
  try { await remote?.stop(); }
  finally { await unsubscribe(); }
}

function scheduleRetry() {
  clearRetry();
  if (!active || !settings.autoStart) return;
  const delay = Math.min(3000 * 2 ** Math.min(retryCount++, 5), 60000);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void serial(() => restore()).catch(() => undefined);
  }, delay);
  retryTimer.unref?.();
}

async function restore() {
  if (!active || !settings.autoStart) return;
  const requestedEpoch = epoch;
  try {
    if (Object.keys(unsaved).length) await persist(unsaved);
    const server = await ensureRemote();
    if (!active || !settings.autoStart || requestedEpoch !== epoch) return;
    await subscribe();
    if (!active || !settings.autoStart || requestedEpoch !== epoch) { await unsubscribe(); return; }
    if (!server.getStatus().running) await server.start({ address: settings.bindAddress, port: settings.port });
    if (!active || !settings.autoStart || requestedEpoch !== epoch) { await stopListener(); return; }
    lastError = null;
    retryCount = 0;
    clearRetry();
  } catch (error) {
    lastError = failure(error);
    if (!remote?.getStatus().running) {
      try { await unsubscribe(); } catch (cleanupError) { lastError = failure(cleanupError); }
    }
    scheduleRetry();
    throw error;
  }
}

function status() {
  const base = remote?.getStatus() ?? {
    phase: "stopped", running: false, links: [], devices: [],
    passwordConfigured: false, addresses: network.listenerAddresses(),
  };
  return {
    ...base, settings: { ...settings }, settingsError,
    autoStart: { enabled: settings.autoStart, persisted: Object.keys(unsaved).length === 0, pending: retryTimer !== null },
    renderer: { ready: rendererRoot !== null },
    error: lastError || initializationError || base.error || null,
  };
}

async function start(input) {
  const requestedEpoch = epoch;
  return serial(async () => {
    if (!active || requestedEpoch !== epoch) throw fail("CANCELED", "开启请求已取消");
    const requested = normalize({ ...settings, port: input.port ?? settings.port, autoStart: true });
    settings = requested;
    try { await persist({ port: settings.port, autoStart: true }); }
    catch (error) { lastError = failure(error); scheduleRetry(); throw error; }
    if (!active || requestedEpoch !== epoch) throw fail("CANCELED", "开启请求已取消");
    if (remote?.getStatus().running && (remote.getStatus().port !== settings.port || remote.getStatus().restartRequired)) await remote.stop();
    await restore();
    return { ok: true, status: status() };
  });
}

function stop() {
  epoch++;
  settings.autoStart = false;
  clearRetry();
  return serial(async () => {
    let writeError;
    try { await persist({ autoStart: false }); } catch (error) { writeError = error; }
    await stopListener();
    lastError = writeError ? failure(writeError) : null;
    retryCount = 0;
    if (writeError) throw writeError;
    return { ok: true, status: status() };
  });
}

async function onPanelInvoke(channel, payload) {
  const input = payload && typeof payload === "object" ? payload : {};
  try {
    switch (channel) {
      case "remote.status":
      case "remote.refresh":
        return { ok: true, status: status() };
      case "remote.indicator": return { running: remote?.getStatus().running === true };
      case "remote.start": return await start(input);
      case "remote.stop": return await stop();
      case "remote.link": return remote ? remote.createLink() : { ok: false, error: { code: "NOT_RUNNING", message: "请先开启访问" } };
      case "remote.setPassword":
        return await serial(async () => {
          const server = await ensureRemote();
          await server.setPassword(input.password);
          if (active && settings.autoStart && !server.getStatus().running) scheduleRetry();
          return { ok: true, status: status() };
        });
      case "remote.revoke":
        return await serial(async () => {
          if (typeof input.deviceId !== "string" || !input.deviceId) throw fail("INVALID_PARAMS", "缺少设备 ID");
          await (await ensureRemote()).revokeDevice(input.deviceId);
          return { ok: true, status: status() };
        });
      case "remote.revokeAll":
        return await serial(async () => {
          await (await ensureRemote()).revokeAllDevices();
          return { ok: true, status: status() };
        });
      case "remote.setConnectorSettings":
        return await serial(async () => {
          if (!Array.isArray(input.extensionIds) || input.extensionIds.some((id) => typeof id !== "string" || !/^[a-p]{32}$/.test(id))) throw fail("INVALID_PARAMS", "扩展 ID 须为 32 位 a-p 小写字母");
          await persist({ extensionIds: [...new Set(input.extensionIds)] });
          return { ok: true, status: status() };
        });
      default: throw fail("UNSUPPORTED", `不支持的设置操作：${channel}`);
    }
  } catch (error) {
    return { ok: false, error: failure(error), status: status() };
  }
}

function onIpcEvent(event) { remote?.broadcastIpc(event); }
function onSettingsChanged() {
  void serial(async () => {
    try {
      const previous = settings;
      await readSettings();
      if (!settings.autoStart) { clearRetry(); await stopListener(); }
      else if (active) {
        if (remote?.getStatus().running && (previous.port !== settings.port || remote.getStatus().port !== settings.port)) await remote.stop();
        await restore();
      }
    } catch (error) { lastError = failure(error); }
  });
}

function startLiveness() {
  if (livenessTimer) return;
  livenessTimer = setInterval(() => {
    void serial(async () => {
      if (!active) return;
      try {
        if (Object.keys(unsaved).length) await persist(unsaved);
        if (settings.autoStart && !retryTimer) {
          if (remote?.getStatus().restartRequired) await remote.stop();
          if (!remote?.getStatus().running) await restore();
        } else if (!settings.autoStart) await unsubscribe();
      } catch (error) { lastError = failure(error); }
    });
  }, 30000);
  livenessTimer.unref?.();
}

async function suspend() {
  active = false;
  epoch++;
  clearRetry();
  if (livenessTimer) clearInterval(livenessTimer);
  livenessTimer = null;
  return serial(async () => {
    try { await stopListener(); }
    finally { await browse.stop(); }
  });
}

async function onLoad() {
  active = true;
  try { await readSettings(); } catch (error) { settingsError = failure(error).message; }
  try { await ensureRemote(); } catch { /* 设置页显示初始化失败的原因。 */ }
  pi.events.on("desktop:ipc-event", onIpcEvent);
  pi.events.on("plugin:settingsChanged", onSettingsChanged);
  browse.open();
  await pi.commands.register({ id: COMMAND_OPEN, title: "局域网远控 V2", run: () => pi.ui.openPanel({ title: "局域网远控 V2" }) });
  commandRegistered = true;
  pi.services.register({
    id: SERVICE_ID,
    start: () => {
      const wasActive = active;
      active = true;
      browse.open();
      startLiveness();
      if (!wasActive && settings.autoStart) void serial(() => restore()).catch(() => undefined);
    },
    stop: suspend,
  });
  serviceRegistered = true;
  startLiveness();
  if (settings.autoStart) void serial(() => restore()).catch(() => undefined);
}

async function onUnload() {
  await suspend();
  pi.events.off("desktop:ipc-event", onIpcEvent);
  pi.events.off("plugin:settingsChanged", onSettingsChanged);
  if (commandRegistered) { await pi.commands.unregister(COMMAND_OPEN); commandRegistered = false; }
  if (serviceRegistered) { await pi.services.unregister(SERVICE_ID); serviceRegistered = false; }
  remote = null;
  rendererRoot = null;
}

module.exports = { onLoad, onUnload, onPanelInvoke, PANEL_CHANNELS, SERVICE_ID, COMMAND_OPEN };
