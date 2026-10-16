import { app, dialog } from "electron";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { APP_ID, APP_SLUG } from "@pi-desktop/shared";
import { configureApplicationIdentity } from "./application-identity";
import { readConfiguredDataDirectory } from "./storage/legacy";
import { runBackupLockProcess } from "./storage/backup-lock";
import { ignoreBrokenStdio } from "./logger";
import { installMainProcessErrorHandlers } from "./main-process-errors";
import { readStoragePreferences, STORAGE_PREFERENCE_FILE } from "./storage/preferences";
import { initialTemporaryWorkspaceCommandLine } from "./temporary-workspace";

export const isBackupLockProcess = runBackupLockProcess();
export const isDevelopmentBuild = process.env.PI_DESKTOP_DEV === "1" || !app.isPackaged;
export let defaultDataDir = "";
export let storageOverridden = false;
export let hasSingleInstanceLock = false;
export let initialTemporaryWorkspace: string | null = null;

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
    const preferences = storageOverridden ? null : readStoragePreferences(preferenceFile, {
      data: defaultDataDir, browser: join(storageAnchor, "chromium"),
    });
    if (existsSync(preferenceFile) && preferences &&
        (!existsSync(preferences.roots.data) || !existsSync(preferences.roots.browser))) {
      throw new Error("所选存储目录不可用，请先重新连接其所在磁盘。");
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
  app.commandLine.appendSwitch("disable-renderer-accessibility");
  if (process.platform === "win32") app.setAppUserModelId(app.isPackaged ? APP_ID : `${APP_ID}.dev`);
  app.on("will-quit", () => {
    if (startupDataDirectoryEnvironment === undefined) delete process.env.PI_DESKTOP_DATA_DIR;
    else process.env.PI_DESKTOP_DATA_DIR = startupDataDirectoryEnvironment;
  });
}
