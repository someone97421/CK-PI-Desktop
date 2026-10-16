import { app, dialog, shell } from "electron";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import { getStorageBootstrap } from "./storage/bootstrap";
import { migrateStorageDirectory } from "./storage/ipc";

export { finishStorageRestart as finishDataDirectoryRestart, isRestartingForStorage as isRestartingForDataDirectory } from "./storage/bootstrap";

export { dataDirectoryConfigPath, readConfiguredDataDirectory } from "./storage/legacy";

export function getDataDirectoryState(dataDir: string) {
  return { path: dataDir, overriddenByEnvironment: !getStorageBootstrap().managed };
}
export async function openDataDirectory(dataDir: string): Promise<void> {
  const error = await shell.openPath(dataDir);
  if (error) throw new Error(error);
}
let choosingDirectory = false;
/** 旧 IPC 保留原生选择与确认交互，实际复制交给上游存储任务。 */
export async function changeDataDirectory(dataDir: string, language?: unknown): Promise<{ canceled: boolean; restarting?: boolean }> {
  const state = getStorageBootstrap();
  if (!state.managed) throw new Error("当前数据目录由 PI_DESKTOP_DATA_DIR 环境变量指定，请先取消该覆盖");
  if (choosingDirectory || state.preferences.pending) throw new Error("正在更改数据存储位置，请稍候");
  choosingDirectory = true;
  try {
    const locale = resolveLocale(typeof language === "string" && language !== "auto" ? language : app.getLocale());
    const copy = catalogs[locale].settings.storage;
    const picked = await dialog.showOpenDialog({ title: copy.migrateTitle, defaultPath: dataDir, properties: ["openDirectory", "createDirectory"] });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
    const result = await dialog.showMessageBox({
      type: "question", title: copy.migrateTitle, message: copy.migrateHint,
      detail: `${copy.source}: ${dataDir}\n${copy.browserSource}: ${state.preferences.roots.browser}\n${copy.destination}: ${picked.filePaths[0]}\n\n${copy.scope}`,
      buttons: [copy.migrateRestart, catalogs[locale].common.cancel], defaultId: 0, cancelId: 1, noLink: true,
    });
    if (result.response !== 0) return { canceled: true };
    await migrateStorageDirectory(picked.filePaths[0], locale);
    return { canceled: false, restarting: true };
  } finally { choosingDirectory = false; }
}
