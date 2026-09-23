import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostProcess } from "./host-process";

type MessageAppend = {
  key: string;
  sessionId: string;
  message: unknown;
  turnId?: string;
};

type OutboxLogger = (level: "warn" | "error", message: string, data?: unknown) => void;

const MAX_ENTRIES = 1024;

/**
 * Keeps transcript appends away from a dead host pipe. The file is an
 * application-owned outbox, while SQLite remains exclusively host-owned.
 * Message ids make replay idempotent after a host restart.
 */
export class PersistenceOutbox {
  private readonly path: string;
  private readonly tempPath: string;
  private readonly logger: OutboxLogger;
  private entries: MessageAppend[] = [];
  private flushing: Promise<void> | null = null;
  private persistChain = Promise.resolve();
  private mutationChain = Promise.resolve();
  private readonly loaded: Promise<void>;
  private onMessagePersisted?: (sessionId: string) => Promise<void> | void;

  constructor(dataDir: string, logger: OutboxLogger) {
    this.path = join(dataDir, "session-message-outbox.json");
    this.tempPath = `${this.path}.tmp`;
    this.logger = logger;
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
    // host 负责跨会话 ID 隔离；只有成功回执才能确认快照覆盖。
    // duplicate / poison 不得视为成功，也不得伪造成功回执：仅把该条延后
    // （保留消息、不调 onMessagePersisted），让后排先行，下一轮再试，
    // 避免单条坏头饿死整个队列，但不丢消息。
    let deferred = 0;
    while (this.entries.length > 0) {
      if (deferred >= this.entries.length) return;
      const current = this.entries[0];
      const currentHost = getHost();
      if (!currentHost || !currentHost.isAvailable()) return;
      try {
        await currentHost.call("session.appendMessage", {
          sessionId: current.sessionId,
          message: current.message,
          turnId: current.turnId,
        });
      } catch (error) {
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
        this.logger("warn", "session persistence flush paused", {
          key: current.key,
          data: String(error),
        });
        return;
      }
      deferred = 0;
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
            "message" in entry
          );
        });
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
 * failures do not even put INVALID_PARAMS in the message text.
 * 注意：判为 poison 也只是延后隔离，不得视为成功、不得调成功回执、
 * 不得丢弃消息。
 */
function isPoisonMessageError(error: unknown): boolean {
  return /(?<![A-Z_])PERMISSION_DENIED:/i.test(String(error));
}
