import { app, dialog } from "electron";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { APP_ID, APP_SLUG } from "@pi-desktop/shared";
import { configureApplicationIdentity } from "./application-identity";
import { readConfiguredDataDirectory } from "./storage/legacy";
import { runBackupLockProcess } from "./storage/backup-lock";
import { ignoreBrokenStdio } from "./logger";
import { installMainProcessErrorHandlers } from "./main-process-errors";
import { readStoragePreferences, STORAGE_PREFERENCE_FILE } from "./storage/preferences";
import { sameStorageRoots } from "./storage/startup-recovery";
import { initialTemporaryWorkspaceCommandLine } from "./temporary-workspace";

export const isBackupLockProcess = runBackupLockProcess();
export const isDevelopmentBuild = process.env.PI_DESKTOP_DEV === "1" || !app.isPackaged;
export let defaultDataDir = "";
export let storageOverridden = false;
export let hasSingleInstanceLock = false;
export let initialTemporaryWorkspace: string | null = null;

const pendingMacWorkspacePaths: string[] = [];
let macWorkspaceLaunchHandler: ((workspacePath: string) => void) | undefined;

export function onMacTemporaryWorkspaceLaunch(handler: (workspacePath: string) => void): void {
  macWorkspaceLaunchHandler = handler;
  for (const workspacePath of pendingMacWorkspacePaths.splice(0)) handler(workspacePath);
}

if (!isBackupLockProcess) {
  ignoreBrokenStdio();
  installMainProcessErrorHandlers();
  // 应用内重启继承的是传给子进程的目录，不是用户显式设置的覆盖项。
  if (process.argv.includes("--pi-managed-storage")) delete process.env.PI_DESKTOP_DATA_DIR;
  const startupDataDirectoryEnvironment = process.env.PI_DESKTOP_DATA_DIR;
  storageOverridden = Boolean(startupDataDirectoryEnvironment?.trim());
  initialTemporaryWorkspace = initialTemporaryWorkspaceCommandLine();
  const storageAnchor = join(app.getPath("appData"), APP_SLUG);
  const preferenceFile = join(storageAnchor, STORAGE_PREFERENCE_FILE);
  let effectiveDataDirectory: string;
  try {
    // 旧配置只作首次导入；已有新指针时不再读取可能离线的旧目录。
    const legacyDirectory = !storageOverridden && !existsSync(preferenceFile)
      ? readConfiguredDataDirectory(app.getPath("appData")) : undefined;
    defaultDataDir = resolve(startupDataDirectoryEnvironment?.trim() || legacyDirectory || join(homedir(), ".pi-desktop"));
    const defaults = { data: defaultDataDir, browser: join(storageAnchor, "chromium") };
    const preferences = storageOverridden ? null : readStoragePreferences(preferenceFile, defaults);
    if (existsSync(preferenceFile) && preferences) {
      const missingData = !existsSync(preferences.roots.data);
      const missingBrowser = !existsSync(preferences.roots.browser);
      const canRecoverDefault = sameStorageRoots(preferences.roots, defaults) && missingData
        && (!preferences.pending || (preferences.pending.kind === "migrate" && !missingBrowser));
      if ((missingData || missingBrowser) && !canRecoverDefault) {
        throw new Error("所选存储目录不可用，请先重新连接其所在磁盘。");
      }
    }
    effectiveDataDirectory = preferences?.roots.data ?? defaultDataDir;
  } catch (error) {
    dialog.showErrorBox("无法读取数据存储位置", `请确认数据目录可用，并检查 ${storageAnchor} 中的存储位置配置。\n\n${error instanceof Error ? error.message : String(error)}`);
    app.exit(1);
    throw error;
  }
  // 在冷维护和业务初始化前同步取得真实目录锁，不让 ready 早于 profile 配置。
  ({ hasSingleInstanceLock } = configureApplicationIdentity(app, {
    dataDir: effectiveDataDirectory, temporaryWorkspacePath: initialTemporaryWorkspace,
  }));
  if (!hasSingleInstanceLock) app.exit(0);
  if (hasSingleInstanceLock && process.platform === "darwin") {
    // 冷启动的文件打开事件可能早于存储准备及业务入口加载。
    app.on("open-file", (event, path) => {
      event.preventDefault();
      try {
        if (!statSync(path).isDirectory()) return;
      } catch {
        return;
      }
      const workspacePath = resolve(path);
      if (macWorkspaceLaunchHandler) macWorkspaceLaunchHandler(workspacePath);
      else pendingMacWorkspacePaths.push(workspacePath);
    });
  }
  app.commandLine.appendSwitch("disable-renderer-accessibility");
  if (process.platform === "win32") app.setAppUserModelId(app.isPackaged ? APP_ID : `${APP_ID}.dev`);
  app.on("will-quit", () => {
    if (startupDataDirectoryEnvironment === undefined) delete process.env.PI_DESKTOP_DATA_DIR;
    else process.env.PI_DESKTOP_DATA_DIR = startupDataDirectoryEnvironment;
  });
}
