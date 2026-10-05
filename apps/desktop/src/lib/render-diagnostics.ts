export type RenderDiagnosticStage =
  | "chat-link-scan"
  | "markdown-linkify-tree"
  | "markdown-normalize"
  | "markdown-split"
  | "markdown-react-render"
  | "code-highlight";

export type RenderDiagnosticFields = {
  sourceLength?: number;
  longestLine?: number;
  inputNodeCount?: number;
  workCodeUnits?: number;
  linkCount?: number;
  durationMs?: number;
  baseDurationMs?: number;
  startTime?: number;
  commitTime?: number;
  reason?: string;
  renderPhase?: string;
};

export type RenderDiagnosticSample = RenderDiagnosticFields & {
  key: string;
  stage: RenderDiagnosticStage;
  phase: "start" | "end" | "complete";
  at: number;
};

const MAX_SAMPLES = 128;
const samples: RenderDiagnosticSample[] = [];
let sequence = 0;

function enabled(): boolean {
  return typeof import.meta.env !== "undefined" &&
    (import.meta.env.DEV || import.meta.env.MODE === "test");
}

function append(sample: RenderDiagnosticSample): void {
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

export function readRenderDiagnosticSamples(): RenderDiagnosticSample[] {
  return samples.map((sample) => ({ ...sample }));
}

export function clearRenderDiagnosticSamples(): void {
  samples.length = 0;
}

/** Start a bounded, content-free record for the current synchronous phase. */
export function beginRenderDiagnostic(
  stage: RenderDiagnosticStage,
  fields: RenderDiagnosticFields = {},
): (result?: RenderDiagnosticFields) => void {
  if (!enabled()) return () => undefined;
  const key = `render-${++sequence}`;
  const startedAt = performance.now();
  append({ key, stage, phase: "start", at: startedAt, ...fields });
  return (result = {}) => {
    const at = performance.now();
    append({
      key,
      stage,
      phase: "end",
      at,
      durationMs: at - startedAt,
      ...fields,
      ...result,
    });
  };
}

/** Add a completed render measurement supplied by React Profiler. */
export function recordRenderDiagnostic(
  stage: RenderDiagnosticStage,
  fields: RenderDiagnosticFields = {},
): void {
  if (!enabled()) return;
  append({
    key: `render-${++sequence}`,
    stage,
    phase: "complete",
    at: performance.now(),
    ...fields,
  });
}

declare global {
  interface Window {
    __piDesktopRenderDiagnostics?: {
      clear: typeof clearRenderDiagnosticSamples;
      read: typeof readRenderDiagnosticSamples;
    };
  }
}

if (enabled() && typeof window !== "undefined") {
  window.__piDesktopRenderDiagnostics = {
    clear: clearRenderDiagnosticSamples,
    read: readRenderDiagnosticSamples,
  };
}
