import { runElapsedMs, type RunTiming } from "@pi-desktop/shared";

/** 人工等待只暂停计时；不改变代理、工具或审批的执行状态。 */
export class RunClock {
  private timing?: RunTiming;

  reset(now = Date.now()): void {
    this.timing = { startedAt: now, pausedMs: 0 };
  }

  setPaused(paused: boolean, now = Date.now()): boolean {
    const timing = this.timing;
    if (!timing || timing.endedAt !== undefined || paused === (timing.pausedAt !== undefined)) return false;
    this.timing = paused
      ? { ...timing, pausedAt: now }
      : { ...timing, pausedAt: undefined, pausedMs: timing.pausedMs + Math.max(0, now - timing.pausedAt!) };
    return true;
  }

  finish(now = Date.now()): boolean {
    if (!this.timing || this.timing.endedAt !== undefined) return false;
    this.timing = { ...this.timing, endedAt: now };
    return true;
  }

  snapshot(): RunTiming | undefined {
    return this.timing ? { ...this.timing } : undefined;
  }

  elapsedMs(now = Date.now()): number {
    return this.timing ? runElapsedMs(this.timing, now) : 0;
  }
}
