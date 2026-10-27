/**
 * Serialize mutating tool calls that target the same file.
 *
 * The parent agent and its subagents run in one sidecar process but issue
 * `tools.execute` calls independently. host-core admits one mutation per
 * session at a time, so the writes themselves cannot tear; what it does not
 * give is a defined order for two same-path mutations, and the sidecar's own
 * per-path bookkeeping needs one. The edit-recovery contract allows three
 * counted failures per path before terminating the prompt, which only means
 * "read fresh content and try again" if the attempts were ordered.
 * With subagents able to fan out (ADR 0062) they no longer are, so the
 * sidecar queues same-path mutations before they reach the host.
 *
 * Different paths never wait on each other, which is the point: fan-out stays
 * parallel except where the order matters.
 */

/** Compare-equal spelling of a path: forward slashes, no `./` prefix. */
export function normalizeLockPath(path: unknown): string {
  return String(path ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

type PathQueueEntry = {
  /** Settled when the latest queued or running exclusive (`run`) holder finishes. */
  writeTail?: Promise<void>;
  /** Settled when every queued or running holder (`run` or `read`) finishes. */
  allTail: Promise<void>;
  holders: number;
};

export class PathMutex {
  /** Per path: the active queue tails and how many holders are still in it. */
  private queues = new Map<string, PathQueueEntry>();

  /** Run `task` exclusively once every earlier read or write for `key` has settled. */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const path = normalizeLockPath(key);
    if (!path) return task();
    const entry = this.queues.get(path);
    const previous = entry?.allTail;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A failed predecessor must not poison the queue; only ordering matters.
    const tail = previous
      ? previous.then(
          () => held,
          () => held,
        )
      : held;
    if (entry) {
      entry.writeTail = tail;
      entry.allTail = tail;
      entry.holders += 1;
    } else {
      this.queues.set(path, { writeTail: tail, allTail: tail, holders: 1 });
    }
    if (previous) await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      this.releaseHolder(path);
    }
  }

  /**
   * Run a read `task` once every earlier write (`run`) for `key` has settled.
   * Concurrent reads on the same path overlap; a subsequent write waits for all
   * earlier reads on that path to finish.
   */
  async read<T>(key: string, task: () => Promise<T>): Promise<T> {
    const path = normalizeLockPath(key);
    if (!path) return task();
    const entry = this.queues.get(path);
    const previousWrite = entry?.writeTail;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readDone = previousWrite
      ? previousWrite.then(
          () => held,
          () => held,
        )
      : held;
    const allTail = entry
      ? Promise.all([entry.allTail, readDone]).then(
          () => undefined,
          () => undefined,
        )
      : readDone;
    if (entry) {
      entry.allTail = allTail;
      entry.holders += 1;
    } else {
      this.queues.set(path, { allTail, holders: 1 });
    }
    if (previousWrite) await previousWrite.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      this.releaseHolder(path);
    }
  }

  private releaseHolder(path: string): void {
    // Drop the entry once the last holder leaves, so a long session does not
    // accumulate one promise per file it ever touched.
    const current = this.queues.get(path);
    if (current) {
      current.holders -= 1;
      if (current.holders <= 0) this.queues.delete(path);
    }
  }

  /** True while any path still has a queued or running holder. */
  get busy(): boolean {
    return this.queues.size > 0;
  }
}
