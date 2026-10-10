import { createHash } from "node:crypto";
import { lstat, readdir, realpath, rm, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { MessageUsage, SubagentPersistenceSettings, SubagentRecallStatus } from "@pi-desktop/shared";
import {
  SubagentPersistenceError, validateCheckpoint,
  type SubagentBeginReceipt, type SubagentBeginRequest,
  type SubagentClaimSessionReceipt, type SubagentClaimSessionRequest,
  type SubagentCommitReceipt, type SubagentCommitRequest,
  type SubagentConfirmEventsRequest, type SubagentControlRecord, type SubagentDirectoryEntry,
  type SubagentEventAckReceipt, type SubagentFailReceipt, type SubagentFailRequest,
  type SubagentListReceipt, type SubagentListRequest, type SubagentLoadReceipt, type SubagentLoadRequest,
  type SubagentPersistencePort, type SubagentRevokeReceipt, type SubagentRevokeRequest,
} from "@pi-desktop/agent-runtime";
import { SNAPSHOT_FILE_LIMIT, SubagentSnapshotFiles } from "./subagent-snapshot-files.js";
import type { SubagentSessionAuthority } from "./subagent-session-authority.js";

export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_SESSION_SNAPSHOTS = 100;
export const MAX_SNAPSHOT_BYTES = SNAPSHOT_FILE_LIMIT;
export const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

/** 保留旧控制文件字段，读取时不再把历史指纹和异常退出视为整会话禁用条件。 */
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

export interface StoredControlRecord extends SubagentControlRecord {
  appVersion?: string;
  modelId?: string;
  agentName?: string;
  lastReportSummary?: string;
  commitDigest?: string;
  parentTurnId?: string;
  parentToolCallId?: string;
  lastResult?: {
    status: string; report: string; turns: number; toolCalls: number; contextCompactions?: number;
    usage?: MessageUsage; executionUsage?: MessageUsage; error?: { code: string; message: string };
  };
}

export interface SubagentSnapshotStoreOptions {
  dataDir: string;
  sessionAuthority: SubagentSessionAuthority;
}

function identifier(id: string): void {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new SubagentPersistenceError("INVALID_REQUEST", "快照标识无效");
}

function samePath(a: string, b: string): boolean {
  if (!a || !b) return a === b;
  return process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
}

/** 可选的上下文存储。唯一的任务执行真相在 runtime；此处只管理文件版本与过期写入。 */
export class SubagentSnapshotStore implements SubagentPersistencePort {
  readonly root: string;
  readonly files: SubagentSnapshotFiles;
  private initialization?: Promise<void>;
  private available = false;
  private availableReason?: string;
  private enabled = false;
  private closed = false;
  private readonly sessions = new Map<string, SessionControlRecord>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly revoked = new Set<string>();
  private readonly closingSessions = new Set<string>();
  private readonly deletedSessions = new Set<string>();

  constructor(private readonly options: SubagentSnapshotStoreOptions) {
    this.root = resolve(options.dataDir, "subagent-contexts", "v1");
    this.files = new SubagentSnapshotFiles(this.root);
  }

  initialize(): Promise<void> {
    return this.initialization ??= (async () => {
      try {
        await this.files.initialize();
        this.available = true;
        try {
          const settings = JSON.parse((await this.files.readBounded(this.files.path("settings.json"), 64 * 1024)).toString("utf8"));
          this.enabled = settings.enabled === true;
        } catch { /* 首次使用保持默认关闭。 */ }
      } catch (error) {
        this.availableReason = error instanceof Error ? error.message : "快照目录不可用";
      }
    })();
  }

  private enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(key) ?? Promise.resolve()).then(work, work);
    this.queues.set(key, next);
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }).catch(() => undefined);
    return next;
  }

  private async ready(writing = false): Promise<void> {
    await this.initialize();
    if (this.closed || !this.available || (writing && !this.enabled)) {
      throw new SubagentPersistenceError("STORAGE_UNAVAILABLE", this.availableReason ?? "快照存储未启用或暂不可用");
    }
  }

  async getSettings(): Promise<SubagentPersistenceSettings> {
    await this.initialize();
    return { enabled: this.enabled, available: this.available, reason: this.availableReason,
      retentionDays: DEFAULT_RETENTION_DAYS, maxSessionSnapshots: MAX_SESSION_SNAPSHOTS,
      maxSnapshotBytes: MAX_SNAPSHOT_BYTES, maxTotalBytes: MAX_TOTAL_BYTES };
  }

  async setEnabled(enabled: boolean): Promise<SubagentPersistenceSettings> {
    await this.ready();
    await this.enqueue("settings", async () => {
      await this.files.atomicWrite(this.files.path("settings.json"), Buffer.from(JSON.stringify({ enabled })));
      this.enabled = enabled;
    });
    return this.getSettings();
  }

  private async read<T>(identity: string, path: string): Promise<T | null> {
    try { return this.files.decode<T>(await this.files.readBounded(path), identity); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  private async control(sessionId: string, delegationId: string): Promise<StoredControlRecord | null> {
    identifier(sessionId); identifier(delegationId);
    if (this.deletedSessions.has(sessionId)) throw new SubagentPersistenceError("SESSION_DELETED", "会话已删除");
    const record = await this.read<StoredControlRecord>(`${sessionId}/${delegationId}/control`, this.files.path(sessionId, delegationId, "control.bin"));
    if (record && (record.sessionId !== sessionId || record.delegationId !== delegationId ||
        !Number.isSafeInteger(record.execution) || !Number.isSafeInteger(record.revision) ||
        !Number.isSafeInteger(record.snapshotGeneration) || record.snapshotGeneration < 0 ||
        !["running", "completed", "failed", "interrupted", "revoked"].includes(record.status))) {
      throw new SubagentPersistenceError("SNAPSHOT_CORRUPTED", "任务控制记录身份或轮次无效");
    }
    return record;
  }

  private async writeControl(control: StoredControlRecord): Promise<void> {
    await this.files.atomicWrite(this.files.path(control.sessionId, control.delegationId, "control.bin"),
      this.files.encode(control, `${control.sessionId}/${control.delegationId}/control`));
  }

  private async writeSession(session: SessionControlRecord): Promise<void> {
    await this.files.atomicWrite(this.files.path(session.sessionId, "session-control.bin"), this.files.encode(session, `${session.sessionId}/session-control`));
  }

  async claimSession(req: SubagentClaimSessionRequest): Promise<SubagentClaimSessionReceipt> {
    await this.ready(); identifier(req.sessionId);
    return this.enqueue<SubagentClaimSessionReceipt>(`session:${req.sessionId}`, async () => {
      const current = this.sessions.get(req.sessionId);
      if (current?.claimedRuntimeInstanceId === req.runtimeInstanceId && !current.closed) {
        return { sessionId: req.sessionId, instanceGeneration: current.instanceGeneration, available: this.enabled, settings: await this.getSettings() };
      }
      if (this.deletedSessions.has(req.sessionId)) throw new SubagentPersistenceError("SESSION_DELETED", "会话已删除");
      const authority = await this.options.sessionAuthority(req.sessionId, "identity");
      if (!authority) throw new SubagentPersistenceError("SESSION_DELETED", "会话已删除");
      const previous = current ?? await this.read<SessionControlRecord>(`${req.sessionId}/session-control`, this.files.path(req.sessionId, "session-control.bin"))
        .catch(() => null);
      const session: SessionControlRecord = { sessionId: req.sessionId, projectRealPath: authority.projectRealPath,
        coveredWatermark: "", instanceGeneration: Math.max(0, Number.isSafeInteger(previous?.instanceGeneration) ? previous!.instanceGeneration : 0) + 1,
        claimedRuntimeInstanceId: req.runtimeInstanceId, closed: false, dirty: false, isolated: false, updatedAt: Date.now() };
      if (this.closed || this.deletedSessions.has(req.sessionId)) throw new SubagentPersistenceError("SESSION_DELETED", "会话已关闭或删除");
      await this.writeSession(session);
      this.sessions.set(req.sessionId, session);
      this.closingSessions.delete(req.sessionId);
      return { sessionId: req.sessionId, instanceGeneration: session.instanceGeneration, available: this.enabled, settings: await this.getSettings() };
    });
  }

  private owner(sessionId: string, generation: number): SessionControlRecord {
    const session = this.sessions.get(sessionId);
    if (this.closed || this.closingSessions.has(sessionId) || !session || session.closed || session.instanceGeneration !== generation) {
      throw new SubagentPersistenceError("STALE_INSTANCE", "快照写入来自已结束的运行实例");
    }
    return session;
  }

  private fresh(sessionId: string, delegationId: string, execution: number, executionId: string, generation: number): StoredControlRecord {
    return { sessionId, delegationId, execution, executionId, instanceGeneration: generation,
      revision: 0, snapshotGeneration: 0, status: "running", commands: {}, pendingDeliveries: [], updatedAt: Date.now() };
  }

  async beginExecution(req: SubagentBeginRequest): Promise<SubagentBeginReceipt> {
    await this.ready(true);
    return this.enqueue<SubagentBeginReceipt>(`${req.sessionId}/${req.delegationId}`, async () => {
      this.owner(req.sessionId, req.instanceGeneration);
      const old = await this.control(req.sessionId, req.delegationId);
      if (this.revoked.has(`${req.sessionId}/${req.delegationId}`) || old?.status === "revoked") throw new SubagentPersistenceError("TASK_REVOKED", "任务已停止");
      if (!Number.isSafeInteger(req.nextExecution) || req.nextExecution < 1) throw new SubagentPersistenceError("INVALID_REQUEST", "执行轮次无效");
      if (old && (old.execution > req.nextExecution || (old.execution === req.nextExecution && old.executionId !== req.executionId))) {
        throw new SubagentPersistenceError("EXECUTION_CONFLICT", "旧登记不能覆盖较新的执行");
      }
      if (old?.execution === req.nextExecution && old.executionId === req.executionId) {
        return { sessionId: req.sessionId, delegationId: req.delegationId, revision: old.revision,
          execution: old.execution, executionId: old.executionId, status: "running", acquiredAt: old.updatedAt, isDuplicate: true };
      }
      const control = old ?? this.fresh(req.sessionId, req.delegationId, req.nextExecution, req.executionId, req.instanceGeneration);
      Object.assign(control, { execution: req.nextExecution, executionId: req.executionId, instanceGeneration: req.instanceGeneration,
        status: "running", revision: control.revision + 1, parentTurnId: req.parentTurnId, parentToolCallId: req.parentToolCallId,
        commands: {}, pendingDeliveries: [], updatedAt: Date.now() });
      this.owner(req.sessionId, req.instanceGeneration);
      await this.writeControl(control);
      return { sessionId: req.sessionId, delegationId: req.delegationId, revision: control.revision,
        execution: control.execution, executionId: control.executionId, status: "running", acquiredAt: control.updatedAt };
    });
  }

  async commitSnapshot(req: SubagentCommitRequest): Promise<SubagentCommitReceipt> {
    await this.ready(true);
    return this.enqueue<SubagentCommitReceipt>(`${req.sessionId}/${req.delegationId}`, async () => {
      const session = this.owner(req.sessionId, req.instanceGeneration);
      const control = await this.control(req.sessionId, req.delegationId);
      if (!control) throw new SubagentPersistenceError("SNAPSHOT_NOT_FOUND", "本轮尚未登记");
      if (this.revoked.has(`${req.sessionId}/${req.delegationId}`) || control.status === "revoked") throw new SubagentPersistenceError("TASK_REVOKED", "任务已停止");
      const checkpoint = validateCheckpoint(req.checkpoint);
      const projectRealPath = checkpoint.header.projectRealPath ? await realpath(checkpoint.header.projectRealPath) : "";
      if (checkpoint.header.sessionId !== req.sessionId || checkpoint.header.delegationId !== req.delegationId ||
          !samePath(projectRealPath, session.projectRealPath) ||
          checkpoint.execution.execution !== req.expectedExecution || checkpoint.execution.executionId !== req.executionId ||
          checkpoint.execution.generation !== req.targetGeneration || !Number.isSafeInteger(req.targetGeneration) || req.targetGeneration < 1 ||
          control.execution !== req.expectedExecution || control.executionId !== req.executionId) {
        throw new SubagentPersistenceError("EXECUTION_CONFLICT", "快照不属于当前任务、目录或执行轮次");
      }
      checkpoint.header.projectRealPath = projectRealPath;
      const bytes = this.files.encode(checkpoint, `${req.sessionId}/${req.delegationId}/generation-${req.targetGeneration}`);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (control.status === "completed" && control.snapshotGeneration === req.targetGeneration) {
        if (control.commitDigest !== digest) throw new SubagentPersistenceError("EXECUTION_CONFLICT", "同一快照版本内容不一致");
      } else {
        if (control.status !== "running" || req.targetGeneration <= control.snapshotGeneration) throw new SubagentPersistenceError("EXECUTION_CONFLICT", "旧快照不能覆盖新状态");
        // 配额写入单独串行；登记、读取及其他任务不被清理阻塞。
        await this.enqueue("quota", async () => {
          await this.makeRoom(req.sessionId, req.delegationId, bytes.length);
          this.owner(req.sessionId, req.instanceGeneration);
          await this.files.atomicWrite(this.files.path(req.sessionId, req.delegationId, `generation-${req.targetGeneration}.bin`), bytes);
          this.owner(req.sessionId, req.instanceGeneration);
          Object.assign(control, { status: "completed", revision: control.revision + 1, snapshotGeneration: req.targetGeneration,
            commitDigest: digest, updatedAt: Date.now(), appVersion: checkpoint.header.appVersion,
            modelId: checkpoint.modelBinding.provider.modelId, agentName: checkpoint.config.definition.name,
            lastReportSummary: checkpoint.usage.lastReportText, pendingDeliveries: [],
            lastResult: { status: "completed", report: checkpoint.usage.lastReportText, turns: checkpoint.usage.turns,
              toolCalls: checkpoint.usage.toolCalls, contextCompactions: checkpoint.compaction.contextCompactions,
              usage: checkpoint.usage.usage, executionUsage: checkpoint.usage.executionUsage } });
          await this.writeControl(control);
          // 只有新版本和索引都已成功写入，才清理同任务上一份成功快照。
          for (const file of await this.children(req.sessionId, req.delegationId)) {
            if (/^generation-\d+\.bin$/.test(file.name) && file.name !== `generation-${req.targetGeneration}.bin`) {
              await unlink(this.files.path(req.sessionId, req.delegationId, file.name)).catch(() => undefined);
            }
          }
        });
      }
      return { sessionId: req.sessionId, delegationId: req.delegationId, revision: control.revision,
        execution: control.execution, executionId: control.executionId, snapshotGeneration: control.snapshotGeneration,
        status: "completed", committedAt: control.updatedAt, durableReady: true };
    });
  }

  async failExecution(req: SubagentFailRequest): Promise<SubagentFailReceipt> {
    await this.ready(true);
    return this.enqueue<SubagentFailReceipt>(`${req.sessionId}/${req.delegationId}`, async () => {
      this.owner(req.sessionId, req.instanceGeneration);
      const control = await this.control(req.sessionId, req.delegationId);
      if (!control || control.execution !== req.expectedExecution || control.executionId !== req.executionId || control.status === "revoked") {
        throw new SubagentPersistenceError("EXECUTION_CONFLICT", "任务执行状态已变化");
      }
      control.status = req.status; control.lastError = req.error; control.revision++; control.updatedAt = Date.now();
      await this.writeControl(control);
      return { sessionId: req.sessionId, delegationId: req.delegationId, revision: control.revision,
        execution: control.execution, status: req.status, failedAt: control.updatedAt };
    });
  }

  async revokeExecution(req: SubagentRevokeRequest): Promise<SubagentRevokeReceipt> {
    await this.ready();
    return this.enqueue<SubagentRevokeReceipt>(`${req.sessionId}/${req.delegationId}`, async () => {
      const old = await this.control(req.sessionId, req.delegationId);
      if (old && req.expectedExecution !== undefined && old.execution > req.expectedExecution) throw new SubagentPersistenceError("EXECUTION_CONFLICT", "旧停止请求不能停止新一轮任务");
      if (req.instanceGeneration !== undefined) this.owner(req.sessionId, req.instanceGeneration);
      this.revoked.add(`${req.sessionId}/${req.delegationId}`);
      const control = old ?? this.fresh(req.sessionId, req.delegationId, req.expectedExecution ?? 1, "", req.instanceGeneration ?? 1);
      control.status = "revoked"; control.revokeReason = req.reason; control.revokedAt = Date.now(); control.updatedAt = control.revokedAt; control.revision++;
      await this.writeControl(control);
      return { sessionId: req.sessionId, delegationId: req.delegationId, revision: control.revision,
        execution: control.execution, status: "revoked", revokedAt: control.revokedAt };
    });
  }

  async loadSnapshot(req: SubagentLoadRequest): Promise<SubagentLoadReceipt> {
    await this.ready();
    return this.enqueue<SubagentLoadReceipt>(`${req.sessionId}/${req.delegationId}`, async () => {
      const control = await this.control(req.sessionId, req.delegationId);
      if (!control || control.status !== "completed" || this.revoked.has(`${req.sessionId}/${req.delegationId}`)) throw new SubagentPersistenceError("SNAPSHOT_NOT_FOUND", "本轮没有可恢复的完整快照");
      const generation = req.generation ?? control.snapshotGeneration;
      if (generation < 1 || generation !== control.snapshotGeneration) throw new SubagentPersistenceError("SNAPSHOT_NOT_FOUND", "该快照版本已失效");
      const info = await lstat(this.files.path(req.sessionId, req.delegationId, `generation-${generation}.bin`));
      if (info.mtimeMs < Date.now() - DEFAULT_RETENTION_DAYS * 86_400_000) throw new SubagentPersistenceError("SNAPSHOT_NOT_FOUND", "上下文快照已过保留期");
      const raw = await this.read<unknown>(`${req.sessionId}/${req.delegationId}/generation-${generation}`, this.files.path(req.sessionId, req.delegationId, `generation-${generation}.bin`));
      if (!raw) throw new SubagentPersistenceError("SNAPSHOT_NOT_FOUND", "上下文快照已清理");
      const checkpoint = validateCheckpoint(raw);
      const authority = await this.options.sessionAuthority(req.sessionId, "identity");
      if (!authority || !samePath(checkpoint.header.projectRealPath, authority.projectRealPath) ||
          checkpoint.header.sessionId !== req.sessionId || checkpoint.header.delegationId !== req.delegationId ||
          checkpoint.execution.execution !== control.execution || checkpoint.execution.executionId !== control.executionId || checkpoint.execution.generation !== generation) {
        throw new SubagentPersistenceError("SNAPSHOT_CORRUPTED", "快照与当前会话、目录或执行轮次不一致");
      }
      return { sessionId: req.sessionId, delegationId: req.delegationId, control, checkpoint };
    });
  }

  private async directoryEntry(control: StoredControlRecord): Promise<SubagentDirectoryEntry> {
    const session = this.sessions.get(control.sessionId);
    const status = control.status === "running" && (!session || session.closed || session.instanceGeneration !== control.instanceGeneration) ? "interrupted" : control.status;
    const info = control.snapshotGeneration > 0
      ? await lstat(this.files.path(control.sessionId, control.delegationId, `generation-${control.snapshotGeneration}.bin`)).catch(() => null) : null;
    const exists = Boolean(info?.isFile() && !info.isSymbolicLink() && info.mtimeMs >= Date.now() - DEFAULT_RETENTION_DAYS * 86_400_000);
    const persistenceState = status === "completed" ? exists ? "pending-validation" : "cleaned" : status === "running" ? "saving" : status;
    return { sessionId: control.sessionId, delegationId: control.delegationId, revision: control.revision,
      execution: control.execution, executionId: control.executionId, snapshotGeneration: control.snapshotGeneration,
      status, canResume: status === "completed" && exists, persistenceState, durableState: persistenceState, source: "disk",
      updatedAt: control.updatedAt, appVersion: control.appVersion, modelId: control.modelId, agentName: control.agentName,
      parentTurnId: control.parentTurnId, parentToolCallId: control.parentToolCallId,
      lastReportSummary: control.lastReportSummary, lastResult: control.lastResult,
      ...(!exists && status === "completed" ? { reason: "完整上下文不可用，已有任务结果仍可读取" } : {}) };
  }

  async listEntries(req: SubagentListRequest): Promise<SubagentListReceipt> {
    await this.ready(); identifier(req.sessionId);
    const dirs = (await this.children(req.sessionId)).filter((file) => file.isDirectory() && /^[a-zA-Z0-9_-]{1,128}$/.test(file.name)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const start = req.cursor ? dirs.findIndex((file) => file.name > req.cursor!) : 0;
    const selected = start < 0 ? [] : dirs.slice(start, start + Math.max(1, Math.min(100, req.limit ?? 100)));
    const entries: SubagentDirectoryEntry[] = [];
    for (const dir of selected) {
      try {
        const control = await this.control(req.sessionId, dir.name);
        if (control) {
          entries.push(await this.directoryEntry(control));
        }
      }
      catch { /* 一份损坏记录不影响其余任务。 */ }
    }
    return { sessionId: req.sessionId, entries, totalCount: dirs.length,
      ...(start >= 0 && start + selected.length < dirs.length ? { nextCursor: selected.at(-1)?.name } : {}) };
  }

  async readRecallStatus(sessionId: string, id: string): Promise<SubagentRecallStatus> {
    try {
      await this.ready();
      const control = await this.control(sessionId, id);
      if (control) { const entry = await this.directoryEntry(control); return { ...entry, snapshotVersion: entry.snapshotGeneration }; }
    } catch { /* 卡片查询不影响聊天。 */ }
    return { delegationId: id, status: "unavailable", canResume: false, source: "disk", persistenceState: "unavailable", reason: "完整上下文暂不可用" };
  }

  async confirmEvents(req: SubagentConfirmEventsRequest): Promise<SubagentEventAckReceipt> {
    // 新快照不再保存消息投递队列；此操作只兼容旧宿主请求。
    const control = await this.control(req.sessionId, req.delegationId);
    return { sessionId: req.sessionId, delegationId: req.delegationId, executionId: req.executionId,
      ackedDeliveryIds: req.deliveryIds.filter((id) => !control?.pendingDeliveries?.some((item) => item.deliveryId === id)),
      remainingDeliveriesCount: control?.pendingDeliveries?.length ?? 0 };
  }

  private async children(...parts: string[]) {
    try { return await readdir(parts.length ? this.files.path(...parts) : this.root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  private async snapshots() {
    const files: { path: string; sessionId: string; delegationId: string; size: number; mtimeMs: number }[] = [];
    for (const session of await this.children()) {
      if (!session.isDirectory() || !/^[a-zA-Z0-9_-]{1,128}$/.test(session.name)) continue;
      for (const task of await this.children(session.name)) {
        if (!task.isDirectory() || !/^[a-zA-Z0-9_-]{1,128}$/.test(task.name)) continue;
        for (const file of await this.children(session.name, task.name)) {
          const path = this.files.path(session.name, task.name, file.name);
          if (file.isFile() && /^generation-\d+\.bin$/.test(file.name)) {
            const info = await lstat(path).catch(() => null);
            if (info) files.push({ path, sessionId: session.name, delegationId: task.name, size: info.size, mtimeMs: info.mtimeMs });
          } else if (file.isFile() && file.name.endsWith(".tmp")) {
            // 仅清理旧的临时文件；同一配额队列不会删除正在写入的快照。
            const info = await lstat(path).catch(() => null);
            if (info && info.mtimeMs < Date.now() - 86_400_000) await unlink(path).catch(() => undefined);
          }
        }
      }
    }
    return files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  }

  private async makeRoom(sessionId: string, delegationId: string, bytes: number): Promise<void> {
    const files = await this.snapshots();
    let total = files.reduce((sum, file) => sum + file.size, 0);
    let count = files.filter((file) => file.sessionId === sessionId).length;
    for (const file of files) {
      if (file.sessionId === sessionId && file.delegationId === delegationId) continue;
      if (file.mtimeMs > Date.now() - DEFAULT_RETENTION_DAYS * 86_400_000 && total + bytes <= MAX_TOTAL_BYTES && (file.sessionId !== sessionId || count < MAX_SESSION_SNAPSHOTS)) continue;
      await unlink(file.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      total -= file.size; if (file.sessionId === sessionId) count--;
    }
    if (total + bytes > MAX_TOTAL_BYTES) throw new SubagentPersistenceError("QUOTA_EXCEEDED", "快照空间不足，保留上一份成功快照");
  }

  async clearSnapshots(): Promise<{ cleared: number }> {
    await this.ready();
    return this.enqueue("quota", async () => {
      let cleared = 0;
      for (const file of await this.snapshots()) { await unlink(file.path); cleared++; }
      return { cleared };
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    identifier(sessionId); this.closingSessions.add(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) { session.closed = true; session.instanceGeneration++; session.claimedRuntimeInstanceId = undefined; }
  }

  async deleteSession(sessionId: string): Promise<void> {
    identifier(sessionId); this.deletedSessions.add(sessionId);
    await this.closeSession(sessionId);
    await Promise.allSettled([...this.queues].filter(([key]) => key.startsWith(`${sessionId}/`) || key === `session:${sessionId}`).map(([, pending]) => pending));
    await rm(this.files.path(sessionId), { recursive: true, force: true });
    this.sessions.delete(sessionId);
  }

  async ownerLost(): Promise<void> { for (const id of this.sessions.keys()) await this.closeSession(id); }
  async closeOwner(): Promise<void> { this.closed = true; await this.ownerLost(); }
}
