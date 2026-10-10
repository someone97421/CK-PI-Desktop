import { randomUUID } from "node:crypto";
import type { RuntimeHost } from "./host-client.js";
import {
  SubagentPersistenceError,
  type SubagentBeginReceipt, type SubagentBeginRequest,
  type SubagentClaimSessionReceipt, type SubagentClaimSessionRequest,
  type SubagentCommitReceipt, type SubagentCommitRequest,
  type SubagentConfirmEventsRequest, type SubagentEventAckReceipt,
  type SubagentFailReceipt, type SubagentFailRequest,
  type SubagentListReceipt, type SubagentListRequest,
  type SubagentLoadReceipt, type SubagentLoadRequest,
  type SubagentPersistencePort, type SubagentPersistenceSettings,
  type SubagentPersistenceStatus, type SubagentRevokeReceipt, type SubagentRevokeRequest,
} from "./subagent-persistence.js";

const RPC_TIMEOUT_MS = 5_000;
const RETRYABLE_CODES = new Set(["STORAGE_UNAVAILABLE", "ETIMEDOUT", "EIO", "EBUSY", "EPERM", "UNKNOWN"]);

interface Execution {
  status: SubagentPersistenceStatus;
  execution: number;
  revision: number;
  begin?: SubagentBeginRequest;
  registered: boolean;
  diskRevision: number;
}

/** 运行状态留在内存；每个任务独立排队同步磁盘，磁盘回执不参与任务准入。 */
export class SubagentPersistenceClient implements SubagentPersistencePort {
  private _instanceGeneration = 1;
  private _available = false;
  private _supported = true;
  private _claimed = false;
  private settings?: SubagentPersistenceSettings;
  private claim?: Promise<SubagentClaimSessionReceipt>;
  private readonly executions = new Map<string, Execution>();
  private readonly stopped = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private closing = false;
  readonly runtimeInstanceId: string;

  constructor(readonly host: RuntimeHost, readonly sessionId: string, runtimeInstanceId?: string) {
    this.runtimeInstanceId = runtimeInstanceId ?? randomUUID();
  }

  get instanceGeneration(): number { return this._instanceGeneration; }
  get available(): boolean { return this._available; }
  get supported(): boolean { return this._supported; }
  get isClaimed(): boolean { return this._claimed; }
  isMemoryOnly(_id: string): boolean { return this.settings?.enabled === false || !this._supported; }

  completeMemoryExecution(id: string, execution: number): void {
    const entry = this.executions.get(id);
    if (entry?.execution === execution && entry.status === "running") entry.status = "completed";
  }

  private async call<T>(operation: string, request: object = {}): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.host.call<T>("subagent.persistence", { operation, ...request }, RPC_TIMEOUT_MS),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new SubagentPersistenceError("STORAGE_UNAVAILABLE", "快照操作超时")), RPC_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const match = message.match(/^\[([A-Z_]+)\]\s*(.*)$/);
      if (match) throw new SubagentPersistenceError(match[1] as any, match[2]);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private enqueue<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).then(work, work);
    this.queues.set(id, next);
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); }).catch(() => undefined);
    return next;
  }

  private async retry<T>(work: () => Promise<T>, active: () => boolean): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (!active() || this.closing) throw new SubagentPersistenceError("EXECUTION_CONFLICT", "快照操作已被后续任务状态替代");
      try { return await work(); }
      catch (error) {
        const code = (error as { code?: string })?.code ?? "UNKNOWN";
        if (attempt >= 1 || !RETRYABLE_CODES.has(code)) throw error;
      }
    }
  }

  async checkCapabilities(): Promise<{ supported: boolean; settings?: SubagentPersistenceSettings }> {
    let result: { protocolVersion: number; settings: SubagentPersistenceSettings } | undefined;
    try { result = await this.call<{ protocolVersion: number; settings: SubagentPersistenceSettings }>("capabilities"); }
    catch (error) {
      if ((error as { code?: unknown })?.code !== -32601 && !/method not found|unsupported subagent persistence/i.test(error instanceof Error ? error.message : "")) throw error;
    }
    this._supported = result?.protocolVersion === 1;
    this.settings = result?.settings;
    this._available = this._supported && Boolean(this.settings?.enabled && this.settings?.available);
    return { supported: this._supported, settings: this.settings };
  }

  async claimSession(_req?: Partial<SubagentClaimSessionRequest>): Promise<SubagentClaimSessionReceipt> {
    if (this.closing) throw new SubagentPersistenceError("STALE_INSTANCE", "运行实例已关闭");
    if (this.claim) return this.claim;
    const pending = (async () => {
      await this.checkCapabilities();
      if (this.closing) throw new SubagentPersistenceError("STALE_INSTANCE", "运行实例已关闭");
      if (!this._available) return { sessionId: this.sessionId, instanceGeneration: this.instanceGeneration, available: false, settings: this.settings };
      const result = await this.call<SubagentClaimSessionReceipt>("claimSession", { sessionId: this.sessionId, runtimeInstanceId: this.runtimeInstanceId });
      this._instanceGeneration = result.instanceGeneration;
      if (result.settings) this.settings = result.settings;
      this._available = result.available;
      this._claimed = result.available;
      return result;
    })();
    this.claim = pending;
    try { return await pending; }
    finally { if (this.claim === pending) this.claim = undefined; }
  }

  private async register(entry: Execution): Promise<void> {
    if (entry.registered) return;
    if (!this._claimed || !this._available) await this.claimSession();
    if (!this._available) throw new SubagentPersistenceError("STORAGE_UNAVAILABLE", "快照存储未启用或暂不可用");
    if (!entry.begin) throw new SubagentPersistenceError("INVALID_REQUEST", "缺少本轮快照登记信息");
    if (entry.status === "revoked" || this.stopped.has(entry.begin.delegationId) || this.closing) throw new SubagentPersistenceError("TASK_REVOKED", "任务已停止");
    const receipt = await this.call<SubagentBeginReceipt>("beginExecution", { ...entry.begin, instanceGeneration: this.instanceGeneration });
    entry.registered = true;
    entry.diskRevision = receipt.revision;
  }

  async beginExecution(req: SubagentBeginRequest): Promise<SubagentBeginReceipt> {
    const previous = this.executions.get(req.delegationId);
    if (this.closing || this.stopped.has(req.delegationId) || (previous && (previous.status !== "completed" || previous.execution !== req.expectedExecution))) {
      throw new SubagentPersistenceError("EXECUTION_CONFLICT", "任务状态或执行轮次已变化");
    }
    const entry: Execution = { status: "running", execution: req.nextExecution,
      revision: (previous?.revision ?? req.expectedRevision) + 1, begin: { ...req }, registered: false, diskRevision: 0 };
    this.executions.set(req.delegationId, entry);
    void this.enqueue(req.delegationId, async () => {
      if (this.closing || this.stopped.has(req.delegationId)) return;
      await this.checkCapabilities();
      if (this.isMemoryOnly(req.delegationId)) return;
      await this.retry(() => this.register(entry), () => !this.stopped.has(req.delegationId));
    }).catch(() => undefined);
    return { sessionId: req.sessionId, delegationId: req.delegationId, revision: entry.revision,
      execution: req.nextExecution, executionId: req.executionId, status: "running", acquiredAt: Date.now() };
  }

  async commitSnapshot(req: SubagentCommitRequest): Promise<SubagentCommitReceipt> {
    const entry = this.executions.get(req.delegationId);
    if (!entry || entry.execution !== req.expectedExecution || entry.status !== "completed") {
      throw new SubagentPersistenceError("EXECUTION_CONFLICT", "仅保存本轮已完成的上下文");
    }
    const frozen = structuredClone(req);
    return this.enqueue<SubagentCommitReceipt>(req.delegationId, async () => {
      if (this.closing || this.stopped.has(req.delegationId)) throw new SubagentPersistenceError("TASK_REVOKED", "快照保存已取消");
      await this.checkCapabilities();
      if (this.isMemoryOnly(req.delegationId)) return { sessionId: req.sessionId, delegationId: req.delegationId,
        revision: entry.revision, execution: entry.execution, executionId: req.executionId,
        snapshotGeneration: 0, status: "completed", committedAt: Date.now(), durableReady: false };
      return this.retry(async () => {
        await this.register(entry);
        if (this.stopped.has(req.delegationId)) throw new SubagentPersistenceError("TASK_REVOKED", "任务已停止");
        return this.call<SubagentCommitReceipt>("commitSnapshot", { ...frozen,
          expectedRevision: entry.diskRevision, instanceGeneration: this.instanceGeneration, pendingDeliveries: [] });
      }, () => entry.status === "completed" && !this.stopped.has(req.delegationId));
    });
  }

  async failExecution(req: SubagentFailRequest): Promise<SubagentFailReceipt> {
    const entry = this.executions.get(req.delegationId);
    if (entry && entry.execution === req.expectedExecution && entry.status !== "revoked") {
      entry.status = req.status;
      void this.enqueue(req.delegationId, () => this.retry(async () => {
        await this.register(entry);
        await this.call("failExecution", { ...req, expectedRevision: entry.diskRevision, instanceGeneration: this.instanceGeneration, pendingDeliveries: [] });
      }, () => entry.status === req.status)).catch(() => undefined);
    }
    return { sessionId: req.sessionId, delegationId: req.delegationId, execution: req.expectedExecution,
      revision: entry?.revision ?? req.expectedRevision, status: req.status, failedAt: Date.now() };
  }

  async revokeExecution(req: SubagentRevokeRequest): Promise<SubagentRevokeReceipt> {
    const entry = this.executions.get(req.delegationId);
    if (!entry) {
      this.stopped.add(req.delegationId);
      return this.enqueue(req.delegationId, () => this.retry(() => this.call<SubagentRevokeReceipt>("revokeExecution", req), () => true));
    }
    if (req.expectedExecution !== undefined && req.expectedExecution !== entry.execution) {
      throw new SubagentPersistenceError("EXECUTION_CONFLICT", "任务执行轮次已变化");
    }
    entry.status = "revoked";
    this.stopped.add(req.delegationId);
    // 已经排队的旧轮也不能在本地停止之后继续提交。
    return this.enqueue(req.delegationId, () => this.retry(() => this.call<SubagentRevokeReceipt>("revokeExecution", {
      ...req, instanceGeneration: this._claimed ? this.instanceGeneration : undefined,
    }), () => entry.status === "revoked"));
  }

  async loadSnapshot(req: SubagentLoadRequest): Promise<SubagentLoadReceipt> {
    const result = await this.call<SubagentLoadReceipt>("loadSnapshot", req);
    if (!this.executions.has(req.delegationId)) this.executions.set(req.delegationId, {
      status: "completed", execution: result.control.execution, revision: result.control.revision,
      registered: true, diskRevision: result.control.revision,
    });
    return result;
  }

  async listEntries(req: SubagentListRequest): Promise<SubagentListReceipt> {
    return this.call("listEntries", req);
  }

  async confirmEvents(req: SubagentConfirmEventsRequest): Promise<SubagentEventAckReceipt> {
    return this.call("confirmEvents", req);
  }

  async getSettings(): Promise<SubagentPersistenceSettings> {
    await this.checkCapabilities();
    return this.settings ?? { enabled: false, available: false, reason: "宿主未提供快照存储",
      retentionDays: 30, maxSessionSnapshots: 100, maxSnapshotBytes: 16 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024 };
  }

  /** 退出时限时收尾；超时后丢弃尚未发出的工作，不延长正常关闭流程。 */
  async flush(timeoutMs = 1_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.allSettled([...this.queues.values()]), new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); this.closing = true; }
  }
}
