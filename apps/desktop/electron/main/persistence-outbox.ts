import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostProcess } from "./host-process";
import { compactToolMessage } from "@pi-desktop/shared";
import { MediaStore } from "@pi-desktop/agent-runtime/media-store";

type MessageAppend = {
  key: string;
  sessionId: string;
  message?: unknown;
  usage?: unknown;
  turnId?: string;
};

type OutboxLogger = (level: "warn" | "error", message: string, data?: unknown) => void;
type OutboxOptions = { now?: () => number };
type AppendRetry = { attempts: number; nextAttemptAt: number; host: HostProcess };

const MAX_ENTRIES = 1024;
const MAX_TRANSIENT_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = 5_000;
const MAX_RETRY_BACKOFF_MS = 60_000;

/**
 * Keeps transcript appends away from a dead host pipe. The file is an
 * application-owned outbox, while SQLite remains exclusively host-owned.
 * Message ids make replay idempotent after a host restart.
 */
export class PersistenceOutbox {
  private readonly path: string;
  private readonly tempPath: string;
  private readonly logger: OutboxLogger;
  private readonly mediaStore: MediaStore;
  private readonly now: () => number;
  private readonly retries = new WeakMap<MessageAppend, AppendRetry>();
  private entries: MessageAppend[] = [];
  private flushing: Promise<void> | null = null;
  private persistChain = Promise.resolve();
  private mutationChain = Promise.resolve();
  private readonly loaded: Promise<void>;
  private onMessagePersisted?: (sessionId: string) => Promise<void> | void;

  constructor(dataDir: string, logger: OutboxLogger, options: OutboxOptions = {}) {
    this.path = join(dataDir, "session-message-outbox.json");
    this.tempPath = `${this.path}.tmp`;
    this.logger = logger;
    this.mediaStore = new MediaStore(join(dataDir, "attachments"));
    this.now = options.now ?? Date.now;
    this.loaded = this.load();
  }

  setOnMessagePersisted(callback?: (sessionId: string) => Promise<void> | void): void {
    this.onMessagePersisted = callback;
  }
  enqueue(entry: MessageAppend, getHost: () => HostProcess | null): Promise<void> {
    return this.queueMutation(() => this.enqueueEntry(entry, getHost));
  }

  // 入队等待刷新时仍按调用顺序执行，防止旧快照晚于新快照写入。
  private queueMutation(action: () => Promise<void>): Promise<void> {
    const mutation = this.mutationChain.then(action);
    this.mutationChain = mutation.catch(() => undefined);
    return mutation;
  }

  private async enqueueEntry(
    entry: MessageAppend,
    getHost: () => HostProcess | null,
  ): Promise<void> {
    await this.loaded;
    entry = { ...entry, message: await this.mediaStore.externalize(compactToolMessage(entry.message)) };
    const existing = this.entries.findIndex((item) => item.key === entry.key);
    if (existing >= 0) this.entries[existing] = entry;
    else {
      if (this.entries.length >= MAX_ENTRIES) await this.flush(getHost);
      if (this.entries.length >= MAX_ENTRIES) {
        this.logger("error", "session persistence outbox is full", {
          key: entry.key,
          sessionId: entry.sessionId,
          size: this.entries.length,
          max: MAX_ENTRIES,
        });
        throw new Error("session persistence outbox is full");
      }
      this.entries.push(entry);
    }
    await this.persist();
    void this.flush(getHost);
  }

  async flush(getHost: () => HostProcess | null): Promise<void> {
    await this.loaded;
    if (this.flushing) return this.flushing;
    this.flushing = this.flushLoop(getHost).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /**
   * Drop queued appends for a session that the user deleted so a later
   * host-side stub recreate cannot resurrect it (D318).
   */
  dropSession(sessionId: string): Promise<void> {
    return this.queueMutation(async () => {
      await this.loaded;
      const next = this.entries.filter((entry) => entry.sessionId !== sessionId);
      if (next.length === this.entries.length) return;
      this.entries = next;
      await this.persist();
    });
  }

  size(): number {
    return this.entries.length;
  }

  private async flushLoop(getHost: () => HostProcess | null): Promise<void> {
    // 失败消息继续保存在原队列；只有 host 成功回执才能触发持久化通知。
    // 已知坏消息和反复失败的消息延后重试，让其他消息继续落盘。
    let deferred = 0;
    while (this.entries.length > 0) {
      if (deferred >= this.entries.length) return;
      const current = this.entries[0];
      const currentHost = getHost();
      if (!currentHost || !currentHost.isAvailable()) return;
      const retry = this.retries.get(current);
      if (retry?.host === currentHost && retry.nextAttemptAt > this.now()) {
        if (retry.attempts < MAX_TRANSIENT_ATTEMPTS) return;
        if (this.deferHead(current)) deferred += 1;
        await this.persist();
        continue;
      }
      try {
        await currentHost.call(current.usage ? "session.recordUsage" : "session.appendMessage", {
          sessionId: current.sessionId,
          ...(current.usage ? { usage: current.usage } : { message: current.message }),
          turnId: current.turnId,
        });
      } catch (error) {
        // 旧请求的失败不暂停并发替换或删除后留下的消息。
        if (this.entries[0] !== current) continue;
        if (isDuplicateMessageIdError(error)) {
          this.logger("warn", "session persistence flush deferred duplicate message id", {
            key: current.key,
            data: String(error),
          });
          if (this.deferHead(current)) deferred += 1;
          await this.persist();
          continue;
        }
        if (isPoisonMessageError(error)) {
          this.logger("warn", "session persistence flush deferred poisoned message", {
            key: current.key,
            data: String(error),
          });
          if (this.deferHead(current)) deferred += 1;
          await this.persist();
          continue;
        }
        if (isForeignKeyError(error)) {
          this.logger("warn", "session persistence flush dropped orphaned message", {
            key: current.key,
            data: String(error),
          });
          if (this.entries[0] === current) this.entries.shift();
          await this.persist();
          continue;
        }
        const retry = this.noteTransientFailure(current, currentHost);
        this.logger("warn", "session persistence flush retry scheduled", {
          key: current.key,
          sessionId: current.sessionId,
          attempts: retry.attempts,
          deferred: retry.attempts >= MAX_TRANSIENT_ATTEMPTS,
          retryInMs: retry.nextAttemptAt - this.now(),
          data: String(error),
        });
        if (retry.attempts < MAX_TRANSIENT_ATTEMPTS) return;
        if (this.deferHead(current)) deferred += 1;
        await this.persist();
        continue;
      }
      deferred = 0;
      this.retries.delete(current);
      try {
        await this.onMessagePersisted?.(current.sessionId);
      } catch (callbackError) {
        this.logger("warn", "outbox onMessagePersisted callback failed", {
          sessionId: current.sessionId,
          data: String(callbackError),
        });
      }
      // A newer snapshot may have replaced this key while the host wrote it.
      // Only remove the exact entry acknowledged by that write.
      if (this.entries[0] === current) this.entries.shift();
      await this.persist();
    }
  }

  /** 重试状态只属于本次消息快照，新快照或新宿主立即重试。 */
  private noteTransientFailure(entry: MessageAppend, host: HostProcess): AppendRetry {
    const previous = this.retries.get(entry);
    const attempts = Math.min(
      (previous?.host === host ? previous.attempts : 0) + 1,
      MAX_TRANSIENT_ATTEMPTS,
    );
    const retry = {
      attempts,
      nextAttemptAt: this.now() + Math.min(RETRY_BACKOFF_MS * 2 ** (attempts - 1), MAX_RETRY_BACKOFF_MS),
      host,
    };
    this.retries.set(entry, retry);
    return retry;
  }

  /** 仅延后收到失败回执的原快照，已删除或替换的消息不影响当前队头。 */
  private deferHead(current: MessageAppend): boolean {
    if (this.entries[0] !== current) return false;
    this.entries.shift();
    this.entries.push(current);
    return true;
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.entries = parsed.filter((entry): entry is MessageAppend => {
          return (
            entry &&
            typeof entry.key === "string" &&
            typeof entry.sessionId === "string" &&
            ("message" in entry || ("usage" in entry && typeof entry.turnId === "string"))
          );
        }).map((entry) => ({ ...entry, message: compactToolMessage(entry.message) }));
        for (const entry of this.entries) {
          // 先成功保存媒体再替换该条；失败时仍保留可重试的完整消息。
          try {
            entry.message = await this.mediaStore.externalize(entry.message);
          } catch (error) {
            this.logger("warn", "outbox media externalization failed", { key: entry.key, error: String(error) });
          }
        }
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        this.logger("warn", "session persistence outbox load failed", String(error));
      }
    }
  }

  private async persist(): Promise<void> {
    const write = this.persistChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      if (this.entries.length === 0) {
        try {
          await writeFile(this.path, "[]\n", "utf8");
        } catch (error) {
          this.logger("warn", "session persistence outbox clear failed", String(error));
        }
        return;
      }
      await writeFile(this.tempPath, `${JSON.stringify(this.entries)}\n`, "utf8");
      await rename(this.tempPath, this.path);
    });
    this.persistChain = write.catch(() => undefined);
    await write;
  }
}

function isDuplicateMessageIdError(error: unknown): boolean {
  return /UNIQUE constraint failed: messages\.id/i.test(String(error));
}

/**
 * The host will reject this message on every retry. Match the host-core
 * provenance prefix in the JSON-RPC message body (append maps those failures
 * as INTERNAL). Do not treat PLUGIN_PERMISSION_DENIED or schema
 * INVALID_PARAMS as poison — those are a different surface, and serde
 * failures do not even put INVALID_PARAMS in the message text. A request
 * exceeding the transport's existing size limit also cannot succeed on retry.
 * 注意：判为 poison 也只是延后隔离，不得视为成功、不得调成功回执、
 * 不得丢弃消息。
 */
function isPoisonMessageError(error: unknown): boolean {
  return /(?<![A-Z_])PERMISSION_DENIED:|request line exceeds 64 MiB/i.test(String(error));
}

/**
 * The parent row (session or turn) no longer exists. This happens after a
 * sidecar or host-core crash where the parent was deleted or never committed.
 * Retrying is pointless — the FK will never be satisfied.
 */
function isForeignKeyError(error: unknown): boolean {
  return /FOREIGN KEY constraint failed/i.test(String(error));
}
