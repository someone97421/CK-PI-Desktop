import { dialog } from "electron";
import { randomUUID } from "node:crypto";
import { IPC, type StorageInfo } from "@pi-desktop/shared";
import type { IpcRegistrar } from "../ipc/types";
import type { BrowserWindow } from "electron";
import { cacheSize, validateTarget } from "./files";
import { getStorageBootstrap, requestStorageRestart } from "./bootstrap";
import { writeStoragePreferences, type StorageJob } from "./preferences";

let busy = false;
function requireManaged() {
  const state = getStorageBootstrap();
  if (!state.managed) throw new Error("Storage is controlled by PI_DESKTOP_DATA_DIR.");
  if (busy || state.preferences.pending) throw new Error("A storage operation is already pending.");
  return state;
}
function schedule(job: StorageJob, restart: () => void): void {
  const state = getStorageBootstrap();
  const preferences = { ...state.preferences, pending: job, lastError: undefined };
  writeStoragePreferences(state.file, preferences);
  state.preferences = preferences;
  restart();
}
/** 旧数据目录 IPC 与新存储卡片共用同一迁移入口。 */
export async function migrateStorageDirectory(path: string, language: string, restart = requestStorageRestart): Promise<void> {
  const state = requireManaged();
  busy = true;
  try {
    const failed = state.preferences.failedMigration;
    const retryId = failed?.target === path ? failed.id : undefined;
    const target = await validateTarget(path, state.preferences.roots, state.anchor, retryId);
    schedule({ id: retryId ?? randomUUID(), kind: "migrate", target, language }, restart);
  } finally { busy = false; }
}

type Dependencies = { registrar: IpcRegistrar; getMainWindow: () => BrowserWindow | null; restart: () => void };
export function registerStorageIpc({ registrar, getMainWindow, restart }: Dependencies): void {
  let chosen: string | null = null;
  const language = (input: unknown): string => {
    if (!input || typeof input !== "object" || !("language" in input) || typeof input.language !== "string" || input.language.length > 32) throw new Error("Invalid storage operation language.");
    return input.language;
  };
  registrar.handleWithEvent(IPC.invoke.storageGet, async (event): Promise<StorageInfo> => {
    registrar.assertMainWindowSender(event);
    const state = getStorageBootstrap();
    return { dataPath: state.preferences.roots.data, browserPath: state.preferences.roots.browser,
      managed: state.managed, cacheBytes: await cacheSize(state.preferences.roots),
      pendingPath: state.preferences.pending?.target ?? null, lastError: state.preferences.lastError ?? null,
      backupPaths: state.preferences.backups.flatMap((roots) => [roots.data, roots.browser]) };
  });
  registrar.handleWithEvent(IPC.invoke.storageChoose, async (event) => {
    registrar.assertMainWindowSender(event);
    requireManaged();
    const window = getMainWindow();
    if (!window) throw new Error("Main window unavailable.");
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] });
    chosen = result.canceled ? null : result.filePaths[0] ?? null;
    return chosen;
  });
  registrar.handleWithEvent(IPC.invoke.storageMigrate, async (event, input: unknown) => {
    registrar.assertMainWindowSender(event);
    if (!input || typeof input !== "object" || !("path" in input) || typeof input.path !== "string" || input.path !== chosen) throw new Error("Select the destination with the directory picker first.");
    await migrateStorageDirectory(input.path, language(input), restart);
  });
  for (const [channel, kind] of [[IPC.invoke.storageClearCache, "cache"], [IPC.invoke.storageRemoveBackup, "backup"]] as const) {
    registrar.handleWithEvent(channel, async (event, input: unknown) => {
      registrar.assertMainWindowSender(event);
      const state = requireManaged();
      if (kind === "backup" && !state.preferences.backups.length) throw new Error("No old storage backup exists.");
      schedule({ id: randomUUID(), kind, language: language(input) }, restart);
    });
  }
}
