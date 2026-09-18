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
 *      network server's lifecycle; the listener never starts on its own — only
 *      an explicit panel action or the persisted auto-start intent starts it;
 *   3. the host adapter (`host-adapter.cjs`) through
 *      a single narrow interface: capabilities() / invoke() / subscribe() /
 *      unsubscribe();
 *   4. host `desktop:event` events, filtered per session by device subscription
 *      and with one adapter subscribe per session (reference counted in the
 *      server).
 *
 * No listener is created until the user starts the service from the panel or the
 * persisted auto-start intent (set by an earlier "开启" and cleared only by an
 * explicit "关闭"/stop command) brings it up. Stopping leaves nothing behind: no
 * socket or staged file; the scrypt password hash and the device records stay in
 * plugin data, and no credential is ever stored in clear text.
 */

const fs = require("node:fs");
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
  /** 用户意图：主程序重开后是否自动恢复监听；只有显式“关闭”会清除。 */
  autoStart: false,
});
const SETTINGS_CACHE_MS = 5000;
const APPEARANCE_CACHE_MS = 15_000;
const LOG_RING_SIZE = 50;
const MAX_LOG_MESSAGE_LENGTH = 400;
/**
 * 自动开启失败的持续恢复策略：网络/端口这类可恢复故障按指数退避一直重试
 * （封顶 60 秒，永不退化成 0 或 Infinity）；缺密码、权限、配置这类重试解决不了
 * 的问题改为低频复查，开启意图始终保留。
 */
const AUTO_START_RETRY_BASE_MS = 3_000;
const AUTO_START_RETRY_MAX_MS = 60_000;
/** 指数上限：3→6→12→24→48→60 秒封顶，避免 2**n 溢出成 Infinity 后又变 0。 */
const AUTO_START_RETRY_MAX_EXPONENT = 5;
/** 缺密码/权限/依赖等问题的复查间隔。 */
const AUTO_START_RECHECK_MS = 5 * 60_000;
/** 存活检查间隔：只用于发现“监听意外停了”，不参与重试节奏。 */
const AUTO_START_LIVENESS_MS = 30_000;
/** 靠重试解决不了的失败原因：走低频复查，不空转。 */
const AUTO_START_SLOW_CODES = Object.freeze([
  "PASSWORD_REQUIRED",
  "INVALID_PARAMS",
  "PERMISSION_DENIED",
  "DEPENDENCY_MISSING",
  "UNSUPPORTED",
]);

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
let dataDirError = null;
let remoteError = null;
let settingsWriteError = null;
/** 写盘未成功的设置（键 → 值），下次存活检查或设置变化时补写。 */
let unsavedSettings = null;
/**
 * 运行时开关状态。`enabled` 是用户意图，只在“开启/关闭”面板操作和插件加载时
 * 从持久设置同步；`settings` 刷新、服务停止、应用退出都不会改动它。
 * `persisted` 表示当前意图是否确实已经写进插件设置（写盘失败时保持 false）。
 */
const autoStart = {
  enabled: false,
  persisted: false,
  attempts: 0,
  slowCheck: false,
  timer: null,
  nextAttemptAt: null,
  lastError: null,
  inFlight: false,
};
let settings = { ...DEFAULT_SETTINGS };
let settingsError = null;
let settingsLoadedAt = 0;
let appearance = null;
let appearanceLoadedAt = 0;
let wired = false;
let registeredCommands = [];
let serviceRegistered = false;
let shuttingDown = false;
/**
 * 生命周期串行化：面板开启/关闭、重试、宿主停服务和卸载依次执行，保证“最后
 * 一次用户操作”决定最终状态，晚到的开启不会覆盖关闭。
 */
let lifecycle = Promise.resolve();
let lifecycleEpoch = 0;
/** onUnload 之后为 true：禁止再排期任何自动开启（onLoad 会复位）。 */
let unloaded = false;
let livenessTimer = null;
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

  let autoStartIntent = DEFAULT_SETTINGS.autoStart;
  if (source.autoStart !== undefined) {
    if (typeof source.autoStart === "boolean") {
      autoStartIntent = source.autoStart;
    } else {
      errors.push("autoStart 必须是布尔值，已按关闭处理");
    }
  }

  return {
    settings: { bindAddress, port, autoStart: autoStartIntent },
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
  const normalized = normalizeSettings({ ...raw, ...(unsavedSettings ?? {}) });
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

/**
 * 把用户自己的选择写回插件设置：最后使用的地址/端口与开启意图。
 *
 * 先更新内存再落盘，因此本次运行始终按用户当前的决定执行；写盘失败时把待写入
 * 的键记进 `unsavedSettings` 并通过 `settingsWriteError` 暴露，绝不谎报“已保存”，
 * 之后由存活检查/设置变化补写。写盘不会强制下一次设置刷新重读文件，避免把本次
 * 尚未保存的选择覆盖掉（外部改动用 plugin:settingsChanged 事件显式触发重读）。
 */
async function persistSettings(partial) {
  settings = { ...settings, ...partial };
  const desired = { ...(unsavedSettings ?? {}), ...partial };
  unsavedSettings = desired;
  try {
    if (typeof pi.plugin.setSettings !== "function") {
      throw Object.assign(new Error("当前宿主不支持保存插件设置"), { code: "UNSUPPORTED" });
    }
    await pi.plugin.setSettings(partial);
  } catch (error) {
    autoStart.persisted = false;
    settingsWriteError = `设置未能保存：${error?.message ?? error}（本次选择仅在本次运行内生效）`;
    recordLog("warn", settingsWriteError);
    return false;
  }
  // 本次写成功的键按值确认后移出待写集合，其余（此前失败的）留待下次补写。
  for (const key of Object.keys(partial)) if (desired[key] === partial[key]) delete desired[key];
  unsavedSettings = Object.keys(desired).length ? desired : null;
  settingsWriteError = unsavedSettings ? "仍有设置未能保存，将自动重试" : null;
  autoStart.persisted = !unsavedSettings;
  return autoStart.persisted;
}

/** 补写此前没保存成功的设置；只在确实有积压时才动。 */
async function retryUnsavedSettings() {
  if (!unsavedSettings || shuttingDown || unloaded) return;
  await persistSettings(unsavedSettings);
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

/**
 * 插件数据目录。凭据（密码哈希、设备令牌）与设置都放在宿主返回的插件数据目录
 * 里，升级/重装后路径稳定，因此只认这个目录。
 *
 * 读不到时返回 null 并记录原因：绝不回退到临时目录或带路径哈希的新目录——那会
 * 让用户升级后“凭据消失”，等于静默换了存储。调用方据此明确报错并保留原有数据。
 */
async function resolveDataDir() {
  try {
    const dir = await pi.plugin.getDataPath();
    if (typeof dir === "string" && dir.trim()) {
      dataDirError = null;
      return dir.trim();
    }
    dataDirError = "宿主没有返回插件数据目录";
  } catch (error) {
    dataDirError = `读取插件数据目录失败：${error?.message ?? error}`;
  }
  recordLog("warn", `${dataDirError}；为避免凭据写入临时目录，已停止启动远程服务`);
  return null;
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
  // 外部改了设置：先把没保存成功的选择补写回去，再按（可能已修正的）设置复查一次。
  void serializeLifecycle(async () => {
    if (shuttingDown || unloaded) return;
    await retryUnsavedSettings();
    if (!autoStart.enabled || remote?.getStatus().running || autoStart.inFlight) return;
    if (autoStart.timer && !autoStart.slowCheck) return;
    scheduleAutoStart(AUTO_START_RETRY_BASE_MS);
  });
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

/**
 * 建立服务实例。数据目录读不到或认证文件损坏时只记录错误并返回 null：面板仍能
 * 打开看到原因，已保存的密码哈希与设备文件既不覆盖也不重置，也不会改用别的目录。
 */
let remoteInitialization = null;
async function ensureRemote() {
  if (remote) return remote;
  if (!remoteInitialization) remoteInitialization = initializeRemote();
  const pending = remoteInitialization;
  try { return await pending; }
  finally { if (remoteInitialization === pending) remoteInitialization = null; }
}
async function initializeRemote() {
  if (remote) return remote;
  const manifest = safeManifest();
  dataDir = await resolveDataDir();
  if (!dataDir) {
    remoteError = { code: "DATA_DIR_UNAVAILABLE", message: dataDirError ?? "无法确定插件数据目录" };
    return null;
  }
  webReady = fs.existsSync(WEB_DIR);
  try {
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
  } catch (error) {
    remoteError = errorPayload(error);
    recordLog("warn", `remote server init failed: ${remoteError.code} ${remoteError.message}`);
    return null;
  }
  remoteError = null;
  return remote;
}

/** 初始化失败时的统一错误：调用方拿到的必须是可读原因，不是 TypeError。 */
function missingRemoteError() {
  const error = new Error(remoteError?.message ?? "远程服务初始化失败");
  error.code = remoteError?.code ?? "INTERNAL";
  return error;
}

/**
 * 只做监听，不改动开关意图。返回实际使用的服务实例，便于调用方在“开启期间用户
 * 又关掉/插件卸载”时把刚起来的监听按同一个实例关掉，而不是依赖模块变量。
 */
async function startListener({ address, port }) {
  const instance = await ensureRemote();
  if (!instance) throw missingRemoteError();
  const status = await instance.start({ address, port });
  instance.markRestartRequired(false);
  return { instance, status };
}

// --- auto start -------------------------------------------------------------

/** 取消失败重试。用户手动关闭、卸载或重试前都调用它。 */
function clearAutoStartTimer() {
  if (autoStart.timer) {
    clearTimeout(autoStart.timer);
    autoStart.timer = null;
  }
  autoStart.nextAttemptAt = null;
}

/**
 * 设定开关意图。只有显式“开启/关闭”（含同名命令）和插件加载时的持久设置会
 * 调用它；服务停止、宿主生命周期、设置刷新都不算用户手动关闭。
 */
function setAutoStartIntent(enabled) {
  const next = enabled === true;
  if (next === autoStart.enabled) return;
  autoStart.enabled = next;
  clearAutoStartTimer();
  autoStart.attempts = 0;
  autoStart.lastError = null;
  autoStart.slowCheck = false;
}

/**
 * 面板可见的开关状态。服务已在运行时一律报告“没有在重试”，避免成功的运行还挂着
 * 上一次失败的 pending/原因。`persisted` 为 false 表示意图没能写进设置。
 */
function autoStartStatus() {
  const running = remote?.getStatus().running === true;
  return {
    enabled: autoStart.enabled,
    persisted: autoStart.persisted,
    running,
    pending: !running && (autoStart.timer !== null || autoStart.inFlight),
    slowCheck: !running && autoStart.slowCheck,
    attempts: autoStart.attempts,
    nextAttemptAt: !running && autoStart.nextAttemptAt ? new Date(autoStart.nextAttemptAt).toISOString() : null,
    lastError: running ? null : autoStart.lastError,
  };
}

/** 退避毫秒数：指数封顶，任何非有限值都退回上限，绝不退化成 0 造成紧密重试。 */
function autoStartRetryDelay(attempts) {
  const exponent = Math.max(0, Math.min(attempts - 1, AUTO_START_RETRY_MAX_EXPONENT));
  const delay = AUTO_START_RETRY_BASE_MS * 2 ** exponent;
  return Number.isFinite(delay) ? Math.min(delay, AUTO_START_RETRY_MAX_MS) : AUTO_START_RETRY_MAX_MS;
}

/** 排期一次自动开启；意图关闭、正在卸载或已卸载后不再排期。 */
function scheduleAutoStart(delayMs, slow = false) {
  if (!autoStart.enabled || shuttingDown || unloaded) return;
  clearAutoStartTimer();
  const upperBound = slow ? AUTO_START_RECHECK_MS : AUTO_START_RETRY_MAX_MS;
  const wait = Number.isFinite(delayMs)
    ? Math.max(0, Math.min(delayMs, upperBound))
    : upperBound;
  autoStart.slowCheck = slow === true;
  autoStart.nextAttemptAt = Date.now() + wait;
  const timer = setTimeout(() => {
    autoStart.timer = null;
    autoStart.nextAttemptAt = null;
    void attemptAutoStart(slow ? "slow-recheck" : "retry");
  }, wait);
  timer.unref?.();
  autoStart.timer = timer;
}

/** 串行化生命周期动作，保证“最后一次用户操作”决定最终监听状态。 */
function serializeLifecycle(operation) {
  const task = lifecycle.then(operation);
  lifecycle = task.catch(() => undefined);
  return task;
}

function autoStartCancelled(epoch) {
  return epoch !== lifecycleEpoch || !autoStart.enabled || shuttingDown || unloaded;
}

/**
 * 一次开启尝试（内部实现，调用方负责串行化）。走的是和面板“开启”完全相同的
 * 路径：地址/端口仍取自设置并交给服务端校验，权限、绑定地址与密码校验一个都不
 * 跳过。返回 null 表示已开启/无需开启/已被取消，否则返回错误负载供面板回显。
 */
async function runStartAttempt(reason) {
  clearAutoStartTimer();
  if (!autoStart.enabled || shuttingDown || unloaded || autoStart.inFlight) return null;
  if (remote?.getStatus().running) {
    autoStart.attempts = 0;
    autoStart.lastError = null;
    autoStart.slowCheck = false;
    return null;
  }
  const epoch = lifecycleEpoch;
  autoStart.inFlight = true;
  try {
    await refreshSettings(true);
    await retryUnsavedSettings();
    if (autoStartCancelled(epoch)) return null;
    const { instance, status } = await startListener({ address: settings.bindAddress, port: settings.port });
    if (autoStartCancelled(epoch)) {
      // 监听期间用户点了“关闭”、宿主停了服务或插件正在卸载：立刻按同一实例关掉，
      // 不许这次晚到的开启把关闭覆盖掉。
      recordLog("warn", `开启期间收到关闭请求，已立即停止监听（${reason}）`);
      try {
        await instance.stop();
      } catch (error) {
        recordLog("warn", `stop after cancelled start failed: ${error?.message ?? error}`);
      }
      return null;
    }
    autoStart.attempts = 0;
    autoStart.lastError = null;
    autoStart.slowCheck = false;
    recordLog("info", `远程服务已开启（${reason}）：${status.address}:${status.port}`);
    return null;
  } catch (error) {
    const payload = errorPayload(error);
    autoStart.attempts += 1;
    autoStart.lastError = payload;
    const slow = AUTO_START_SLOW_CODES.includes(payload.code);
    const delay = slow ? AUTO_START_RECHECK_MS : autoStartRetryDelay(autoStart.attempts);
    recordLog("warn", `开启失败（第 ${autoStart.attempts} 次，${reason}）：${payload.code} ${payload.message}；${slow ? "等待低频复查" : `${Math.round(delay / 1000)} 秒后重试`}`);
    if (autoStart.enabled && !shuttingDown && !unloaded) scheduleAutoStart(delay, slow);
    return payload;
  } finally {
    autoStart.inFlight = false;
  }
}

/** 自动开启入口：与面板开启/关闭串行，避免晚到的尝试覆盖用户的最后意图。 */
function attemptAutoStart(reason) {
  return serializeLifecycle(() => runStartAttempt(reason));
}

// --- liveness ----------------------------------------------------------------

function stopLivenessWatch() {
  if (!livenessTimer) return;
  clearInterval(livenessTimer);
  livenessTimer = null;
}

/**
 * 低频存活检查：只在“意图开启、未卸载、确实有服务实例、当前没在运行、也没有已
 * 排期的重试”时动手，用于发现监听被意外停掉（见服务端的 LISTENER_CLOSED）并
 * 按意图恢复。它不参与重试节奏，成功运行时什么都不做。
 */
function livenessCheck() {
  if (shuttingDown || unloaded) return;
  void serializeLifecycle(async () => {
    if (shuttingDown || unloaded) return;
    // 关闭及正常运行时同样补写，避免重启读回旧的开关状态。
    await retryUnsavedSettings();
    if (!autoStart.enabled || autoStart.inFlight || autoStart.timer) return;
    if (remote?.getStatus().running) return;
    autoStart.attempts = 0;
    recordLog("warn", "检测到监听已停止，按开启意图自动恢复");
    await runStartAttempt("存活检查");
  });
}

function startLivenessWatch() {
  if (livenessTimer) return;
  livenessTimer = setInterval(livenessCheck, AUTO_START_LIVENESS_MS);
  livenessTimer.unref?.();
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
        error: remoteError ?? null,
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
    settingsWriteError,
    autoStart: autoStartStatus(),
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

/**
 * 面板“开启”。除了立刻监听，还要把地址/端口和开启意图写进插件设置：这样
 * 主程序重开后会自动恢复，直到用户显式“关闭”。启动失败不撤销意图，交由退避
 * 重试持续恢复；设置没写成功时如实回报 warning，不谎报“已记住”。
 */
function startFromPanel(input) {
  const requestedEpoch = lifecycleEpoch;
  // 与自动重试、关闭、卸载串行：用户最后一次操作决定最终监听状态。
  return serializeLifecycle(async () => {
    try {
      await refreshSettings(true);
      if (requestedEpoch !== lifecycleEpoch || shuttingDown || unloaded) {
        return { ok: false, error: { code: "NOT_READY", message: "开启请求已取消" }, status: await buildStatus() };
      }
      // 面板显式传空串表示“自动选择本机私网地址”，与持久设置里的空值同义。
      const requestedAddress = typeof input.address === "string" ? input.address.trim() : settings.bindAddress;
      if (requestedAddress && !network.isAllowedBindAddress(requestedAddress)) {
        throw Object.assign(new Error("监听地址必须是本机私网或回环 IPv4 地址"), { code: "INVALID_PARAMS" });
      }
      let requestedPort = settings.port;
      if (input.port !== undefined && input.port !== null) {
        const parsed = Number(input.port);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
          throw Object.assign(new Error("端口必须是 1..65535 的整数"), { code: "INVALID_PARAMS" });
        }
        requestedPort = parsed;
      }
      // 手动开启是一次新的用户决定：重置失败计数，让退避从最小间隔重新开始。
      setAutoStartIntent(true);
      autoStart.attempts = 0;
      autoStart.lastError = null;
      autoStart.persisted = await persistSettings({ bindAddress: requestedAddress, port: requestedPort, autoStart: true });
      const failure = await runStartAttempt("面板开启");
      const status = await buildStatus();
      if (failure) {
        recordLog("warn", `start failed: ${failure.code} ${failure.message}`);
        return { ok: false, error: failure, status };
      }
      return autoStart.persisted ? { ok: true, status } : { ok: true, warning: persistenceWarning(), status };
    } catch (error) {
      recordLog("warn", `start rejected: ${error?.message ?? error}`);
      return { ok: false, error: errorPayload(error, "INVALID_PARAMS"), status: await buildStatus() };
    }
  });
}

/** 写盘失败时的如实回报：调用方要用它告诉用户“这次只是运行期生效”。 */
function persistenceWarning() {
  return { code: "SETTINGS_NOT_PERSISTED", message: settingsWriteError ?? "开启状态未能写入插件设置" };
}

/**
 * 面板“关闭”，也是唯一清除开启意图的地方：应用退出、插件停用和宿主停止服务
 * 都直接调用服务层，不走这里。意图与在途开启请求立刻作废（epoch 自增），随后
 * 串行地写盘并停监听，保证关闭一定是最后生效的那个动作。
 */
function stopFromPanel() {
  lifecycleEpoch += 1;
  setAutoStartIntent(false);
  return serializeLifecycle(async () => {
    setAutoStartIntent(false);
    clearAutoStartTimer();
    autoStart.persisted = await persistSettings({ autoStart: false });
    if (!remote) {
      const status = await buildStatus();
      return autoStart.persisted ? { ok: true, status } : { ok: true, warning: persistenceWarning(), status };
    }
    try {
      await remote.stop();
      const status = await buildStatus();
      return autoStart.persisted ? { ok: true, status } : { ok: true, warning: persistenceWarning(), status };
    } catch (error) {
      recordLog("warn", `stop failed: ${error?.message ?? error}`);
      return { ok: false, error: errorPayload(error), status: await buildStatus() };
    }
  });
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
        const instance = await ensureRemote();
        if (!instance) throw missingRemoteError();
        await instance.setPassword(input.password);
        // 之前因缺少密码而没开启时，补上密码后按用户既有意图立刻重试一次
        // （缺密码属于低频复查类失败，这里不必再等复查间隔）。
        if (autoStart.enabled && !remote?.getStatus().running) {
          autoStart.attempts = 0;
          scheduleAutoStart(AUTO_START_RETRY_BASE_MS);
        }
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
        startLivenessWatch();
        if (autoStart.enabled && !remote?.getStatus().running) scheduleAutoStart(0);
        recordLog("info", "remote control service ready (listener starts from the panel or the persisted intent)");
      },
      stop: async () => {
        // 宿主生命周期（退出应用、停用插件、停服务）不是用户手动关闭：只断监听，
        // 保留 autoStart 意图。epoch 自增 + 串行化保证在途的开启请求不会在停服务
        // 之后又把监听拉起来。
        lifecycleEpoch += 1;
        clearAutoStartTimer();
        stopLivenessWatch();
        return serializeLifecycle(async () => {
          try {
            await remote?.stop();
          } catch (error) {
            recordLog("warn", `service stop failed: ${error?.message ?? error}`);
          }
        });
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
  // 允许自动开启（重新加载/宿主重启插件后复用同一模块实例的情况）。
  unloaded = false;
  await refreshSettings(true);
  // 意图来自上次显式“开启”：主程序重开后恢复监听，直到用户手动关闭。
  setAutoStartIntent(settings.autoStart === true);
  autoStart.persisted = true;
  adapter = loadAdapter();
  await ensureRemote();
  ensureWired();
  registerService();
  await registerCommands(manifest);
  startLivenessWatch();
  if (autoStart.enabled) {
    recordLog("info", "检测到开启意图，准备自动恢复远程访问");
    scheduleAutoStart(0);
  }
  recordLog("info", "lan-remote-control loaded");
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // 卸载不是用户手动关闭：只停监听、定时器；autoStart 意图保持不变，下次加载
  // 仍按意图自动开启。unloaded 阻止卸载后再排期，epoch 让在途开启请求作废。
  unloaded = true;
  lifecycleEpoch += 1;
  clearAutoStartTimer();
  stopLivenessWatch();
  return serializeLifecycle(async () => {
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
  });
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
