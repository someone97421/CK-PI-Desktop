import { randomUUID } from "node:crypto";
import {
  isReportIntervalSteps,
  type SubagentCollaborationSnapshot,
  type SubagentGuideReceipt,
  type SubagentProgressReport,
  type SubagentStep,
} from "@pi-desktop/shared";
import type { SubagentObserverSnapshot } from "./subagent-checkpoint.js";

const MAX_STEPS = 256;
const MAX_GUIDES = 64;
const MAX_REPORT_STEPS = 16;
const MAX_DETAIL_CHARS = 16_000;

/** 只保留脱敏后的旁路副本；原始完整输出仍由现有转录路径保存。 */
export function redactSubagentData(value: unknown, secrets: readonly string[] = []): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, (key, item) =>
      /^(?:authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)$/i.test(key)
        ? "[REDACTED]" : item) ?? "";
  } catch { text = "[unserializable result]"; }
  for (const secret of secrets) if (secret.length >= 4) text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|cookie)[\\"']*\s*[:=]\s*)(\\?["'])(.*?)\2/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s,"'};]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function clip(text: string, size: number): string {
  return text.length <= size ? text : `${text.slice(0, size)}\n[truncated; inspect transcript by toolCallId]`;
}

export type SubagentObservation =
  | { kind: "report"; report: SubagentProgressReport }
  | { kind: "guide"; guide: SubagentGuideReceipt }
  | { kind: "stop"; source: "user" | "parent" | "session" }
  | { kind: "snapshot" };

/** 计数和报告与模型循环解耦；回调只登记通知，不等待父 Agent。 */
export class SubagentObserver {
  readonly guides: SubagentGuideReceipt[] = [];
  private steps: SubagentStep[] = [];
  private readonly seenSteps = new Set<string>();
  private readonly seenGuides = new Set<string>();
  private pendingReport: SubagentStep[] = [];
  private pendingFrom?: number;
  private pendingTo?: number;
  private pendingCount = 0;
  private pendingErrors = 0;
  private reportSeq = 0;
  private latestReport?: SubagentProgressReport;
  private statement = "";
  private segmentId = 1;
  private execution = 1;
  private segmentCompleted = 0;
  private started = 0;
  private completed = 0;
  private phase: SubagentCollaborationSnapshot["phase"] = "running";
  private stopSource?: SubagentCollaborationSnapshot["stopSource"];

  constructor(
    readonly delegationId: string,
    private interval: number,
    readonly intervalSource: "definition" | "dispatch",
    private readonly notify: (event: SubagentObservation) => void,
    private readonly secrets: readonly string[] = [],
  ) {
    if (!isReportIntervalSteps(interval)) throw new Error("reportIntervalSteps must be a positive safe integer");
  }

  safe(value: unknown, limit = MAX_DETAIL_CHARS): string {
    return clip(redactSubagentData(value, this.secrets), limit);
  }

  get hasGuides(): boolean { return this.guides.some((guide) => guide.status === "accepted"); }
  get stopping(): boolean { return this.phase === "stopping" || this.phase === "finished"; }

  snapshot(): SubagentCollaborationSnapshot {
    return {
      execution: this.execution,
      reportIntervalSteps: this.interval, intervalSource: this.intervalSource,
      segmentId: this.segmentId, segmentCompletedSteps: this.segmentCompleted,
      stepsSinceReport: this.pendingCount, startedSteps: this.started, completedSteps: this.completed,
      phase: this.phase, ...(this.stopSource ? { stopSource: this.stopSource } : {}),
      ...(this.latestReport ? { latestReport: this.latestReport } : {}),
      ...(this.guides.length ? { latestGuide: { ...this.guides.at(-1)! } } : {}),
    };
  }

  begin(toolCallId: string, toolName: string, args: unknown): boolean {
    if (this.seenSteps.has(toolCallId)) return false;
    this.seenSteps.add(toolCallId);
    this.steps.push({ execution: this.execution, seq: ++this.started, segmentId: this.segmentId, toolCallId, toolName,
      args: this.safe(args), startedAt: Date.now(), status: "running" });
    if (this.steps.length > MAX_STEPS) this.steps.shift();
    this.notify({ kind: "snapshot" });
    return true;
  }

  end(toolCallId: string, result: unknown, isError: boolean): void {
    const step = this.steps.find((entry) => entry.toolCallId === toolCallId);
    if (!step || step.endedAt !== undefined) return;
    const safe = redactSubagentData(result, this.secrets);
    step.endedAt = Date.now();
    step.status = isError && /TOOL_ABORTED|operation aborted|cancelled|canceled/i.test(safe) ? "aborted" : isError ? "error" : "success";
    step.result = clip(safe, MAX_DETAIL_CHARS);
    step.truncated = safe.length > MAX_DETAIL_CHARS || step.args.length > MAX_DETAIL_CHARS;
    this.completed += 1;
    this.segmentCompleted += 1;
    this.pendingCount += 1;
    if (step.status !== "success") this.pendingErrors += 1;
    this.pendingFrom ??= step.seq;
    this.pendingTo = step.seq;
    // 只截取本批的头部索引；其余可按步骤号查询，不随 N 无限膨胀。
    if (this.pendingReport.length < MAX_REPORT_STEPS) {
      this.pendingReport.push({ ...step, args: clip(step.args, 240), result: clip(step.result, 400) });
    }
    if (this.pendingCount >= this.interval) this.flush("interval");
    this.notify({ kind: "snapshot" });
  }

  noteStatement(text: string): void { this.statement = this.safe(text, 500); }

  flush(reason: SubagentProgressReport["reason"]): void {
    if (!this.pendingCount) return;
    const now = Date.now();
    const report: SubagentProgressReport = {
      execution: this.execution,
      reportId: `${this.delegationId}:${++this.reportSeq}`, reportSeq: this.reportSeq,
      delegationId: this.delegationId, segmentId: this.segmentId,
      fromStep: this.pendingFrom!, toStep: this.pendingTo!, capturedAt: now, generatedAt: now,
      reason, summary: `${this.pendingCount} tool calls completed; ${this.pendingErrors} failed or cancelled.`,
      steps: this.pendingReport.map((step) => ({ ...step })),
      truncated: this.pendingCount > this.pendingReport.length || this.pendingReport.some((step) => step.truncated || step.args.includes("[truncated") || step.result?.includes("[truncated")),
      ...(this.statement ? { statement: this.statement } : {}),
    };
    this.latestReport = report;
    this.pendingReport = [];
    this.pendingCount = 0;
    this.pendingErrors = 0;
    this.pendingFrom = this.pendingTo = undefined;
    this.notify({ kind: "report", report });
  }

  guide(instruction: string, interval?: number, commandId: string = randomUUID()): SubagentGuideReceipt {
    const existing = this.guides.find((entry) => entry.commandId === commandId);
    if (existing) return { ...existing };
    let reason: string | undefined;
    if (this.seenGuides.has(commandId)) reason = "This command was already processed; its receipt is in the transcript. It will not be reapplied.";
    else if (this.stopping) reason = "The subagent is stopping or has finished.";
    else if (!instruction.trim() || instruction.length > 12_000) reason = "instruction must contain 1–12000 characters.";
    else if (interval !== undefined && !isReportIntervalSteps(interval)) reason = "reportIntervalSteps must be a positive safe integer.";
    else if (interval !== undefined && this.intervalSource === "definition" && interval !== this.interval) reason = "The user's fixed report interval cannot be overridden.";
    else if (this.guides.filter((entry) => entry.status === "accepted").length >= 16) reason = "Too many pending guides; wait for application before sending more.";
    const receipt: SubagentGuideReceipt = {
      delegationId: this.delegationId, commandId, instruction: this.safe(instruction, 12_000),
      ...(interval !== undefined ? { reportIntervalSteps: interval } : {}),
      receivedAt: Date.now(), status: reason ? "rejected" : "accepted", ...(reason ? { reason } : {}),
    };
    if (!reason) this.phase = "guiding";
    this.seenGuides.add(commandId);
    this.guides.push(receipt);
    while (this.guides.length > MAX_GUIDES) {
      const settled = this.guides.findIndex((guide) => guide.status !== "accepted" && guide.status !== "applying");
      if (settled < 0) break;
      this.guides.splice(settled, 1);
    }
    this.notify({ kind: "guide", guide: { ...receipt } });
    return { ...receipt };
  }

  applyGuides(): string | undefined {
    if (this.stopping) return undefined;
    const guides = this.guides.filter((entry) => entry.status === "accepted");
    if (!guides.length) return undefined;
    this.flush("guide");
    for (const guide of guides) {
      guide.status = "applying";
      this.notify({ kind: "guide", guide: { ...guide } });
      if (guide.reportIntervalSteps !== undefined) this.interval = guide.reportIntervalSteps;
    }
    this.segmentId += 1;
    this.segmentCompleted = 0;
    this.statement = "";
    this.phase = "running";
    return guides.map((guide) => `[Parent guidance ${guide.commandId}]\n${guide.instruction}`).join("\n\n");
  }

  guidesApplied(): void {
    for (const guide of this.guides.filter((entry) => entry.status === "applying")) {
      guide.status = "applied";
      guide.appliedAt = Date.now();
      this.notify({ kind: "guide", guide: { ...guide } });
    }
  }

  /** 正常完成后的新一轮；仅刷新分段，不重置累计计数和报告序号。 */
  resume(): void {
    if (this.phase !== "finished" || this.stopSource) throw new Error("Subagent context is not resumable.");
    this.execution += 1;
    this.segmentId += 1;
    this.segmentCompleted = 0;
    this.statement = "";
    this.latestReport = undefined;
    this.phase = "running";
    this.notify({ kind: "snapshot" });
  }

  stop(source: NonNullable<SubagentCollaborationSnapshot["stopSource"]>): void {
    if (this.stopSource) return;
    if (this.phase !== "finished") this.phase = "stopping";
    this.stopSource = source;
    for (const guide of this.guides) if (guide.status === "accepted" || guide.status === "applying") {
      guide.status = "cancelled";
      guide.reason = "Stopping takes precedence over guidance.";
      this.notify({ kind: "guide", guide: { ...guide } });
    }
    this.notify({ kind: "stop", source });
  }

  finish(reason: "completed" | "stopped" | "failed"): void {
    this.flush(reason);
    for (const guide of this.guides) if (guide.status === "accepted" || guide.status === "applying") {
      guide.status = "cancelled";
      guide.reason = `Subagent ${reason} before guidance could apply.`;
      this.notify({ kind: "guide", guide: { ...guide } });
    }
    this.phase = "finished";
    this.notify({ kind: "snapshot" });
  }

  inspect(fromStep = 1, limit = 10, offset = 0): Record<string, unknown> {
    const selected = this.steps.filter((step) => step.seq >= fromStep).slice(0, Math.min(10, Math.max(1, limit)));
    return {
      delegationId: this.delegationId, ...this.snapshot(),
      earliestRetainedStep: this.steps[0]?.seq ?? 1,
      historyTruncated: fromStep < (this.steps[0]?.seq ?? 1),
      recordReference: "Full tool records are retained in the session transcript under toolCallId.",
      steps: selected.map((step) => ({ ...step, args: clip(step.args, 800),
        result: step.result?.slice(offset, offset + 3000),
        nextOffset: (step.result?.length ?? 0) > offset + 3000 ? offset + 3000 : null })),
      nextStep: selected.at(-1)?.seq !== undefined && selected.at(-1)!.seq < this.started ? selected.at(-1)!.seq + 1 : null,
      guides: this.guides.slice(-4).map((guide) => ({ ...guide })),
    };
  }

  exportState(): SubagentObserverSnapshot {
    return {
      execution: this.execution,
      interval: this.interval,
      intervalSource: this.intervalSource,
      segmentId: this.segmentId,
      segmentCompleted: this.segmentCompleted,
      started: this.started,
      completed: this.completed,
      pendingCount: this.pendingCount,
      pendingErrors: this.pendingErrors,
      pendingFrom: this.pendingFrom,
      pendingTo: this.pendingTo,
      reportSeq: this.reportSeq,
      latestReport: this.latestReport ? { ...this.latestReport } : undefined,
      statement: this.statement,
      phase: "finished",
      stopSource: this.stopSource,
      guides: this.guides.map((g) => ({ ...g })),
      steps: this.steps.map((s) => ({ ...s })),
      seenSteps: Array.from(this.seenSteps),
      seenGuides: Array.from(this.seenGuides),
    };
  }

  static restore(
    delegationId: string,
    snapshot: SubagentObserverSnapshot,
    notify: (event: SubagentObservation) => void,
    secrets: readonly string[] = [],
  ): SubagentObserver {
    const observer = new SubagentObserver(
      delegationId,
      snapshot.interval,
      snapshot.intervalSource,
      notify,
      secrets,
    );
    observer.execution = snapshot.execution;
    observer.segmentId = snapshot.segmentId;
    observer.segmentCompleted = snapshot.segmentCompleted;
    observer.started = snapshot.started;
    observer.completed = snapshot.completed;
    observer.pendingCount = snapshot.pendingCount;
    observer.pendingErrors = snapshot.pendingErrors;
    observer.pendingFrom = snapshot.pendingFrom;
    observer.pendingTo = snapshot.pendingTo;
    observer.reportSeq = snapshot.reportSeq;
    observer.latestReport = snapshot.latestReport ? { ...snapshot.latestReport } : undefined;
    observer.statement = snapshot.statement ?? "";
    observer.phase = "finished";
    observer.stopSource = snapshot.stopSource;
    for (const guide of snapshot.guides) {
      observer.guides.push({ ...guide });
    }
    observer.steps = snapshot.steps.map((s) => ({ ...s }));
    for (const stepId of snapshot.seenSteps) {
      observer.seenSteps.add(stepId);
    }
    for (const guideId of snapshot.seenGuides) {
      observer.seenGuides.add(guideId);
    }
    return observer;
  }
}
