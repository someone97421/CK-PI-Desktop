import { app, dialog, shell } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import { storageOverridden } from "../installation";
import type { Logger } from "../logger";
import {
  createRendererCrashLoopFallback,
  type RendererCrashLoopFallback,
} from "../renderer-crash-loop";

/** Use the confirmed quit path to flush running turns before exiting. */
export function createWindowRendererCrashLoopFallback({
  state,
  dataDir,
  logger,
  isRendererStable,
}: Readonly<{
  state: { quitConfirmed: boolean };
  dataDir: string;
  logger: Pick<Logger, "app">;
  isRendererStable: () => boolean;
}>): RendererCrashLoopFallback {
  const quit = () => {
    state.quitConfirmed = true;
    app.quit();
  };
  const showTerminalDialog = async () => {
    const labels = catalogs[resolveLocale(app.getLocale())];
    const { response } = await dialog.showMessageBox({
      type: "error",
      title: labels.rendererCrash.title,
      message: labels.rendererCrash.body,
      buttons: [labels.rendererCrash.openLogs, labels.tray.quit],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) {
      const logs = join(dataDir, "logs");
      mkdirSync(logs, { recursive: true });
      await shell.openPath(logs);
    }
    quit();
  };
  return createRendererCrashLoopFallback({
    // Installation has already restored the fork profile after taking the lock.
    markerDir: app.getPath("userData"),
    logger,
    isRendererStable,
    relaunch: () => {
      const args = process.argv.slice(1);
      if (!storageOverridden && !args.includes("--pi-managed-storage")) {
        args.push("--pi-managed-storage");
      }
      const portableExecutable = process.env.PORTABLE_EXECUTABLE_FILE?.trim();
      app.relaunch({ args, ...(portableExecutable ? { execPath: portableExecutable } : {}) });
      quit();
    },
    showTerminalDialog: () => {
      void showTerminalDialog().catch((error: unknown) => {
        logger.app("diagnostics", "error", "renderer crash-loop dialog failed; quitting", {
          event: "rendererCrashLoop",
          data: { action: "dialog", error: error instanceof Error ? error.message : String(error) },
        });
        quit();
      });
    },
  });
}
