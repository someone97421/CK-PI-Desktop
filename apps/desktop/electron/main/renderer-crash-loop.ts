import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./logger";

/**
 * Crash-loop fallback (issue #2595): a renderer that crashes on every
 * startup turns automatic recovery into an endless reload loop — the window
 * never finishes loading, so the user sees a black screen and a flashing
 * taskbar icon. When the breaker in `renderer-recovery.ts` trips, the first
 * trip relaunches once without hardware acceleration, a common mitigation
 * for renderer crashes at startup. The cause on the affected machines is
 * not established; the marker only records that the attempt was spent, so
 * a loop that survives it surfaces a dialog instead of relaunching forever.
 *
 * The marker lives in the installation's `userData` directory, which is
 * known synchronously before `ready`: boot reads it there to disable
 * hardware acceleration (see `installation.ts`), so manual launches are
 * covered too. A fallback run that stays healthy for
 * `GPU_FALLBACK_STABLE_MS` without a renderer crash clears the marker, so a
 * later boot returns to hardware acceleration.
 */

export const GPU_FALLBACK_STABLE_MS = 10 * 60_000;

export function gpuFallbackMarkerPath(markerDir: string): string {
  return join(markerDir, "renderer-crash-loop.json");
}

/**
 * Whether the one GPU-fallback relaunch is spent. Presence alone decides, so
 * an unreadable or corrupt marker still counts as spent; never throws.
 */
export function hasGpuFallbackMarker(markerDir: string): boolean {
  return existsSync(gpuFallbackMarkerPath(markerDir));
}

/** Persist the spent fallback. Throws when the marker cannot be written. */
export function writeGpuFallbackMarker(markerDir: string): void {
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(
    gpuFallbackMarkerPath(markerDir),
    JSON.stringify({ gpuFallbackAt: new Date().toISOString() }),
    { encoding: "utf8", flag: "wx" },
  );
}

/** Remove the marker. Throws when an existing marker cannot be removed. */
export function clearGpuFallbackMarker(markerDir: string): void {
  rmSync(gpuFallbackMarkerPath(markerDir), { force: true });
}

type TimerHandle = ReturnType<typeof setTimeout>;

export type RendererCrashLoopFallbackDependencies = Readonly<{
  markerDir: string;
  logger: Pick<Logger, "app">;
  /** Restart the app through the confirmed-quit path. */
  relaunch: () => void;
  /** Tell the user automatic recovery stopped; owns quit / open-logs. */
  showTerminalDialog: () => void;
  isRendererStable: () => boolean;
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}>;

export type RendererCrashLoopFallback = Readonly<{
  /** The main frame finished loading. */
  rendererLoaded: () => void;
  /** The main frame started replacing its document, or its renderer exited. */
  rendererInterrupted: () => void;
  /** The recovery breaker tripped for this window's renderer. */
  crashLoopDetected: () => void;
  /** The owning window closed. */
  dispose: () => void;
}>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One controller per main window. The stable-uptime timer belongs to the
 * renderer that is currently loaded: a crash, a newer load, terminal
 * escalation, or window disposal cancels it, so a marker is only cleared
 * after continuous healthy uptime of a single renderer.
 */
export function createRendererCrashLoopFallback(
  dependencies: RendererCrashLoopFallbackDependencies,
): RendererCrashLoopFallback {
  const { markerDir, logger } = dependencies;
  const setTimer = dependencies.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = dependencies.clearTimer ?? ((handle) => clearTimeout(handle));
  let stableTimer: TimerHandle | null = null;
  let settled = false;

  const log = (level: "info" | "warn" | "error", message: string, data: Record<string, unknown>) =>
    logger.app("diagnostics", level, message, { event: "rendererCrashLoop", data });

  const cancelStableTimer = () => {
    if (stableTimer === null) return;
    clearTimer(stableTimer);
    stableTimer = null;
  };

  const escalateToDialog = (data: Record<string, unknown>, message: string) => {
    settled = true;
    log(data.error === undefined ? "warn" : "error", message, { action: "dialog", ...data });
    dependencies.showTerminalDialog();
  };

  return {
    rendererLoaded() {
      cancelStableTimer();
      if (settled || !hasGpuFallbackMarker(markerDir)) return;
      stableTimer = setTimer(() => {
        stableTimer = null;
        if (!dependencies.isRendererStable()) return;
        try {
          clearGpuFallbackMarker(markerDir);
          log("info", "renderer stayed healthy without GPU acceleration; cleared fallback marker", {
            action: "clear-marker",
          });
        } catch (error) {
          log("warn", "could not clear renderer crash-loop fallback marker", {
            action: "clear-marker",
            error: errorMessage(error),
          });
        }
      }, GPU_FALLBACK_STABLE_MS);
    },
    rendererInterrupted: cancelStableTimer,
    crashLoopDetected() {
      cancelStableTimer();
      if (settled) return;
      if (hasGpuFallbackMarker(markerDir)) {
        escalateToDialog(
          {},
          "renderer crash loop persists without GPU acceleration; stopping automatic reloads",
        );
        return;
      }
      try {
        writeGpuFallbackMarker(markerDir);
      } catch (error) {
        // Without a persisted marker the relaunch has no deduplication guard
        // and could loop across processes; stop here and tell the user.
        escalateToDialog(
          { error: errorMessage(error) },
          "could not persist renderer crash-loop fallback marker; stopping automatic reloads",
        );
        return;
      }
      settled = true;
      try {
        dependencies.relaunch();
        log("warn", "renderer crash loop detected; relaunching without GPU acceleration", {
          action: "relaunch-disable-gpu",
        });
      } catch (error) {
        escalateToDialog(
          { error: errorMessage(error) },
          "could not relaunch after renderer crash loop; stopping automatic reloads",
        );
      }
    },
    dispose() {
      cancelStableTimer();
      settled = true;
    },
  };
}
