import { randomUUID } from "node:crypto";
import type { LiveWorkSelectionOption } from "@pi-desktop/shared";
import type { LiveWorkIntent } from "./intent.js";

export type LiveWorkAdmission =
  | "received"
  | "reviewing"
  | "dispatching"
  | "accepted"
  | "rejected"
  | "unknown"
  | "withdrawn";

export type LiveWorkExecution =
  | "not-started"
  | "queued"
  | "running"
  | "waiting-permission"
  | "waiting-input"
  | "completed"
  | "failed"
  | "interrupted"
  | "canceled";

export type LiveWorkOperation = {
  operationId: string;
  callId: string;
  workBindingRevision: number;
  workSessionId: string;
  providerRequestId: string;
  sequence: number;
  instruction: string;
  admission: LiveWorkAdmission;
  execution: LiveWorkExecution;
  summary?: string;
  resultSummary?: string;
  intent?: LiveWorkIntent;
  userMessageId?: string;
  queueEntryId?: string;
  turnId?: string;
  selections?: LiveWorkSelectionOption[];
};

export type RegisterCandidateResult =
  | { status: "created"; operation: LiveWorkOperation }
  | { status: "replayed"; operation: LiveWorkOperation }
  | { status: "conflict" }
  | { status: "capacity" }
  | { status: "invalid" };

const MAX_OPERATION_IDS = 256;
const MAX_PENDING_ADMISSION = 8;
const MAX_REQUEST_ID_BYTES = 256;
const MAX_INSTRUCTION_BYTES = 8 * 1024;

/** Per-call identity ledger. It tracks Host admission; it never replays work. */
export class LiveWorkOperationLedger {
  private readonly operations = new Map<string, LiveWorkOperation>();
  private nextSequence = 1;

  constructor(
    private readonly scope: { callId: string; workBindingRevision: number; workSessionId: string },
    private readonly createOperationId: () => string = randomUUID,
    private readonly createUserMessageId: () => string = randomUUID,
  ) {}

  registerCandidate(providerRequestId: string, instruction: string): RegisterCandidateResult {
    if (!this.isValidRequest(providerRequestId, instruction)) return { status: "invalid" };
    const existing = this.operations.get(providerRequestId);
    if (existing) {
      return existing.instruction === instruction
        ? { status: "replayed", operation: { ...existing } }
        : { status: "conflict" };
    }
    if (this.operations.size >= MAX_OPERATION_IDS || this.pendingAdmissionCount() >= MAX_PENDING_ADMISSION) {
      return { status: "capacity" };
    }
    const operation: LiveWorkOperation = {
      ...this.scope,
      operationId: this.createOperationId(),
      providerRequestId,
      sequence: this.nextSequence++,
      instruction,
      admission: "received",
      execution: "not-started",
      userMessageId: this.createUserMessageId(),
    };
    this.operations.set(providerRequestId, operation);
    return { status: "created", operation: { ...operation } };
  }

  get(providerRequestId: string): LiveWorkOperation | undefined {
    const operation = this.operations.get(providerRequestId);
    return operation ? { ...operation } : undefined;
  }

  getByOperationId(operationId: string): LiveWorkOperation | undefined {
    const operation = [...this.operations.values()].find((item) => item.operationId === operationId);
    return operation ? { ...operation } : undefined;
  }

  update(providerRequestId: string, update: Partial<Omit<LiveWorkOperation,
    "callId" | "workBindingRevision" | "workSessionId" | "providerRequestId" | "sequence" | "instruction" | "operationId"
  >>): LiveWorkOperation | undefined {
    const operation = this.operations.get(providerRequestId);
    if (!operation) return undefined;
    Object.assign(operation, update);
    return { ...operation };
  }

  values(): LiveWorkOperation[] {
    return [...this.operations.values()].map((operation) => ({ ...operation }));
  }

  private pendingAdmissionCount(): number {
    return [...this.operations.values()].filter(({ admission }) =>
      admission === "received" || admission === "reviewing" || admission === "dispatching" || admission === "unknown",
    ).length;
  }

  private isValidRequest(providerRequestId: string, instruction: string): boolean {
    if (!providerRequestId.trim() || new TextEncoder().encode(providerRequestId).byteLength > MAX_REQUEST_ID_BYTES) return false;
    if (!instruction.trim() || new TextEncoder().encode(instruction).byteLength > MAX_INSTRUCTION_BYTES) return false;
    return true;
  }
}
