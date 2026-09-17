import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { HostProcess } from "./host-process";
import type { PersistenceOutbox } from "./persistence-outbox";
import type { UiMessage } from "@pi-desktop/shared";

/** One "send now" transfer of a durable queue entry into a running turn. */
export type QueuedSteeringReceipt = {
  queuedTurnId: string;
  sessionId: string;
  /** Durable identity of the injected user message (reused by every retry). */
  messageId: string;
  expectedTurnId: string;
  /**
   * `pending` is written before the runtime is asked; `accepted` is written
   * before the transcript echo. A `pending` receipt is an unknown outcome and
   * must never be replayed as a normal queued turn.
   */
  state: "pending" | "accepted";
  /** Set on `accepted`: the runtime turn that took the input. */
  turnId?: string;
  /** Set on `accepted`: the prepared echo, so a retry keeps the same append. */
  message?: UiMessage;
  createdAt: string;
};

type ReceiptLogger = (level: "warn" | "error", message: string, data?: unknown) => void;

const MAX_RECEIPTS = 128;

/**
 * Durable journal for queue-entry steering (independent additive file, no
 * schema or protocol change). It exists so a crash between "the runtime
 * accepted this input" and "the queue entry is gone" cannot silently replay the
 * message: `pending` isolates the entry, `accepted` retries only the durable
 * echo and the deletion.
 */
export class QueuedSteeringReceipts {
  private readonly path: string;
  private readonly tempPath: string;
  private readonly logger: ReceiptLogger;
  private entries = new Map<string, QueuedSteeringReceipt>();
  private persistChain = Promise.resolve();
  private readonly loaded: Promise<void>;

  constructor(dataDir: string, logger: ReceiptLogger) {
    this.path = join(dataDir, "queued-steering-receipts.json");
    this.tempPath = `${this.path}.tmp`;
    this.logger = logger;
    this.loaded = this.load();
    void this.loaded.catch(() => undefined);
  }

  async list(): Promise<QueuedSteeringReceipt[]> {
    await this.loaded;
    return [...this.entries.values()];
  }

  async get(queuedTurnId: string): Promise<QueuedSteeringReceipt | undefined> {
    await this.loaded;
    return this.entries.get(queuedTurnId);
  }

  /**
   * Record the intent to steer this entry. The caller must await this before it
   * asks the runtime: without it a later crash looks like "never tried".
   */
  async begin(input: {
    queuedTurnId: string;
    sessionId: string;
    messageId: string;
    expectedTurnId: string;
  }): Promise<void> {
    await this.loaded;
    const existing = this.entries.get(input.queuedTurnId);
    // An accepted or pending receipt for the same entry is authoritative: a
    // repeated request must not reset it to "pending".
    if (existing) return;
    if (this.entries.size >= MAX_RECEIPTS) {
      this.logger("error", "queued steering receipts are full", {
        size: this.entries.size,
        max: MAX_RECEIPTS,
      });
      throw new Error("queued steering receipt journal is full");
    }
    this.entries.set(input.queuedTurnId, {
      queuedTurnId: input.queuedTurnId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      expectedTurnId: input.expectedTurnId,
      state: "pending",
      createdAt: new Date().toISOString(),
    });
    await this.persist();
  }

  /**
   * Record that the runtime took the input, together with the prepared echo, so
   * the transcript append can be retried without asking the runtime again.
   */
  async accept(
    queuedTurnId: string,
    accepted: { turnId: string; message: UiMessage },
  ): Promise<void> {
    await this.loaded;
    const existing = this.entries.get(queuedTurnId);
    if (!existing) {
      // The pending receipt must have been written first; accepting without it
      // would make the transfer unrecoverable, so the state is recreated.
      throw new Error(`no pending steering receipt for ${queuedTurnId}`);
    }
    this.entries.set(queuedTurnId, {
      ...existing,
      state: "accepted",
      turnId: accepted.turnId,
      message: accepted.message,
    });
    await this.persist();
  }

  /** The transfer is finished (or was proven rejected): stop remembering it. */
  async settle(queuedTurnId: string): Promise<void> {
    await this.loaded;
    const previous = this.entries.get(queuedTurnId);
    if (!previous) return;
    this.entries.delete(queuedTurnId);
    try { await this.persist(); }
    catch (error) { this.entries.set(queuedTurnId, previous); throw error; }
  }

  /** Session delete drops its receipts (same rule as the persistence outbox). */
  async dropSession(sessionId: string): Promise<void> {
    await this.loaded;
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (entry.sessionId !== sessionId) continue;
      this.entries.delete(id);
      changed = true;
    }
    if (changed) await this.persist();
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("Invalid queued steering receipt journal");
      for (const entry of parsed) {
        if (
          entry &&
          typeof entry.queuedTurnId === "string" &&
          typeof entry.sessionId === "string" &&
          typeof entry.messageId === "string" &&
          typeof entry.expectedTurnId === "string" &&
          (entry.state === "pending" || entry.state === "accepted")
        ) {
          this.entries.set(entry.queuedTurnId, entry as QueuedSteeringReceipt);
        } else {
          throw new Error("Invalid queued steering receipt entry");
        }
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        this.logger("warn", "queued steering receipts load failed", String(error));
        throw error;
      }
    }
  }

  private async persist(): Promise<void> {
    const write = this.persistChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.tempPath, `${JSON.stringify([...this.entries.values()])}\n`, "utf8");
      await rename(this.tempPath, this.path);
    });
    this.persistChain = write.catch(() => undefined);
    await write;
  }
}

/** The main-owned durable side of one queued steering transfer. */
export type QueuedSteeringJournal = {
  list(): Promise<
    Array<{ queuedTurnId: string; sessionId: string; state: "pending" | "accepted"; turnId?: string }>
  >;
  /** Record the intent before the runtime is asked (the caller must await it). */
  begin(input: {
    queuedTurnId: string;
    sessionId: string;
    messageId: string;
    expectedTurnId: string;
  }): Promise<void>;
  /** Record the accepted echo before it is queued for persistence. */
  accept(queuedTurnId: string, accepted: { turnId: string; message: UiMessage }): Promise<void>;
  /** Re-apply the accepted echo. Throws when the append cannot be queued. */
  settle(queuedTurnId: string): Promise<void>;
  /** Forget one receipt: the transfer is finished. */
  complete(queuedTurnId: string): Promise<void>;
  /** Forget a proven-rejected intent. */
  reject(queuedTurnId: string): Promise<void>;
};

export function createQueuedSteeringJournal(options: {
  receipts: QueuedSteeringReceipts;
  outbox: PersistenceOutbox;
  getHost: () => HostProcess | null;
}): QueuedSteeringJournal {
  const { receipts, outbox, getHost } = options;
  return {
    async list() {
      const entries = await receipts.list();
      return entries.map((entry) => ({
        queuedTurnId: entry.queuedTurnId,
        sessionId: entry.sessionId,
        state: entry.state,
        ...(entry.turnId ? { turnId: entry.turnId } : {}),
      }));
    },
    async begin(input) {
      await receipts.begin(input);
    },
    async accept(queuedTurnId, accepted) {
      await receipts.accept(queuedTurnId, accepted);
    },
    async settle(queuedTurnId) {
      const receipt = await receipts.get(queuedTurnId);
      if (!receipt || receipt.state !== "accepted" || !receipt.message) {
        // Only an accepted transfer has durable side effects to re-apply; a
        // pending one is an unknown outcome and stays isolated.
        throw new Error(`no accepted steering receipt for ${queuedTurnId}`);
      }
      // The same key as the live event path keeps a replay idempotent.
      await outbox.enqueue(
        {
          key: `message:${receipt.sessionId}:${receipt.message.id}`,
          sessionId: receipt.sessionId,
          message: receipt.message,
          turnId: receipt.turnId,
        },
        getHost,
      );
    },
    async complete(queuedTurnId) {
      await receipts.settle(queuedTurnId);
    },
    async reject(queuedTurnId) {
      await receipts.settle(queuedTurnId);
    },
  };
}
