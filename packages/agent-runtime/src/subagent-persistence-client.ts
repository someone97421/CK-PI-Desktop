/**
 * Subagent persistence client (ADR 0089).
 * Proxies SubagentPersistencePort operations over the host reverse-RPC channel
 * (`host.call('subagent.persistence', { operation, ...req })`).
 */

import { randomUUID } from "node:crypto";
import type { RuntimeHost } from "./host-client.js";
import {
  SubagentPersistenceError,
  type SubagentBeginReceipt,
  type SubagentBeginRequest,
  type SubagentClaimSessionReceipt,
  type SubagentClaimSessionRequest,
  type SubagentCommitReceipt,
  type SubagentCommitRequest,
  type SubagentConfirmEventsRequest,
  type SubagentDirectoryEntry,
  type SubagentEventAckReceipt,
  type SubagentFailReceipt,
  type SubagentFailRequest,
  type SubagentListReceipt,
  type SubagentListRequest,
  type SubagentLoadReceipt,
  type SubagentLoadRequest,
  type SubagentPersistencePort,
  type SubagentPersistenceSettings,
  type SubagentPersistenceStatus,
  type SubagentRevokeReceipt,
  type SubagentRevokeRequest,
} from "./subagent-persistence.js";

export interface MemoryLedgerEntry {
  status: SubagentPersistenceStatus;
  execution: number;
  revision: number;
  isMemoryOnly: boolean;
  wasDurable: boolean;
}

export class SubagentPersistenceClient implements SubagentPersistencePort {
  private _instanceGeneration = 1;
  private _available = false;
  private _settings?: SubagentPersistenceSettings;
  private _claimed = false;
  private _supported = true;
  private readonly memoryLedger = new Map<string, MemoryLedgerEntry>();
  readonly runtimeInstanceId: string;

  constructor(
    readonly host: RuntimeHost,
    readonly sessionId: string,
    runtimeInstanceId?: string,
  ) {
    this.runtimeInstanceId = runtimeInstanceId || randomUUID();
  }

  get instanceGeneration(): number {
    return this._instanceGeneration;
  }

  get available(): boolean {
    return this._available;
  }

  get supported(): boolean {
    return this._supported;
  }

  get isClaimed(): boolean {
    return this._claimed;
  }

  /** Checks whether a given delegation is running strictly in-memory without durable store backing */
  public isMemoryOnly(delegationId: string): boolean {
    const entry = this.memoryLedger.get(delegationId);
    if (entry) return entry.isMemoryOnly;
    return !this._supported || !this._available;
  }

  completeMemoryExecution(delegationId: string, execution: number): void {
    const entry = this.memoryLedger.get(delegationId);
    if (entry?.isMemoryOnly && entry.execution === execution && entry.status === "running") entry.status = "completed";
  }

  /** Explicitly marks a delegation as backed by durable store */
  public markDurable(delegationId: string, execution = 1, revision = 1): void {
    const existing = this.memoryLedger.get(delegationId);
    this.memoryLedger.set(delegationId, {
      status: existing?.status ?? "completed",
      execution: Math.max(execution, existing?.execution ?? 1),
      revision: Math.max(revision, existing?.revision ?? 1),
      isMemoryOnly: false,
      wasDurable: true,
    });
  }

  async checkCapabilities(): Promise<{ supported: boolean; settings?: SubagentPersistenceSettings }> {
    try {
      const res = await this.host.call<{ protocolVersion: number; settings: SubagentPersistenceSettings }>(
        "subagent.persistence",
        { operation: "capabilities" },
      );
      if (res && typeof res === "object" && res.protocolVersion === 1) {
        this._supported = true;
        this._settings = res.settings;
        this._available = Boolean(res.settings?.available && res.settings?.enabled);
        return { supported: true, settings: this._settings };
      }
      this._supported = false;
      this._available = false;
      return { supported: false };
    } catch {
      this._supported = false;
      this._available = false;
      return { supported: false };
    }
  }

  async claimSession(req?: Partial<SubagentClaimSessionRequest>): Promise<SubagentClaimSessionReceipt> {
    const payload: SubagentClaimSessionRequest = {
      sessionId: req?.sessionId ?? this.sessionId,
      runtimeInstanceId: req?.runtimeInstanceId ?? this.runtimeInstanceId,
    };

    // Capability check MUST happen before claiming
    await this.checkCapabilities();
    if (!this._supported) {
      this._claimed = true;
      this._available = false;
      return {
        sessionId: payload.sessionId,
        instanceGeneration: 1,
        available: false,
        reason: "Subagent persistence protocol version is unsupported or unavailable",
      };
    }

    try {
      const res = await this.host.call<SubagentClaimSessionReceipt>("subagent.persistence", {
        operation: "claimSession",
        ...payload,
      });
      this._instanceGeneration = res.instanceGeneration;
      if (res.settings) this._settings = res.settings;
      this._available = Boolean(res.available && (res.settings?.enabled ?? true));
      this._claimed = true;
      this._supported = true;
      return res;
    } catch (err) {
      this._claimed = true;
      if (this.isUnsupportedRpc(err)) {
        this._supported = false;
        this._available = false;
        return {
          sessionId: payload.sessionId,
          instanceGeneration: 1,
          available: false,
          reason: "Host does not support subagent persistence",
        };
      }
      throw this.wrapPersistenceError(err);
    }
  }

  async beginExecution(req: SubagentBeginRequest): Promise<SubagentBeginReceipt> {
    if (!this.memoryLedger.has(req.delegationId) && req.expectedExecution === 0) {
      await this.claimSession();
      req = { ...req, instanceGeneration: this.instanceGeneration };
    }
    const entry = this.memoryLedger.get(req.delegationId);
    const wasDurable = entry ? entry.wasDurable : (req.expectedRevision > 0 || req.expectedExecution > 0);

    // Previously durable task must ALWAYS go through store CAS to avoid bypassing revoked/interrupted
    if (wasDurable) {
      try {
        const receipt = await this.host.call<SubagentBeginReceipt>("subagent.persistence", {
          operation: "beginExecution",
          ...req,
        });
        this.memoryLedger.set(req.delegationId, {
          status: "running",
          execution: req.nextExecution,
          revision: receipt.revision,
          isMemoryOnly: false,
          wasDurable: true,
        });
        return receipt;
      } catch (err) {
        throw this.wrapPersistenceError(err);
      }
    }

    // Fresh task when unsupported or persistence is disabled/unavailable runs strictly in-memory
    const shouldRunMemoryOnly = !this._supported || !this._available || entry?.isMemoryOnly;
    if (shouldRunMemoryOnly) {
      if (entry && (entry.status !== "completed" || entry.execution !== req.expectedExecution || entry.revision !== req.expectedRevision)) {
        throw new SubagentPersistenceError("EXECUTION_CONFLICT", "内存任务状态或执行轮次不匹配");
      }
      const rev = (entry?.revision ?? req.expectedRevision) + 1;
      this.memoryLedger.set(req.delegationId, {
        status: "running",
        execution: req.nextExecution,
        revision: rev,
        isMemoryOnly: true,
        wasDurable: false,
      });
      return {
        sessionId: req.sessionId,
        delegationId: req.delegationId,
        revision: rev,
        execution: req.nextExecution,
        executionId: req.executionId,
        status: "running",
        acquiredAt: Date.now(),
      };
    }

    // Fresh task with active store backing
    try {
      const receipt = await this.host.call<SubagentBeginReceipt>("subagent.persistence", {
        operation: "beginExecution",
        ...req,
      });
      this.memoryLedger.set(req.delegationId, {
        status: "running",
        execution: req.nextExecution,
        revision: receipt.revision,
        isMemoryOnly: false,
        wasDurable: true,
      });
      return receipt;
    } catch (err) {
      throw this.wrapPersistenceError(err);
    }
  }

  async commitSnapshot(req: SubagentCommitRequest): Promise<SubagentCommitReceipt> {
    const entry = this.memoryLedger.get(req.delegationId);
    if (entry?.isMemoryOnly || (!entry?.wasDurable && !this._supported)) {
      const rev = (entry?.revision ?? req.expectedRevision) + 1;
      this.memoryLedger.set(req.delegationId, {
        status: "completed",
        execution: req.expectedExecution,
        revision: rev,
        isMemoryOnly: true,
        wasDurable: false,
      });
      return {
        sessionId: req.sessionId,
        delegationId: req.delegationId,
        revision: rev,
        execution: req.expectedExecution,
        executionId: req.executionId,
        snapshotGeneration: 0,
        status: "completed",
        committedAt: Date.now(),
        durableReady: false,
      };
    }

    try {
      const receipt = await this.host.call<SubagentCommitReceipt>("subagent.persistence", {
        operation: "commitSnapshot",
        ...req,
      });
      this.memoryLedger.set(req.delegationId, {
        status: "completed",
        execution: req.expectedExecution,
        revision: receipt.revision,
        isMemoryOnly: false,
        wasDurable: true,
      });
      return receipt;
    } catch (err) {
      throw this.wrapPersistenceError(err);
    }
  }

  async failExecution(req: SubagentFailRequest): Promise<SubagentFailReceipt> {
    const entry = this.memoryLedger.get(req.delegationId);
    if (entry?.isMemoryOnly || (!entry?.wasDurable && !this._supported)) {
      const rev = (entry?.revision ?? req.expectedRevision) + 1;
      this.memoryLedger.set(req.delegationId, {
        status: req.status,
        execution: req.expectedExecution,
        revision: rev,
        isMemoryOnly: true,
        wasDurable: false,
      });
      return {
        sessionId: req.sessionId,
        delegationId: req.delegationId,
        revision: rev,
        execution: req.expectedExecution,
        status: req.status,
        failedAt: Date.now(),
      };
    }

    try {
      const receipt = await this.host.call<SubagentFailReceipt>("subagent.persistence", {
        operation: "failExecution",
        ...req,
      });
      this.memoryLedger.set(req.delegationId, {
        status: req.status,
        execution: req.expectedExecution,
        revision: receipt.revision,
        isMemoryOnly: false,
        wasDurable: true,
      });
      return receipt;
    } catch (err) {
      throw this.wrapPersistenceError(err);
    }
  }

  async revokeExecution(req: SubagentRevokeRequest): Promise<SubagentRevokeReceipt> {
    const entry = this.memoryLedger.get(req.delegationId);
    if (entry?.isMemoryOnly) {
      if (req.expectedExecution !== undefined && req.expectedExecution !== entry.execution) {
        throw new SubagentPersistenceError("EXECUTION_CONFLICT", "内存任务执行轮次已变化");
      }
      const rev = (entry?.revision ?? req.expectedRevision ?? 0) + 1;
      this.memoryLedger.set(req.delegationId, {
        status: "revoked",
        execution: req.expectedExecution ?? entry?.execution ?? 1,
        revision: rev,
        isMemoryOnly: true,
        wasDurable: false,
      });
      return {
        sessionId: req.sessionId,
        delegationId: req.delegationId,
        revision: rev,
        execution: req.expectedExecution ?? entry?.execution ?? 1,
        status: "revoked",
        revokedAt: Date.now(),
      };
    }

    try {
      const receipt = await this.host.call<SubagentRevokeReceipt>("subagent.persistence", {
        operation: "revokeExecution",
        ...req,
      });
      this.memoryLedger.set(req.delegationId, {
        status: "revoked",
        execution: receipt.execution,
        revision: receipt.revision,
        isMemoryOnly: false,
        wasDurable: true,
      });
      return receipt;
    } catch (err) {
      throw this.wrapPersistenceError(err);
    }
  }

  async loadSnapshot(req: SubagentLoadRequest): Promise<SubagentLoadReceipt> {
    try {
      const receipt = await this.host.call<SubagentLoadReceipt>("subagent.persistence", {
        operation: "loadSnapshot",
        ...req,
      });
      this.markDurable(req.delegationId, receipt.control.execution, receipt.control.revision);
      return receipt;
    } catch (err) {
      throw this.wrapPersistenceError(err);
    }
  }

  async listEntries(req: SubagentListRequest): Promise<SubagentListReceipt> {
    if (!this._supported) {
      return {
        sessionId: req.sessionId,
        entries: [],
      };
    }
    try {
      const receipt = await this.host.call<SubagentListReceipt>("subagent.persistence", {
        operation: "listEntries",
        ...req,
      });
      if (Array.isArray(receipt?.entries)) {
        for (const e of receipt.entries) {
          this.markDurable(e.delegationId, e.execution, e.revision);
        }
      }
      return receipt;
    } catch (err) {
      if (this.isUnsupportedRpc(err)) {
        this._supported = false;
        return { sessionId: req.sessionId, entries: [] };
      }
      throw this.wrapPersistenceError(err);
    }
  }

  async confirmEvents(req: SubagentConfirmEventsRequest): Promise<SubagentEventAckReceipt> {
    if (!this._supported) {
      return {
        sessionId: req.sessionId,
        delegationId: req.delegationId,
        executionId: req.executionId,
        ackedDeliveryIds: req.deliveryIds,
        remainingDeliveriesCount: 0,
      };
    }
    try {
      return await this.host.call<SubagentEventAckReceipt>("subagent.persistence", {
        operation: "confirmEvents",
        ...req,
      });
    } catch (err) {
      throw this.wrapPersistenceError(err);
    }
  }

  async getSettings(): Promise<SubagentPersistenceSettings> {
    const caps = await this.checkCapabilities();
    return caps.settings ?? {
      enabled: false,
      available: false,
      reason: "Not supported by host",
      retentionDays: 30,
      maxSessionSnapshots: 100,
      maxSnapshotBytes: 16 * 1024 * 1024,
      maxTotalBytes: 512 * 1024 * 1024,
    };
  }

  private isUnsupportedRpc(err: unknown): boolean {
    const msg = String((err as any)?.message ?? "");
    const code = (err as any)?.code ?? (err as any)?.rpcCode;
    return code === -32601 || /method not found|unsupported subagent persistence/i.test(msg);
  }

  private wrapPersistenceError(err: unknown): Error {
    if (err instanceof SubagentPersistenceError) return err;
    const msg = err instanceof Error ? err.message : String(err);
    const codeMatch = msg.match(/^\[([A-Z_]+)\]\s*(.*)$/);
    if (codeMatch) {
      return new SubagentPersistenceError(codeMatch[1] as any, codeMatch[2]);
    }
    const code = (err as any)?.code || (err as any)?.errorCode;
    if (typeof code === "string") {
      return new SubagentPersistenceError(code as any, msg, (err as any)?.details);
    }
    return err instanceof Error ? err : new Error(msg);
  }
}
