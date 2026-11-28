export type RendererGoneDetails = Readonly<{
  reason: string;
  exitCode: number;
}>;

type RendererRecoveryDependencies = Readonly<{
  canReload: () => boolean;
  reload: () => void;
  log: (details: RendererGoneDetails, reloaded: boolean) => void;
  onCrashLoopDetected: () => void;
}>;

const CRASH_COOLDOWN_MS = 2_000;
const CRASH_LOOP_THRESHOLD = 5;

/** Each main window owns its startup crash streak and any scheduled reload. */
export function createRendererRecovery({
  canReload,
  reload,
  log,
  onCrashLoopDetected,
}: RendererRecoveryDependencies) {
  let lastReloadTimestamp = Number.NEGATIVE_INFINITY;
  let consecutiveCrashesWithoutLoad = 0;
  let stopped = false;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelReload = () => {
    if (reloadTimer === undefined) return;
    clearTimeout(reloadTimer);
    reloadTimer = undefined;
  };
  const reloadIfLive = () => {
    reloadTimer = undefined;
    if (stopped || !canReload()) return;
    lastReloadTimestamp = Date.now();
    reload();
  };

  return {
    rendererGone(details: RendererGoneDetails): void {
      if (details.reason === "clean-exit" || stopped || !canReload()) {
        log(details, false);
        return;
      }
      if (++consecutiveCrashesWithoutLoad >= CRASH_LOOP_THRESHOLD) {
        stopped = true;
        cancelReload();
        log(details, false);
        onCrashLoopDetected();
        return;
      }
      log(details, true);
      if (reloadTimer !== undefined) return;
      const delay = CRASH_COOLDOWN_MS - (Date.now() - lastReloadTimestamp);
      if (delay > 0) reloadTimer = setTimeout(reloadIfLive, delay);
      else reloadIfLive();
    },
    rendererLoaded(): void {
      cancelReload();
      consecutiveCrashesWithoutLoad = 0;
    },
    dispose(): void {
      stopped = true;
      cancelReload();
    },
  };
}
