/** 一轮主代理运行的计时快照；仅扣除阻塞主代理的人工等待。 */
export type RunTiming = {
  startedAt: number;
  pausedMs: number;
  pausedAt?: number;
  endedAt?: number;
};

export function runElapsedMs(timing: RunTiming, now = Date.now()): number {
  const end = timing.endedAt ?? now;
  return Math.max(0, Math.min(end, timing.pausedAt ?? end) - timing.startedAt - timing.pausedMs);
}
