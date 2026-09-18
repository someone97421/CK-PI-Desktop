/**
 * Subagent persistence port and protocol contracts (ADR 0089).
 * Defines the narrow storage port interface and CAS control protocol
 * between agent runtime/sidecar and the desktop host SubagentSnapshotStore.
 */

import type { SubagentCheckpoint } from "./subagent-checkpoint.js";
import type {
  AgentEventEnvelope,
  MessageUsage,
  SubagentPersistenceSettings,
  SubagentPersistenceState,
  SubagentRecallStatus,
} from "@pi-desktop/shared";

export type { SubagentPersistenceSettings, SubagentPersistenceState, SubagentRecallStatus };

/** Persistent execution status in durable control record */
export type SubagentPersistenceStatus =
  | "running"
  | "completed"
  | "revoked"
  | "failed"
  | "interrupted";

/** User-facing durable recall state alias for shared type */
export type SubagentDurableState = SubagentPersistenceState;

/** Pending event delivery needing idempotent acknowledgment; contains full envelope payload */
export interface SubagentPendingEvent {
  deliveryId: string;
  eventKind: "result" | "observation" | "report";
  envelope: AgentEventEnvelope;
  createdAt: number;
}

/** Historical command deduplication record kept until session deletion */
export interface SubagentCommandReceiptRecord {
  commandId: string;
  commandDigest: string;
  execution: number;
  executionId: string;
  receivedAt: number;
  receipt: Record<string, unknown>;
}

/**
 * Control record representing the authoritative source of truth
 * for subagent recall eligibility and execution lifecycle.
 */
export interface SubagentControlRecord {
  sessionId: string;
  delegationId: string;
  /** Monotonic revision number incremented on every control state mutation (CAS) */
  revision: number;
  /** Current or last execution count (1-based) */
  execution: number;
  /** Unique execution identifier for the current/last turn */
  executionId: string;
  /** Immutable snapshot generation currently pointed to by completed state */
  snapshotGeneration: number;
  /** Authoritative task state */
  status: SubagentPersistenceStatus;
  /** Sidecar/host instance epoch to fence off delayed callbacks from replaced instances */
  instanceGeneration: number;
  /** Retained deduplication command receipts to reject replay and detect argument mismatch */
  commands: Record<string, SubagentCommandReceiptRecord>;
  /** Deliveries pending receipt confirmation by parent transcript/UI */
  pendingDeliveries: SubagentPendingEvent[];
  updatedAt: number;
  revokedAt?: number;
  revokeReason?: string;
  lastError?: { code: string; message: string };
}

/** Error codes for subagent persistence operations */
export type SubagentPersistenceErrorCode =
  | "CAS_FAILED"
  | "STALE_INSTANCE"
  | "EXECUTION_CONFLICT"
  | "COMMAND_DUPLICATE"
  | "COMMAND_MISMATCH"
  | "TASK_REVOKED"
  | "TASK_FAILED"
  | "TASK_INTERRUPTED"
  | "SNAPSHOT_NOT_FOUND"
  | "SNAPSHOT_CORRUPTED"
  | "STORAGE_UNAVAILABLE"
  | "SESSION_DELETED"
  | "QUOTA_EXCEEDED"
  | "INVALID_REQUEST";

export class SubagentPersistenceError extends Error {
  readonly code: SubagentPersistenceErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: SubagentPersistenceErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = "SubagentPersistenceError";
    this.code = code;
    this.details = details;
  }
}

/** Request to claim a session epoch and retrieve host instance generation */
export interface SubagentClaimSessionRequest {
  sessionId: string;
  runtimeInstanceId: string;
}

export interface SubagentClaimSessionReceipt {
  sessionId: string;
  instanceGeneration: number;
  available: boolean;
  reason?: string;
  settings?: SubagentPersistenceSettings;
}

/** Request to initiate or advance an execution under CAS */
export interface SubagentBeginRequest {
  sessionId: string;
  delegationId: string;
  /** Expected revision before increment; 0 for fresh task initialization */
  expectedRevision: number;
  /** Expected previous execution number; 0 for initial execution */
  expectedExecution: number;
  nextExecution: number;
  executionId: string;
  instanceGeneration: number;
  commandId: string;
  commandDigest: string;
  parentTurnId?: string;
  parentToolCallId: string;
  /** Encrypted recall instruction payload or task definition */
  instructionPayload?: string;
  /**
   * In-memory continuation flag set strictly by runtime when previous execution
   * completed in memory but failed durable commit (persistence-error), allowing
   * advancement from status "running" without rolling back execution or bypassing CAS.
   */
  memoryContinuation?: boolean;
}

export interface SubagentBeginReceipt {
  sessionId: string;
  delegationId: string;
  revision: number;
  execution: number;
  executionId: string;
  status: "running";
  acquiredAt: number;
  isDuplicate?: boolean;
}

/** Request to atomically commit a completed execution snapshot */
export interface SubagentCommitRequest {
  sessionId: string;
  delegationId: string;
  expectedRevision: number;
  expectedExecution: number;
  executionId: string;
  instanceGeneration: number;
  targetGeneration: number;
  checkpoint: SubagentCheckpoint;
  pendingDeliveries?: SubagentPendingEvent[];
}

export interface SubagentCommitReceipt {
  sessionId: string;
  delegationId: string;
  revision: number;
  execution: number;
  executionId: string;
  snapshotGeneration: number;
  status: "completed";
  committedAt: number;
  durableReady: boolean;
}

/** Request to transition execution to failed or interrupted under CAS */
export interface SubagentFailRequest {
  sessionId: string;
  delegationId: string;
  expectedRevision: number;
  expectedExecution: number;
  executionId: string;
  instanceGeneration: number;
  status: "failed" | "interrupted";
  error: { code: string; message: string };
  pendingDeliveries?: SubagentPendingEvent[];
}

export interface SubagentFailReceipt {
  sessionId: string;
  delegationId: string;
  revision: number;
  execution: number;
  status: "failed" | "interrupted";
  failedAt: number;
}

/** Request to permanently revoke/stop a subagent */
export interface SubagentRevokeRequest {
  sessionId: string;
  delegationId: string;
  expectedRevision?: number;
  expectedExecution?: number;
  instanceGeneration?: number;
  reason: string;
  source: "user" | "parent" | "session";
}

export interface SubagentRevokeReceipt {
  sessionId: string;
  delegationId: string;
  revision: number;
  execution: number;
  status: "revoked";
  revokedAt: number;
}

/** Request to load a completed snapshot */
export interface SubagentLoadRequest {
  sessionId: string;
  delegationId: string;
  generation?: number;
}

export interface SubagentLoadReceipt {
  sessionId: string;
  delegationId: string;
  control: SubagentControlRecord;
  checkpoint: SubagentCheckpoint;
}

/** Lightweight catalog entry for TaskList, cold TaskWait and recall queries */
export interface SubagentDirectoryEntry {
  sessionId: string;
  delegationId: string;
  revision: number;
  execution: number;
  executionId: string;
  snapshotGeneration: number;
  status: SubagentPersistenceStatus;
  canResume: boolean;
  persistenceState: SubagentPersistenceState;
  durableState: SubagentPersistenceState;
  source: "memory" | "disk";
  reason?: string;
  parentTurnId?: string;
  parentToolCallId?: string;
  updatedAt: number;
  appVersion?: string;
  modelId?: string;
  agentName?: string;
  lastReportSummary?: string;
  /** Bounded last execution outcome to satisfy cold TaskWait without parsing full messages */
  lastResult?: {
    status: string;
    report: string;
    turns: number;
    toolCalls: number;
    contextCompactions?: number;
    usage?: MessageUsage;
    executionUsage?: MessageUsage;
    error?: { code: string; message: string };
  };
}

export interface SubagentListRequest {
  sessionId: string;
  limit?: number;
  cursor?: string;
}

export interface SubagentListReceipt {
  sessionId: string;
  entries: SubagentDirectoryEntry[];
  nextCursor?: string;
  totalCount?: number;
}

export interface SubagentConfirmEventsRequest {
  sessionId: string;
  delegationId: string;
  executionId: string;
  deliveryIds: string[];
}

export interface SubagentEventAckReceipt {
  sessionId: string;
  delegationId: string;
  executionId: string;
  ackedDeliveryIds: string[];
  remainingDeliveriesCount: number;
}

/**
 * Narrow persistence port implemented by desktop main process SubagentSnapshotStore
 * and consumed by the sidecar/agent-runtime.
 */
export interface SubagentPersistencePort {
  /** Claim or re-claim a session epoch, acquiring the server instanceGeneration */
  claimSession(req: SubagentClaimSessionRequest): Promise<SubagentClaimSessionReceipt>;

  /** Begin execution under CAS; enforces single active owner and idempotency */
  beginExecution(req: SubagentBeginRequest): Promise<SubagentBeginReceipt>;

  /** Commit immutable snapshot and update control to completed */
  commitSnapshot(req: SubagentCommitRequest): Promise<SubagentCommitReceipt>;

  /** Record execution failure or interruption under CAS */
  failExecution(req: SubagentFailRequest): Promise<SubagentFailReceipt>;

  /** Mark execution revoked across restarts */
  revokeExecution(req: SubagentRevokeRequest): Promise<SubagentRevokeReceipt>;

  /** Load completed checkpoint and verify integrity */
  loadSnapshot(req: SubagentLoadRequest): Promise<SubagentLoadReceipt>;

  /** List lightweight metadata directory with bounded pagination */
  listEntries(req: SubagentListRequest): Promise<SubagentListReceipt>;

  /** Acknowledge delivery of pending transcript/UI events */
  confirmEvents(req: SubagentConfirmEventsRequest): Promise<SubagentEventAckReceipt>;

  /** Query current snapshot store settings and availability */
  getSettings?(): Promise<SubagentPersistenceSettings>;
}
