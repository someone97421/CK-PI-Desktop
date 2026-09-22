/**
 * Sole desktop host service responsible for snapshot persistence, atomic CAS control
 * state mutations, session lifecycle fencing, event confirmation and quotas.
 */

import { createHash } from "node:crypto";
import { lstat, readdir, rm, unlink } from "node:fs/promises";
import { normalize, resolve } from "node:path";
import type {
  AgentEventEnvelope,
  MessageUsage,
  SubagentPersistenceSettings,
  SubagentPersistenceState,
  SubagentRecallStatus,
} from "@pi-desktop/shared";
import {
  SubagentPersistenceError,
  validateCheckpoint,
  type SubagentBeginReceipt,
  type SubagentBeginRequest,
  type SubagentCheckpoint,
  type SubagentClaimSessionReceipt,
  type SubagentClaimSessionRequest,
  type SubagentCommandReceiptRecord,
  type SubagentCommitReceipt,
  type SubagentCommitRequest,
  type SubagentConfirmEventsRequest,
  type SubagentControlRecord,
  type SubagentDirectoryEntry,
  type SubagentEventAckReceipt,
  type SubagentFailReceipt,
  type SubagentFailRequest,
  type SubagentListReceipt,
  type SubagentListRequest,
  type SubagentLoadReceipt,
  type SubagentLoadRequest,
  type SubagentPendingEvent,
  type SubagentPersistencePort,
  type SubagentRevokeReceipt,
  type SubagentRevokeRequest,
} from "@pi-desktop/agent-runtime";
import {
  LegacySnapshotKeyUnavailableError,
  SNAPSHOT_FILE_LIMIT,
  SubagentSnapshotFiles,
  type SnapshotKeyProtector,
} from "./subagent-snapshot-files.js";
import type { SubagentSessionAuthority } from "./subagent-session-authority.js";

export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_SESSION_SNAPSHOTS = 100;
export const MAX_SNAPSHOT_BYTES = SNAPSHOT_FILE_LIMIT; // 16 MiB
export const MAX_TOTAL_BYTES = 512 * 1024 * 1024; // 512 MiB
export const MAX_CONTROL_RECORDS_PER_SESSION = 500;

/** Sequential FIFO promise queue to strictly serialize control and quota operations */
class AsyncSerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}

/** Durable session-level control record for isolation, fencing and watermark verification */
export interface SessionControlRecord {
  sessionId: string;
  projectRealPath: string;
  coveredWatermark: string;
  instanceGeneration: number;
  claimedRuntimeInstanceId?: string;
  closed: boolean;
  dirty: boolean;
  isolated: boolean;
  isolateReason?: string;
  updatedAt: number;
}

/** Extended control record with optional catalog metadata to allow O(1) directory listing */
export interface StoredControlRecord extends SubagentControlRecord {
  appVersion?: string;
  modelId?: string;
  agentName?: string;
  lastReportSummary?: string;
  commitDigest?: string;
  parentTurnId?: string;
  parentToolCallId?: string;
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

export interface SubagentSnapshotStoreOptions {
  dataDir: string;
  protector: SnapshotKeyProtector;
  sessionAuthority: SubagentSessionAuthority;
  deliverEvent: (envelope: AgentEventEnvelope) => Promise<void>;
}

function assertValidIdentifier(id: string, label: string): void {
  if (typeof id !== "string" || !id || id.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new SubagentPersistenceError("INVALID_REQUEST", `无效的${label}标识符: ${id}`);
  }
}

function normalizePath(p: string): string {
  const resolved = resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function computeCommitDigest(checkpoint: SubagentCheckpoint, pendingDeliveries?: SubagentPendingEvent[]): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(checkpoint));
  if (pendingDeliveries?.length) {
    const sorted = [...pendingDeliveries].sort((a, b) => a.deliveryId.localeCompare(b.deliveryId));
    hash.update(JSON.stringify(sorted));
  }
  return hash.digest("hex");
}

export class SubagentSnapshotStore implements SubagentPersistencePort {
  readonly root: string;
  readonly files: SubagentSnapshotFiles;
  private readonly sessionAuthority: SubagentSessionAuthority;
  private readonly deliverEvent: (envelope: AgentEventEnvelope) => Promise<void>;
  private readonly queue = new AsyncSerialQueue();

  /** Sessions admitted in this owner process; cold sessions were history-verified before admission. */
  private readonly verifiedSessions = new Set<string>();

  /** Memory fence for revoked tasks; prevents resurrection even if disk write fails */
  private readonly memoryRevokedTasks = new Set<string>();

  /** Tracking of unpersisted revokes needing retry and preventing clean close */
  private readonly unpersistedRevocations = new Set<string>();

  /** In-memory isolated sessions map when file corruptions occur */
  private readonly isolatedSessions = new Map<string, string>();

  /** Active delivery IDs and in-flight delivery promises */
  private readonly activeDeliveries = new Set<string>();
  private readonly activeDeliveryPromises = new Set<Promise<void>>();
  private readonly deliveryTimers = new Map<NodeJS.Timeout, { sessionId: string; cancel: () => void }>();
  private readonly deliverySessions = new Map<Promise<void>, string>();
  private readonly closingSessions = new Set<string>();
  private deliveryDraining = false;

  /** Disabled by default before dedicated acceptance verification (ADR 0089 Section 11 Item 5) */
  private enabled = false;
  private available = false;
  private availableReason?: string;
  private closed = false;
  private initialized = false;

  constructor(options: SubagentSnapshotStoreOptions) {
    this.root = resolve(options.dataDir, "subagent-contexts", "v1");
    this.files = new SubagentSnapshotFiles(this.root, options.protector);
    this.sessionAuthority = options.sessionAuthority;
    this.deliverEvent = options.deliverEvent;
  }

  // =========================================================================
  // Lifecycle and Administrative API
  // =========================================================================

  async initialize(): Promise<void> {
    return this.queue.enqueue(async () => {
      if (this.initialized) return;

      try {
        await this.files.initialize();
        this.available = true;
      } catch (error) {
        this.available = false;
        this.availableReason = error instanceof Error ? error.message : "子代理快照目录不可用。";
        this.initialized = true;
        return;
      }

      // Load user persistence settings if present
      try {
        const settingsPath = this.files.path("settings.json");
        const settingsBuf = await this.files.readBounded(settingsPath, 64 * 1024);
        const parsed = JSON.parse(settingsBuf.toString("utf8"));
        if (typeof parsed.enabled === "boolean") {
          this.enabled = parsed.enabled;
        }
      } catch {
        // Default enabled remains false (ADR 0089: disabled by default before dedicated acceptance verification)
      }

      // Clean up orphaned .tmp files in root and subdirectories left by prior abrupt exit
      await this.cleanupTemporaryFiles(this.root);

      // Pending event deliveries to resume delivering outside serial queue
      const pendingResumptions: { sessionId: string; delegationId: string; executionId: string }[] = [];

      // Scan existing session directories: clean orphans, verify watermarks, handle dirty exits
      // Note: Cold scanning NEVER sets dirty: true; only claimSession/beginExecution marks dirty
      try {
        const rootEntries = await readdir(this.root, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (!entry.isDirectory()) continue;
          const sessionId = entry.name;
          if (sessionId === "settings.json" || sessionId.endsWith(".tmp")) continue;

          try {
            assertValidIdentifier(sessionId, "会话");
          } catch {
            continue;
          }

          const sessionPath = this.files.path(sessionId);
          try {
            const stat = await lstat(sessionPath);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
              await rm(sessionPath, { recursive: true, force: true });
              continue;
            }
          } catch {
            continue;
          }

          const authority = await this.sessionAuthority(sessionId);
          if (!authority) {
            // Orphan session directory no longer in host session database
            await rm(sessionPath, { recursive: true, force: true });
            continue;
          }

          let sessionControl: SessionControlRecord | null = null;
          try {
            sessionControl = await this.loadSessionControl(sessionId, true);
          } catch (error) {
            // 保留当前用户无法解密的旧会话，避免初始化将旧加密控制记录覆盖。
            if (error instanceof LegacySnapshotKeyUnavailableError) continue;
            // Corrupted session control -> mark isolated
            sessionControl = {
              sessionId,
              projectRealPath: authority.projectRealPath,
              coveredWatermark: authority.watermark,
              instanceGeneration: 1,
              closed: true,
              dirty: false,
              isolated: true,
              isolateReason: "SESSION_CONTROL_CORRUPTED",
              updatedAt: Date.now(),
            };
            await this.saveSessionControl(sessionId, sessionControl);
          }

          if (sessionControl) {
            // Check dirty shutdown from previous host crash
            if (sessionControl.dirty) {
              sessionControl.isolated = true;
              sessionControl.isolateReason = "DIRTY_EXIT_ISOLATION";
            }

            // Check watermark against authority
            if (sessionControl.coveredWatermark !== authority.watermark) {
              sessionControl.isolated = true;
              sessionControl.isolateReason = "SESSION_WATERMARK_MISMATCH";
            }

            // Check project real path
            if (normalizePath(sessionControl.projectRealPath) !== normalizePath(authority.projectRealPath)) {
              sessionControl.isolated = true;
              sessionControl.isolateReason = "PROJECT_REALPATH_MISMATCH";
            }

            if (!sessionControl.isolated) {
              this.verifiedSessions.add(sessionId);
            }

            // Scan subagent delegation directories in this session
            try {
              const delegEntries = await readdir(sessionPath, { withFileTypes: true });
              for (const dEntry of delegEntries) {
                if (!dEntry.isDirectory()) continue;
                const delegationId = dEntry.name;
                try {
                  assertValidIdentifier(delegationId, "子代理任务");
                  const control = await this.loadControl(sessionId, delegationId);
                  if (control) {
                    // Running tasks from previous crash must transition to interrupted
                    if (control.status === "running") {
                      control.status = "interrupted";
                      control.revision += 1;
                      control.updatedAt = Date.now();
                      await this.saveControl(sessionId, delegationId, control);
                    }
                    if (!sessionControl.isolated && control.pendingDeliveries?.length) {
                      pendingResumptions.push({ sessionId, delegationId, executionId: control.executionId });
                    }
                  }
                } catch {
                  // Skip damaged task directory
                }
              }
            } catch {
              // Directory read error
            }

            // Cold scanning does NOT acquire owner or set dirty: true
            sessionControl.updatedAt = Date.now();
            await this.saveSessionControl(sessionId, sessionControl);
          } else {
            // Initializing new session control on clean startup
            sessionControl = {
              sessionId,
              projectRealPath: authority.projectRealPath,
              coveredWatermark: authority.watermark,
              instanceGeneration: 1,
              closed: false,
              dirty: false,
              isolated: false,
              updatedAt: Date.now(),
            };
            await this.saveSessionControl(sessionId, sessionControl);
            this.verifiedSessions.add(sessionId);
          }
        }
      } catch {
        // Root directory traversal error
      }

      // Evict expired snapshots beyond retention window
      await this.pruneExpiredSnapshots();

      this.initialized = true;

      // Trigger asynchronous pending redeliveries outside the serial queue
      for (const item of pendingResumptions) {
        this.triggerPendingDeliveriesAsync(item.sessionId, item.delegationId, item.executionId);
      }
    });
  }

  async getSettings(): Promise<SubagentPersistenceSettings> {
    return {
      enabled: this.enabled,
      available: this.available,
      reason: this.availableReason,
      retentionDays: DEFAULT_RETENTION_DAYS,
      maxSessionSnapshots: MAX_SESSION_SNAPSHOTS,
      maxSnapshotBytes: MAX_SNAPSHOT_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES,
    };
  }

  async setEnabled(enabled: boolean): Promise<SubagentPersistenceSettings> {
    return this.queue.enqueue(async () => {
      this.enabled = enabled;
      if (this.available) {
        try {
          const settingsPath = this.files.path("settings.json");
          await this.files.atomicWrite(
            settingsPath,
            Buffer.from(JSON.stringify({ enabled }), "utf8"),
          );
        } catch {
          // Best effort save
        }
      }
      return this.getSettings();
    });
  }

  async clearSnapshots(): Promise<{ cleared: number }> {
    return this.queue.enqueue(async () => {
      if (!this.available) return { cleared: 0 };
      let cleared = 0;

      try {
        const rootEntries = await readdir(this.root, { withFileTypes: true });
        for (const sessionEntry of rootEntries) {
          if (!sessionEntry.isDirectory()) continue;
          const sessionId = sessionEntry.name;
          if (sessionId === "settings.json" || sessionId.endsWith(".tmp")) continue;

          const sessionPath = this.files.path(sessionId);
          const delegEntries = await readdir(sessionPath, { withFileTypes: true });
          for (const delegEntry of delegEntries) {
            if (!delegEntry.isDirectory()) continue;
            const delegationId = delegEntry.name;
            const delegPath = this.files.path(sessionId, delegationId);

            const filesInDeleg = await readdir(delegPath);
            for (const file of filesInDeleg) {
              if (file.startsWith("generation-") && file.endsWith(".bin")) {
                try {
                  await unlink(this.files.path(sessionId, delegationId, file));
                  cleared++;
                } catch {
                  // File unlink error
                }
              }
            }
          }
        }
      } catch {
        // Cleared count so far
      }

      return { cleared };
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    assertValidIdentifier(sessionId, "会话");
    this.closingSessions.add(sessionId);
    for (const timer of this.deliveryTimers.values()) {
      if (timer.sessionId === sessionId) timer.cancel();
    }
    await Promise.allSettled([...this.deliverySessions]
      .filter(([, id]) => id === sessionId).map(([pending]) => pending));
    return this.queue.enqueue(async () => {
      assertValidIdentifier(sessionId, "会话");
      if (!this.available) return;

      const sessionControl = await this.loadSessionControl(sessionId);
      if (sessionControl) {
        let hasUnpersistedRevoke = false;
        for (const memKey of this.unpersistedRevocations) {
          if (memKey.startsWith(`${sessionId}/`)) {
            hasUnpersistedRevoke = true;
            break;
          }
        }

        sessionControl.closed = true;
        sessionControl.instanceGeneration += 1;
        sessionControl.claimedRuntimeInstanceId = undefined;

        if (hasUnpersistedRevoke) {
          sessionControl.isolated = true;
          sessionControl.dirty = true;
          sessionControl.isolateReason = "UNPERSISTED_SAFETY_RECORD";
        } else {
          sessionControl.dirty = false;
        }

        sessionControl.updatedAt = Date.now();
        await this.saveSessionControl(sessionId, sessionControl);

        // Transition running tasks to interrupted
        try {
          const sessionPath = this.files.path(sessionId);
          const delegEntries = await readdir(sessionPath, { withFileTypes: true });
          for (const entry of delegEntries) {
            if (!entry.isDirectory()) continue;
            const delegationId = entry.name;
            const control = await this.loadControl(sessionId, delegationId);
            if (control && control.status === "running") {
              control.status = "interrupted";
              control.revision += 1;
              control.updatedAt = Date.now();
              await this.saveControl(sessionId, delegationId, control);
            }
          }
        } catch {
          // Best effort
        }
      }

      this.verifiedSessions.delete(sessionId);
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    return this.queue.enqueue(async () => {
      assertValidIdentifier(sessionId, "会话");
      this.verifiedSessions.delete(sessionId);

      if (!this.available) return;
      try {
        const sessionPath = this.files.path(sessionId);
        await rm(sessionPath, { recursive: true, force: true });
      } catch {
        // Best effort delete
      }
    });
  }

  async closeOwner(): Promise<void> {
    // 1. Exit barrier: stop initiating new background deliveries, cancel timers, and await in-flight deliveries & queued acks
    this.deliveryDraining = true;
    for (const timer of this.deliveryTimers.values()) timer.cancel();
    this.deliveryTimers.clear();

    while (this.activeDeliveryPromises.size > 0) {
      await Promise.allSettled(Array.from(this.activeDeliveryPromises));
    }

    // 2. Execute final close mutations inside the serial queue
    return this.queue.enqueue(async () => {
      this.closed = true;
      if (!this.available) return;

      // Retry persisting any pending unpersisted revocations
      for (const memKey of Array.from(this.unpersistedRevocations)) {
        const [sId, dId] = memKey.split("/");
        try {
          const control = await this.loadControl(sId, dId);
          if (control && control.status !== "revoked") {
            control.status = "revoked";
            control.revision += 1;
            control.revokedAt = control.revokedAt ?? Date.now();
            control.updatedAt = Date.now();
            await this.saveControl(sId, dId, control);
          }
          this.unpersistedRevocations.delete(memKey);
        } catch {
          // Retained in unpersistedRevocations
        }
      }

      const rootEntries = await readdir(this.root, { withFileTypes: true });
      for (const entry of rootEntries) {
        if (!entry.isDirectory()) continue;
        const sessionId = entry.name;
        if (sessionId === "settings.json" || sessionId.endsWith(".tmp")) continue;

        let sessionControl: SessionControlRecord | null = null;
        try {
          sessionControl = await this.loadSessionControl(sessionId);
        } catch {
          continue;
        }
        if (!sessionControl) continue;

        // Transition running tasks to interrupted
        try {
          const sessionPath = this.files.path(sessionId);
          const delegEntries = await readdir(sessionPath, { withFileTypes: true });
          for (const dEntry of delegEntries) {
            if (!dEntry.isDirectory()) continue;
            const control = await this.loadControl(sessionId, dEntry.name);
            if (control && control.status === "running") {
              control.status = "interrupted";
              control.revision += 1;
              control.updatedAt = Date.now();
              await this.saveControl(sessionId, dEntry.name, control);
            }
          }
        } catch {
          // Best effort
        }

        // Check if session has unpersisted revocations
        let hasUnpersistedRevokeForSession = false;
        for (const memKey of this.unpersistedRevocations) {
          if (memKey.startsWith(`${sessionId}/`)) {
            hasUnpersistedRevokeForSession = true;
            break;
          }
        }

        // Verify watermark before clearing dirty flag
        const authority = await this.sessionAuthority(sessionId);
        if (hasUnpersistedRevokeForSession) {
          sessionControl.isolated = true;
          sessionControl.dirty = true;
          sessionControl.isolateReason = "UNPERSISTED_SAFETY_RECORD";
        } else if (authority) {
          if (authority.watermark === sessionControl.coveredWatermark) {
            sessionControl.dirty = false;
          } else {
            sessionControl.isolated = true;
            sessionControl.isolateReason = "SESSION_WATERMARK_MISMATCH";
          }
        } else {
          sessionControl.dirty = false;
        }

        sessionControl.closed = true;
        sessionControl.claimedRuntimeInstanceId = undefined;
        sessionControl.updatedAt = Date.now();
        await this.saveSessionControl(sessionId, sessionControl);
      }

      // Explicit failure if any unpersisted safety records could not be flushed
      if (this.unpersistedRevocations.size > 0) {
        throw new SubagentPersistenceError(
          "STORAGE_UNAVAILABLE",
          `退出时存在未落盘的撤销安全记录 (${Array.from(this.unpersistedRevocations).join(", ")})，拒绝标记干净退出`,
        );
      }
    });
  }

  async ownerLost(): Promise<void> {
    return this.queue.enqueue(async () => {
      if (!this.available) return;

      try {
        const rootEntries = await readdir(this.root, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (!entry.isDirectory()) continue;
          const sessionId = entry.name;
          if (sessionId === "settings.json" || sessionId.endsWith(".tmp")) continue;

          let sessionControl: SessionControlRecord | null = null;
          try {
            sessionControl = await this.loadSessionControl(sessionId);
          } catch {
            continue;
          }
          if (!sessionControl) continue;

          let hasUnconfirmedRevoke = false;
          try {
            const sessionPath = this.files.path(sessionId);
            const delegEntries = await readdir(sessionPath, { withFileTypes: true });
            for (const dEntry of delegEntries) {
              if (!dEntry.isDirectory()) continue;
              const control = await this.loadControl(sessionId, dEntry.name);
              if (control) {
                if (control.status === "running") {
                  control.status = "interrupted";
                  control.revision += 1;
                  control.updatedAt = Date.now();
                  await this.saveControl(sessionId, dEntry.name, control);
                }
                if (control.status === "revoked" && control.revokedAt && Date.now() - control.revokedAt < 15_000) {
                  hasUnconfirmedRevoke = true;
                }
              }
            }
          } catch {
            // Best effort
          }

          if (hasUnconfirmedRevoke) {
            sessionControl.isolated = true;
            sessionControl.isolateReason = "UNCONFIRMED_REVOKE_ON_OWNER_LOST";
          }
          sessionControl.claimedRuntimeInstanceId = undefined;
          sessionControl.updatedAt = Date.now();
          await this.saveSessionControl(sessionId, sessionControl);
        }
      } catch {
        // Best effort
      }
    });
  }

  async recordCoverage(sessionId: string): Promise<void> {
    if (this.closed) return;
    return this.queue.enqueue(async () => {
      if (this.closed) return;
      assertValidIdentifier(sessionId, "会话");
      if (!this.available || !this.verifiedSessions.has(sessionId)) {
        return;
      }

      const sessionControl = await this.loadSessionControl(sessionId);
      if (!sessionControl || sessionControl.isolated) {
        return;
      }

      const authority = await this.sessionAuthority(sessionId);
      if (!authority) return;

      if (sessionControl.coveredWatermark === authority.watermark) {
        return; // Up to date, avoid redundant write
      }

      sessionControl.coveredWatermark = authority.watermark;
      sessionControl.updatedAt = Date.now();
      await this.saveSessionControl(sessionId, sessionControl);
    });
  }

  async readRecallStatus(sessionId: string, id: string): Promise<SubagentRecallStatus> {
    assertValidIdentifier(sessionId, "会话");
    assertValidIdentifier(id, "子代理任务");

    if (!this.available) {
      return {
        delegationId: id,
        status: "unavailable",
        canResume: false,
        source: "disk",
        persistenceState: "unavailable",
        reason: this.availableReason || "子代理持久化未启用或存储不可用",
      };
    }

    let sessionControl: SessionControlRecord | null = null;
    try {
      sessionControl = await this.loadSessionControl(sessionId);
    } catch (err) {
      return {
        delegationId: id,
        status: "blocked",
        canResume: false,
        source: "disk",
        persistenceState: "blocked",
        reason: `会话控制记录损坏: ${(err as Error).message}`,
      };
    }

    if (!sessionControl) {
      return {
        delegationId: id,
        status: "unavailable",
        canResume: false,
        source: "disk",
        persistenceState: "unavailable",
        reason: "会话控制记录不存在",
      };
    }

    if (sessionControl.isolated) {
      return {
        delegationId: id,
        status: "blocked",
        canResume: false,
        source: "disk",
        persistenceState: "blocked",
        reason: `会话已隔离: ${sessionControl.isolateReason || "外部未知变动"}`,
      };
    }

    let control: StoredControlRecord | null = null;
    try {
      control = await this.loadControl(sessionId, id);
    } catch (err) {
      return {
        delegationId: id,
        status: "blocked",
        canResume: false,
        source: "disk",
        persistenceState: "blocked",
        reason: `任务控制记录损坏: ${(err as Error).message}`,
      };
    }

    if (!control) {
      return {
        delegationId: id,
        status: "unavailable",
        canResume: false,
        source: "disk",
        persistenceState: "unavailable",
        reason: "子代理控制记录不存在",
      };
    }

    const memKey = `${sessionId}/${id}`;
    if (this.memoryRevokedTasks.has(memKey) || control.status === "revoked") {
      return {
        delegationId: id,
        execution: control.execution,
        status: "revoked",
        canResume: false,
        source: "disk",
        persistenceState: "revoked",
        reason: control.revokeReason || "已撤销",
      };
    }

    if (control.status === "failed") {
      return {
        delegationId: id,
        execution: control.execution,
        status: "failed",
        canResume: false,
        source: "disk",
        persistenceState: "failed",
        reason: control.lastError?.message || "执行失败",
      };
    }

    if (control.status === "interrupted") {
      return {
        delegationId: id,
        execution: control.execution,
        status: "interrupted",
        canResume: false,
        source: "disk",
        persistenceState: "interrupted",
        reason: "任务执行已中断",
      };
    }

    if (control.status === "running") {
      return {
        delegationId: id,
        execution: control.execution,
        status: "running",
        canResume: false,
        source: "disk",
        persistenceState: "saving",
      };
    }

    if (control.status === "completed") {
      if (control.snapshotGeneration <= 0) {
        return {
          delegationId: id,
          execution: control.execution,
          status: "completed",
          canResume: false,
          source: "disk",
          persistenceState: "cleaned",
          reason: "快照已清理或无有效快照",
        };
      }

      const snapPath = this.files.path(
        sessionId,
        id,
        `generation-${control.snapshotGeneration}.bin`,
      );
      const exists = await this.fileExists(snapPath);
      if (!exists) {
        return {
          delegationId: id,
          execution: control.execution,
          status: "completed",
          canResume: false,
          source: "disk",
          persistenceState: "cleaned",
          reason: "快照正文已清理",
        };
      }

      // Metadata only: canResume is FALSE until runtime passes configuration & model validation
      return {
        delegationId: id,
        execution: control.execution,
        status: "completed",
        canResume: false,
        source: "disk",
        persistenceState: "pending-validation",
        snapshotVersion: control.snapshotGeneration,
      };
    }

    return {
      delegationId: id,
      execution: control.execution,
      status: control.status,
      canResume: false,
      source: "disk",
      persistenceState: "unavailable",
    };
  }

  // =========================================================================
  // SubagentPersistencePort Protocol Implementation
  // =========================================================================

  async claimSession(req: SubagentClaimSessionRequest): Promise<SubagentClaimSessionReceipt> {
    return this.queue.enqueue(async () => {
      assertValidIdentifier(req.sessionId, "会话");
      const settings = await this.getSettings();

      if (!this.available || !this.enabled || this.closed) {
        return {
          sessionId: req.sessionId,
          instanceGeneration: 0,
          available: false,
          reason: this.availableReason || "子代理持久化未启用或存储不可用",
          settings,
        };
      }

      let sessionControl = await this.loadSessionControl(req.sessionId);
      if (sessionControl?.isolated) {
        return {
          sessionId: req.sessionId,
          instanceGeneration: sessionControl.instanceGeneration,
          available: false,
          reason: `会话已被隔离无法持久化: ${sessionControl.isolateReason || "外部未知变更"}`,
          settings,
        };
      }

      // Repeated claims from the admitted owner are idempotent and do not re-read a live transcript.
      if (
        sessionControl &&
        this.verifiedSessions.has(req.sessionId) &&
        sessionControl.claimedRuntimeInstanceId === req.runtimeInstanceId &&
        !sessionControl.closed
      ) {
        return {
          sessionId: req.sessionId,
          instanceGeneration: sessionControl.instanceGeneration,
          available: true,
          settings,
        };
      }

      if (!sessionControl) {
        // There is no historical snapshot to authorize. Validate the live session identity and
        // controlled directory now; recordCoverage/clean shutdown will replace this marker.
        const authority = await this.sessionAuthority(req.sessionId, "identity");
        if (!authority) {
          return {
            sessionId: req.sessionId,
            instanceGeneration: 0,
            available: false,
            reason: "会话不存在或已删除",
            settings,
          };
        }
        sessionControl = {
          sessionId: req.sessionId,
          projectRealPath: authority.projectRealPath,
          coveredWatermark: authority.watermark,
          instanceGeneration: 1,
          claimedRuntimeInstanceId: req.runtimeInstanceId,
          closed: false,
          dirty: true,
          isolated: false,
          updatedAt: Date.now(),
        };
        await this.saveSessionControl(req.sessionId, sessionControl);
        this.verifiedSessions.add(req.sessionId);
      } else {
        // A record not admitted during initialization is historical state and must be verified strictly.
        if (!this.verifiedSessions.has(req.sessionId)) {
          if (sessionControl.dirty) {
            sessionControl.isolated = true;
            sessionControl.isolateReason = "DIRTY_EXIT_ISOLATION";
            await this.saveSessionControl(req.sessionId, sessionControl);
            return {
              sessionId: req.sessionId,
              instanceGeneration: sessionControl.instanceGeneration,
              available: false,
              reason: "会话此前未干净退出，已安全隔离",
              settings,
            };
          }

          const authority = await this.sessionAuthority(req.sessionId, "history");
          if (!authority) {
            return {
              sessionId: req.sessionId,
              instanceGeneration: sessionControl.instanceGeneration,
              available: false,
              reason: "会话不存在或已删除",
              settings,
            };
          }
          if (authority.watermark !== sessionControl.coveredWatermark) {
            sessionControl.isolated = true;
            sessionControl.isolateReason = "SESSION_WATERMARK_MISMATCH";
            await this.saveSessionControl(req.sessionId, sessionControl);
            return {
              sessionId: req.sessionId,
              instanceGeneration: sessionControl.instanceGeneration,
              available: false,
              reason: "会话外部转录发生未知变动，已安全隔离",
              settings,
            };
          }
          this.verifiedSessions.add(req.sessionId);
        }

        sessionControl.instanceGeneration += 1;
        sessionControl.claimedRuntimeInstanceId = req.runtimeInstanceId;
        sessionControl.closed = false;
        sessionControl.dirty = true;
        sessionControl.updatedAt = Date.now();
        await this.saveSessionControl(req.sessionId, sessionControl);
      }

      return {
        sessionId: req.sessionId,
        instanceGeneration: sessionControl.instanceGeneration,
        available: true,
        settings,
      };
    });
  }

  async beginExecution(req: SubagentBeginRequest): Promise<SubagentBeginReceipt> {
    return this.queue.enqueue(async () => {
      this.assertAvailable();
      assertValidIdentifier(req.sessionId, "会话");
      assertValidIdentifier(req.delegationId, "子代理任务");

      const memKey = `${req.sessionId}/${req.delegationId}`;
      if (this.memoryRevokedTasks.has(memKey)) {
        throw new SubagentPersistenceError("TASK_REVOKED", "子代理已在内存中被安全撤销");
      }

      const sessionControl = await this.loadSessionControl(req.sessionId);
      if (!sessionControl) {
        throw new SubagentPersistenceError("SESSION_DELETED", "会话控制记录不存在");
      }
      if (sessionControl.isolated) {
        throw new SubagentPersistenceError(
          "TASK_FAILED",
          `会话已被安全隔离，无法开始执行: ${sessionControl.isolateReason || "未知原因"}`,
        );
      }
      if (sessionControl.closed) {
        throw new SubagentPersistenceError("STALE_INSTANCE", "会话已封闭");
      }
      if (req.instanceGeneration < sessionControl.instanceGeneration) {
        throw new SubagentPersistenceError("STALE_INSTANCE", "实例代次已过时");
      }

      let control = await this.loadControl(req.sessionId, req.delegationId);
      const now = Date.now();
      let receipt: SubagentBeginReceipt;

      if (control) {
        // Deduplicate commandId: return exact original receipt if digest matches
        const existingCommand = control.commands[req.commandId];
        if (existingCommand) {
          if (existingCommand.commandDigest === req.commandDigest) {
            const originalReceipt = existingCommand.receipt as SubagentBeginReceipt;
            return {
              sessionId: originalReceipt?.sessionId ?? req.sessionId,
              delegationId: originalReceipt?.delegationId ?? req.delegationId,
              revision: originalReceipt?.revision ?? control.revision,
              execution: originalReceipt?.execution ?? control.execution,
              executionId: originalReceipt?.executionId ?? control.executionId,
              status: "running",
              acquiredAt: originalReceipt?.acquiredAt ?? existingCommand.receivedAt,
              isDuplicate: true,
            };
          } else {
            throw new SubagentPersistenceError(
              "COMMAND_MISMATCH",
              `命令ID ${req.commandId} 参数不符`,
            );
          }
        }

        // Status checks
        if (control.status === "revoked") {
          throw new SubagentPersistenceError("TASK_REVOKED", "子代理已永久撤销停止");
        }
        if (control.status === "failed") {
          throw new SubagentPersistenceError("TASK_FAILED", "子代理上一轮已失败不可召回");
        }
        if (control.status === "interrupted") {
          throw new SubagentPersistenceError("TASK_INTERRUPTED", "子代理执行曾被中断不可召回");
        }

        // Allow memory continuation if previous execution completed in memory but failed durable commit
        if (control.status === "running") {
          if (
            req.memoryContinuation === true &&
            req.instanceGeneration === control.instanceGeneration &&
            control.revision === req.expectedRevision &&
            control.execution === req.expectedExecution
          ) {
            // Permitted memory continuation; control advances under CAS below
          } else {
            throw new SubagentPersistenceError("EXECUTION_CONFLICT", "子代理正在执行中");
          }
        }

        // CAS revision and execution checks
        if (control.revision !== req.expectedRevision) {
          throw new SubagentPersistenceError(
            "CAS_FAILED",
            `控制版本不匹配: expected ${req.expectedRevision}, actual ${control.revision}`,
          );
        }
        if (control.execution !== req.expectedExecution) {
          throw new SubagentPersistenceError(
            "EXECUTION_CONFLICT",
            `执行轮次不匹配: expected ${req.expectedExecution}, actual ${control.execution}`,
          );
        }

        // Snapshots are required for resuming unless continuing in-memory after persistence commit error
        if (req.expectedExecution > 0 && control.snapshotGeneration <= 0 && req.memoryContinuation !== true) {
          throw new SubagentPersistenceError("SNAPSHOT_NOT_FOUND", "召回所需的历史快照不存在");
        }

        control.revision += 1;
        control.execution = req.nextExecution;
        control.executionId = req.executionId;
        control.status = "running";
        control.instanceGeneration = req.instanceGeneration;
        control.updatedAt = now;
        control.parentTurnId = req.parentTurnId;
        control.parentToolCallId = req.parentToolCallId;

        receipt = {
          sessionId: req.sessionId,
          delegationId: req.delegationId,
          revision: control.revision,
          execution: control.execution,
          executionId: control.executionId,
          status: "running",
          acquiredAt: now,
        };

        control.commands[req.commandId] = {
          commandId: req.commandId,
          commandDigest: req.commandDigest,
          execution: req.nextExecution,
          executionId: req.executionId,
          receivedAt: now,
          receipt,
        };
      } else {
        // Initial execution: must have revision 0 and execution 0
        if (req.expectedRevision !== 0 || req.expectedExecution !== 0) {
          throw new SubagentPersistenceError(
            "CAS_FAILED",
            `初始任务要求 expectedRevision=0, expectedExecution=0，实际为 ${req.expectedRevision}, ${req.expectedExecution}`,
          );
        }

        // Safety limit on control records per session
        await this.assertControlRecordQuota(req.sessionId);

        receipt = {
          sessionId: req.sessionId,
          delegationId: req.delegationId,
          revision: 1,
          execution: req.nextExecution,
          executionId: req.executionId,
          status: "running",
          acquiredAt: now,
        };

        control = {
          sessionId: req.sessionId,
          delegationId: req.delegationId,
          revision: 1,
          execution: req.nextExecution,
          executionId: req.executionId,
          snapshotGeneration: 0,
          status: "running",
          instanceGeneration: req.instanceGeneration,
          commands: {
            [req.commandId]: {
              commandId: req.commandId,
              commandDigest: req.commandDigest,
              execution: req.nextExecution,
              executionId: req.executionId,
              receivedAt: now,
              receipt,
            },
          },
          pendingDeliveries: [],
          updatedAt: now,
          parentTurnId: req.parentTurnId,
          parentToolCallId: req.parentToolCallId,
        };
      }

      // Mark session dirty on execution acquisition
      sessionControl.dirty = true;
      sessionControl.updatedAt = now;
      await this.saveSessionControl(req.sessionId, sessionControl);

      await this.saveControl(req.sessionId, req.delegationId, control);

      return receipt;
    });
  }

  async commitSnapshot(req: SubagentCommitRequest): Promise<SubagentCommitReceipt> {
    const commitReceipt = await this.queue.enqueue(async () => {
      this.assertAvailable();
      assertValidIdentifier(req.sessionId, "会话");
      assertValidIdentifier(req.delegationId, "子代理任务");

      // Validate targetGeneration is a strictly positive integer
      if (!Number.isInteger(req.targetGeneration) || req.targetGeneration <= 0) {
        throw new SubagentPersistenceError("INVALID_REQUEST", "targetGeneration 必须为严格正整数");
      }

      const memKey = `${req.sessionId}/${req.delegationId}`;
      if (this.memoryRevokedTasks.has(memKey)) {
        throw new SubagentPersistenceError("TASK_REVOKED", "子代理已在内存中被安全撤销，拒绝提交");
      }

      const sessionControl = await this.loadSessionControl(req.sessionId);
      if (!sessionControl || sessionControl.closed) {
        throw new SubagentPersistenceError("STALE_INSTANCE", "会话已封闭或不存在");
      }
      if (sessionControl.isolated) {
        throw new SubagentPersistenceError(
          "TASK_FAILED",
          `会话已被安全隔离: ${sessionControl.isolateReason || "未知原因"}`,
        );
      }
      if (req.instanceGeneration !== sessionControl.instanceGeneration) {
        throw new SubagentPersistenceError("STALE_INSTANCE", "实例代次已过时");
      }

      const control = await this.loadControl(req.sessionId, req.delegationId);
      if (!control) {
        throw new SubagentPersistenceError("SNAPSHOT_NOT_FOUND", "未找到对应的控制记录");
      }

      // Revoked status has absolute precedence: reject delayed commit
      if (control.status === "revoked") {
        throw new SubagentPersistenceError("TASK_REVOKED", "子代理已被撤销，拒绝完成提交");
      }

      // Checkpoint identity and schema validation
      const validatedCheckpoint = validateCheckpoint(req.checkpoint);
      if (
        validatedCheckpoint.execution.execution !== req.expectedExecution ||
        validatedCheckpoint.execution.generation !== req.targetGeneration ||
        validatedCheckpoint.header.projectRealPath !== sessionControl.projectRealPath ||
        validatedCheckpoint.execution.executionId !== req.executionId ||
        validatedCheckpoint.header.sessionId !== req.sessionId ||
        validatedCheckpoint.header.delegationId !== req.delegationId
      ) {
        throw new SubagentPersistenceError("INVALID_REQUEST", "快照载荷中的身份信息与提交请求不符");
      }

      // Compute cryptographic digest of canonical checkpoint and pending deliveries
      const commitDigest = computeCommitDigest(validatedCheckpoint, req.pendingDeliveries);

      // Idempotent commit detection: verify both execution identity and canonical commit digest
      if (
        control.status === "completed" &&
        control.execution === req.expectedExecution &&
        control.executionId === req.executionId &&
        control.snapshotGeneration === req.targetGeneration
      ) {
        if (control.commitDigest !== commitDigest) {
          throw new SubagentPersistenceError(
            "EXECUTION_CONFLICT",
            "重复提交 completed 状态但快照正文内容不一致，拒绝幂等处理",
          );
        }
        return {
          sessionId: req.sessionId,
          delegationId: req.delegationId,
          revision: control.revision,
          execution: control.execution,
          executionId: control.executionId,
          snapshotGeneration: control.snapshotGeneration,
          status: "completed" as const,
          committedAt: control.updatedAt,
          durableReady: true,
        };
      }

      // Strict transition: only running -> completed allowed
      if (control.status !== "running") {
        throw new SubagentPersistenceError(
          "EXECUTION_CONFLICT",
          `只允许处于 running 状态的任务提交完成，当前状态为: ${control.status}`,
        );
      }

      if (req.targetGeneration <= control.snapshotGeneration) {
        throw new SubagentPersistenceError(
          "INVALID_REQUEST",
          `targetGeneration (${req.targetGeneration}) 必须严格大于当前 snapshotGeneration (${control.snapshotGeneration})`,
        );
      }

      // CAS checks
      if (control.revision !== req.expectedRevision) {
        throw new SubagentPersistenceError(
          "CAS_FAILED",
          `控制版本不匹配: expected ${req.expectedRevision}, actual ${control.revision}`,
        );
      }
      if (control.execution !== req.expectedExecution) {
        throw new SubagentPersistenceError(
          "EXECUTION_CONFLICT",
          `执行轮次不匹配: expected ${req.expectedExecution}, actual ${control.execution}`,
        );
      }
      if (control.executionId !== req.executionId) {
        throw new SubagentPersistenceError(
          "EXECUTION_CONFLICT",
          `执行ID不匹配: expected ${req.executionId}, actual ${control.executionId}`,
        );
      }

      // Check if snapshot file already exists; verify full content digest if retry after control write failure
      const snapshotPath = this.files.path(
        req.sessionId,
        req.delegationId,
        `generation-${req.targetGeneration}.bin`,
      );
      const identity = `${req.sessionId}/${req.delegationId}/generation-${req.targetGeneration}`;
      let needWriteSnapshot = true;

      if (await this.fileExists(snapshotPath)) {
        try {
          const existingBytes = await this.files.readBounded(snapshotPath, MAX_SNAPSHOT_BYTES);
          const decoded = this.files.decode<unknown>(existingBytes, identity);
          const validated = validateCheckpoint(decoded);
          const existingDigest = computeCommitDigest(validated, req.pendingDeliveries);

          if (
            existingDigest === commitDigest &&
            validated.execution.executionId === req.executionId &&
            validated.execution.execution === req.expectedExecution &&
            validated.header.sessionId === req.sessionId &&
            validated.header.delegationId === req.delegationId
          ) {
            needWriteSnapshot = false; // Identical snapshot from previous failed control write
          } else {
            // Content differs! Reject and do not delete or reuse
            throw new SubagentPersistenceError(
              "EXECUTION_CONFLICT",
              `快照代次 generation-${req.targetGeneration} 已存在但正文摘要或交付项不一致，拒绝覆盖或复用`,
            );
          }
        } catch (readErr) {
          if (readErr instanceof SubagentPersistenceError) throw readErr;
          throw new SubagentPersistenceError(
            "SNAPSHOT_CORRUPTED",
            `已存在的快照代次 generation-${req.targetGeneration} 损坏或不可读取: ${(readErr as Error).message}`,
          );
        }
      }

      if (needWriteSnapshot) {
        const encodedSnapshot = this.files.encode(validatedCheckpoint, identity, MAX_SNAPSHOT_BYTES);
        await this.enforceGlobalQuota(encodedSnapshot.length);
        await this.enforceSessionSnapshotQuota(req.sessionId);
        await this.files.atomicWrite(snapshotPath, encodedSnapshot);
      }

      // Update control record pointing to new generation
      control.revision += 1;
      control.snapshotGeneration = req.targetGeneration;
      control.status = "completed";
      control.commitDigest = commitDigest;
      control.updatedAt = Date.now();

      // Merge and validate pending deliveries: explicit rejection if envelope format is invalid
      if (req.pendingDeliveries?.length) {
        const existingIds = new Set(control.pendingDeliveries.map((p) => p.deliveryId));
        for (const pending of req.pendingDeliveries) {
          if (!existingIds.has(pending.deliveryId)) {
            const ev = pending.envelope?.event;
            if (
              pending.envelope?.sessionId !== req.sessionId ||
              pending.deliveryId !== `subagent-execution:${req.delegationId}:${req.expectedExecution}:finished` ||
              !ev ||
              ev.type !== "message_end" ||
              ev.message?.role !== "tool" ||
              ev.message?.toolName !== "TaskExecution" ||
              ev.message?.id !== pending.deliveryId
            ) {
              throw new SubagentPersistenceError(
                "INVALID_REQUEST",
                `待交付事件信封格式无效: deliveryId=${pending.deliveryId} 要求 type=message_end, role=tool, toolName=TaskExecution 且 message.id 严格匹配`,
              );
            }
            control.pendingDeliveries.push(pending);
          }
        }
      }

      // Populate summary metadata for directory entries
      control.appVersion = validatedCheckpoint.header.appVersion;
      control.modelId = validatedCheckpoint.modelBinding.provider.modelId;
      control.agentName = validatedCheckpoint.config.definition.name;
      control.lastReportSummary =
        validatedCheckpoint.observer.latestReport?.statement ||
        validatedCheckpoint.usage.lastReportText;
      control.lastResult = {
        status: "completed",
        report:
          validatedCheckpoint.usage.lastReportText ||
          validatedCheckpoint.observer.latestReport?.statement ||
          "",
        turns: validatedCheckpoint.usage.turns,
        toolCalls: validatedCheckpoint.usage.toolCalls,
        contextCompactions: validatedCheckpoint.compaction.contextCompactions,
        usage: validatedCheckpoint.usage.usage,
        executionUsage: validatedCheckpoint.usage.executionUsage,
      };

      await this.saveControl(req.sessionId, req.delegationId, control);

      // Clean old generation files strictly in-queue based on current committed generation
      await this.pruneOldGenerationsInQueue(req.sessionId, req.delegationId, control.snapshotGeneration);

      return {
        sessionId: req.sessionId,
        delegationId: req.delegationId,
        revision: control.revision,
        execution: control.execution,
        executionId: control.executionId,
        snapshotGeneration: control.snapshotGeneration,
        status: "completed" as const,
        committedAt: Date.now(),
        durableReady: true,
      };
    });

    // Deliver pending events asynchronously outside the serial queue to prevent deadlock
    this.triggerPendingDeliveriesAsync(req.sessionId, req.delegationId, req.executionId);

    return commitReceipt;
  }

  async failExecution(req: SubagentFailRequest): Promise<SubagentFailReceipt> {
    const failReceipt = await this.queue.enqueue(async () => {
      this.assertAvailable();
      assertValidIdentifier(req.sessionId, "会话");
      assertValidIdentifier(req.delegationId, "子代理任务");

      const sessionControl = await this.loadSessionControl(req.sessionId);
      if (!sessionControl || sessionControl.closed) {
        throw new SubagentPersistenceError("STALE_INSTANCE", "会话已封闭或不存在");
      }
      if (req.instanceGeneration !== sessionControl.instanceGeneration) {
        throw new SubagentPersistenceError("STALE_INSTANCE", "实例代次已过时");
      }

      const control = await this.loadControl(req.sessionId, req.delegationId);
      if (!control) {
        throw new SubagentPersistenceError("SNAPSHOT_NOT_FOUND", "未找到对应的控制记录");
      }

      // Revoked status has absolute precedence
      if (control.status === "revoked") {
        throw new SubagentPersistenceError("TASK_REVOKED", "子代理已被撤销");
      }
      if (control.status !== "running" || control.executionId !== req.executionId ||
          (req.status !== "failed" && req.status !== "interrupted")) {
        throw new SubagentPersistenceError("EXECUTION_CONFLICT", "失败回执不属于当前执行");
      }

      if (control.revision !== req.expectedRevision) {
        throw new SubagentPersistenceError(
          "CAS_FAILED",
          `控制版本不匹配: expected ${req.expectedRevision}, actual ${control.revision}`,
        );
      }
      if (control.execution !== req.expectedExecution) {
        throw new SubagentPersistenceError(
          "EXECUTION_CONFLICT",
          `执行轮次不匹配: expected ${req.expectedExecution}, actual ${control.execution}`,
        );
      }

      control.revision += 1;
      control.status = req.status;
      control.lastError = req.error;
      control.updatedAt = Date.now();

      if (req.pendingDeliveries?.length) {
        const existingIds = new Set(control.pendingDeliveries.map((p) => p.deliveryId));
        for (const pending of req.pendingDeliveries) {
          if (!existingIds.has(pending.deliveryId)) {
            const ev = pending.envelope?.event;
            if (
              pending.envelope?.sessionId !== req.sessionId ||
              pending.deliveryId !== `subagent-execution:${req.delegationId}:${req.expectedExecution}:finished` ||
              !ev ||
              ev.type !== "message_end" ||
              ev.message?.role !== "tool" ||
              ev.message?.toolName !== "TaskExecution" ||
              ev.message?.id !== pending.deliveryId
            ) {
              throw new SubagentPersistenceError(
                "INVALID_REQUEST",
                `待交付事件信封格式无效: deliveryId=${pending.deliveryId}`,
              );
            }
            control.pendingDeliveries.push(pending);
          }
        }
      }

      await this.saveControl(req.sessionId, req.delegationId, control);

      return {
        sessionId: req.sessionId,
        delegationId: req.delegationId,
        revision: control.revision,
        execution: control.execution,
        status: req.status,
        failedAt: Date.now(),
      };
    });

    this.triggerPendingDeliveriesAsync(req.sessionId, req.delegationId, req.executionId);
    return failReceipt;
  }

  async revokeExecution(
    req: SubagentRevokeRequest & { expectedExecution?: number },
  ): Promise<SubagentRevokeReceipt> {
    return this.queue.enqueue(async () => {
      // Revocation must never be blocked by disabled persistence
      if (this.closed) {
        throw new SubagentPersistenceError("STORAGE_UNAVAILABLE", "存储服务已关闭");
      }
      assertValidIdentifier(req.sessionId, "会话");
      assertValidIdentifier(req.delegationId, "子代理任务");

      const memKey = `${req.sessionId}/${req.delegationId}`;

      let sessionControl: SessionControlRecord | null = null;
      try {
        sessionControl = await this.loadSessionControl(req.sessionId);
      } catch {
        // Session control error will be handled during write
      }

      if (sessionControl && req.instanceGeneration && req.instanceGeneration < sessionControl.instanceGeneration) {
        throw new SubagentPersistenceError("STALE_INSTANCE", "实例代次已过时");
      }

      let control: StoredControlRecord | null = null;
      try {
        control = await this.loadControl(req.sessionId, req.delegationId);
      } catch (err) {
        if (sessionControl) {
          sessionControl.isolated = true;
          sessionControl.dirty = true;
          sessionControl.isolateReason = "REVOKE_LOAD_FAILED";
          await this.saveSessionControl(req.sessionId, sessionControl);
        }
        throw err;
      }

      // Pre-check qualification and CAS before setting memoryRevokedTasks (prevents stale cards from poisoning memory)
      if (control) {
        if (req.expectedRevision !== undefined && req.expectedRevision > 0 && control.revision !== req.expectedRevision) {
          throw new SubagentPersistenceError(
            "CAS_FAILED",
            `控制版本不匹配: expected ${req.expectedRevision}, actual ${control.revision}`,
          );
        }

        if (req.expectedExecution !== undefined && req.expectedExecution > 0) {
          if (control.execution > req.expectedExecution) {
            throw new SubagentPersistenceError(
              "EXECUTION_CONFLICT",
              `旧卡片执行轮次已过时 (${req.expectedExecution} < ${control.execution})，无法停止新轮次`,
            );
          }
        }

        if (control.status === "revoked") {
          return {
            sessionId: req.sessionId,
            delegationId: req.delegationId,
            revision: control.revision,
            execution: control.execution,
            status: "revoked",
            revokedAt: control.revokedAt ?? Date.now(),
          };
        }
      }

      // Qualification passed: set memory fence and unpersisted tracking
      this.memoryRevokedTasks.add(memKey);
      this.unpersistedRevocations.add(memKey);

      const now = Date.now();

      // Cold revoke: ensure session dirty flag is persisted so crash won't lose dirty tracking
      if (sessionControl && !sessionControl.dirty) {
        sessionControl.dirty = true;
        sessionControl.updatedAt = now;
        await this.saveSessionControl(req.sessionId, sessionControl);
      }

      try {
        if (!control) {
          control = {
            sessionId: req.sessionId,
            delegationId: req.delegationId,
            revision: 1,
            execution: 0,
            executionId: "",
            snapshotGeneration: 0,
            status: "revoked",
            instanceGeneration: req.instanceGeneration ?? 1,
            commands: {},
            pendingDeliveries: [],
            updatedAt: now,
            revokedAt: now,
            revokeReason: req.reason,
          };
          await this.saveControl(req.sessionId, req.delegationId, control);
        } else {
          control.revision += 1;
          control.status = "revoked";
          control.revokedAt = now;
          control.revokeReason = req.reason;
          control.updatedAt = now;
          await this.saveControl(req.sessionId, req.delegationId, control);
        }

        this.unpersistedRevocations.delete(memKey);
      } catch (saveError) {
        // Disk write failed: isolate session, retain dirty flag, and propagate error
        if (sessionControl) {
          sessionControl.isolated = true;
          sessionControl.dirty = true;
          sessionControl.isolateReason = "REVOKE_PERSISTENCE_FAILED";
          await this.saveSessionControl(req.sessionId, sessionControl);
        }
        throw saveError;
      }

      return {
        sessionId: req.sessionId,
        delegationId: req.delegationId,
        revision: control.revision,
        execution: control.execution,
        status: "revoked",
        revokedAt: control.revokedAt ?? now,
      };
    });
  }

  async loadSnapshot(req: SubagentLoadRequest): Promise<SubagentLoadReceipt> {
    return this.queue.enqueue(async () => {
      this.assertAvailable();
      assertValidIdentifier(req.sessionId, "会话");
      assertValidIdentifier(req.delegationId, "子代理任务");

      const memKey = `${req.sessionId}/${req.delegationId}`;
      if (this.memoryRevokedTasks.has(memKey)) {
        throw new SubagentPersistenceError("TASK_REVOKED", "子代理已被撤销，禁止加载快照");
      }

      const sessionControl = await this.loadSessionControl(req.sessionId);
      if (sessionControl?.isolated) {
        throw new SubagentPersistenceError(
          "TASK_FAILED",
          `会话已被隔离无法加载快照: ${sessionControl.isolateReason || "外部未知变更"}`,
        );
      }

      const control = await this.loadControl(req.sessionId, req.delegationId);
      if (!control) {
        throw new SubagentPersistenceError("SNAPSHOT_NOT_FOUND", "未找到子代理控制记录");
      }

      // Strictly completed tasks only; running/revoked/failed/interrupted cannot restore snapshots
      if (control.status !== "completed") {
        if (control.status === "revoked") {
          throw new SubagentPersistenceError("TASK_REVOKED", "子代理已撤销，无法加载快照");
        }
        if (control.status === "failed") {
          throw new SubagentPersistenceError("TASK_FAILED", "子代理已失败，无法加载快照");
        }
        if (control.status === "interrupted") {
          throw new SubagentPersistenceError("TASK_INTERRUPTED", "子代理已中断，无法加载快照");
        }
        throw new SubagentPersistenceError(
          "INVALID_REQUEST",
          `当前状态为 ${control.status}，只有 completed 任务允许加载快照`,
        );
      }

      if (control.snapshotGeneration <= 0) {
        throw new SubagentPersistenceError("SNAPSHOT_NOT_FOUND", "该任务尚无有效快照");
      }

      // Generation strictly equals control.snapshotGeneration
      if (req.generation !== undefined && req.generation !== control.snapshotGeneration) {
        throw new SubagentPersistenceError(
          "INVALID_REQUEST",
          `请求加载的代次 (${req.generation}) 与当前控制记录指向的代次 (${control.snapshotGeneration}) 不符，禁止加载过时快照`,
        );
      }

      const generation = control.snapshotGeneration;
      const snapPath = this.files.path(
        req.sessionId,
        req.delegationId,
        `generation-${generation}.bin`,
      );

      let bytes: Buffer;
      try {
        bytes = await this.files.readBounded(snapPath, MAX_SNAPSHOT_BYTES);
      } catch {
        throw new SubagentPersistenceError("SNAPSHOT_NOT_FOUND", `快照文件不存在或损坏: gen ${generation}`);
      }

      const identity = `${req.sessionId}/${req.delegationId}/generation-${generation}`;
      let rawCheckpoint: unknown;
      try {
        rawCheckpoint = this.files.decode(bytes, identity);
      } catch {
        throw new SubagentPersistenceError("SNAPSHOT_CORRUPTED", "快照格式、身份或旧版加密认证失败");
      }

      const validatedCheckpoint = validateCheckpoint(rawCheckpoint);

      // Verify checkpoint execution identity matches control record
      if (
        validatedCheckpoint.execution.execution !== control.execution ||
        validatedCheckpoint.execution.executionId !== control.executionId
      ) {
        throw new SubagentPersistenceError("SNAPSHOT_CORRUPTED", "快照内部执行标识与控制记录不匹配");
      }
      if (
        validatedCheckpoint.header.sessionId !== req.sessionId ||
        validatedCheckpoint.header.delegationId !== req.delegationId
      ) {
        throw new SubagentPersistenceError("SNAPSHOT_CORRUPTED", "快照头部身份信息与请求会话不匹配");
      }

      return {
        sessionId: req.sessionId,
        delegationId: req.delegationId,
        control,
        checkpoint: validatedCheckpoint,
      };
    });
  }

  async listEntries(req: SubagentListRequest): Promise<SubagentListReceipt> {
    assertValidIdentifier(req.sessionId, "会话");
    if (!this.available) {
      return { sessionId: req.sessionId, entries: [], totalCount: 0 };
    }

    let sessionControl: SessionControlRecord | null = null;
    try {
      sessionControl = await this.loadSessionControl(req.sessionId);
    } catch {
      // Handled as isolated below
    }

    const sessionIsolated = Boolean(sessionControl?.isolated);
    const isolateReason = sessionControl?.isolateReason;

    const limit = Math.min(Math.max(req.limit ?? 50, 1), 100);
    const sessionPath = this.files.path(req.sessionId);

    let delegNames: string[] = [];
    try {
      const entries = await readdir(sessionPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== "settings.json" && !entry.name.endsWith(".tmp")) {
          delegNames.push(entry.name);
        }
      }
    } catch {
      return { sessionId: req.sessionId, entries: [], totalCount: 0 };
    }

    delegNames.sort();
    const totalCount = delegNames.length;

    let startIndex = 0;
    if (req.cursor) {
      const idx = delegNames.indexOf(req.cursor);
      if (idx >= 0) {
        startIndex = idx + 1;
      }
    }

    const pagedNames = delegNames.slice(startIndex, startIndex + limit);
    const entries: SubagentDirectoryEntry[] = [];

    for (const delegationId of pagedNames) {
      try {
        const control = await this.loadControl(req.sessionId, delegationId);
        if (!control) continue;

        let canResume = false;
        let persistenceState: SubagentPersistenceState = "unavailable";
        let durableState: SubagentPersistenceState = "unavailable";
        let reason: string | undefined;

        const memKey = `${req.sessionId}/${delegationId}`;
        const isRevoked = this.memoryRevokedTasks.has(memKey) || control.status === "revoked";

        if (sessionIsolated) {
          persistenceState = "blocked";
          durableState = "blocked";
          canResume = false;
          reason = isolateReason || "会话已被隔离";
        } else if (isRevoked) {
          persistenceState = "revoked";
          durableState = "revoked";
          canResume = false;
          reason = control.revokeReason || "已撤销";
        } else if (control.status === "failed") {
          persistenceState = "failed";
          durableState = "failed";
          canResume = false;
          reason = control.lastError?.message || "执行失败";
        } else if (control.status === "interrupted") {
          persistenceState = "interrupted";
          durableState = "interrupted";
          canResume = false;
          reason = "任务执行已中断";
        } else if (control.status === "running") {
          persistenceState = "saving";
          durableState = "saving";
          canResume = false;
        } else if (control.status === "completed") {
          if (control.snapshotGeneration > 0) {
            const snapPath = this.files.path(
              req.sessionId,
              delegationId,
              `generation-${control.snapshotGeneration}.bin`,
            );
            const exists = await this.fileExists(snapPath);
            if (exists) {
              persistenceState = "pending-validation";
              durableState = "durable-ready";
              canResume = false; // Metadata listing requires runtime validation before canResume is true
            } else {
              persistenceState = "cleaned";
              durableState = "cleaned";
              canResume = false;
              reason = "快照正文已清理";
            }
          } else {
            persistenceState = "cleaned";
            durableState = "cleaned";
            canResume = false;
            reason = "无有效快照";
          }
        }

        entries.push({
          sessionId: req.sessionId,
          delegationId,
          revision: control.revision,
          execution: control.execution,
          executionId: control.executionId,
          snapshotGeneration: control.snapshotGeneration,
          status: control.status,
          canResume,
          persistenceState,
          durableState,
          source: "disk",
          reason,
          parentTurnId: control.parentTurnId,
          parentToolCallId: control.parentToolCallId,
          updatedAt: control.updatedAt,
          appVersion: control.appVersion,
          modelId: control.modelId,
          agentName: control.agentName,
          lastReportSummary: control.lastReportSummary,
          lastResult: control.lastResult,
        });
      } catch {
        // Skip damaged control
      }
    }

    const nextCursor =
      startIndex + limit < delegNames.length
        ? pagedNames[pagedNames.length - 1]
        : undefined;

    return {
      sessionId: req.sessionId,
      entries,
      nextCursor,
      totalCount,
    };
  }

  async confirmEvents(req: SubagentConfirmEventsRequest): Promise<SubagentEventAckReceipt> {
    return this.queue.enqueue(async () => {
      this.assertAvailable();
      assertValidIdentifier(req.sessionId, "会话");
      assertValidIdentifier(req.delegationId, "子代理任务");

      const control = await this.loadControl(req.sessionId, req.delegationId);
      if (!control) {
        throw new SubagentPersistenceError("SNAPSHOT_NOT_FOUND", "未找到子代理控制记录");
      }

      // executionId binding: refuse sidecar confirming events belonging to a different execution
      if (req.executionId !== control.executionId) {
        throw new SubagentPersistenceError(
          "EXECUTION_CONFLICT",
          `执行ID不匹配: request ${req.executionId}, control ${control.executionId}`,
        );
      }

      // Sidecar cannot arbitrate deletion of un-delivered events; confirmEvents only returns current status
      const pendingIds = new Set((control.pendingDeliveries ?? []).map((p) => p.deliveryId));
      const confirmed = req.deliveryIds.filter((id) => !pendingIds.has(id));

      return {
        sessionId: req.sessionId,
        delegationId: req.delegationId,
        executionId: req.executionId,
        ackedDeliveryIds: confirmed,
        remainingDeliveriesCount: control.pendingDeliveries?.length ?? 0,
      };
    });
  }

  // =========================================================================
  // Internal Helpers & Delivery Convergence
  // =========================================================================

  private assertAvailable(): void {
    if (this.closed) {
      throw new SubagentPersistenceError("STORAGE_UNAVAILABLE", "存储服务已关闭");
    }
    if (!this.available || !this.enabled) {
      throw new SubagentPersistenceError(
        "STORAGE_UNAVAILABLE",
        this.availableReason || "子代理上下文持久化未启用或存储不可用",
      );
    }
  }

  private async loadSessionControl(
    sessionId: string,
    preserveUnavailableLegacy = false,
  ): Promise<SessionControlRecord | null> {
    const p = this.files.path(sessionId, "session-control.bin");
    let bytes: Buffer;
    try {
      bytes = await this.files.readBounded(p, 1024 * 1024);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      this.isolatedSessions.set(sessionId, "SESSION_CONTROL_CORRUPTED");
      throw new SubagentPersistenceError(
        "SNAPSHOT_CORRUPTED",
        `读取会话控制记录失败: ${(err as Error).message}`,
      );
    }

    try {
      return this.files.decode<SessionControlRecord>(bytes, `${sessionId}/session-control`);
    } catch (err) {
      if (preserveUnavailableLegacy && err instanceof LegacySnapshotKeyUnavailableError) throw err;
      this.isolatedSessions.set(sessionId, "SESSION_CONTROL_CORRUPTED");
      throw new SubagentPersistenceError(
        "SNAPSHOT_CORRUPTED",
        `会话控制记录格式、身份或旧版加密认证失败: ${(err as Error).message}`,
      );
    }
  }

  private async saveSessionControl(sessionId: string, record: SessionControlRecord): Promise<void> {
    const p = this.files.path(sessionId, "session-control.bin");
    const bytes = this.files.encode(record, `${sessionId}/session-control`, 1024 * 1024);
    await this.files.atomicWrite(p, bytes);
  }

  private async loadControl(sessionId: string, delegationId: string): Promise<StoredControlRecord | null> {
    const p = this.files.path(sessionId, delegationId, "control.bin");
    let bytes: Buffer;
    try {
      bytes = await this.files.readBounded(p, 1024 * 1024);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new SubagentPersistenceError(
        "SNAPSHOT_CORRUPTED",
        `读取任务控制记录失败: ${(err as Error).message}`,
      );
    }

    try {
      return this.files.decode<StoredControlRecord>(bytes, `${sessionId}/${delegationId}/control`);
    } catch (err) {
      throw new SubagentPersistenceError(
        "SNAPSHOT_CORRUPTED",
        `任务控制记录格式、身份或旧版加密认证失败: ${(err as Error).message}`,
      );
    }
  }

  private async saveControl(sessionId: string, delegationId: string, record: StoredControlRecord): Promise<void> {
    const p = this.files.path(sessionId, delegationId, "control.bin");
    const bytes = this.files.encode(record, `${sessionId}/${delegationId}/control`, 1024 * 1024);
    await this.files.atomicWrite(p, bytes);
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      const stat = await lstat(path);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  }

  private deliveryStopped(sessionId: string): boolean {
    return this.deliveryDraining || this.closed || this.closingSessions.has(sessionId);
  }

  private cancellableSleep(sessionId: string, ms: number): Promise<boolean> {
    if (this.deliveryStopped(sessionId)) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.deliveryTimers.delete(timer);
        resolve(!this.deliveryStopped(sessionId));
      }, ms);
      timer.unref();
      this.deliveryTimers.set(timer, { sessionId, cancel: () => {
        clearTimeout(timer);
        this.deliveryTimers.delete(timer);
        resolve(false);
      } });
    });
  }

  /** 补投在队列外执行；真实落盘后先覆盖水位，再移除 pending。 */
  private triggerPendingDeliveriesAsync(sessionId: string, delegationId: string, _executionId: string): void {
    if (this.deliveryStopped(sessionId)) return;
    const taskKey = `${sessionId}/${delegationId}`;
    if (this.activeDeliveries.has(taskKey)) return;
    this.activeDeliveries.add(taskKey);
    const deliveryPromise = (async () => {
      let failures = 0;
      while (!this.deliveryStopped(sessionId)) {
        try {
          const pending = await this.queue.enqueue(async () => {
            const session = await this.loadSessionControl(sessionId);
            if (!session || session.closed || session.isolated) return undefined;
            const control = await this.loadControl(sessionId, delegationId);
            return control?.pendingDeliveries?.[0];
          });
          if (!pending || this.deliveryStopped(sessionId)) return;
          const envelope = pending.envelope;
          const event = envelope?.event;
          if (envelope.sessionId !== sessionId || event?.type !== "message_end" ||
              event.message.role !== "tool" || event.message.toolName !== "TaskExecution" ||
              event.message.id !== pending.deliveryId) return;
          await this.deliverEvent(envelope);
          await this.queue.enqueue(async () => {
            const session = await this.loadSessionControl(sessionId);
            if (!session || session.closed) return;
            if (this.verifiedSessions.has(sessionId) && !session.isolated) {
              const authority = await this.sessionAuthority(sessionId);
              if (!authority) throw new Error("会话已不存在，无法确认补投水位");
              session.coveredWatermark = authority.watermark;
              session.updatedAt = Date.now();
              await this.saveSessionControl(sessionId, session);
            }
            const live = await this.loadControl(sessionId, delegationId);
            if (!live) return;
            live.pendingDeliveries = live.pendingDeliveries.filter((item) => item.deliveryId !== pending.deliveryId);
            live.updatedAt = Date.now();
            await this.saveControl(sessionId, delegationId, live);
          });
          failures = 0;
        } catch {
          // 保留待交付记录。退避间隔封顶一分钟，关闭会话/应用会唤醒并取消等待。
          failures = Math.min(failures + 1, 8);
          if (!await this.cancellableSleep(sessionId, Math.min(60_000, 250 * 2 ** failures))) return;
        }
      }
    })().catch(() => undefined).finally(() => {
      this.activeDeliveries.delete(taskKey);
      this.activeDeliveryPromises.delete(deliveryPromise);
      this.deliverySessions.delete(deliveryPromise);
    });
    this.activeDeliveryPromises.add(deliveryPromise);
    this.deliverySessions.set(deliveryPromise, sessionId);
  }

  private async assertControlRecordQuota(sessionId: string): Promise<void> {
    const sessionPath = this.files.path(sessionId);
    try {
      const entries = await readdir(sessionPath, { withFileTypes: true });
      const dirCount = entries.filter((e) => e.isDirectory()).length;
      if (dirCount >= MAX_CONTROL_RECORDS_PER_SESSION) {
        throw new SubagentPersistenceError(
          "QUOTA_EXCEEDED",
          `会话控制记录已达上限 (${MAX_CONTROL_RECORDS_PER_SESSION})，拒绝新增任务`,
        );
      }
    } catch (err) {
      if (err instanceof SubagentPersistenceError) throw err;
      throw new SubagentPersistenceError("STORAGE_UNAVAILABLE", `无法核算控制记录配额: ${(err as Error).message}`);
    }
  }

  private async enforceSessionSnapshotQuota(sessionId: string): Promise<void> {
    const sessionPath = this.files.path(sessionId);
    try {
      const delegEntries = await readdir(sessionPath, { withFileTypes: true });
      const snapshotFiles: { path: string; mtime: number }[] = [];

      for (const dEntry of delegEntries) {
        if (!dEntry.isDirectory()) continue;
        const delegPath = this.files.path(sessionId, dEntry.name);
        const files = await readdir(delegPath);
        for (const file of files) {
          if (file.startsWith("generation-") && file.endsWith(".bin")) {
            const fullPath = this.files.path(sessionId, dEntry.name, file);
            try {
              const stat = await lstat(fullPath);
              snapshotFiles.push({ path: fullPath, mtime: stat.mtimeMs });
            } catch {
              // Ignore stat failure
            }
          }
        }
      }

      if (snapshotFiles.length >= MAX_SESSION_SNAPSHOTS) {
        snapshotFiles.sort((a, b) => a.mtime - b.mtime);
        const toRemove = snapshotFiles.slice(0, snapshotFiles.length - MAX_SESSION_SNAPSHOTS + 1);
        for (const item of toRemove) {
          try {
            await unlink(item.path);
          } catch {
            // Ignore unlink failure
          }
        }
      }
    } catch {
      // Directory read error
    }
  }

  /**
   * Enforces global quota accounting across all snapshots, control records and temporary files.
   * If disk scanning fails, safely rejects new allocation.
   * Pruning ONLY removes generation files, never control or watermark records.
   */
  private async enforceGlobalQuota(additionalBytes: number): Promise<void> {
    if (additionalBytes > MAX_SNAPSHOT_BYTES) {
      throw new SubagentPersistenceError(
        "QUOTA_EXCEEDED",
        `单份快照大小超过上限 (${Math.round(MAX_SNAPSHOT_BYTES / (1024 * 1024))} MiB)`,
      );
    }

    let totalBytes = 0;
    const prunableGenerationFiles: { path: string; size: number; mtime: number }[] = [];

    try {
      const rootEntries = await readdir(this.root, { withFileTypes: true });
      for (const sEntry of rootEntries) {
        const fullRootEntryPath = this.files.path(sEntry.name);
        const stat = await lstat(fullRootEntryPath);
        totalBytes += stat.size;

        if (sEntry.isDirectory() && sEntry.name !== "settings.json" && !sEntry.name.endsWith(".tmp")) {
          const delegEntries = await readdir(fullRootEntryPath, { withFileTypes: true });
          for (const dEntry of delegEntries) {
            const fullDelegPath = this.files.path(sEntry.name, dEntry.name);
            const dStat = await lstat(fullDelegPath);
            totalBytes += dStat.size;

            if (dEntry.isDirectory()) {
              const files = await readdir(fullDelegPath);
              for (const file of files) {
                const fullFilePath = this.files.path(sEntry.name, dEntry.name, file);
                const fStat = await lstat(fullFilePath);
                totalBytes += fStat.size;

                if (file.startsWith("generation-") && file.endsWith(".bin")) {
                  prunableGenerationFiles.push({ path: fullFilePath, size: fStat.size, mtime: fStat.mtimeMs });
                }
              }
            }
          }
        }
      }
    } catch (scanErr) {
      throw new SubagentPersistenceError(
        "STORAGE_UNAVAILABLE",
        `配额空间统计失败，安全保守拒绝新增: ${(scanErr as Error).message}`,
      );
    }

    // Overhead for atomic rename (2x snapshot size)
    const required = additionalBytes * 2;
    if (totalBytes + required > MAX_TOTAL_BYTES) {
      prunableGenerationFiles.sort((a, b) => a.mtime - b.mtime);
      for (const item of prunableGenerationFiles) {
        try {
          await unlink(item.path);
          totalBytes -= item.size;
          if (totalBytes + required <= MAX_TOTAL_BYTES) break;
        } catch {
          // Ignore
        }
      }

      if (totalBytes + required > MAX_TOTAL_BYTES) {
        throw new SubagentPersistenceError(
          "QUOTA_EXCEEDED",
          `快照全局配额超限 (${Math.round(MAX_TOTAL_BYTES / (1024 * 1024))} MiB)，控制记录不可删除，已停止新增`,
        );
      }
    }
  }

  /** Prunes older generation files in-queue based on current committed snapshotGeneration */
  private async pruneOldGenerationsInQueue(sessionId: string, delegationId: string, currentGen: number): Promise<void> {
    try {
      const delegPath = this.files.path(sessionId, delegationId);
      const files = await readdir(delegPath);
      for (const file of files) {
        if (file.startsWith("generation-") && file.endsWith(".bin") && file !== `generation-${currentGen}.bin`) {
          try {
            await unlink(this.files.path(sessionId, delegationId, file));
          } catch {
            // Ignore
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  private async pruneExpiredSnapshots(): Promise<void> {
    const expireBefore = Date.now() - DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    try {
      const rootEntries = await readdir(this.root, { withFileTypes: true });
      for (const sEntry of rootEntries) {
        if (!sEntry.isDirectory()) continue;
        const sessionId = sEntry.name;
        if (sessionId === "settings.json" || sessionId.endsWith(".tmp")) continue;

        const sessionPath = this.files.path(sessionId);
        const delegEntries = await readdir(sessionPath, { withFileTypes: true });
        for (const dEntry of delegEntries) {
          if (!dEntry.isDirectory()) continue;
          const delegPath = this.files.path(sessionId, dEntry.name);
          const files = await readdir(delegPath);
          for (const file of files) {
            if (file.startsWith("generation-") && file.endsWith(".bin")) {
              const fullPath = this.files.path(sessionId, dEntry.name, file);
              try {
                const stat = await lstat(fullPath);
                if (stat.mtimeMs < expireBefore) {
                  await unlink(fullPath);
                }
              } catch {
                // Ignore
              }
            }
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  private async cleanupTemporaryFiles(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = resolve(dir, entry.name);
        if (entry.name.endsWith(".tmp")) {
          await unlink(fullPath).catch(() => {});
        } else if (entry.isDirectory()) {
          await this.cleanupTemporaryFiles(fullPath);
        }
      }
    } catch {
      // Best effort cleanup
    }
  }
}
