import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { type MessageUsage, type UiMessage } from "@pi-desktop/shared";

import type { HostRpc } from "./host-ports.js";

export type TurnPersistenceLogger = (
  level: "warn" | "error",
  message: string,
  data?: Record<string, unknown>,
) => void;

export type MessageAppend = {
  sessionId: string;
  message?: UiMessage;
  usage?: MessageUsage;
  turnId?: string;
};

type StoredMessageAppend = MessageAppend & { key: string };

type HostAvailability = HostRpc & { isAvailable?(): boolean };

/** Bounded backoff between retries while host-core or its database recovers. */
const RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 4_000, 8_000] as const;

function isDuplicateMessageIdError(error: unknown): boolean {
  return /UNIQUE constraint failed: messages\.id/i.test(String(error));
}

/** The session or turn was deleted while this row was queued; its parent cannot return. */
function isForeignKeyError(error: unknown): boolean {
  return /FOREIGN KEY constraint failed/i.test(String(error));
}

/**
 * Durable transcript appends for the headless Host. Rows of one session are
 * written in order. A row is removed only after host-core acknowledges it (or
 * reports that the same message id is already present); write failures keep it
 * in the queue for retry and, when a persistence path is configured, for the
 * next `pi-host` start. The desktop has its own file-backed outbox and does
 * not share this process-local implementation.
 */
export class TurnPersistence {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly entries: StoredMessageAppend[] = [];
  private readonly loaded: Promise<StoredMessageAppend[]>;
  private readonly persistencePath?: string;
  private readonly disposeWaiters = new Set<() => void>();
  private pendingCount = 0;
  private persistChain = Promise.resolve();
  private queueWritable = true;
  private disposed = false;

  constructor(
    private readonly deps: {
      getHost: () => HostAvailability | null;
      log: TurnPersistenceLogger;
      sleep?: (ms: number) => Promise<void>;
      /** Durable queue location, normally inside the pi-host data directory. */
      persistencePath?: string;
    },
  ) {
    this.persistencePath = deps.persistencePath;
    this.loaded = this.load().then((entries) => {
      // Keep every restored row under queue management before any append or
      // acknowledgement can rewrite the file; chains only control write order.
      this.entries.push(...entries);
      return entries;
    });
    void this.loaded.then((entries) => {
      for (const entry of entries) this.enqueue(entry, false, true);
    });
  }

  /** Number of appends not yet acknowledged by host-core. */
  size(): number {
    return Math.max(this.pendingCount, this.entries.length);
  }

  /** Queue one append behind the session's earlier ones; resolves once it landed or shutdown retained it. */
  append(entry: MessageAppend): Promise<void> {
    return this.enqueue({ ...entry, key: randomUUID() }, true);
  }

  /** Wait until every queued append has landed or shutdown has retained it. */
  async flush(): Promise<void> {
    await this.loaded;
    await Promise.all([...this.chains.values()]);
  }

  dispose(): void {
    this.disposed = true;
    for (const release of this.disposeWaiters) release();
    this.disposeWaiters.clear();
  }

  private enqueue(entry: StoredMessageAppend, persist: boolean, alreadyStored = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.pendingCount += 1;
    const previous = this.chains.get(entry.sessionId) ?? Promise.resolve();
    const run = previous
      .then(async () => {
        await this.loaded;
        if (!alreadyStored) this.entries.push(entry);
        if (persist) {
          try {
            await this.persist();
          } catch (error) {
            // The in-memory queue still retries this process; a persistence
            // failure is reported instead of making the event fire-and-forget.
            this.deps.log("error", "transcript queue persistence failed", {
              sessionId: entry.sessionId,
              messageId: entry.message?.id,
              error: String(error),
            });
          }
        }
        await this.write(entry);
      })
      .finally(() => {
        this.pendingCount -= 1;
        if (this.chains.get(entry.sessionId) === run) this.chains.delete(entry.sessionId);
      });
    this.chains.set(entry.sessionId, run);
    return run;
  }

  private async write(entry: StoredMessageAppend): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      if (this.disposed) return;
      const host = this.deps.getHost();
      if (host && (host.isAvailable?.() ?? true)) {
        try {
          await host.call(entry.usage ? "session.recordUsage" : "session.appendMessage", {
            sessionId: entry.sessionId,
            ...(entry.usage ? { usage: entry.usage } : { message: entry.message }),
            ...(entry.turnId ? { turnId: entry.turnId } : {}),
          });
          await this.remove(entry);
          return;
        } catch (error) {
          if (isDuplicateMessageIdError(error) || isForeignKeyError(error)) {
            await this.remove(entry);
            return;
          }
          // A database error (for example a full disk) must not drop a tool
          // result that the user already saw. Keep the row and retry until it
          // lands or this process is shut down; the durable queue survives the
          // latter when the data directory itself is writable.
          this.deps.log("warn", "transcript append retry scheduled", {
            sessionId: entry.sessionId,
            messageId: entry.message?.id,
            attempt: attempt + 1,
            error: String(error),
          });
        }
      }
      await this.sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
    }
  }

  private async remove(entry: StoredMessageAppend): Promise<void> {
    const index = this.entries.indexOf(entry);
    if (index >= 0) this.entries.splice(index, 1);
    try {
      await this.persist();
    } catch (error) {
      // A stale persisted row is replayed once and acknowledged as a
      // duplicate; that is safer than losing an unacknowledged row.
      this.deps.log("warn", "transcript queue acknowledgement persistence failed", {
        sessionId: entry.sessionId,
        messageId: entry.message?.id,
        error: String(error),
      });
    }
  }

  private async load(): Promise<StoredMessageAppend[]> {
    if (!this.persistencePath) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.persistencePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
        this.queueWritable = false;
        this.deps.log("warn", "transcript queue load failed", { error: String(error) });
      }
      return [];
    }
    const entries: StoredMessageAppend[] = [];
    if (Array.isArray(parsed)) {
      for (const value of parsed) {
        const entry = value as Partial<StoredMessageAppend> | null;
        if (!entry || typeof entry !== "object" || typeof entry.sessionId !== "string" || !entry.sessionId
            || !("message" in entry || "usage" in entry)) {
          this.queueWritable = false;
          this.deps.log("warn", "transcript queue contains an invalid entry", {});
          return [];
        }
        entries.push({
          sessionId: entry.sessionId,
          ...(entry.message !== undefined ? { message: entry.message } : {}),
          ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
          ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
          key: typeof entry.key === "string" ? entry.key : randomUUID(),
        });
      }
      return entries;
    }
    this.queueWritable = false;
    this.deps.log("warn", "transcript queue has an invalid shape", {});
    return [];
  }

  private async persist(): Promise<void> {
    if (!this.persistencePath) return;
    if (!this.queueWritable) throw new Error("the existing transcript queue could not be read safely");
    const path = this.persistencePath;
    const payload = `${JSON.stringify(this.entries)}\n`;
    const write = this.persistChain.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    });
    this.persistChain = write.catch(() => undefined);
    await write;
  }

  private async sleep(ms: number): Promise<void> {
    if (this.disposed) return;
    let release = () => undefined;
    const interrupted = new Promise<void>((resolve) => {
      release = () => {
        this.disposeWaiters.delete(release);
        resolve();
      };
      this.disposeWaiters.add(release);
    });
    try {
      await Promise.race([(this.deps.sleep ?? defaultSleep)(ms), interrupted]);
    } finally {
      this.disposeWaiters.delete(release);
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
