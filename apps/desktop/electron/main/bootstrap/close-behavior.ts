import { dialog, type BrowserWindow } from "electron";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import { IPC, type CloseBehavior } from "@pi-desktop/shared";
import { randomUUID } from "node:crypto";
import {
  readCloseBehavior,
  writeCloseBehavior,
} from "../window-preferences";
import type { WindowLifecycleState } from "./window";

export type CloseBehaviorDependencies = {
  state: WindowLifecycleState;
  dataDir: string;
  getLocale: () => string;
  createTray: () => void;
};

export function createCloseBehaviorRuntime({
  state,
  dataDir,
  getLocale,
  createTray,
}: CloseBehaviorDependencies) {
  let pending: { id: string; finish: (choice: "tray" | "quit" | null) => void } | null = null;

  const respondClosePrompt = (id: string, choice: "tray" | "quit" | null) => {
    if (pending?.id !== id) return false;
    pending.finish(choice);
    return true;
  };

  const showClosePrompt = (window: BrowserWindow, kind: "close" | "quit") => {
    if (window.isDestroyed() || window.webContents.isLoadingMainFrame()) return Promise.resolve(null);
    pending?.finish(null);
    return new Promise<"tray" | "quit" | null>((resolve) => {
      const id = randomUUID();
      const cancel = () => finish(null);
      const finish = (choice: "tray" | "quit" | null) => {
        if (pending?.id !== id) return;
        pending = null;
        window.removeListener("closed", cancel);
        window.webContents.removeListener("did-start-loading", cancel);
        window.webContents.removeListener("render-process-gone", cancel);
        resolve(kind === "quit" && choice === "tray" ? null : choice);
      };
      pending = { id, finish };
      window.once("closed", cancel);
      window.webContents.once("did-start-loading", cancel);
      window.webContents.once("render-process-gone", cancel);
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      window.webContents.send(IPC.event.closePrompt, { id, kind });
    });
  };
  const applyCloseBehavior = (next: CloseBehavior): void => {
    state.closeBehavior = next;
    writeCloseBehavior(dataDir, next);
    if (next === "tray") createTray();
  };

  const askCloseBehavior = async (
    window: BrowserWindow,
  ): Promise<"tray" | "quit" | null> => {
    return showClosePrompt(window, "close");
  };

  const confirmQuitDialog = async (): Promise<boolean> => {
    const labels = catalogs[resolveLocale(getLocale())];
    const parent =
      state.mainWindow && !state.mainWindow.isDestroyed()
        ? state.mainWindow
        : undefined;
    if (parent) return (await showClosePrompt(parent, "quit")) === "quit";
    const options = {
      type: "warning" as const,
      title: labels.tray.confirmQuitTitle,
      message: labels.tray.confirmQuitTitle,
      detail: labels.tray.confirmQuitBody,
      buttons: [labels.common.cancel, labels.tray.confirmQuit],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const { response } = await dialog.showMessageBox(options);
    return response === 1;
  };

  return {
    applyCloseBehavior,
    askCloseBehavior,
    confirmQuitDialog,
    readCloseBehavior: () => readCloseBehavior(dataDir),
    respondClosePrompt,
  };
}
