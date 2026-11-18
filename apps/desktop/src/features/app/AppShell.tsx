import {
  type CSSProperties,
  lazy,
  type ReactNode,
  Suspense,
  useState,
  useRef,
} from "react";
import { ChatSurface } from "../../components/ChatSurface";
import { ConversationTopbar } from "../../components/ConversationTopbar";
import { ExtensionPromptHost } from "../../components/ExtensionPromptDialog";
import { PluginRendererHost } from "../../plugins/renderer-host/PluginRendererHost";
import {
  IconChevronLeft,
  IconNewSession,
  IconPanel,
  IconPanelOpen,
} from "../../components/icons";
import { LifecycleConfirmationDialog } from "../../components/LifecycleConfirmationDialog";
import { ProjectCreateDialog } from "../../components/ProjectCreateDialog";
import { SearchDialog } from "../../components/SearchDialog";
import { Sidebar } from "../../components/Sidebar";
import { StartupRecovery } from "../../components/StartupRecovery";
import { ToastHost } from "../../components/Toast";
import { UpdateBanner } from "../../components/UpdateBanner";
import { cx, TooltipButton } from "../../components/ui";
import { WindowControls } from "../../components/WindowControls";
import { WorkPanel } from "../../components/workpanel/WorkPanel";
import { useCopyTex } from "../../hooks/use-copy-tex";
import { api } from "../../lib/api";
import { PortalVisibilityProvider } from "../../lib/portal-visibility";
import { CollapsedTitlebarActions, RoutePending } from "./chrome";
import { useAppShellRuntime } from "./useAppShellRuntime";

const SettingsPage = lazy(() =>
  import("../../pages/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
);
const PullRequestsPage = lazy(() =>
  import("../../pages/PullRequestsPage").then((module) => ({
    default: module.PullRequestsPage,
  })),
);
const ScheduledPage = lazy(() =>
  import("../../pages/ScheduledPage").then((module) => ({
    default: module.ScheduledPage,
  })),
);
const PluginsPage = lazy(() =>
  import("../../pages/PluginsPage").then((module) => ({
    default: module.PluginsPage,
  })),
);

export function AppShell() {
  const {
    compact,
    compactLayer,
    showCompactChat,
    t,
    ready,
    page,
    activeSessionId,
    subagentPanel,
    subagentPanelOpen,
    closeSubagentPanel,
    workPanelOpen,
    searchOpen,
    setSearchOpen,
    sidebarCollapsed,
    sidebarEntering,
    sidebarExiting,
    sidebarWidth,
    handleSidebarWidthChange,
    handleSidebarWidthCommit,
    toggleSidebar,
    reopenSidebar,
    autoCollapseSidebar,
    appShellRef,
    shellWidth,
    runMenuCommand,
    handleSidebarAnimationEnd,
    presentedWorkPanelOpen,
    workPanelExiting,
    workPanelExitGeneration,
    finishWorkPanelExit,
    togglePresentedWorkPanel,
    workPanelMaximized,
    toggleWorkPanelMaximize,
    backendDown,
    archMismatch,
    setArchMismatch,
    showSplash,
    splash,
    startupPhase,
    startupWaitedMs,
    retryStartup,
    startupRetrying,
    sidebarToggleShortcut,
    workPanelToggleTooltip,
  } = useAppShellRuntime();
  const [toastAnchor, setToastAnchor] = useState<HTMLElement | null>(null);
  const chatVisible = page !== "settings" && (compact ? compactLayer === "chat" : !workPanelMaximized);
  const panelVisible = page !== "settings" && (compact ? compactLayer === "workpanel" : presentedWorkPanelOpen || workPanelExiting);
  const workPanelMounted = useRef(false);
  if (presentedWorkPanelOpen || workPanelExiting) workPanelMounted.current = true;
  useCopyTex();

  // A boot that never reaches the shell gets a surface it can act on instead of
  // a window that only knows how to wait (issue #831). Rendered as a direct child
  // of the shell so it can layer above the splash and below the window controls.
  const startupRecovery =
    startupPhase === "starting" ? null : (
      <StartupRecovery
        phase={startupPhase}
        waitedMs={startupWaitedMs}
        onRetry={retryStartup}
        retrying={startupRetrying}
        down={backendDown}
      />
    );

  let shell: ReactNode = null;
  if (ready) {
    shell = (
      <>
        <PortalVisibilityProvider visible={page !== "settings"}>
          <div
            className="app-chat-shell"
            hidden={page === "settings"}
            inert={page === "settings" ? true : undefined}
          >
            {compact || !sidebarCollapsed || sidebarExiting ? (
              <PortalVisibilityProvider visible={page !== "settings" && (!compact || compactLayer === "projects")}>
                <Sidebar
                  className={cx(sidebarEntering && "is-entering", sidebarExiting && "is-exiting")}
                  onAnimationEnd={handleSidebarAnimationEnd}
                  onToggleSidebar={compact ? showCompactChat : toggleSidebar}
                  compact={compact}
                  inactive={compact && compactLayer !== "projects"}
                  onOpenConversation={compact ? showCompactChat : undefined}
                  sidebarToggleShortcut={sidebarToggleShortcut}
                  sidebarWidth={sidebarWidth}
                  onWidthChange={handleSidebarWidthChange}
                  onWidthCommit={handleSidebarWidthCommit}
                />
              </PortalVisibilityProvider>
            ) : null}

            {!compact && workPanelMaximized && (
              /* 面板占满内容区时，保留标题栏操作。 */
              <div
                className={cx(
                  "window-chrome-row",
                  !sidebarCollapsed && "sidebar-expanded",
                )}
              >
                {sidebarCollapsed && (
                  <CollapsedTitlebarActions
                    onToggleSidebar={toggleSidebar}
                    onNewTask={() => void runMenuCommand("newTask")}
                    sidebarToggleShortcut={sidebarToggleShortcut}
                  />
                )}
                {!sidebarCollapsed && (
                  <TooltipButton
                    type="button"
                    className="title-nav-btn"
                    tooltip={t("nav.newTask")}
                    ariaLabel={t("nav.newTask")}
                    data-nav="new-task"
                    onClick={() => void runMenuCommand("newTask")}
                  >
                    <IconNewSession size={15} />
                  </TooltipButton>
                )}
                <div className="window-chrome-drag" aria-hidden />
              </div>
            )}

            {(compact || !workPanelMaximized) && (
            <PortalVisibilityProvider visible={chatVisible}>
              <section
                ref={setToastAnchor}
                className="main-pane"
                hidden={!chatVisible}
                inert={compact && compactLayer !== "chat" ? true : undefined}
                aria-hidden={compact && compactLayer !== "chat" ? true : undefined}
              >
                {page === "chat" ? (
                  <ConversationTopbar
                    compact={compact}
                    sidebarCollapsed={compact || sidebarCollapsed}
                    workPanelOpen={!compact && presentedWorkPanelOpen}
                    onToggleSidebar={toggleSidebar}
                    onNewTask={() => void runMenuCommand("newTask")}
                    onOpenSearch={() => setSearchOpen(true)}
                  />
                ) : (
                  <div
                    className={cx(
                      "main-titlebar",
                      !compact && presentedWorkPanelOpen && "work-panel-open",
                    )}
                  >
                    {(compact || sidebarCollapsed) && (
                      <div className="main-titlebar-left no-drag">
                        <CollapsedTitlebarActions
                          onToggleSidebar={reopenSidebar}
                          onNewTask={() => void runMenuCommand("newTask")}
                          sidebarToggleShortcut={sidebarToggleShortcut}
                        />
                      </div>
                    )}
                  </div>
                )}
                {page !== "settings" ? <UpdateBanner /> : null}

                {backendDown && (
                  <div
                    className={`backend-banner no-drag ${backendDown.fatal ? "fatal" : "warn"}`}
                    role="status"
                  >
                    <span className="backend-dot" aria-hidden />
                    <span>
                      {backendDown.fatal
                        ? backendDown.message === "GLIBC_UNSUPPORTED"
                          ? t("status.unsupportedGlibc")
                          : backendDown.message === "DB_SCHEMA_TOO_NEW"
                            ? t("status.dbSchemaTooNew", {
                                found: backendDown.schema?.found ?? "?",
                                supported: backendDown.schema?.supported ?? "?",
                              })
                            : t("status.fatal")
                        : t("status.restarting")}
                    </span>
                    {backendDown.fatal && (
                      <button
                        type="button"
                        className="backend-action"
                        onClick={() => void api.openLogs()}
                      >
                        {t("status.openLogs")}
                      </button>
                    )}
                  </div>
                )}

                {archMismatch && (
                  <div className="backend-banner no-drag warn" role="status">
                    <span className="backend-dot" aria-hidden />
                    <span>
                      {t("status.archMismatch", {
                        buildArch: t(
                          `status.archNames.${archMismatch.platform}.${archMismatch.processArch}`,
                          { defaultValue: archMismatch.processArch },
                        ),
                        machineArch: t(
                          `status.archNames.${archMismatch.platform}.${archMismatch.machineArch}`,
                          { defaultValue: archMismatch.machineArch },
                        ),
                      })}
                    </span>
                    <button
                      type="button"
                      className="backend-action"
                      onClick={() => setArchMismatch(null)}
                    >
                      {t("status.dismissArchMismatch")}
                    </button>
                  </div>
                )}

                <div hidden={page !== "chat"} style={page === "chat" ? { display: "contents" } : undefined}>
                  <ChatSurface visible={page === "chat" && chatVisible} />
                </div>
                <Suspense fallback={<RoutePending />}>
                  {page === "pulls" ? (
                    <div className="route-surface route-page">
                      <PullRequestsPage />
                    </div>
                  ) : page === "scheduled" ? (
                    <div className="route-surface route-page">
                      <ScheduledPage />
                    </div>
                  ) : page === "plugins" ? (
                    <div className="route-surface route-page">
                      <PluginsPage />
                    </div>
                  ) : null}
                </Suspense>
              </section>
            </PortalVisibilityProvider>
            )}

            {(presentedWorkPanelOpen || workPanelExiting || (compact && workPanelMounted.current)) && (
              <PortalVisibilityProvider visible={panelVisible}>
                <WorkPanel
                  panelBlocked={searchOpen || !panelVisible}
                  exiting={workPanelExiting}
                  onExitAnimationEnd={() =>
                    finishWorkPanelExit(workPanelExitGeneration.current)
                  }
                  subagentPanel={subagentPanelOpen ? subagentPanel : null}
                  onCloseSubagentPanel={closeSubagentPanel}
                  containerWidth={shellWidth}
                  sidebarWidth={sidebarWidth}
                  sidebarCollapsed={sidebarCollapsed}
                  sidebarExiting={sidebarExiting}
                  onAutoCollapseSidebar={compact || !panelVisible ? undefined : autoCollapseSidebar}
                  maximized={compact || workPanelMaximized}
                  compact={compact}
                  inactive={compact ? compactLayer !== "workpanel" : !panelVisible && !workPanelExiting}
                  onToggleMaximize={toggleWorkPanelMaximize}
                />
              </PortalVisibilityProvider>
            )}

            {compact && compactLayer === "workpanel" && (
              <TooltipButton
                type="button"
                className="compact-panel-back title-nav-btn no-drag"
                tooltip={t("nav.conversation")}
                ariaLabel={t("nav.conversation")}
                onClick={showCompactChat}
              >
                <IconChevronLeft size={15} />
              </TooltipButton>
            )}

            <TooltipButton
              type="button"
              className="app-work-panel-toggle no-drag"
              tooltip={workPanelToggleTooltip}
              ariaLabel={workPanelToggleTooltip}
              aria-pressed={workPanelOpen || presentedWorkPanelOpen}
              disabled={!activeSessionId && !presentedWorkPanelOpen && !workPanelExiting}
              onClick={togglePresentedWorkPanel}
            >
              <span className="app-work-panel-toggle-icon" aria-hidden>
                <IconPanel size={15} />
                <IconPanelOpen size={15} />
              </span>
            </TooltipButton>
          </div>
        </PortalVisibilityProvider>
        {page === "settings" ? (
          <Suspense fallback={<RoutePending />}>
            <SettingsPage compact={compact} />
          </Suspense>
        ) : null}
        <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
        <ToastHost anchorElement={page === "settings" ? null : toastAnchor} />
        <PluginRendererHost />
        <ExtensionPromptHost />
        {page === "settings" ? <UpdateBanner /> : null}
      </>
    );
  }

  return (
    <div
      data-compact-layout={compact ? "true" : undefined}
      data-compact-layer={compact ? compactLayer : undefined}
      ref={appShellRef}
      className={cx(
        "app-shell",
        !ready && "app-shell-boot",
        page === "settings" && ready && "settings-mode",
        sidebarCollapsed && "sidebar-collapsed",
        !compact && workPanelMaximized && "work-panel-maximized",
        showSplash && "is-booting",
      )}
      style={{ "--ds-sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <div className="app-scenic-backdrop" aria-hidden />
      {shell}
      {/* Outside pane stacking; skip splash so the band cannot cover boot chrome. */}
      {/* `showSplash` stays true for as long as the shell is not ready, so a
          bare `!showSplash` test would leave the recovery surface without any
          window controls — the only ones a frameless Windows/Linux window has.
          The controls therefore follow the boot surface that is actually up. */}
      {(ready && !showSplash) || startupPhase !== "starting" ? (
        <WindowControls />
      ) : null}
      <ProjectCreateDialog />
      <LifecycleConfirmationDialog />
      {splash}
      {startupRecovery}
    </div>
  );
}
