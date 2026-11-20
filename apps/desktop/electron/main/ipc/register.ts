import { join } from "node:path";
import { dialog, net, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron";
import { err, ErrorCodes, IPC, IPC_WHITELIST, ok, type LifecycleDialogChoice, type Result } from "@pi-desktop/shared";
import type { AgentHostBridge } from "../agent-host-bridge";
import type { AgentSidecar } from "../agent-sidecar";
import type { SubagentSnapshotStore } from "../runtime/subagent-snapshot-store";
import type { HostProcess } from "../host-process";
import { ROUTE_LOCAL, type BackendRouter } from "../remote/backend-router";
import { createRendererFileReader } from "../renderer-file-reader";
import { remoteWorkspaceForFiles } from "../remote/workspace-file-scope";
import { registerAgentExtensionIpc } from "../agent-extensions-ipc";
import { readNpmPath, writeNpmPath } from "../npm-preferences";
import { registerAgentIpc } from "./agent-ipc";
import { registerBackgroundTasksIpc } from "./background-tasks-ipc";
import { registerAppIpc } from "./app-ipc";
import { registerDiagnosticsIpc } from "./diagnostics-ipc";
import { registerStartupAnimationIpc } from "./startup-animation-ipc";
import { registerMarketIpc } from "./market-ipc";
import { registerMcpIpc } from "./mcp-ipc";
import type { McpOAuthManager } from "../mcp-oauth";
import { searchMcpMarket } from "../mcp-registry-catalog";
import { registerNotificationIpc } from "./notification-ipc";
import { registerPluginIpc } from "./plugin-ipc";
import { registerPluginUiIpc } from "./plugin-ui-ipc";
import { registerPluginLauncherIpc } from "./plugin-launcher-ipc";
import { registerJevIpc } from "./jev-ipc";
import { registerModesIpc } from "./modes-ipc";
import type { ModeServices } from "../runtime/mode-services";
import { registerProviderIpc } from "./provider-ipc";
import { registerPiSyncIpc } from "./pi-sync-ipc";
import { registerPullsIpc } from "./pulls-ipc";
import { registerScheduledIpc } from "./scheduled-ipc";
import { registerSessionIpc } from "./session-ipc";
import { registerSettingsIpc } from "./settings-ipc";
import { registerConfigSyncIpc } from "./config-sync-ipc";
import { registerSkillsIpc } from "./skills-ipc";
import { registerAgentImportIpc } from "./agent-import-ipc";
import { registerRemoteHostIpc } from "./remote-host-ipc";
import { fetchSkillMarketDocument, searchSkillMarket } from "../skill-market-catalog";
import { registerWindowIpc } from "./window-ipc";
import { registerWorktreeIpc } from "./worktree-ipc";
import { createComposerTemplateLoader, registerWorkspaceIpc } from "./workspace-ipc";
import { registerComposerIpc } from "./composer-ipc";
import { registerBrowserReferenceIpc } from "./browser-reference-ipc";
import { registerSpeechIpc } from "./speech-ipc";
import { registerLiveVoiceIpc } from "./live-voice-ipc";
import type { LiveCallService } from "../live-voice/call-service";
import type { ComposerSuggestionAnswer } from "../services/composer-suggestion";
import type { IpcRegistrar } from "./types";
import type { createTraySessions } from "../tray-sessions";
import type { createTaskbarUnreadBadge } from "../taskbar-unread-badge";
import { registerStorageIpc } from "../storage/ipc";
import { requestStorageRestart } from "../storage/bootstrap";
import { getModuleDirectory } from "../module-path";
import { rememberComposerPickerSelection } from "../composer-picker";

export type RegisterIpcDependencies = {
  isQuitting: () => boolean;
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  /** Renderer-ready handoff for queued Windows Explorer launches. */
  takeTemporaryWorkspaces?: () => { workspacePaths: string[] };
  getHost: () => HostProcess | null;
  traySessions: ReturnType<typeof createTraySessions>;
  taskbarUnreadBadge: ReturnType<typeof createTaskbarUnreadBadge>;
  getSidecar: () => AgentSidecar | null;
  subagentSnapshots: SubagentSnapshotStore;
  getAgentHostBridge: () => AgentHostBridge | null;
  /**
   * Resolves the remote backend router once it exists. Renderer IPC calls whose
   * session is owned by a paired remote host are forwarded through it; every
   * other call — including all internal invokes — runs the local handler
   * unchanged. Null until the router is wired (and in tests).
   */
  getBackendRouter?: () => BackendRouter | null;
  getNotificationViewingSessionId: () => string | null;
  setNotificationViewingSessionId: (sessionId: string | null) => void;
  /** The session on screen, as the shell reported it (plugin `session:activated`). */
  setActivePluginSession: (
    next: { sessionId: string; projectPath: string | null } | null,
  ) => void;
  /** The shell's answer to a composer suggestion it was offered (ADR 0333). */
  settleComposerSuggestion: (answer: ComposerSuggestionAnswer) => boolean;
  activeUserSubagentDocuments: (...args: any[]) => Promise<any>;
  disabledBuiltinSubagents: () => Promise<string[]>;
  disabledBuiltinSkills: () => Promise<string[]>;
  /** Host activation plus the inline-visualization switch, for runtime consumers. */
  runtimeDisabledBuiltinSkills: () => Promise<string[]>;
  completionNoticeTurns: Set<string>;
  /** Mode definition catalog and staged run coordination (ADR mode-definitions). */
  modeServices: ModeServices;
  liveCallService?: LiveCallService;
  mcpOAuth?: McpOAuthManager;
  markLifecycleDialogRendererReady: (window: BrowserWindow) => boolean;
  respondLifecycleDialog: (senderWindowId: number, requestId: unknown, choice: LifecycleDialogChoice) => boolean;
  [name: string]: any;
};

function wrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
  return fn()
    .then((data) => ok(data))
    .catch((e: any) =>
      err(
        e?.data?.errorCode || e?.errorCode || ErrorCodes.INTERNAL,
        e instanceof Error ? e.message : String(e),
        { retriable: e?.data?.retriable === true, details: e?.data },
      ),
    );
}

const registeredIpcHandlers = new Map<string, (...args: unknown[]) => Promise<Result<unknown>>>();

export async function invokeRegisteredIpc(channel: string, ...args: unknown[]): Promise<Result<unknown>> {
  if (!IPC_WHITELIST.has(channel)) return err(ErrorCodes.UNAUTHORIZED, `IPC channel is not allowed: ${channel}`);
  const handler = registeredIpcHandlers.get(channel);
  if (!handler) return err(ErrorCodes.NOT_FOUND, `IPC channel is not registered: ${channel}`);
  if (channel === IPC.invoke.composerPasteFiles && args[0] && typeof args[0] === "object") {
    const input = args[0] as { files?: Array<{ data?: unknown }> };
    if (Array.isArray(input.files)) {
      args[0] = { ...input, files: input.files.map((file) => ({
        ...file,
        data: typeof file.data === "string" ? Uint8Array.from(Buffer.from(file.data, "base64")) : file.data,
      })) };
    }
  }
  return handler(...args);
}

export function registerIpcHandlers(dependencies: RegisterIpcDependencies) {
  const {
    ipcMain,
    getMainWindow,
    getHost,
    getSidecar,
    getAgentHostBridge,
    getBackendRouter,
    getNotificationViewingSessionId,
    setNotificationViewingSessionId,
    setActivePluginSession,
    settleComposerSuggestion,
    getPluginLauncherWindow,
    togglePluginLauncher,
    openPluginMarket,
    safeOpenExternal,
    updater,
    dataDir,
    activeTurns,
    completionNoticeTurns,
    isTurnDispatchable,
    sessionProjects,
    persistenceOutbox,
    queuedSteeringJournal,
    logger,
    plugins,
    localApps,
    speech,
    sessionCapabilityContext,
    enrichSession,
    acquireSessionOperation,
    sessionConfiguration,
    beginTranscriptRewrite,
    forgetTranscriptRewriteHistory,
    recordTurnStart,
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
    applyTemporaryWorkspaceContextMenu,
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
    activeUserSubagentDocuments,
    disabledBuiltinSubagents,
    disabledBuiltinSkills,
    runtimeDisabledBuiltinSkills,
    pluginActiveInProject,
    getWorkPanelReservationWidth,
    setWorkPanelReservationWidth,
    setWorkPanelReservation,
    getWorkPanelChatWidthSetter,
    applyCloseBehavior,
    getCloseBehavior,
    respondClosePrompt,
    isMacosWindowTranslucent,
    markMenuRendererReady,
    markLifecycleDialogRendererReady,
    respondLifecycleDialog,
    traySessions,
    taskbarUnreadBadge,
    executeNativeMenuAction,
    scheduledRunsBySession,
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
    pluginViews,
    pluginScopes,
    rememberPluginScopes,
    pluginPanels,
    getUpdaterLocale,
    getPluginPanelTheme,
    isDeveloperMode,
    sendToRenderer,
    liveCallService,
  } = dependencies;


  const ipcHandlers = new Map<string, (...args: any[]) => Promise<any>>();
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    const handler = async (...args: any[]) => {
      const result = await fn(...args);
      traySessions.observeInvoke(channel);
      taskbarUnreadBadge.observeInvoke(channel);
      return result;
    };
    ipcHandlers.set(channel, handler);
    // The interception seam for remote-host routing: a renderer call whose
    // session is owned by a paired remote host is served over RACP-WS; every
    // other call (and every internal invoke, which never reaches this wrapper)
    // runs the existing local handler byte-for-byte unchanged.
    const invoke = (...args: unknown[]) => wrap(async () => {
      const router = getBackendRouter?.();
      if (router) {
        const outcome = await router.route(channel, args);
        if (outcome !== ROUTE_LOCAL) return outcome.value;
      }
      return handler(...args);
    });
    registeredIpcHandlers.set(channel, invoke);
    ipcMain.handle(channel, (_event, ...args) => invoke(...args));
  };
  const internalEvents = new WeakSet<IpcMainInvokeEvent>();
  const internalSender = () => {
    const window = getMainWindow();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) return window.webContents;
    const mainFrame = { routingId: 0, processId: 0, url: "" };
    return { id: 0, mainFrame, getURL: () => "", getZoomFactor: () => 1 } as IpcMainInvokeEvent["sender"];
  };
  const handleWithEvent = (
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any>,
  ) => {
    registeredIpcHandlers.set(channel, (...args) => wrap(async () => {
      const sender = internalSender();
      const event = { sender, senderFrame: sender.mainFrame, frameId: sender.mainFrame.routingId, processId: sender.mainFrame.processId } as IpcMainInvokeEvent;
      internalEvents.add(event);
      try { return await fn(event, ...args); }
      finally { internalEvents.delete(event); }
    }));
    ipcMain.handle(channel, async (event, ...args) => wrap(() => fn(event, ...args)));
  };
  const assertMainWindowSender = (event: IpcMainInvokeEvent): void => {
    if (internalEvents.has(event)) return;
    if (event.sender.id !== getMainWindow()?.webContents.id) {
      throw Object.assign(new Error("renderer is not the main window"), {
        errorCode: "PERMISSION_DENIED",
      });
    }
  };

  const optionalWorkspaceRoot = async (): Promise<string | null> => {
    const currentHost = getHost();
    if (!currentHost) return null;
    try {
      const result = (await currentHost.call("workspace.get")) as {
        workspace: { path?: string } | null;
      };
      return result.workspace?.path ?? null;
    } catch {
      return null;
    }
  };

  const registrar: IpcRegistrar = {
    ipcMain,
    handle,
    handleWithEvent,
    assertMainWindowSender,
  };
  registerStorageIpc({ registrar, getMainWindow, restart: requestStorageRestart });
  registerBrowserReferenceIpc({ registrar, sendToRenderer });

  if (dependencies.takeTemporaryWorkspaces) {
    registrar.handle(IPC.invoke.temporaryWorkspaceTake, async () =>
      dependencies.takeTemporaryWorkspaces!(),
    );
  }
  registerAppIpc({
    registrar,
    getHost,
    getPluginLauncherWindow,
    togglePluginLauncher,
    safeOpenExternal,
    updater,
  });
  registerNotificationIpc({
    registrar,
    getHost,
    getMainWindow,
    getViewingSessionId: getNotificationViewingSessionId,
    setViewingSessionId: setNotificationViewingSessionId,
    sendToRenderer,
  });
  registerBackgroundTasksIpc({ registrar, getHost });
  registerSessionIpc({
    subagentSnapshots: dependencies.subagentSnapshots,
    registrar,
    getHost,
    getSidecar,
    dataDir,
    activeTurns,
    isSessionBusy: dependencies.isSessionBusy,
    isQuitting: dependencies.isQuitting,
    sessionProjects,
    persistenceOutbox,
    logger,
    plugins,
    sessionCapabilityContext,
    enrichSession,
    acquireSessionOperation,
    sessionConfiguration,
    beginTranscriptRewrite,
    forgetTranscriptRewriteHistory,
    stripWinLongPrefix,
    modeCatalog: dependencies.modeServices.catalog,
  });
  registerSettingsIpc({
    registrar,
    getHost,
    getSidecar,
    getMainWindow,
    sendToRenderer,
    dataDir,
    normalizeSettings,
    validateSettingsWrite,
    testNetworkProxy,
    applyNetworkProxyFromAppSettings,
    currentNetworkProxy,
    applyApplicationMenuSettings,
    applyDeveloperMode,
    applyPreventScreenSleep,
    applyTemporaryWorkspaceContextMenu,
    applyKeepAwakeWhileRunning,
    applyUpdatePreference: (preference) => updater.setPreference(preference),
    resolveEffectiveCommandShell,
    applyAppearanceIcon,
    liveCallService,
  });
  registerConfigSyncIpc({
    registrar,
    getHost,
    sendToRenderer,
  });
  registerProviderIpc({
    registrar,
    getHost,
    modelsDevCatalog,
    vendorOAuth,
    logger,
    enrichProvider,
    listRuntimeProviders,
    enrichProviderList,
    bindingForModel,
    onProviderInvalidated: (providerId) => liveCallService?.invalidateProvider(providerId),
  });
  registerPiSyncIpc({
    registrar,
    getHost,
    logger,
  });
  registerJevIpc({ registrar, logger });
  registerModesIpc({ registrar, catalog: dependencies.modeServices.catalog, runs: dependencies.modeServices.runs });
  registerWorktreeIpc({
    registrar,
    getHost,
    logger,
    openPath: (path) => shell.openPath(path),
    stripWinLongPrefix,
  });
  const loadComposerTemplatesCached = createComposerTemplateLoader(logger);
  const composerCommandService = registerComposerIpc({
    registrar,
    userMcp,
    refreshUserMcp,
    plugins,
    agentExtensions,
    optionalWorkspaceRoot,
    activeUserSkills,
    disabledBuiltinSkills: runtimeDisabledBuiltinSkills,
    pluginActiveInProject,
    loadComposerTemplatesCached,
    sessionWorkspaceRoot: async (sessionId) => {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      const result = await host.call("session.get", { id: sessionId, messageLimit: 1 }) as { session?: { projectPath?: string; temporaryWorkspacePath?: string } };
      if (!result.session) throw new Error("session not found");
      return result.session.projectPath ?? result.session.temporaryWorkspacePath ?? null;
    },
  });
  registerWindowIpc({
    setTraySessionPreferences: traySessions.setPreferences,
    registrar,
    getMainWindow,
    getWorkPanelReservationWidth,
    setWorkPanelReservationWidth,
    setWorkPanelReservation,
    getWorkPanelChatWidthSetter,
    applyCloseBehavior,
    getCloseBehavior,
    respondClosePrompt,
    isMacosWindowTranslucent,
    markMenuRendererReady,
    markLifecycleDialogRendererReady,
    respondLifecycleDialog,
    executeNativeMenuAction,
  });
  registerPullsIpc({ registrar, getHost });
  registerScheduledIpc({
    registrar,
    getHost,
    scheduledRunsBySession,
    onSessionsChanged: () => sendToRenderer(IPC.event.sessionsChanged, { reason: "scheduled.delete" }),
    isQuitting: dependencies.isQuitting,
    invoke: async (channel, args) => {
      const handler = ipcHandlers.get(channel);
      if (!handler) throw new Error("scheduled prompt handler unavailable");
      return handler(...args);
    },
  });
  registerWorkspaceIpc({
    registrar,
    getMainWindow,
    getHost,
    getSidecar,
    dataDir,
    isDevelopmentBuild,
    plugins,
    browserHost,
    clipboardHistory,
    recordPastedClipboardFiles,
    currentWorkspacePath,
    setCurrentWorkspacePath,
    withGitBranch,
    stripWinLongPrefix,
  });

  registerAgentExtensionIpc({
    handle,
    bridge: agentExtensions,
    window: getMainWindow,
    dialogs: dialog,
    getLocale: getUpdaterLocale,
    getNpmPath: () => readNpmPath(dataDir),
    setNpmPath: (path) => writeNpmPath(dataDir, path),
    importRoot: join(dataDir, "plugins", "imported"),
    loadDevPlugin: async (path) => {
      const currentHost = getHost();
      if (!currentHost) throw new Error("host unavailable");
      const loaded = await currentHost.call<{ plugin: any }>("plugins.loadDev", { path });
      await plugins.loadFromPath(path, loaded.plugin?.permissions ?? [], { development: true });
      if (loaded.plugin?.id) plugins.watchDevPlugin(loaded.plugin.id);
      sendToRenderer(IPC.event.pluginChanged, { reason: "importExtension", pluginId: loaded.plugin?.id });
      return loaded;
    },
    runCommand: async (input) => {
      const currentSidecar = getSidecar();
      if (!currentSidecar) throw new Error("agent sidecar unavailable");
      return currentSidecar.call<{ handled: boolean }>("extensions.command.run", input);
    },
  });
  registerAgentIpc({
    subagentSnapshots: dependencies.subagentSnapshots,
    registrar,
    getHost,
    getSidecar,
    getAgentHostBridge,
    cancelSessionTools: (sessionId: string, reason?: string) => {
      plugins.cancelSessionTools(sessionId, reason);
      userMcp.cancelSessionCalls(sessionId);
    },
    logger,
    agentExtensions,
    persistenceOutbox,
    queuedSteeringJournal,
    dataDir,
    activeTurns,
    completionNoticeTurns,
    recordTurnStart,
    observePersistedUserMessage: dependencies.observePersistedUserMessage,
    scheduledRunsBySession,
    isTurnDispatchable,
    activeTurnUsages,
    approvedExecutionIdsBySession,
    claimedExecutionSessions,
    resolveAgentRuntimeLaunch,
    acquireSessionOperation,
    sessionConfiguration,
    finishTurn,
    lockAbortReason,
    finishApprovedExecution,
    dispatchApprovedPlan,
    dispatchExecutionForProposal,
    emitAgentEvent,
    setNotificationViewingSessionId,
    optionalWorkspaceRoot,
    composerCommandService,
    loadComposerTemplatesCached,
    modeRuns: dependencies.modeServices.runs,
  });

  registerPluginIpc({
    registrar,
    getHost,
    plugins,
    agentExtensions,
    browserHost,
    pluginViews,
    pluginScopes,
    rememberPluginScopes,
    sendToRenderer,
    logger,
  });


  registerMcpIpc({
    registrar,
    getHost,
    userMcp,
    oauth: mcpOAuth,
    currentWorkspacePath,
    refreshUserMcp,
    describeError,
    sendToRenderer,
    searchMcpMarket,
  });


  registerSkillsIpc({
    registrar,
    getHost,
    searchSkillMarket,
    fetchSkillMarketDocument,
    optionalWorkspaceRoot,
    activeUserSubagentDocuments,
    disabledBuiltinSubagents,
    disabledBuiltinSkills,
    stripWinLongPrefix,
    sendToRenderer,
    logger,
  });


  registerAgentImportIpc({
    registrar,
    getHost,
    sendToRenderer,
    refreshUserMcp,
    currentWorkspacePath,
  });

  registerPluginUiIpc({
    registrar,
    plugins,
    browserHost,
    pluginViews,
    pluginPanels,
    pluginActiveInProject,
    currentWorkspacePath,
    getUpdaterLocale,
    getPluginPanelTheme,
    setActivePluginSession,
    settleComposerSuggestion,
  });
  registerPluginLauncherIpc({
    registrar,
    getHost,
    getPluginLauncherWindow,
    plugins,
    localApps,
    getLocale: getUpdaterLocale,
    openPluginMarket,
  });
  registerSpeechIpc({ registrar, speech });

  if (liveCallService) {
    registerLiveVoiceIpc({ registrar, service: liveCallService, getMainWindow });
  }

  registerRemoteHostIpc({ registrar });

  registerMarketIpc({
    registrar,
    getHost,
    plugins,
    agentExtensions,
    optionalWorkspaceRoot,
    pluginActiveInProject,
    sendToRenderer,
  });


  registerDiagnosticsIpc({
    registrar,
    dataDir,
    stripWinLongPrefix,
    isDeveloperMode,
    getMainWindow,
  });

  registerStartupAnimationIpc({ registrar, dataDir, stripWinLongPrefix });

  plugins?.setServices?.({
    invokeIpc: invokeRegisteredIpc,
    getRendererRoot: () => join(getModuleDirectory(import.meta.url), "../renderer").replace(/\.asar([/\\])/, ".asar.unpacked$1"),
    readRendererFile: createRendererFileReader({
      isRemote: async (sessionId) => Boolean(await remoteWorkspaceForFiles(getHost, sessionId, getSidecar)),
      resolve: async (input) => {
        const result = await invokeRegisteredIpc(IPC.invoke.fsResolveRef, { ref: input.path, sessionId: input.sessionId });
        if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
        return result.data as import("@pi-desktop/shared").FsChatRefResolveResult;
      },
    }),
    readRendererResource: async (url: string) => {
      if (!/^(pi-genui|plugin-renderer|plugin-asset|appearance-media):\/\//.test(url)) {
        throw new Error("unsupported renderer resource");
      }
      const response = await net.fetch(url);
      const headers: Record<string, string> = {};
      for (const name of ["content-type", "content-security-policy"]) {
        const value = response.headers.get(name);
        if (value) headers[name] = value;
      }
      return { status: response.status, headers, body: Buffer.from(await response.arrayBuffer()).toString("base64") };
    },
    importUploadedFiles: async (input: { sessionId?: string; draftId?: string; files: Array<{ path: string; name?: string }> }) => {
      const token = rememberComposerPickerSelection(input.files.map((file) => file.path), internalSender().id);
      const result = await invokeRegisteredIpc(IPC.invoke.composerImportFiles, { sessionId: input.sessionId, draftId: input.draftId, token });
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      const imported = result.data as { files: Array<{ path: string; name: string }> };
      return { ...imported, files: imported.files.map((file, index) => ({ ...file, name: input.files[index]?.name || file.name })) };
    },
  });


  return async (channel: string, args: readonly unknown[] = []) => {
    const handler = ipcHandlers.get(channel);
    if (!handler) {
      throw Object.assign(new Error(`IPC channel is not available to external agents: ${channel}`), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    return handler(...args);
  };
}
