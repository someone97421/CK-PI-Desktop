import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
} from "electron";
import { join } from "node:path";
import { configureApplicationIdentity } from "./application-identity";
import { readConfiguredDataDirectory } from "./data-directory";
import { SubagentSnapshotStore } from "./runtime/subagent-snapshot-store";
import { createSubagentSessionAuthority } from "./runtime/subagent-session-authority";
import {
  applyNetworkProxyFromAppSettings,
  currentNetworkProxy,
  disposeSystemProxyRelay,
  ensureSystemProxyRelay,
  testNetworkProxy,
} from "./network-proxy";
import { installInsecureEndpointNotice } from "./network-notice";
import {
  APP_ID,
  APP_VERSION,
  IPC,
  IPC_WHITELIST,
  isActiveInProject,
  type ActivationScope,
  type AgentEventEnvelope,
  type CloseBehavior,
  type KeybindingOverrides,
  type PlanExecutionFinishStatus,
} from "@pi-desktop/shared";
import { AgentExtensionBridge } from "./agent-extensions";
import {
  knownProjectGroups,
  pluginWorkspaceInfo,
  refreshProjectGroups,
} from "./workspace-roots";
import { PersistenceOutbox } from "./persistence-outbox";
import { QueuedSteeringReceipts, createQueuedSteeringJournal } from "./queued-steering-receipts";
import { Logger, ignoreBrokenStdio } from "./logger";
import { describeError, installMainProcessErrorHandlers } from "./main-process-errors";
import {
  ModelsDevCatalog,
  catalogModelConfigFor,
} from "./models-dev-catalog";
import { VendorOAuth } from "./oauth";
import { AppUpdaterController } from "./updater";
import {
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,
  type WorkPanelReservationState,
} from "./work-panel-window";
import { InflightCheckpointer } from "@pi-desktop/host-runtime";
import { withGitBranch } from "./workspace-git";
import { createPlanUiProbe } from "./plan-ui-probe";
import { registerIpcHandlers } from "./ipc/register";
import { MainProcessState } from "./bootstrap/main-state";
import { registerApplicationActivation } from "./bootstrap/app-activation";
import {
  createTemporaryWorkspaceRuntime,
  initialTemporaryWorkspaceCommandLine,
} from "./temporary-workspace";
import { createHostRuntime } from "./runtime/host";
import { createSidecarRuntime } from "./runtime/sidecar";
import { createEventPersistence } from "./runtime/event-persistence";
import { createPlanRuntime } from "./runtime/plans";
import { createRuntimeLifecycle } from "./runtime/lifecycle";
import {
  createProviderCatalogRuntime,
} from "./runtime/provider-catalog";
import { createSessionLaunchRuntime } from "./runtime/session-launch";
import { createSessionConfigurationQueue } from "./runtime/session-configuration";
import { createSessionCoordination } from "./runtime/session-coordination";
import { createScheduledRuntime } from "./runtime/scheduled";
import { createDesktopServices } from "./services/desktop-services";
import { createPluginServices } from "./services/plugin-services";
import { wirePluginThemeRuntimeServices } from "./plugin-theme-services";
import { createSessionCollaborationService } from "./services/session-collaboration";
import {
  createApplicationLifecycle,
} from "./bootstrap/app-lifecycle";
import { registerApplicationStartup } from "./bootstrap/startup";
import { createLauncher } from "./bootstrap/launcher";
import { createWorkPanelRuntime } from "./bootstrap/work-panel";
import { createCloseBehaviorRuntime } from "./bootstrap/close-behavior";
import { registerShutdownHandlers } from "./bootstrap/shutdown";
import { stripWinLongPrefix } from "./path-utils";

// A closed stdout/stderr (Linux AppImage, GUI launch without a TTY) must not
// surface as Electron's "Uncaught Exception: write EPIPE" dialog. The same
// default dialog must not appear for a stray uncaughtException (non-ASCII
// HTTP headers from a system proxy, destroyed webContents, etc.).
ignoreBrokenStdio();
installMainProcessErrorHandlers();

const isDevelopmentBuild =
  process.env.PI_DESKTOP_DEV === "1" || !app.isPackaged;
const initialTemporaryWorkspace = initialTemporaryWorkspaceCommandLine();
const startupDataDirectoryEnvironment = process.env.PI_DESKTOP_DATA_DIR;
let configuredDataDirectory: string | undefined;
try {
  if (!startupDataDirectoryEnvironment?.trim()) {
    configuredDataDirectory = readConfiguredDataDirectory(app.getPath("appData"));
  }
} catch (error) {
  dialog.showErrorBox("无法读取数据存储位置", `请确认数据目录可用，并检查系统应用数据目录中的 this-is-a-agent/data-directory.json。\n\n${error instanceof Error ? error.message : String(error)}`);
  app.exit(1);
}
const { dataDir, hasSingleInstanceLock } = configureApplicationIdentity(app, {
  dataDir: configuredDataDirectory,
  temporaryWorkspacePath: initialTemporaryWorkspace,
});
// Work around a Chromium accessibility-tree crash during streaming updates.
// Chromium disables its renderer accessibility tree here; assess Computer Use separately.
app.commandLine.appendSwitch("disable-renderer-accessibility");
if (!hasSingleInstanceLock) {
  // 立即终止，防止下面的日志、outbox 和插件初始化触碰另一个进程的业务目录。
  app.exit(0);
}
// 所有旧的目录消费者和子进程共用同一个有效路径；退出时恢复用户启动环境。
process.env.PI_DESKTOP_DATA_DIR = dataDir;
app.on("will-quit", () => {
  if (startupDataDirectoryEnvironment === undefined) delete process.env.PI_DESKTOP_DATA_DIR;
  else process.env.PI_DESKTOP_DATA_DIR = startupDataDirectoryEnvironment;
});
if (process.platform === "win32") {
  // Development must not claim the packaged app's AUMID. Windows resolves the
  // taskbar identity through it, so sharing the id with an installed build made
  // the dev window group under that app and display its (older) icon. macOS
  // already isolates development behind a `.dev` bundle id.
  app.setAppUserModelId(app.isPackaged ? APP_ID : `${APP_ID}.dev`);
}

// Native resize streams can pause briefly while the pointer crosses a display
// scale boundary. Keep recovery out of that gesture and only run it after the
// bounds have been stable for one short interaction window.
const WINDOW_BOUNDS_SETTLE_MS = 300;
const WORK_PANEL_NATIVE_RESIZE_SETTLE_MS = 180;
const WORK_PANEL_CHAT_RESIZE_SETTLE_MS = WINDOW_BOUNDS_SETTLE_MS + 120;

const mainState = new MainProcessState();
const {
  launcherState,
  windowLifecycleState,
  runtimeState,
  applicationLifecycleState,
  applicationAppearanceState,
  planRuntimeState,
  startupState,
  shutdownState,
  windowsAllowedToClose,
} = mainState;

const getHost = () => mainState.host;
const getMainWindow = () => mainState.mainWindow;
const getSidecar = () => mainState.sidecar;

let applicationLifecycle: ReturnType<typeof createApplicationLifecycle> | null = null;
let launcherRuntime: ReturnType<typeof createLauncher> | null = null;
let closeBehaviorRuntime: ReturnType<typeof createCloseBehaviorRuntime> | null = null;
const showPluginLauncherForLifecycle = (): Promise<void> => {
  if (!launcherRuntime) {
    return Promise.reject(new Error("launcher is not initialized"));
  }
  return launcherRuntime.showPluginLauncher();
};
const applyPluginLauncherShortcutForLifecycle = (
  keybindings?: KeybindingOverrides,
) => {
  launcherRuntime?.applyPluginLauncherShortcut(keybindings);
};
const applyToggleWindowShortcutForLifecycle = (
  keybindings?: KeybindingOverrides,
) => {
  launcherRuntime?.applyToggleWindowShortcut(keybindings);
};
const applyCloseBehaviorForLifecycle = (next: CloseBehavior) => {
  if (!closeBehaviorRuntime) {
    throw new Error("close behavior runtime is not initialized");
  }
  closeBehaviorRuntime.applyCloseBehavior(next);
};
const askCloseBehaviorForLifecycle = (
  window: BrowserWindow,
): Promise<CloseBehavior | null> => {
  if (!closeBehaviorRuntime) {
    return Promise.reject(new Error("close behavior runtime is not initialized"));
  }
  return closeBehaviorRuntime.askCloseBehavior(window);
};

const workPanelRuntime = createWorkPanelRuntime({
  state: windowLifecycleState,
  windowMinWidth: WINDOW_MIN_WIDTH,
  chatResizeSettleMs: WORK_PANEL_CHAT_RESIZE_SETTLE_MS,
});
const {
  workPanelMinimumWindowWidth,
  observedWorkPanelBaseBounds,
  markWorkPanelChatResizeActive,
  classifyDisplayTransition,
  applyWorkPanelReservation,
} = workPanelRuntime;

const desktopServices = createDesktopServices({
  getLogger: () => logger,
  getMainWindow,
});
const {
  clipboardHistory,
  getPluginNotificationPermission,
  requestPluginNotificationPermission,
  showPluginNativeNotification,
  recordPastedClipboardFiles,
  safeOpenExternal,
} = desktopServices;

// Agent extensions (D387/D388, ADR 0214): plugins contribute the modules,
// the sidecar loads them; this bridge carries commands, diagnostics, and
// prompts between the two.
const agentExtensions = new AgentExtensionBridge({
  hasRenderer: () =>
    !!mainState.mainWindow &&
    !mainState.mainWindow.isDestroyed() &&
    !mainState.mainWindow.webContents.isDestroyed(),
  onChanged: () => sendToRenderer(IPC.event.pluginChanged, { reason: "agentExtensions" }),
  onPrompt: (prompt) => {
    logger.app("plugin", "info", "extension prompt", {
      sessionId: prompt.sessionId,
      data: { promptId: prompt.promptId, kind: prompt.request.kind, extensionId: prompt.extensionId },
    });
    sendToRenderer(IPC.event.extensionsUiPrompt, prompt);
  },
  onToast: (message) => sendToRenderer(IPC.event.toast, { message }),
  onStatus: (event) => sendToRenderer(IPC.event.extensionsStatus, event),
});

const logger = new Logger(
  dataDir,
  isDevelopmentBuild ? "debug" : "info",
  { mirrorConsole: isDevelopmentBuild },
);
installMainProcessErrorHandlers({
  emit: (record) => {
    logger.app("runtime", "error", record.message, {
      code: record.code,
      data: { recoverable: record.recoverable, detail: record.detail },
    });
  },
});

const persistenceOutbox = new PersistenceOutbox(dataDir, (level, message, data) => {
  logger.app("persistence", level, message, { data });
});
const queuedSteeringReceipts = new QueuedSteeringReceipts(dataDir, (level, message, data) => {
  logger.app("persistence", level, message, { data });
});
const queuedSteeringJournal = createQueuedSteeringJournal({
  receipts: queuedSteeringReceipts, outbox: persistenceOutbox, getHost,
});
const steeringReplies = new Set<string>();
const scheduledRuntime = createScheduledRuntime({
  dataDir,
  getHost,
  logger,
});
const { importLegacyScheduled } = scheduledRuntime;
// The reply currently streaming in each session, checkpointed to host-core so
// a quit or crash mid-reply keeps the text the user already saw (D299). A
// checkpoint is a best-effort write against a live host; the outbox is not
// involved because a stale checkpoint must never be replayed after the final
// row.
const inflightCheckpointer = new InflightCheckpointer(async (checkpoint) => {
  if (!mainState.host || !mainState.host.isAvailable()) return;
  await mainState.host.call(
    "session.saveInflightMessage",
    {
      sessionId: checkpoint.sessionId,
      turnId: checkpoint.turnId,
      message: checkpoint.message,
    },
    5_000,
  );
});

const updater = new AppUpdaterController({
  logger,
  send: sendToRenderer,
  currentVersion: APP_VERSION,
  isPackaged: !isDevelopmentBuild,
  getLocale: () => mainState.updaterLocale,
  readUpdateSettings: async () => {
    const host = getHost();
    if (!host?.isAvailable()) throw new Error("host unavailable");
    return host.call<{
      updatePreference?: unknown;
      lastNotifiedUpdateVersion?: unknown;
    }>("settings.get");
  },
  persistLastNotifiedVersion: async (version) => {
    const host = getHost();
    if (!host?.isAvailable()) throw new Error("host unavailable");
    await host.call("settings.set", { lastNotifiedUpdateVersion: version });
  },
  persistDismissedVersion: async (version) => {
    const host = getHost();
    if (!host?.isAvailable()) throw new Error("host unavailable");
    await host.call("settings.set", { updateDismissedVersion: version });
  },
});

/**
 * Vendor-account logins. Holds the pi-ai credential plumbing so tokens stay in
 * this process; the renderer sees progress events and the sidecar sees only
 * resolved request auth.
 */
const modelsDevCatalog = new ModelsDevCatalog({
  catalogPath: app.isPackaged
    ? join(process.resourcesPath, "models.dev", "api.json")
    : join(app.getAppPath(), "resources", "models.dev", "api.json"),
});

const vendorOAuth = new VendorOAuth({
  call: <T,>(method: string, params?: unknown): Promise<T> => {
    const currentHost = getHost();
    if (!currentHost) throw new Error("host unavailable");
    return currentHost.call<T>(method, params);
  },
  emit: (event) => sendToRenderer(IPC.event.providersOauth, event),
  openExternal: async (url) => {
    await safeOpenExternal(url);
  },
  getPluginOAuthBridge: () => pluginServices.plugins,
  log: (level, message, data) => logger.app("provider", level, message, { data }),
  onAccountModels: (id, models) => modelsDevCatalog.setAccountModels(id, models),
  onAccountRemoved: (id) => modelsDevCatalog.deleteAccount(id),
  modelConfigFor: async ({ providerId, vendorKey, option }) => {
    await modelsDevCatalog.ensureLoaded();
    return catalogModelConfigFor(modelsDevCatalog, {
      providerId,
      vendorKey,
      baseUrl: option.baseUrl,
      apiStyle: option.apiStyle,
      modelId: option.modelId,
    });
  },
});

let sessionLaunchRuntime: ReturnType<typeof createSessionLaunchRuntime> | null = null;
const pluginServices = createPluginServices({
  dataDir,
  logger,
  getMainWindow,
  getHost,
  sendToRenderer,
  safeOpenExternal,
  stripWinLongPrefix,
  clipboardHistory,
  getPluginNotificationPermission,
  requestPluginNotificationPermission,
  showPluginNativeNotification,
  getUpdaterLocale: () => mainState.updaterLocale,
  getPluginPanelTheme: () => mainState.pluginPanelTheme,
  getAppearance: () => {
    if (!applicationLifecycle) {
      throw new Error("application lifecycle is not initialized");
    }
    return applicationLifecycle.resolveAppearance();
  },
  getWorkspacePath: currentWorkspacePath,
  resolveAgentRuntimeLaunch: (...args) => {
    if (!sessionLaunchRuntime) {
      throw new Error("session launch runtime is not initialized");
    }
    return (
      sessionLaunchRuntime.resolveAgentRuntimeLaunch as (
        ...args: any[]
      ) => Promise<any>
    )(...args);
  },
  vendorOAuth,
});
const {
  plugins,
  userMcp,
  mcpOAuth,
  pluginScopes,
  sessionProjects,
  pluginPanels,
  pluginViews,
  browserHost,
  announceTurnEnded,
  speech,
} = pluginServices;

const providerCatalogRuntime = createProviderCatalogRuntime({
  getHost,
  modelsDevCatalog,
});
const {
  bindingForModel,
  effectiveSubagentModelConfig,
  enrichProvider,
  enrichProviderList,
  sessionCapabilityContext,
  enrichSession,
  normalizeSettings,
  validateSettingsWrite,
  normalizeThinkingLevel,
  listRuntimeProviders,
} = providerCatalogRuntime;

const createdSessionLaunchRuntime = createSessionLaunchRuntime({
  runtimeState,
  logger,
  userMcp,
  plugins,
  sessionProjects,
  dataDir,
  vendorOAuth,
  modelsDevCatalog,
  getWorkspacePath: currentWorkspacePath,
  pluginActiveInProject,
  bindingForModel,
  effectiveSubagentModelConfig,
  normalizeThinkingLevel,
});
sessionLaunchRuntime = createdSessionLaunchRuntime;
const {
  refreshUserMcp,
  activeUserSkills,
  activeUserSubagentDocuments,
  disabledBuiltinSubagents,
  loadUserSkillBody,
  resolveEffectiveCommandShell,
  resolveAgentRuntimeLaunch,
} = createdSessionLaunchRuntime;

/**
 * Refresh the cached plugin scopes from a `plugins.list` payload.
 *
 * Anything that changes a scope goes through host-core, so every read of the
 * list is also the moment to re-learn them.
 */
function rememberPluginScopes(list: Array<{ id?: string; scope?: ActivationScope }>): void {
  pluginScopes.clear();
  for (const plugin of list) {
    if (typeof plugin?.id === "string" && plugin.scope) {
      pluginScopes.set(plugin.id, plugin.scope);
    }
  }
}

/**
 * Whether a loaded plugin's contributions apply to `projectPath`.
 *
 * `enabled` is already implied — a disabled plugin is never loaded into the
 * runtime — so only the scope is consulted here. A plugin with no cached scope
 * counts as global, which is what every plugin installed before scopes existed
 * was.
 */
function pluginActiveInProject(pluginId: string, projectPath: string | null | undefined): boolean {
  const scope = pluginScopes.get(pluginId);
  if (!scope) return true;
  return isActiveInProject({ enabled: true, scope }, projectPath);
}

/**
 * The workspace the window is showing, from the cache Main keeps in sync with
 * every `workspace.get` / open-folder result. Synchronous on purpose: scope
 * filtering runs inside IPC handlers that must not await the host.
 */
function currentWorkspacePath(): string | null {
  return (globalThis as { __piWorkspacePath?: string | null }).__piWorkspacePath ?? null;
}

/** Push a panel event to detached windows and docked views. */
function broadcastPluginPanelEvent(event: string, payload: unknown): void {
  pluginPanels.broadcast(event, payload);
  pluginViews.broadcast(event, payload);
}

function setCurrentWorkspacePath(path: string | null): void {
  const previous = currentWorkspacePath();
  (globalThis as { __piWorkspacePath?: string | null }).__piWorkspacePath = path;
  if (previous === path) return;
  const payload = pluginWorkspaceInfo(path);
  broadcastPluginPanelEvent("workspace:changed", payload);
  plugins.broadcastEvent("workspace:changed", [payload]);
  // The group snapshot starts cold, so this first push can only carry the bare
  // workspace. Fetch the project's folders once and repeat it, so a plugin that
  // was already open sees them without waiting for the next switch; every later
  // switch finds the snapshot warm and broadcasts exactly once (ADR 0252).
  if (knownProjectGroups() === null) {
    void refreshProjectGroups(mainState.host).then((changed) => {
      if (!changed) return;
      const enriched = pluginWorkspaceInfo(currentWorkspacePath());
      broadcastPluginPanelEvent("workspace:changed", enriched);
      plugins.broadcastEvent("workspace:changed", [enriched]);
    });
  }
}

/** Pull the user's MCP server records from host-core into the local runtime. */
function sendToRenderer(channel: string, payload: unknown) {
  applicationLifecycle?.traySessions.observeEvent(channel, payload);
  applicationLifecycle?.taskbarUnreadBadge.observeEvent(channel, payload);
  if (channel === IPC.event.pluginChanged) {
    applicationLifecycle?.applyNativeThemeSource({
      theme: applicationAppearanceState.appThemePreference,
    });
  }
  if (!IPC_WHITELIST.has(channel)) return;
  const window = mainState.mainWindow;
  if (
    !window ||
    window.isDestroyed() ||
    window.webContents.isDestroyed()
  ) {
    return;
  }
  try {
    window.webContents.send(channel, payload);
  } catch {
    // The renderer's main frame can be disposed — the window closed while the
    // app keeps running (macOS dock, resident tray) or a teardown race where
    // webContents.isDestroyed() has not flipped yet — before the send reaches
    // it. Notifying a gone frame is routine teardown, never an error:
    // supervision must keep running with no window attached.
  }

}

installInsecureEndpointNotice(sendToRenderer);

const temporaryWorkspaceRuntime = createTemporaryWorkspaceRuntime({
  onPending: (workspacePath) =>
    sendToRenderer(IPC.event.temporaryWorkspacePending, { workspacePath }),
  log: (message, data) => logger.app("diagnostics", "warn", message, { data }),
});
if (initialTemporaryWorkspace) {
  temporaryWorkspaceRuntime.enqueueFromCommandLine([
    "this-is-a-agent",
    "--temporary-workspace",
    initialTemporaryWorkspace,
  ]);
}

applicationLifecycle = createApplicationLifecycle({
  getRunningSessionIds: () => activeTurns.keys(),
  state: windowLifecycleState,
  appState: applicationLifecycleState,
  appearanceState: applicationAppearanceState,
  dataDir,
  isDevelopmentBuild,
  windowsAllowedToClose,
  windowMinWidth: WINDOW_MIN_WIDTH,
  windowMinHeight: WINDOW_MIN_HEIGHT,
  windowBoundsSettleMs: WINDOW_BOUNDS_SETTLE_MS,
  workPanelNativeResizeSettleMs: WORK_PANEL_NATIVE_RESIZE_SETTLE_MS,
  applyWorkPanelReservation,
  markWorkPanelChatResizeActive,
  workPanelMinimumWindowWidth,
  observedWorkPanelBaseBounds,
  classifyDisplayTransition,
  sendToRenderer,
  safeOpenExternal,
  showPluginLauncher: showPluginLauncherForLifecycle,
  askCloseBehavior: askCloseBehaviorForLifecycle,
  applyCloseBehavior: applyCloseBehaviorForLifecycle,
  browserHost,
  pluginViews,
  plugins,
  logger,
  refreshReleaseNotes: () => updater.refreshReleaseNotes(),
  applyPluginLauncherShortcut: applyPluginLauncherShortcutForLifecycle,
  applyToggleWindowShortcut: applyToggleWindowShortcutForLifecycle,
  broadcastPluginPanelEvent,
  getHost,
});
const {
  applyDevelopmentBranding,
  hasVisibleWindow,
  restoreMainWindow,
  toggleMainWindow,
  createTray,
  applyAppearanceIcon,
  markMenuRendererReady,
  ensureWindow,
  dispatchApplicationMenuCommand,
  executeNativeMenuAction,
  dispatchNativeMenuAction,
  applyDeveloperMode,
  applyPreventScreenSleep,
  applyKeepAwakeWhileRunning,
  disposePowerSaveBlockers,
  applyApplicationMenuSettings,
  applyAppThemePreference,
  broadcastAppearance,
  flushPendingApplicationMenuCommands,
} = applicationLifecycle;

wirePluginThemeRuntimeServices({
  plugins,
  getHost,
  sendToRenderer,
  applyAppThemePreference,
  broadcastAppearance,
});

closeBehaviorRuntime = createCloseBehaviorRuntime({
  state: windowLifecycleState,
  dataDir,
  getLocale: () => mainState.updaterLocale,
  createTray,
});
const {
  applyCloseBehavior,
  confirmQuitDialog,
  respondClosePrompt,
} = closeBehaviorRuntime;

const createdLauncher = createLauncher({
  state: windowLifecycleState,
  launcherState,
  appState: applicationLifecycleState,
  getHost,
  logger,
  safeOpenExternal,
  toggleMainWindow,
});
launcherRuntime = createdLauncher;
const {
  prewarmPluginLauncher,
  togglePluginLauncher,
  applyPluginLauncherShortcut,
  applyToggleWindowShortcut,
} = createdLauncher;

/** sessionId → open host turn id, for turn bookkeeping across agent events. */
const activeTurns = new Map<string, string>();
/** Plan submission turns end without a task-complete notification. */
const planSubmissionTurnIds = new Set<string>();
/** sessionId → host execution id for an approved plan currently dispatched. */
const approvedExecutionIdsBySession = new Map<string, string>();
/** executionId → durable execution turn identity. */
const approvedExecutionTurns = new Map<
  string,
  { sessionId: string; turnId: string }
>();
/** Claimed executions remain tracked even before their durable turn exists. */
const claimedExecutionSessions = new Map<string, string>();
/** Click/start deduplication for approved plan execution. */
const dispatchingApprovedExecutions = new Set<string>();
const startedApprovedExecutions = new Set<string>();
const finishedApprovedExecutions = new Set<string>();
const pendingExecutionFinishes = new Map<
  string,
  { status: PlanExecutionFinishStatus; errorCode?: string }
>();
const inFlightExecutionFinishes = new Set<string>();
/** sessionId → scheduled task_run id awaiting completion. */
const scheduledRunsBySession = new Map<string, string>();
/** Preserve tool metadata until the result is persisted at tool_end. Subagent
 * calls also carry their attribution, which is what lets a permission request
 * name the delegate that asked (ADR 0062). */
const activeToolCalls = new Map<
  string,
  {
    toolName: string;
    args: unknown;
    createdAt: string;
    turnId?: string;
    parentToolCallId?: string;
    agentName?: string;
  }
>();

const sessionCoordination = createSessionCoordination({
  activeTurns,
  getMainWindow,
  getViewingSessionId: () => mainState.notificationViewingSessionId,
});
const {
  activeTurnUsages,
  acquireSessionOperation,
  addActiveTurnUsage,
  activeToolCallKey,
  planSubmissionTurnKey,
  lockAbortReason,
  isTurnDispatchable,
  isSessionBusy,
  isStaleTerminalEvent,
} = sessionCoordination;

const sessionConfiguration = createSessionConfigurationQueue({
  getHost,
  isTurnActive: (sessionId) => activeTurns.has(sessionId),
  onChanged: (sessionId, session, applied) => {
    if (session && applied && (applied.providerId !== undefined || applied.modelId !== undefined || applied.thinkingLevel !== undefined)) {
      plugins.broadcastEvent("session:modelChanged", [{
        sessionId,
        modelKey: session.providerId && session.modelId ? `${session.providerId}/${session.modelId}` : null,
        thinkingLevel: session.thinkingLevel,
      }]);
    }
    sendToRenderer(IPC.event.sessionsChanged, { reason: "session.configuration" });
    plugins.publishDesktopEvent({ sessionId, kind: "session.changed", payload: { reason: applied ? "configured" : "configuration-pending" } });
    if (!sessionConfiguration.hasPending(sessionId)) mainState.agentHostBridge?.agentHost.kick(sessionId);
  },
  log: (message, data) => logger.app("session", "warn", message, { data }),
});

/**
 * Applies a close-behavior choice. The tray icon is owned by D216 and stays
 * resident on every platform, so switching to "quit" must not destroy it —
 * minimize-to-tray still needs it to bring the window back.
 */
let runtimeLifecycle: ReturnType<typeof createRuntimeLifecycle> | null = null;
const superviseRestart = (kind: "host" | "sidecar"): Promise<void> => {
  if (!runtimeLifecycle) {
    return Promise.reject(new Error("runtime lifecycle is not initialized"));
  }
  return runtimeLifecycle.superviseRestart(kind);
};

const planUiProbe = createPlanUiProbe({
  getHost,
  getSidecar,
  logger,
});

let emitAgentEvent: (envelope: AgentEventEnvelope) => void = () => undefined;

const sessionCollaboration = createSessionCollaborationService({
  getHost,
  getSidecar,
  getBridge: () => mainState.agentHostBridge,
  getActiveTurn: (sessionId) => activeTurns.get(sessionId),
  flushTranscript: async () => {
    await persistenceOutbox.flush(getHost);
    return persistenceOutbox.size() === 0;
  },
  isPluginLoaded: (pluginId) => plugins.listLoaded().some((plugin) => plugin.manifest.id === pluginId),
  isQuitting: () => mainState.quitting,
  onChanged: () => sendToRenderer(IPC.event.sessionsChanged, { reason: "session.collaboration" }),
  log: (message, data) => logger.app("runtime", "warn", message, { data }),
});

const planRuntime = createPlanRuntime({
  runtimeState,
  planState: planRuntimeState,
  logger,
  sendToRenderer,
  coordination: sessionCoordination,
  scheduledRunsBySession,
  activeToolCalls,
  planSubmissionTurnIds,
  approvedExecutionIdsBySession,
  claimedExecutionSessions,
  approvedExecutionTurns,
  startedApprovedExecutions,
  finishedApprovedExecutions,
  dispatchingApprovedExecutions,
  inFlightExecutionFinishes,
  pendingExecutionFinishes,
  announceTurnEnded,
  emitAgentEvent: (envelope) => emitAgentEvent(envelope),
  acquireSessionOperation,
  resolveAgentRuntimeLaunch,
  isQuitting: () => mainState.quitting,
  onTurnSettled: sessionCollaboration.settle,
  sessionConfiguration,
});
const {
  finishTurn,
  finishApprovedExecution,
  dispatchApprovedPlan,
  drainApprovedPlanExecutions,
  dispatchExecutionForProposal,
} = planRuntime;

const eventPersistence = createEventPersistence({
  runtimeState,
  steeringReplies,
  activeTurns,
  activeToolCalls,
  activeToolCallKey,
  approvedExecutionIdsBySession,
  approvedExecutionTurns,
  pendingExecutionFinishes,
  planSubmissionTurnIds,
  planSubmissionTurnKey,
  inflightCheckpointer,
  persistenceOutbox,
  addActiveTurnUsage,
  logger,
  finishTurn,
  isStaleTerminalEvent,
  finishApprovedExecution,
  emitAgentEvent: (envelope) => emitAgentEvent(envelope),
});
const { persistAgentEvent } = eventPersistence;

const subagentSnapshots = new SubagentSnapshotStore({
  dataDir,
  sessionAuthority: createSubagentSessionAuthority(dataDir, getHost),
  deliverEvent: async (envelope) => {
    const host = getHost();
    if (!host || envelope.event.type !== "message_end" || envelope.event.message.role !== "tool" ||
        envelope.event.message.toolName !== "TaskExecution") throw new Error("Invalid durable subagent event");
    const message = { ...envelope.event.message,
      parentToolCallId: envelope.parentToolCallId ?? envelope.event.message.parentToolCallId,
      agentName: envelope.agentName ?? envelope.event.message.agentName };
    await host.call("session.appendMessage", { sessionId: envelope.sessionId, message, turnId: envelope.turnId });
    emitAgentEvent(envelope);
  },
});
persistenceOutbox.setOnMessagePersisted((sessionId) => subagentSnapshots.recordCoverage(sessionId));

const sidecarRuntime = createSidecarRuntime({
  runtimeState,
  taskTranscript: sessionCoordination.taskTranscript,
  subagentSnapshots,
  steeringReplies,
  logger,
  sendToRenderer,
  persistAgentEvent,
  activeTurns,
  approvedExecutionIdsBySession,
  claimedExecutionSessions,
  inflightCheckpointer,
  finishTurn,
  isStaleTerminalEvent,
  finishApprovedExecution,
  superviseRestart,
  isQuitting: () => mainState.quitting,
  dataDir,
  agentExtensions,
  vendorOAuth,
  listRuntimeProviders,
  modelsDevCatalog,
  effectiveSubagentModelConfig,
  browserHost,
  plugins,
  sessionProjects,
  loadUserSkillBody,
  activeUserSkills,
  pluginActiveInProject,
  currentNetworkProxy,
});
emitAgentEvent = sidecarRuntime.emitAgentEvent;
const { startSidecar } = sidecarRuntime;
sessionCoordination.taskTranscript.setPublisher(async (sessionId, turnId, message, echo) => {
  if (echo) emitAgentEvent({ sessionId, turnId, ts: Date.now(), event: { type: "message_end", message, taskSummary: true } });
  try {
    await persistenceOutbox.enqueue({ key: `message:${sessionId}:${message.id}`, sessionId, turnId, message }, getHost);
  } catch (error) {
    logger.app("persistence", "warn", "task summary enqueue failed", { sessionId, data: String(error) });
    throw error;
  }
});

const { startHost } = createHostRuntime({
  runtimeState,
  dataDir,
  logger,
  persistenceOutbox,
  activeToolCalls,
  activeToolCallKey,
  sessionProjects,
  plugins,
  userMcp,
  pluginActiveInProject,
  sendToRenderer,
  emitAgentEvent,
  togglePluginLauncher,
  finishTurn,
  isTurnDispatchable,
  finishApprovedExecution,
  activeTurns,
  approvedExecutionIdsBySession,
  claimedExecutionSessions,
  importLegacyScheduled,
  superviseRestart,
  isQuitting: () => mainState.quitting,
  ensureSystemProxyRelay,
});

runtimeLifecycle = createRuntimeLifecycle({
  runtimeState,
  dataDir,
  logger,
  sendToRenderer,
  startHost,
  startSidecar,
  drainApprovedPlanExecutions,
  applyNetworkProxyFromAppSettings,
  plugins,
  setCurrentWorkspacePath,
  rememberPluginScopes,
  refreshUserMcp,
  isQuitting: () => mainState.quitting,
  getDisplayLocale: () => applicationAppearanceState.updaterLocale,
});
const { bootHostStatus, bootBackends } = runtimeLifecycle;

function registerIpc() {
  return registerIpcHandlers({
    traySessions: applicationLifecycle!.traySessions,
    taskbarUnreadBadge: applicationLifecycle!.taskbarUnreadBadge,
    ipcMain,
    getMainWindow,
    takeTemporaryWorkspaces: () => temporaryWorkspaceRuntime.takePending(),
    getHost,
    getSidecar,
    getAgentHostBridge: () => mainState.agentHostBridge,
    getBackendRouter: () => startupState.backendRouter,
    getNotificationViewingSessionId: () => mainState.notificationViewingSessionId,
    setNotificationViewingSessionId: (sessionId: string | null) => {
      mainState.notificationViewingSessionId = sessionId;
    },
    getPluginLauncherWindow: () => mainState.pluginLauncherWindow,
    togglePluginLauncher,
    safeOpenExternal,
    updater,
    dataDir,
    activeTurns,
    isTurnDispatchable,
    sessionProjects,
    persistenceOutbox,
    subagentSnapshots,
    queuedSteeringJournal,
    logger,
    plugins,
    speech,
    sessionCapabilityContext,
    enrichSession,
    acquireSessionOperation,
    sessionConfiguration,
    stripWinLongPrefix,
    normalizeSettings,
    validateSettingsWrite,
    testNetworkProxy,
    applyNetworkProxyFromAppSettings,
    currentNetworkProxy,
    applyApplicationMenuSettings,
    applyDeveloperMode,
    applyPreventScreenSleep,
    applyKeepAwakeWhileRunning,
    applyTemporaryWorkspaceContextMenu: (settings) => temporaryWorkspaceRuntime.applyContextMenu(settings),
    resolveEffectiveCommandShell,
    applyAppearanceIcon,
    modelsDevCatalog,
    vendorOAuth,
    enrichProvider,
    listRuntimeProviders,
    enrichProviderList,
    bindingForModel,
    agentExtensions,
    activeUserSkills,
    pluginActiveInProject,
    getWorkPanelReservationWidth: () => mainState.requestedWorkPanelReservation,
    setWorkPanelReservationWidth: (width: number) => {
      mainState.requestedWorkPanelReservation = width;
    },
    setWorkPanelReservation: (state: WorkPanelReservationState) => {
      mainState.workPanelReservation = state;
    },
    getWorkPanelChatWidthSetter: () => mainState.setWorkPanelChatWidthForWindow,
    applyCloseBehavior,
    getCloseBehavior: () => mainState.closeBehavior,
    respondClosePrompt,
    markMenuRendererReady,
    executeNativeMenuAction,
    scheduledRunsBySession,
    isQuitting: () => mainState.quitting,
    isDevelopmentBuild,
    browserHost,
    clipboardHistory,
    recordPastedClipboardFiles,
    currentWorkspacePath,
    setCurrentWorkspacePath,
    withGitBranch,
    activeTurnUsages,
    approvedExecutionIdsBySession,
    claimedExecutionSessions,
    resolveAgentRuntimeLaunch,
    finishTurn,
    lockAbortReason,
    finishApprovedExecution,
    dispatchApprovedPlan,
    dispatchExecutionForProposal,
    emitAgentEvent,
    userMcp,
    mcpOAuth,
    refreshUserMcp,
    describeError,
    activeUserSubagentDocuments,
    disabledBuiltinSubagents,
    pluginViews,
    pluginScopes,
    rememberPluginScopes,
    pluginPanels,
    getUpdaterLocale: () => mainState.updaterLocale,
    getPluginPanelTheme: () => mainState.pluginPanelTheme,
    isDeveloperMode: () => mainState.developerMode,
    sendToRenderer,
  });
}

// Default hardening for every web contents Electron creates, applied before
// the owning surface can wire its own handlers (which replace these). A new
// window that forgets to set a window-open handler therefore denies popups
// and cannot attach a <webview> instead of inheriting Chromium's defaults.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
});

registerApplicationStartup({
  queuedSteeringJournal,
  hasSingleInstanceLock,
  state: startupState,
  dataDir,
  logger,
  updater,
  modelsDevCatalog,
  plugins,
  isSessionBusy: (sessionId) => isSessionBusy(sessionId) || sessionConfiguration.hasPending(sessionId),
  prepareSessionForTurn: async (sessionId) => {
    if (!activeTurns.has(sessionId)) await sessionConfiguration.flush(sessionId);
  },
  getHost,
  getMainWindow,
  sendToRenderer,
  applyDevelopmentBranding,
  createTray,
  dispatchApplicationMenuCommand,
  dispatchNativeMenuAction,
  prewarmPluginLauncher,
  registerIpc,
  bootBackends,
  planUiProbe,
  applyApplicationMenuSettings,
  applyDeveloperMode,
  applyPreventScreenSleep,
  applyKeepAwakeWhileRunning,
  applyTemporaryWorkspaceContextMenu: (settings) =>
    temporaryWorkspaceRuntime.applyContextMenu(settings).catch((error) => {
      logger.app("diagnostics", "warn", "Windows Explorer context menu refresh failed", {
        data: String(error),
      });
    }),
  applyPluginLauncherShortcut,
  applyToggleWindowShortcut,
  ensureWindow,
  bootHostStatus,
  flushPendingApplicationMenuCommands,
  invokeSessionCollaboration: sessionCollaboration.invoke,
  onSessionQueueChange: () => {
    void sessionCollaboration.drain().catch((error: unknown) => {
      logger.app("runtime", "warn", "session callback drain failed", { data: String(error) });
    });
  },
});

registerShutdownHandlers({
  hasSingleInstanceLock,
  state: shutdownState,
  getHost,
  getSidecar,
  getMcpControl: () => mainState.mcpControl,
  activeTurns,
  persistenceOutbox,
  closeSubagentSnapshots: () => subagentSnapshots.closeOwner(),
  flushTaskSummaries: async () => {
    await sessionCoordination.taskTranscript.flush();
    await persistenceOutbox.flush(getHost);
  },
  inflightCheckpointer,
  flushEventPersistence: eventPersistence.flush,
  pluginPanels,
  plugins,
  userMcp,
  mcpOAuth,
  browserHost,
  pluginViews,
  updater,
  logger,
  confirmQuitDialog,
  disposePowerSaveBlockers,
  disposeSystemProxyRelay,
});

registerApplicationActivation({
  restoreMainWindow,
  isQuitting: () => mainState.quitting,
  isApplicationBooted: () => applicationLifecycleState.applicationBooted,
  hasVisibleWindow,
  onTemporaryWorkspaceLaunch: (commandLine, additionalData) =>
    temporaryWorkspaceRuntime.enqueueFromCommandLine(commandLine, additionalData),
});
