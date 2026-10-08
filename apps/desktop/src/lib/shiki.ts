import type { ThemedToken } from "shiki/core";
import { inspectHighlightLimits } from "./render-content-limits.ts";
import { beginRenderDiagnostic } from "./render-diagnostics.ts";
import type { HighlightCommand, HighlightReply, HighlightRequest } from "./shiki-protocol.ts";
export { resolveLang, themeForMode, type ThemeMode } from "./shiki-languages.ts";

type Tokens = ThemedToken[][] | null;
export type HighlightWorker = {
  onmessage: ((event: MessageEvent<HighlightReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage: (command: HighlightCommand) => void;
  terminate: () => void;
};
type Job = {
  request: HighlightRequest;
  key: string;
  canceled: boolean;
  done: (tokens: Tokens) => void;
};

// 只存有界指纹，不长期保留对话原文；主题切换也不重试已失败的内容。
function failureKey(code: string, lang: string): string {
  let a = 2166136261;
  let b = 5381;
  for (let i = 0; i < code.length; i++) {
    a = Math.imul(a ^ code.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ code.charCodeAt(i);
  }
  return `${lang}:${code.length}:${a >>> 0}:${b >>> 0}`;
}

/** 单 Worker 串行执行；流式更新只保留每个代码块最新的等待请求。 */
export class HighlightService {
  private worker: HighlightWorker | null = null;
  private active: Job | null = null;
  private queue = new Map<string, Job>();
  private failures = new Set<string>();
  private failedLanguages = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sequence = 0;
  private disabled = false;
  private loaded = false;
  private finishDiagnostic: ((result?: { reason: string }) => void) | undefined;

  private createWorker: () => HighlightWorker;
  private timeoutMs: number;
  private loadTimeoutMs: number;

  constructor(createWorker: () => HighlightWorker, timeoutMs = 1500, loadTimeoutMs = 15_000) {
    this.createWorker = createWorker;
    this.timeoutMs = timeoutMs;
    this.loadTimeoutMs = loadTimeoutMs;
  }

  request(owner: string, code: string, lang: string, theme: string, done: Job["done"]): () => void {
    this.queue.delete(owner);
    if (this.disabled || !inspectHighlightLimits(code).within || this.failedLanguages.has(lang)) {
      done(null);
      return () => {};
    }
    const key = failureKey(code, lang);
    const job: Job = {
      request: { type: "highlight", id: ++this.sequence, owner, code, lang, theme },
      key, canceled: false, done,
    };
    if (this.failures.has(key)) {
      done(null);
    } else {
      this.queue.set(owner, job);
      this.pump();
    }
    return () => {
      job.canceled = true;
      if (this.queue.get(owner) === job) this.queue.delete(owner);
    };
  }

  release(owner: string): void {
    this.queue.delete(owner);
    if (this.active?.request.owner === owner) this.active.canceled = true;
    this.worker?.postMessage({ type: "release", owner });
  }

  dispose(): void {
    this.disabled = true;
    this.resetWorker();
    this.settle(null, "disposed");
  }

  private resetWorker(): void {
    clearTimeout(this.timer);
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
  }

  private rememberFailure(key: string): void {
    this.failures.add(key);
    if (this.failures.size > 256) this.failures.delete(this.failures.values().next().value!);
  }

  private armTimeout(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.active) return;
      this.rememberFailure(this.active.key);
      if (!this.loaded) this.failedLanguages.add(this.active.request.lang);
      this.resetWorker();
      this.settle(null, "timeout");
    }, ms);
  }

  private settle(tokens: Tokens, reason: string): void {
    clearTimeout(this.timer);
    const job = this.active;
    this.active = null;
    this.finishDiagnostic?.({ reason });
    this.finishDiagnostic = undefined;
    try {
      if (job && !job.canceled) job.done(tokens);
    } finally {
      // 避免一批纯文本回退造成递归调用。
      queueMicrotask(() => this.pump());
    }
  }

  private pump(): void {
    if (this.active) return;
    for (const [owner, job] of this.queue) {
      this.queue.delete(owner);
      if (job.canceled) continue;
      if (this.disabled || this.failures.has(job.key) || this.failedLanguages.has(job.request.lang)) {
        job.done(null);
        continue;
      }
      this.active = job;
      this.loaded = false;
      this.finishDiagnostic = beginRenderDiagnostic("code-highlight", { sourceLength: job.request.code.length });
      try {
        if (!this.worker) {
          const worker = this.createWorker();
          this.worker = worker;
          worker.onmessage = ({ data }) => {
            if (worker !== this.worker || data.id !== this.active?.request.id) return;
            if (data.type === "loaded") {
              this.loaded = true;
              this.armTimeout(this.timeoutMs);
            } else {
              if (!data.tokens && this.active) this.rememberFailure(this.active.key);
              this.settle(data.tokens, data.tokens ? "complete" : "fallback");
            }
          };
          worker.onerror = () => {
            if (worker !== this.worker) return;
            // 启动/加载脚本失败时本窗口退回纯文本，避免反复创建失败的 Worker。
            this.disabled = true;
            this.resetWorker();
            this.settle(null, "worker-error");
          };
        }
        this.armTimeout(this.loadTimeoutMs);
        this.worker.postMessage(job.request);
      } catch {
        this.disabled = true;
        this.resetWorker();
        this.settle(null, "worker-unavailable");
      }
      return;
    }
  }
}

export const highlightService = new HighlightService(() =>
  new Worker(new URL("./shiki.worker.ts", import.meta.url), { type: "module" }),
);
